// What to download and the yt-dlp arguments for it. Pure functions: nothing runs here. The
// choices below come from real yt-dlp runs.
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::{check_url, is_invisible, js_runtime, progress, Tuning};
use crate::errors::AppError;

/// Sent by the frontend (mirrored by `DownloadRequest` in ipc.ts). There is no output folder
/// on purpose: the frontend never touches the file system. Also stored as JSON in the
/// `downloads` table (db.rs), so a new field must be optional or old rows stop loading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadRequest {
    pub url: String,
    pub mode: Mode,
    /// Set when the download is one entry of a playlist. Left out of the stored JSON
    /// when `None`, so a plain download serializes exactly as before 4.2 (the duplicate check
    /// compares that text).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub playlist: Option<PlaylistPosition>,
    /// A subfolder of the output folder for the final file (the playlist's title).
    /// Raw text from the frontend: `folder_name` cleans it where it is used. Left out of the
    /// stored JSON when `None`, like `playlist`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    /// Subtitles to embed in a video. Ignored in audio mode. Left out of the stored
    /// JSON when `None`, like `playlist` and `folder`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subtitles: Option<Subtitles>,
}

/// The languages to embed in a video's file and whether the automatic captions may be used for
/// them (`DownloadRequest.subtitles`, mirrored in ipc.ts). A language the video lacks is skipped
/// by yt-dlp without an error (checked with YouTube), and one that fails to download (YouTube
/// answers 429 now and then) is only a warning: the video still comes down, without it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Subtitles {
    pub langs: Vec<String>,
    /// Also take the automatic captions, for a language with no manual subtitles.
    pub auto: bool,
}

/// Most languages one download may ask for: a long list is a mistake, not a choice.
const MAX_SUBTITLE_LANGS: usize = 20;

/// Whether `code` is a language code that is safe to hand to yt-dlp's `--sub-langs`: ASCII letters
/// and digits with `-` inside (`es`, `pt-BR`, `zh-Hans`, `es-419`, `en-orig`), up to 24 characters.
/// The value is a list of regular expressions there, where a leading `-` excludes, `all` is
/// everything and `.`, `*` or `,` mean something, so none of that gets through.
pub fn is_language_code(code: &str) -> bool {
    (1..=24).contains(&code.len())
        && code.starts_with(|c: char| c.is_ascii_alphanumeric())
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !code.eq_ignore_ascii_case("all")
}

impl Subtitles {
    /// `--sub-langs` and `--embed-subs`, plus `--write-auto-subs` when asked. No `--write-subs`:
    /// with it yt-dlp keeps the `.vtt` files next to the video after embedding them (checked
    /// with yt-dlp 2026.08.19); without it, it deletes them. An empty list adds nothing.
    fn args(&self) -> Result<Vec<String>, AppError> {
        if self.langs.is_empty() {
            return Ok(vec![]);
        }
        if self.langs.len() > MAX_SUBTITLE_LANGS {
            return Err(AppError::Unknown(format!(
                "at most {MAX_SUBTITLE_LANGS} subtitle languages at a time"
            )));
        }
        if let Some(bad) = self.langs.iter().find(|code| !is_language_code(code)) {
            return Err(AppError::Unknown(format!(
                "not a subtitle language code: {bad:?}"
            )));
        }
        let mut args = vec![
            "--sub-langs".into(),
            self.langs.join(","),
            "--embed-subs".into(),
        ];
        if self.auto {
            args.push("--write-auto-subs".into());
        }
        Ok(args)
    }
}

/// A title that is nothing but a Windows device name, alone or with an extension or spaces after it
/// (`CON`, `nul`, `COM1.txt`, `LPT¹`): as a file name it names the device, not a file. Python
/// regular expression, for `--replace-in-metadata`. A title that only starts with the word
/// (`Con Air`) does not match.
const DEVICE_TITLE: &str =
    "(?i)^(CON|PRN|AUX|NUL|COM[1-9\\u00b9\\u00b2\\u00b3]|LPT[1-9\\u00b9\\u00b2\\u00b3])( *\\..*| *)$";

/// The embedding and isolate controls of Unicode (U+202A to U+202E, U+2066 to U+2069), which
/// reorder how a name is drawn. The marks used in right-to-left text (U+200E, U+200F) and the joiners
/// of emoji and Indic scripts stay: ordinary titles use them.
const DIRECTION_CONTROLS: &str = "[\\u202a-\\u202e\\u2066-\\u2069]";

/// Longest subfolder name, in UTF-16 units (what Windows counts).
const MAX_FOLDER_UNITS: usize = 60;

/// Device names Windows reserves, with or without an extension (`CON.txt` is still `CON`).
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// A folder name that is safe on every system, from `raw` (a playlist's title, so anything):
/// characters no system allows in a name (`<>:"/\\|?*` and control characters) become `_`, so a
/// title can never climb out of the output folder or name a path; spaces and dots at the ends go
/// (Windows drops them, and a leading dot would hide the folder elsewhere); a reserved Windows
/// name gets a `_` in front; and it is cut to `MAX_FOLDER_UNITS`. `None` if nothing is left, and
/// the files then go straight into the output folder.
pub fn folder_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            // Direction overrides and zero-width characters would let a name read as another one.
            c if c.is_control() || is_invisible(c) => '_',
            c => c,
        })
        .collect();
    let mut units = 0;
    let cut: String = cleaned
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= MAX_FOLDER_UNITS
        })
        .collect();
    // Cutting can leave a dot or space at the end.
    let name = cut.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    if name.is_empty() {
        return None;
    }
    // Windows reads `CON .txt` (spaces before the dot) and `COM¹` (a superscript digit) as the
    // devices too.
    let stem: String = name
        .split('.')
        .next()
        .unwrap_or(name)
        .trim_end()
        .chars()
        .map(|c| match c {
            '¹' => '1',
            '²' => '2',
            '³' => '3',
            c => c,
        })
        .collect();
    let reserved = RESERVED_NAMES.iter().any(|r| r.eq_ignore_ascii_case(&stem));
    Some(if reserved {
        format!("_{name}")
    } else {
        name.to_string()
    })
}

/// Where a download sits in its playlist: it numbers the file (`07 - Title.opus`) and, in audio
/// mode, the track tag. `index` starts at 1. `count` (the playlist's size) only decides how many
/// digits the number gets, so that 9, 10 and 100 sort in order. The frontend sets it for audio
/// only; the backend applies it to whatever it is given.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlaylistPosition {
    pub index: u32,
    pub count: u32,
}

impl PlaylistPosition {
    /// `07 - ` (at least two digits, as many as `count` needs).
    fn prefix(self) -> String {
        let width = self.count.max(self.index).max(99).to_string().len();
        format!("{:0width$} - ", self.index)
    }
}

/// `{ "kind": "video", "maxHeight": 1080, "container": "mp4" }` or
/// `{ "kind": "audio", "format": "mp3", "bitrateKbps": 192 }`; missing options are `None`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Mode {
    /// `None` height: no limit (4K/8K if the source has it). `None` container: yt-dlp picks
    /// one that fits the codecs (mkv or webm).
    Video {
        max_height: Option<u32>,
        container: Option<Container>,
    },
    /// `bitrate_kbps` only applies to the lossy conversions (mp3, m4a, opus).
    Audio {
        format: AudioFormat,
        bitrate_kbps: Option<u32>,
    },
}

/// Only containers that ffmpeg can fill with `-c copy`: video is never re-encoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Container {
    /// The best resolution in an mp4 (AV1 up to 4K on YouTube).
    Mp4,
    /// An mp4 that plays everywhere: H.264 + AAC when the source has them (YouTube: up to
    /// 1080p). It is a preference, not a filter, so a source without H.264 still downloads.
    #[serde(rename = "mp4Compatible")]
    Mp4Compatible,
    Mkv,
    Webm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AudioFormat {
    /// The original audio, not re-encoded, in its own container (.opus, .m4a...).
    Best,
    Mp3,
    M4a,
    Opus,
    Flac,
    Wav,
}

impl Container {
    /// The `-S` keys after the resolution, which always comes first except for compatible
    /// mp4, where the codec does (an H.264 at 1080p beats an AV1 at 4K there).
    fn sort(self, height: Option<u32>) -> String {
        let res = match height {
            Some(height) => format!("res:{height}"),
            None => "res".to_string(),
        };
        match self {
            Self::Mp4 => format!("{res},ext:mp4:m4a"),
            Self::Mp4Compatible => format!("vcodec:h264,{res},acodec:aac"),
            Self::Webm => format!("{res},ext:webm:webm"),
            Self::Mkv => res,
        }
    }

    /// `--merge-output-format` and `--remux-video`. Webm gets a way out: a source with only
    /// H.264/AAC (Reddit) cannot go in it, so the merge falls back to mkv (`webm/mkv`) and the
    /// remux keeps mkv, sends a lone mp4 to mkv, and only then remuxes to webm. Without the
    /// remux rule, yt-dlp remuxed the fallback mkv to webm and failed (checked).
    fn flags(self) -> (&'static str, &'static str) {
        match self {
            Self::Mp4 | Self::Mp4Compatible => ("mp4", "mp4"),
            Self::Mkv => ("mkv", "mkv"),
            Self::Webm => ("webm/mkv", "mkv>mkv/mp4>mkv/webm"),
        }
    }
}

impl AudioFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Best => "best",
            Self::Mp3 => "mp3",
            Self::M4a => "m4a",
            Self::Opus => "opus",
            Self::Flac => "flac",
            Self::Wav => "wav",
        }
    }
}

/// How the final file is named. Three fixed choices, no free-form template: the
/// user never types text that becomes part of a yt-dlp `-o` argument. Stored in the `settings`
/// table by `as_str`, and sent by the frontend in the same camelCase (`NameTemplate` in ipc.ts).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NameTemplate {
    /// `Title.ext`
    Title,
    /// `Title [id].ext`: the id keeps two videos with the same title apart.
    #[default]
    TitleId,
    /// `Channel - Title.ext`
    ChannelTitle,
}

impl NameTemplate {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::TitleId => "titleId",
            Self::ChannelTitle => "channelTitle",
        }
    }

    /// The inverse of `as_str`; anything else (a stored value from a newer or broken app) is
    /// `None`, and the caller falls back to the default.
    pub fn parse(text: &str) -> Option<Self> {
        [Self::Title, Self::TitleId, Self::ChannelTitle]
            .into_iter()
            .find(|template| template.as_str() == text)
    }
}

/// Windows' classic path limit, in UTF-16 units. Newer Windows can lift it, but only if the
/// user turned it on, and ffmpeg and the other tools do not all honor it.
const PATH_LIMIT: usize = 260;
/// Kept free for what follows the title: ` [id]` (ids go up to ~25 characters) and the
/// intermediate suffix (`.f401-9.webm.part`).
const NAME_RESERVE: usize = 48;
/// Channel names are cut to this many bytes in `Channel - Title`.
const CHANNEL_BYTES: usize = 40;
const MAX_TITLE_BYTES: usize = 150;
const MIN_TITLE_BYTES: usize = 20;

/// Whether `temp_dir` is so deep that not even `MIN_TITLE_BYTES` of title fit under `PATH_LIMIT`
/// for the plainest name (no number, no channel). Past that the folder itself is the problem
///: `output_template` keeps its floor and the download may fail.
pub fn too_deep_for_titles(temp_dir: &Path) -> bool {
    let used = temp_dir.to_string_lossy().encode_utf16().count() + 1;
    used + NAME_RESERVE + MIN_TITLE_BYTES > PATH_LIMIT
}

/// yt-dlp's `-o` for `template`, with the title cut so that the longest path it will write
/// (`temp_dir` + name + `.f401.webm.part`) stays under `PATH_LIMIT`. `.NB` keeps at most N
/// UTF-8 bytes and never splits a character (checked with yt-dlp 2026.08.19 on a CJK title).
/// Bytes, not characters: three per CJK character is more than the UTF-16 unit Windows
/// counts, so it only errs on the short side. `--trim-filenames` was discarded: it cuts the
/// whole name, `[id]` included. Up to 150 bytes with the default folder; the deeper the folder,
/// the shorter, down to a floor of 20 (past that the folder itself is the problem).
// Known limit: the Windows limit applies on every system (255 bytes per name is all Linux and
// macOS need); it only shortens titles in folders over ~100 characters there.
pub fn output_template(
    template: NameTemplate,
    temp_dir: &Path,
    home: &Path,
    position: Option<PlaylistPosition>,
) -> String {
    // Plain digits and " - ": nothing yt-dlp would read as a template field.
    let number = position.map(PlaylistPosition::prefix).unwrap_or_default();
    // The longest path is the intermediate file in `temp_dir` or the final one in `home`, which
    // is deeper when it has a subfolder.
    let units = |dir: &Path| dir.to_string_lossy().encode_utf16().count();
    let used = units(temp_dir).max(units(home)) + 1 + number.len(); // + the separator
    let channel = match template {
        NameTemplate::ChannelTitle => CHANNEL_BYTES + " - ".len(),
        _ => 0,
    };
    let title = PATH_LIMIT
        .saturating_sub(used + NAME_RESERVE + channel)
        .clamp(MIN_TITLE_BYTES, MAX_TITLE_BYTES);
    let name = match template {
        NameTemplate::Title => format!("%(title).{title}B.%(ext)s"),
        NameTemplate::TitleId => format!("%(title).{title}B [%(id)s].%(ext)s"),
        // `channel` is missing on SoundCloud and Reddit; `uploader` is what they have, and
        // `Unknown` covers sources with neither (a plain file URL). Checked with yt-dlp.
        NameTemplate::ChannelTitle => {
            format!("%(channel,uploader|Unknown).{CHANNEL_BYTES}B - %(title).{title}B.%(ext)s")
        }
    };
    format!("{number}{name}")
}

/// Fragments fetched at once inside ONE download (only HLS/DASH sources are fragmented; a plain
/// file ignores it). Measured on SoundCloud: 3.2 s -> 2.7 s with 4, no gain with 8. Four on top
/// of the queue's 3 downloads is at most 12 connections, which sites tolerate.
///
/// With a speed limit it is 1 instead: `--limit-rate` is per fragment connection, so 4 at once
/// went through a 300 KB/s limit at ~650 KB/s (measured with yt-dlp 2026.08.19).
const CONCURRENT_FRAGMENTS: &str = "4";

/// Seconds yt-dlp waits between its requests while it extracts a video, so a long playlist does
/// not hammer the site and trigger rate limiting. Measured on YouTube: +1.2 s per download with
/// 0.5 (+2.1 s with 1). Each download is its own yt-dlp process, so this spaces the requests of
/// one extraction, not the start of the next video.
// Known limit: fixed for now; a user setting would sit with the download limits.
const SLEEP_REQUESTS: &str = "0.5";

/// Every yt-dlp argument for `request`: the final file, named by `template`, goes to
/// `out_dir` (in the request's subfolder, if it has one), everything in between (`.part`, `.f*` streams, `.temp.*`, covers) to `temp_dir`,
/// and the sidecars are in `bin_dir`.
pub fn args(
    request: &DownloadRequest,
    template: NameTemplate,
    out_dir: &Path,
    temp_dir: &Path,
    bin_dir: &Path,
    tuning: Tuning,
) -> Result<Vec<String>, AppError> {
    check_url(&request.url)?;
    let home = match request.folder.as_deref().and_then(folder_name) {
        Some(folder) => out_dir.join(folder),
        None => out_dir.to_path_buf(),
    };
    let mut args: Vec<String> = vec![
        "--newline".into(),
        "--no-playlist".into(),
        // Piped to us, yt-dlp writes in the Windows code page (cp1252), not UTF-8, and drops
        // what it cannot encode (CJK). Our line reader expects UTF-8, so an accented title came
        // back with U+FFFD in it and a Japanese one without its letters: the final path read
        // from `--print` pointed at no file, and "Open folder" fell back to the bare folder
        //. Needs to be first-class, not left to the system.
        "--encoding".into(),
        "utf-8".into(),
        // `--print` implies `--quiet`, which would also silence the progress template:
        // `--progress` brings it back. Errors and warnings still go to stderr.
        "--progress".into(),
        "--print".into(),
        progress::PRINT_FILE.into(),
        // One JSON object per progress update: never parse the free-text progress bar.
        "--progress-template".into(),
        progress::TEMPLATE.into(),
        "--ffmpeg-location".into(),
        bin_dir.to_string_lossy().into_owned(),
        "--js-runtimes".into(),
        js_runtime(bin_dir),
        "--concurrent-fragments".into(),
        if tuning.limit_rate_kbps.is_some() {
            "1"
        } else {
            CONCURRENT_FRAGMENTS
        }
        .into(),
        "--sleep-requests".into(),
        SLEEP_REQUESTS.into(),
        // The folders go in `-P`, and `-o` stays relative: with an absolute `-o`, yt-dlp
        // ignores `temp:` and writes everything next to the final file (checked).
        "-P".into(),
        format!("home:{}", home.to_string_lossy()),
        "-P".into(),
        format!("temp:{}", temp_dir.to_string_lossy()),
        "-o".into(),
        output_template(template, temp_dir, &home, request.playlist),
    ];
    // A site's title becomes a file name. yt-dlp already turns separators and the characters
    // Windows forbids into look-alikes (checked), but leaves a title that is a Windows
    // device name (`CON`, `NUL.txt`) and direction overrides. Both are fixed in the title itself,
    // so the file name and the embedded tag agree; ordinary titles never match.
    for (pattern, replacement) in [(DEVICE_TITLE, r"_\g<0>"), (DIRECTION_CONTROLS, "")] {
        args.extend(["--replace-in-metadata", "title", pattern, replacement].map(String::from));
    }
    match request.mode {
        Mode::Video {
            max_height,
            container,
        } => {
            // Sorting instead of a `[height<=H]` filter: the filter fails outright when no
            // format is that small, while `res:H` takes the closest one. Resolution comes
            // first, so the container never lowers the quality; it only picks between
            // streams of the same height (mp4: AV1/H.264 + AAC, webm: VP9 + Opus).
            let sort = match container {
                Some(container) => container.sort(max_height),
                None => Container::Mkv.sort(max_height),
            };
            args.extend(["-f".into(), "bv*+ba/b".into(), "-S".into(), sort]);
            if let Some(container) = container {
                // Merge (two streams) or remux (one file) into it; both are `-c copy`.
                let (merge, remux) = container.flags();
                args.extend([
                    "--merge-output-format".into(),
                    merge.into(),
                    "--remux-video".into(),
                    remux.into(),
                ]);
            }
            // Embedded in mp4 (as mov_text), mkv (SubRip or WebVTT) and webm (WebVTT): yt-dlp
            // converts what each container needs, so there is no `--convert-subs`.
            if let Some(subtitles) = &request.subtitles {
                args.extend(subtitles.args()?);
            }
        }
        Mode::Audio {
            format,
            bitrate_kbps,
        } => {
            // `-x` even for Best: with `--audio-format best` it moves the original stream
            // (same packets) to its own container, `.opus` instead of `.webm`, where the
            // cover can be embedded; a `.webm` makes `--embed-thumbnail` fail.
            args.extend([
                "-f".into(),
                "ba/b".into(),
                "-x".into(),
                "--audio-format".into(),
                format.as_str().into(),
                "--embed-metadata".into(),
            ]);
            // WAV cannot hold a cover: `--embed-thumbnail` makes the whole download fail.
            if format != AudioFormat::Wav {
                args.push("--embed-thumbnail".into());
            }
            let lossy = matches!(
                format,
                AudioFormat::Mp3 | AudioFormat::M4a | AudioFormat::Opus
            );
            if let (true, Some(kbps)) = (lossy, bitrate_kbps) {
                args.extend(["--audio-quality".into(), format!("{kbps}K")]);
            }
            // The track tag: a literal on the left of `--parse-metadata` becomes the field on the
            // right (checked with yt-dlp 2026.08.19: `track=7` in the mp3 and the opus).
            if let Some(position) = request.playlist {
                args.extend([
                    "--parse-metadata".into(),
                    format!("{}:%(track_number)s", position.index),
                ]);
            }
        }
    }
    // The speed limit and the browser cookies the user chose.
    tuning.extend(&mut args);
    // Ends yt-dlp's options: whatever follows is a URL, never an option.
    args.extend(["--".into(), request.url.clone()]);
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;

    const URL: &str = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";

    fn video(max_height: Option<u32>, container: Option<Container>) -> Vec<String> {
        build(Mode::Video {
            max_height,
            container,
        })
    }

    fn audio(format: AudioFormat, bitrate_kbps: Option<u32>) -> Vec<String> {
        build(Mode::Audio {
            format,
            bitrate_kbps,
        })
    }

    fn build(mode: Mode) -> Vec<String> {
        let request = DownloadRequest {
            url: URL.into(),
            mode,
            playlist: None,
            folder: None,
            subtitles: None,
        };
        args(
            &request,
            NameTemplate::default(),
            Path::new("out"),
            Path::new("tmp"),
            Path::new("bin"),
            Tuning::default(),
        )
        .unwrap()
    }

    /// The value after `flag`, if the flag is there.
    fn value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        let i = args.iter().position(|a| a == flag)?;
        args.get(i + 1).map(String::as_str)
    }

    fn all_modes() -> Vec<Vec<String>> {
        let mut all = vec![video(None, None), video(Some(720), None)];
        for c in [
            Container::Mp4,
            Container::Mp4Compatible,
            Container::Mkv,
            Container::Webm,
        ] {
            all.push(video(None, Some(c)));
            all.push(video(Some(1080), Some(c)));
        }
        for f in [
            AudioFormat::Best,
            AudioFormat::Mp3,
            AudioFormat::M4a,
            AudioFormat::Opus,
            AudioFormat::Flac,
            AudioFormat::Wav,
        ] {
            all.push(audio(f, None));
            all.push(audio(f, Some(192)));
        }
        all
    }

    #[test]
    fn video_without_limit_sorts_by_resolution_only() {
        let args = video(None, None);
        assert_eq!(value(&args, "-f"), Some("bv*+ba/b"));
        assert_eq!(value(&args, "-S"), Some("res"));
        assert_eq!(value(&args, "--merge-output-format"), None);
        assert_eq!(value(&args, "--remux-video"), None);
    }

    #[test]
    fn video_height_limit_is_a_sort_not_a_filter() {
        let args = video(Some(1080), None);
        assert_eq!(value(&args, "-f"), Some("bv*+ba/b"));
        assert_eq!(value(&args, "-S"), Some("res:1080"));
    }

    #[test]
    fn each_container_merges_and_remuxes_into_itself() {
        for (container, sort, merge, remux) in [
            (Container::Mp4, "res:720,ext:mp4:m4a", "mp4", "mp4"),
            (
                Container::Mp4Compatible,
                "vcodec:h264,res:720,acodec:aac",
                "mp4",
                "mp4",
            ),
            (Container::Mkv, "res:720", "mkv", "mkv"),
            (
                Container::Webm,
                "res:720,ext:webm:webm",
                "webm/mkv",
                "mkv>mkv/mp4>mkv/webm",
            ),
        ] {
            let args = video(Some(720), Some(container));
            assert_eq!(value(&args, "-S"), Some(sort));
            assert_eq!(value(&args, "--merge-output-format"), Some(merge));
            assert_eq!(value(&args, "--remux-video"), Some(remux));
        }
        assert_eq!(
            value(&video(None, Some(Container::Mp4Compatible)), "-S"),
            Some("vcodec:h264,res,acodec:aac")
        );
        assert_eq!(
            value(&video(None, Some(Container::Mp4)), "-S"),
            Some("res,ext:mp4:m4a")
        );
    }

    #[test]
    fn audio_best_extracts_without_converting() {
        let args = audio(AudioFormat::Best, Some(320));
        assert_eq!(value(&args, "-f"), Some("ba/b"));
        assert!(args.contains(&"-x".to_string()));
        assert_eq!(value(&args, "--audio-format"), Some("best"));
        // Nothing is re-encoded, so a bitrate makes no sense.
        assert_eq!(value(&args, "--audio-quality"), None);
    }

    #[test]
    fn each_audio_conversion() {
        for (format, name, lossy) in [
            (AudioFormat::Mp3, "mp3", true),
            (AudioFormat::M4a, "m4a", true),
            (AudioFormat::Opus, "opus", true),
            (AudioFormat::Flac, "flac", false),
            (AudioFormat::Wav, "wav", false),
        ] {
            let args = audio(format, Some(192));
            assert_eq!(value(&args, "--audio-format"), Some(name));
            let quality = lossy.then_some("192K");
            assert_eq!(value(&args, "--audio-quality"), quality, "{name}");
            assert_eq!(value(&audio(format, None), "--audio-quality"), None);
        }
    }

    #[test]
    fn audio_always_embeds_metadata_and_cover_except_cover_in_wav() {
        for f in [
            AudioFormat::Best,
            AudioFormat::Mp3,
            AudioFormat::M4a,
            AudioFormat::Opus,
            AudioFormat::Flac,
        ] {
            let args = audio(f, None);
            assert!(args.contains(&"--embed-metadata".to_string()));
            assert!(args.contains(&"--embed-thumbnail".to_string()));
        }
        let wav = audio(AudioFormat::Wav, None);
        assert!(wav.contains(&"--embed-metadata".to_string()));
        assert!(!wav.contains(&"--embed-thumbnail".to_string()));
    }

    #[test]
    fn every_mode_ends_with_double_dash_and_the_url_and_keeps_progress() {
        for args in all_modes() {
            assert_eq!(args[args.len() - 2..], ["--", URL]);
            assert_eq!(
                value(&args, "--progress-template"),
                Some(progress::TEMPLATE)
            );
            assert!(value(&args, "--js-runtimes").is_some_and(|v| v.starts_with("deno:")));
            assert!(args.contains(&"--newline".to_string()));
            // Output in UTF-8, or a title with accents breaks the printed path.
            assert_eq!(value(&args, "--encoding"), Some("utf-8"));
            // The final path is printed, and progress stays on despite `--print`'s quiet.
            assert_eq!(value(&args, "--print"), Some(progress::PRINT_FILE));
            assert!(args.contains(&"--progress".to_string()));
        }
    }

    #[test]
    fn every_mode_limits_fragments_and_spaces_requests() {
        for args in all_modes() {
            assert_eq!(value(&args, "--concurrent-fragments"), Some("4"));
            assert_eq!(value(&args, "--sleep-requests"), Some("0.5"));
        }
    }

    #[test]
    fn every_mode_fixes_device_names_and_direction_controls_in_the_title() {
        for args in all_modes() {
            let fixes: Vec<&[String]> = args
                .windows(4)
                .filter(|w| w[0] == "--replace-in-metadata")
                .collect();
            assert_eq!(fixes.len(), 2, "{args:?}");
            assert_eq!(
                fixes[0],
                ["--replace-in-metadata", "title", DEVICE_TITLE, r"_\g<0>"]
            );
            assert_eq!(
                fixes[1],
                ["--replace-in-metadata", "title", DIRECTION_CONTROLS, ""]
            );
        }
    }

    #[test]
    fn a_speed_limit_and_cookies_are_passed_and_a_limit_turns_fragments_off() {
        let run = |tuning| {
            args(
                &DownloadRequest {
                    url: URL.into(),
                    mode: Mode::Audio {
                        format: AudioFormat::Best,
                        bitrate_kbps: None,
                    },
                    playlist: None,
                    folder: None,
                    subtitles: None,
                },
                NameTemplate::default(),
                Path::new("out"),
                Path::new("tmp"),
                Path::new("bin"),
                tuning,
            )
            .unwrap()
        };
        let plain = run(Tuning::default());
        assert_eq!(value(&plain, "--concurrent-fragments"), Some("4"));
        assert_eq!(value(&plain, "--limit-rate"), None);
        assert_eq!(value(&plain, "--cookies-from-browser"), None);
        let tuned = run(Tuning {
            limit_rate_kbps: Some(500),
            cookies: Some(crate::ytdlp::Cookies::Browser(
                crate::ytdlp::Browser::Firefox,
            )),
        });
        assert_eq!(value(&tuned, "--concurrent-fragments"), Some("1"));
        assert_eq!(value(&tuned, "--limit-rate"), Some("500K"));
        assert_eq!(value(&tuned, "--cookies-from-browser"), Some("firefox"));
        // The same with a cookies file: `--cookies` and its own path.
        let with_file = run(Tuning {
            limit_rate_kbps: None,
            cookies: Some(crate::ytdlp::Cookies::File(
                "/data/cookies-run/run-1-0.txt".into(),
            )),
        });
        assert_eq!(
            value(&with_file, "--cookies"),
            Some("/data/cookies-run/run-1-0.txt")
        );
        assert_eq!(value(&with_file, "--cookies-from-browser"), None);
        assert_eq!(with_file[with_file.len() - 2..], ["--", URL]);
        // Still ends with `--` and the URL: the options come before it.
        assert_eq!(tuned[tuned.len() - 2..], ["--", URL]);
    }

    #[test]
    fn final_file_and_temporary_files_go_to_their_folders() {
        for args in all_modes() {
            let paths: Vec<&str> = args
                .iter()
                .enumerate()
                .filter(|(_, arg)| *arg == "-P")
                .map(|(i, _)| args[i + 1].as_str())
                .collect();
            assert_eq!(paths, ["home:out", "temp:tmp"]);
            // Relative, or yt-dlp would ignore `temp:`.
            assert_eq!(value(&args, "-o"), Some("%(title).150B [%(id)s].%(ext)s"));
        }
    }

    fn named(template: NameTemplate, temp_dir: &str) -> String {
        output_template(template, Path::new(temp_dir), Path::new("out"), None)
    }

    const ALL_TEMPLATES: [NameTemplate; 3] = [
        NameTemplate::Title,
        NameTemplate::TitleId,
        NameTemplate::ChannelTitle,
    ];

    #[test]
    fn each_name_template_has_its_own_shape() {
        assert_eq!(named(NameTemplate::Title, "tmp"), "%(title).150B.%(ext)s");
        assert_eq!(
            named(NameTemplate::TitleId, "tmp"),
            "%(title).150B [%(id)s].%(ext)s"
        );
        // 40 bytes of channel (or uploader, or "Unknown"), and the title has less room.
        assert_eq!(
            named(NameTemplate::ChannelTitle, "tmp"),
            "%(channel,uploader|Unknown).40B - %(title).150B.%(ext)s"
        );
    }

    fn at(index: u32, count: u32) -> Option<PlaylistPosition> {
        Some(PlaylistPosition { index, count })
    }

    #[test]
    fn a_playlist_position_numbers_the_file_with_enough_digits() {
        let named = |p| output_template(NameTemplate::Title, Path::new("tmp"), Path::new("out"), p);
        // At least two digits; three once the playlist has 100 or more, so 9, 10 and 100 sort.
        assert_eq!(named(at(7, 24)), "07 - %(title).150B.%(ext)s");
        assert_eq!(named(at(7, 100)), "007 - %(title).150B.%(ext)s");
        assert_eq!(named(at(1234, 2000)), "1234 - %(title).150B.%(ext)s");
        // Whatever the frontend sends, the prefix is only digits and " - ".
        assert!(named(at(u32::MAX, u32::MAX)).starts_with("4294967295 - %(title)"));
        // The prefix takes room from the title, like the folder does: 260 - 151 - 48 = 61 bytes
        // without it, 5 fewer with "07 - ".
        let deep = "x".repeat(150);
        let title = |p| output_template(NameTemplate::Title, Path::new(&deep), Path::new("out"), p);
        assert_eq!(title(None), "%(title).61B.%(ext)s");
        assert_eq!(title(at(7, 24)), "07 - %(title).56B.%(ext)s");
    }

    #[test]
    fn audio_in_a_playlist_gets_the_number_in_the_name_and_the_track_tag() {
        let request = |mode, playlist| DownloadRequest {
            url: URL.into(),
            mode,
            playlist,
            folder: None,
            subtitles: None,
        };
        let audio = Mode::Audio {
            format: AudioFormat::Mp3,
            bitrate_kbps: None,
        };
        let run = |r: &DownloadRequest| {
            args(
                r,
                NameTemplate::Title,
                Path::new("out"),
                Path::new("tmp"),
                Path::new("bin"),
                Tuning::default(),
            )
            .unwrap()
        };
        let numbered = run(&request(audio.clone(), at(7, 24)));
        assert!(value(&numbered, "-o").unwrap().starts_with("07 - %(title)"));
        assert_eq!(
            value(&numbered, "--parse-metadata"),
            Some("7:%(track_number)s")
        );
        // Without a position nothing changes.
        let plain = run(&request(audio, None));
        assert!(value(&plain, "-o").unwrap().starts_with("%(title)"));
        assert!(!plain.contains(&"--parse-metadata".to_string()));
        // Video: only the name gets the number, there is no track tag.
        let video = run(&request(
            Mode::Video {
                max_height: None,
                container: None,
            },
            at(3, 5),
        ));
        assert!(value(&video, "-o").unwrap().starts_with("03 - "));
        assert!(!video.contains(&"--parse-metadata".to_string()));
    }

    #[test]
    fn folder_names_are_safe_on_every_system() {
        let cases = [
            ("My Playlist", Some("My Playlist")),
            ("  Rock & Roll  ", Some("Rock & Roll")),
            // Nothing can climb out of the output folder or name a path.
            ("../../Windows", Some("_.._Windows")),
            ("..", None),
            (".", None),
            (r"a/b\c", Some("a_b_c")),
            (r"C:\Users", Some("C__Users")),
            (
                "AC/DC: <Live> \"Best\" | ?*",
                Some("AC_DC_ _Live_ _Best_ _ __"),
            ),
            (".hidden", Some("hidden")),
            ("name. . ", Some("name")),
            ("tab\there\nnewline", Some("tab_here_newline")),
            ("", None),
            ("   ", None),
            ("???", Some("___")),
            // Windows device names, with or without an extension, in any case.
            ("CON", Some("_CON")),
            ("nul", Some("_nul")),
            ("Com1.txt", Some("_Com1.txt")),
            ("CONSOLE", Some("CONSOLE")),
            ("Mix 2024", Some("Mix 2024")),
            // Accents, CJK and emoji stay.
            ("Música ñandú 万聖街 🎵", Some("Música ñandú 万聖街 🎵")),
        ];
        for (raw, expected) in cases {
            assert_eq!(folder_name(raw).as_deref(), expected, "{raw:?}");
        }
    }

    #[test]
    fn a_long_folder_name_is_cut_without_splitting_a_character() {
        let ascii = folder_name(&"a".repeat(200)).unwrap();
        assert_eq!(ascii.len(), MAX_FOLDER_UNITS);
        // CJK: one UTF-16 unit each; emoji take two, so fewer fit.
        let cjk = folder_name(&"万".repeat(200)).unwrap();
        assert_eq!(cjk.chars().count(), MAX_FOLDER_UNITS);
        let emoji = folder_name(&"🎵".repeat(200)).unwrap();
        assert_eq!(emoji.chars().count(), MAX_FOLDER_UNITS / 2);
        // A cut that lands after a space or dot leaves none at the end.
        let name = format!("{} {}", "a".repeat(MAX_FOLDER_UNITS - 1), "b");
        assert_eq!(
            folder_name(&name).unwrap(),
            "a".repeat(MAX_FOLDER_UNITS - 1)
        );
    }

    #[test]
    fn the_subfolder_goes_in_the_home_path_and_takes_room_from_the_title() {
        let request = |folder: Option<&str>| DownloadRequest {
            url: URL.into(),
            mode: Mode::Video {
                max_height: None,
                container: None,
            },
            playlist: None,
            folder: folder.map(String::from),
            subtitles: None,
        };
        let run = |r: &DownloadRequest| {
            args(
                r,
                NameTemplate::Title,
                Path::new("out"),
                Path::new("out/.albaro-tmp/1"),
                Path::new("bin"),
                Tuning::default(),
            )
            .unwrap()
        };
        let home = |a: &[String]| value(a, "-P").unwrap().to_string();
        assert_eq!(home(&run(&request(None))), "home:out");
        let with = run(&request(Some("My list")));
        assert_eq!(
            home(&with),
            format!("home:{}", Path::new("out").join("My list").display())
        );
        // An unusable name is no folder at all.
        assert_eq!(home(&run(&request(Some("..")))), "home:out");
        // The temporary folder stays where it was.
        assert_eq!(value(&with, "-P"), Some(home(&with).as_str()));
        assert!(with.contains(&"temp:out/.albaro-tmp/1".to_string()));
        // A folder deeper than the temporary one shortens the title.
        let long = "x".repeat(MAX_FOLDER_UNITS);
        let deep = run(&request(Some(&long)));
        let shallow = run(&request(Some("a")));
        let bytes = |a: &[String]| {
            let o = value(a, "-o").unwrap();
            o.split(".")
                .nth(1)
                .unwrap()
                .trim_end_matches('B')
                .parse::<usize>()
                .unwrap()
        };
        assert!(bytes(&deep) <= bytes(&shallow));
    }

    #[test]
    fn the_folder_is_optional_and_left_out_of_the_stored_json() {
        let json = r#"{"url": "https://e.com/v", "mode": {"kind": "audio", "format": "best", "bitrateKbps": null}}"#;
        let old: DownloadRequest = serde_json::from_str(json).unwrap();
        assert_eq!(old.folder, None);
        let text = serde_json::to_string(&old).unwrap();
        assert!(!text.contains("folder"), "{text}");
        let with = DownloadRequest {
            folder: Some("Mi lista".into()),
            subtitles: None,
            ..old
        };
        let text = serde_json::to_string(&with).unwrap();
        assert!(text.ends_with(r#","folder":"Mi lista"}"#), "{text}");
        assert_eq!(
            serde_json::from_str::<DownloadRequest>(&text).unwrap(),
            with
        );
    }

    fn with_subtitles(mode: Mode, subtitles: Option<Subtitles>) -> Result<Vec<String>, AppError> {
        args(
            &DownloadRequest {
                url: URL.into(),
                mode,
                playlist: None,
                folder: None,
                subtitles,
            },
            NameTemplate::default(),
            Path::new("out"),
            Path::new("tmp"),
            Path::new("bin"),
            Tuning::default(),
        )
    }

    fn mp4_mode() -> Mode {
        Mode::Video {
            max_height: None,
            container: Some(Container::Mp4),
        }
    }

    fn subs(langs: &[&str], auto: bool) -> Option<Subtitles> {
        Some(Subtitles {
            langs: langs.iter().map(|l| l.to_string()).collect(),
            auto,
        })
    }

    #[test]
    fn subtitles_are_embedded_and_the_files_are_not_kept() {
        let args = with_subtitles(mp4_mode(), subs(&["es", "pt-BR"], false)).unwrap();
        assert_eq!(value(&args, "--sub-langs"), Some("es,pt-BR"));
        assert!(args.contains(&"--embed-subs".to_string()));
        assert!(!args.contains(&"--write-auto-subs".to_string()));
        // With `--write-subs` yt-dlp keeps the `.vtt` files after embedding them.
        assert!(!args.contains(&"--write-subs".to_string()));
        // Still ends with `--` and the URL.
        assert_eq!(args[args.len() - 2..], ["--", URL]);
    }

    #[test]
    fn automatic_captions_are_only_asked_for_when_allowed() {
        let args = with_subtitles(mp4_mode(), subs(&["en"], true)).unwrap();
        assert!(args.contains(&"--write-auto-subs".to_string()));
    }

    #[test]
    fn no_subtitles_no_arguments_whatever_the_container() {
        for container in [
            None,
            Some(Container::Mp4),
            Some(Container::Mp4Compatible),
            Some(Container::Mkv),
            Some(Container::Webm),
        ] {
            let mode = Mode::Video {
                max_height: None,
                container,
            };
            for request in [None, subs(&[], true)] {
                let args = with_subtitles(mode.clone(), request).unwrap();
                for flag in ["--sub-langs", "--embed-subs", "--write-auto-subs"] {
                    assert!(!args.contains(&flag.to_string()), "{flag}");
                }
            }
            let with = with_subtitles(mode, subs(&["en"], false)).unwrap();
            assert!(with.contains(&"--embed-subs".to_string()));
        }
    }

    #[test]
    fn audio_ignores_subtitles() {
        let audio = Mode::Audio {
            format: AudioFormat::Mp3,
            bitrate_kbps: None,
        };
        let args = with_subtitles(audio, subs(&["en"], true)).unwrap();
        for flag in ["--sub-langs", "--embed-subs", "--write-auto-subs"] {
            assert!(!args.contains(&flag.to_string()), "{flag}");
        }
    }

    #[test]
    fn only_plain_language_codes_reach_yt_dlp() {
        for good in ["es", "en", "pt-BR", "zh-Hans", "es-419", "en-orig", "a"] {
            assert!(is_language_code(good), "{good}");
        }
        // yt-dlp reads `--sub-langs` as comma-separated regexes: `-x` excludes, `all` is every
        // language, `.*` matches many, `,` splits.
        let too_long = "a".repeat(25);
        for bad in [
            "", "all", "ALL", "-es", "en.*", "en,fr", "es ", " es", "e s", "ñ", "es/en", "^en$",
            "en;rm", &too_long,
        ] {
            assert!(!is_language_code(bad), "{bad:?}");
            let refused = with_subtitles(mp4_mode(), subs(&["es", bad], false));
            assert!(matches!(refused, Err(AppError::Unknown(_))), "{bad:?}");
        }
    }

    #[test]
    fn too_many_languages_are_refused() {
        let many: Vec<String> = (0..21).map(|n| format!("l{n}")).collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();
        assert!(with_subtitles(mp4_mode(), subs(&refs[..20], false)).is_ok());
        assert!(matches!(
            with_subtitles(mp4_mode(), subs(&refs, false)),
            Err(AppError::Unknown(_))
        ));
    }

    #[test]
    fn subtitles_are_optional_and_left_out_of_the_stored_json() {
        let json = r#"{"url": "https://e.com/v", "mode": {"kind": "video", "maxHeight": null, "container": null}}"#;
        let old: DownloadRequest = serde_json::from_str(json).unwrap();
        assert_eq!(old.subtitles, None);
        assert!(!serde_json::to_string(&old).unwrap().contains("subtitles"));
        let with = DownloadRequest {
            subtitles: subs(&["es", "en"], true),
            ..old
        };
        let text = serde_json::to_string(&with).unwrap();
        assert!(
            text.ends_with(r#","subtitles":{"langs":["es","en"],"auto":true}}"#),
            "{text}"
        );
        assert_eq!(
            serde_json::from_str::<DownloadRequest>(&text).unwrap(),
            with
        );
    }

    #[test]
    fn the_position_is_optional_and_left_out_of_the_stored_json() {
        let json = r#"{"url": "https://e.com/v", "mode": {"kind": "audio", "format": "best", "bitrateKbps": null}}"#;
        let old: DownloadRequest = serde_json::from_str(json).unwrap();
        assert_eq!(old.playlist, None);
        // Serializes as it did before 4.2: the duplicate check compares this text.
        assert_eq!(
            serde_json::to_string(&old).unwrap(),
            r#"{"url":"https://e.com/v","mode":{"kind":"audio","format":"best","bitrateKbps":null}}"#
        );
        let numbered = DownloadRequest {
            playlist: at(2, 9),
            ..old
        };
        let text = serde_json::to_string(&numbered).unwrap();
        assert!(text.ends_with(r#","playlist":{"index":2,"count":9}}"#));
        assert_eq!(
            serde_json::from_str::<DownloadRequest>(&text).unwrap(),
            numbered
        );
    }

    #[test]
    fn the_name_template_reaches_the_dash_o_argument() {
        let request = DownloadRequest {
            url: URL.into(),
            mode: Mode::Audio {
                format: AudioFormat::Best,
                bitrate_kbps: None,
            },
            playlist: None,
            folder: None,
            subtitles: None,
        };
        for template in ALL_TEMPLATES {
            let args = args(
                &request,
                template,
                Path::new("out"),
                Path::new("tmp"),
                Path::new("bin"),
                Tuning::default(),
            )
            .unwrap();
            assert_eq!(value(&args, "-o"), Some(named(template, "tmp").as_str()));
        }
    }

    /// The title's byte limit in `-o` (`%(title).NB`).
    fn title_bytes(template: &str) -> usize {
        let after = template.split("%(title).").nth(1).unwrap();
        after[..after.find('B').unwrap()].parse().unwrap()
    }

    #[test]
    fn a_deeper_folder_gets_a_shorter_title_and_the_path_stays_under_the_limit() {
        for template in ALL_TEMPLATES {
            let mut last = usize::MAX;
            for depth in [0, 40, 100, 140, 180] {
                let temp = format!("{}\\.albaro-tmp\\123", "d".repeat(depth));
                let limit = title_bytes(&named(template, &temp));
                assert!(limit <= last, "{template:?} at {depth}: {limit} > {last}");
                last = limit;
                // Wherever the floor allows it, folder + title + channel + reserve fits.
                let channel = if template == NameTemplate::ChannelTitle {
                    CHANNEL_BYTES + 3
                } else {
                    0
                };
                if limit > MIN_TITLE_BYTES {
                    let total = temp.len() + 1 + limit + channel + NAME_RESERVE;
                    assert!(total <= PATH_LIMIT, "{template:?} at {depth}: {total}");
                }
            }
            // Never shorter than the floor, however deep, nor longer than the ceiling.
            let huge = "d".repeat(600);
            assert_eq!(title_bytes(&named(template, &huge)), MIN_TITLE_BYTES);
            assert_eq!(title_bytes(&named(template, "t")), MAX_TITLE_BYTES);
        }
    }

    #[test]
    fn the_path_is_measured_in_utf16_units_not_bytes() {
        // 100 CJK characters: 300 bytes but only 100 UTF-16 units, which is what Windows counts.
        let cjk = "漢".repeat(100);
        let ascii = "a".repeat(100);
        assert_eq!(
            named(NameTemplate::Title, &cjk),
            named(NameTemplate::Title, &ascii)
        );
    }

    #[test]
    fn name_templates_round_trip_and_unknown_text_is_refused() {
        for t in ALL_TEMPLATES {
            assert_eq!(NameTemplate::parse(t.as_str()), Some(t));
            // The settings text is also the JSON the frontend sends.
            assert_eq!(
                serde_json::to_string(&t).unwrap(),
                format!("\"{}\"", t.as_str())
            );
        }
        for bad in ["", "Title", "title_id", "%(title)s", "channel"] {
            assert_eq!(NameTemplate::parse(bad), None, "{bad}");
            assert!(serde_json::from_str::<NameTemplate>(&format!("\"{bad}\"")).is_err());
        }
        assert_eq!(NameTemplate::default(), NameTemplate::TitleId);
    }

    #[test]
    fn video_is_never_re_encoded() {
        for args in all_modes() {
            for banned in [
                "--recode-video",
                "--postprocessor-args",
                "--ppa",
                "-c",
                "-c:v",
            ] {
                assert!(!args.contains(&banned.to_string()), "{banned} in {args:?}");
            }
        }
    }

    #[test]
    fn invalid_url_is_rejected() {
        let request = DownloadRequest {
            url: "--exec=calc.exe".into(),
            mode: Mode::Video {
                max_height: None,
                container: None,
            },
            playlist: None,
            folder: None,
            subtitles: None,
        };
        let result = args(
            &request,
            NameTemplate::default(),
            Path::new("out"),
            Path::new("tmp"),
            Path::new("bin"),
            Tuning::default(),
        );
        assert!(matches!(result, Err(AppError::InvalidUrl(_))));
    }

    #[test]
    fn request_reads_the_frontend_json() {
        let video: DownloadRequest = serde_json::from_str(
            r#"{"url": "https://e.com/v", "mode": {"kind": "video", "maxHeight": 1080, "container": "mp4"}}"#,
        )
        .unwrap();
        assert_eq!(
            video.mode,
            Mode::Video {
                max_height: Some(1080),
                container: Some(Container::Mp4)
            }
        );
        let audio: DownloadRequest = serde_json::from_str(
            r#"{"url": "https://e.com/v", "mode": {"kind": "audio", "format": "best"}}"#,
        )
        .unwrap();
        assert_eq!(
            audio.mode,
            Mode::Audio {
                format: AudioFormat::Best,
                bitrate_kbps: None
            }
        );
        // The compatible mp4 is its own name in JSON; rows saved before it existed still load.
        let compat: DownloadRequest = serde_json::from_str(
            r#"{"url": "https://e.com/v", "mode": {"kind": "video", "maxHeight": null, "container": "mp4Compatible"}}"#,
        )
        .unwrap();
        assert_eq!(
            compat.mode,
            Mode::Video {
                max_height: None,
                container: Some(Container::Mp4Compatible)
            }
        );
        // Numbers must be numbers: text or negatives never reach an argument.
        for bad in [r#""1080""#, "-1", "1080.5"] {
            let json = format!(
                r#"{{"url": "https://e.com/v", "mode": {{"kind": "video", "maxHeight": {bad}}}}}"#
            );
            assert!(
                serde_json::from_str::<DownloadRequest>(&json).is_err(),
                "{bad}"
            );
        }
    }
}
