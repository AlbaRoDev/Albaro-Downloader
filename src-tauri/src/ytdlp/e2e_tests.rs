// End-to-end downloads with the real yt-dlp, FFmpeg and Deno. They need internet and
// take seconds, so they are ignored by `cargo test` and the CI. Run them by hand, in src-tauri:
//
//     cargo test -- --ignored --nocapture
//
// They use the app's own arguments (`formats::args`) and error classification (`classify`),
// and the sidecars from target/debug, where the build copies them without the target-triple
// suffix, just like next to the app executable. What they skip is the runner: it needs a real
// Tauri `AppHandle`, so here yt-dlp runs through `std::process` (the runner has its own unit
// tests and was checked in the app).
mod hostile;

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Instant,
};

use serde_json::Value;

use super::{
    classify,
    formats::{
        self, AudioFormat, Container, DownloadRequest, Mode, NameTemplate, PlaylistPosition,
        Subtitles,
    },
    progress, Cookies, Tuning,
};
use crate::{cookies::CookieCopy, db::DownloadState, errors::AppError, queue, test_util::TempDir};

const ZOO: &str = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const ZOO_TITLE: &str = "Me at the zoo";
/// A plain mp4 file (generic extractor, no account needed): H.264 + AAC, so it cannot go into a
/// webm. It replaced a Reddit video, which now asks for a login even with a bare yt-dlp.
const PLAIN_MP4: &str = "https://www.w3schools.com/html/mov_bbb.mp4";

/// target/debug: the test executable lives in target/debug/deps.
fn bin_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let dir = exe.parent().and_then(Path::parent).unwrap().to_path_buf();
    assert!(
        dir.join(exe_name("yt-dlp")).exists(),
        "no sidecars in {dir:?}: run `pnpm sidecars` and build first"
    );
    dir
}

fn exe_name(name: &str) -> String {
    format!("{name}{}", std::env::consts::EXE_SUFFIX)
}

fn request(url: &str, mode: Mode) -> DownloadRequest {
    DownloadRequest {
        url: url.into(),
        mode,
        playlist: None,
        folder: None,
        subtitles: None,
    }
}

/// Runs yt-dlp with `args`; a failure comes back classified, as in the app.
fn run(args: &[String]) -> Result<Vec<u8>, AppError> {
    let output = Command::new(bin_dir().join(exe_name("yt-dlp")))
        .args(args)
        .output()
        .unwrap();
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(classify::classify(&String::from_utf8_lossy(&output.stderr)))
    }
}

/// The id the e2e downloads use for their temporary folder.
const ID: i64 = 1;

fn args(request: &DownloadRequest, out: &Path) -> Vec<String> {
    args_named(request, NameTemplate::default(), out)
}

fn args_named(request: &DownloadRequest, template: NameTemplate, out: &Path) -> Vec<String> {
    formats::args(
        request,
        template,
        out,
        &queue::temp_dir(out, ID),
        &bin_dir(),
        Tuning::default(),
    )
    .unwrap()
}

/// Downloads like the app does, temporary folder and its cleanup included (`finished` removes
/// the empty folder, a failure deletes it), so callers can check what is left in `out`.
/// Returns the final path yt-dlp printed (`--print`), if it did.
fn download(request: &DownloadRequest, out: &Path) -> Result<Option<PathBuf>, AppError> {
    download_run(args(request, out), out)
}

/// `download` with another file name template.
fn download_named(
    request: &DownloadRequest,
    template: NameTemplate,
    out: &Path,
) -> Result<Option<PathBuf>, AppError> {
    download_run(args_named(request, template, out), out)
}

fn download_run(args: Vec<String>, out: &Path) -> Result<Option<PathBuf>, AppError> {
    let result = run(&args).map(|stdout| {
        String::from_utf8_lossy(&stdout)
            .lines()
            .filter_map(progress::parse_file)
            .next_back()
            .map(PathBuf::from)
    });
    let cleanup = match &result {
        Ok(_) => queue::cleanup_for(DownloadState::Finished, None),
        Err(error) => queue::cleanup_for(DownloadState::Failed, Some(error)),
    };
    queue::clean_temp(&queue::temp_dir(out, ID), ID, cleanup).unwrap();
    result
}

/// The `--print` line gives the very file left in the folder, also after a merge,
/// a remux or an audio extraction.
fn assert_printed(printed: Option<PathBuf>, file: &Path) {
    let printed = printed.expect("yt-dlp printed no [albaro-file] line");
    assert_eq!(
        fs::canonicalize(printed).unwrap(),
        fs::canonicalize(file).unwrap()
    );
}

/// The folder must hold just the final file: no `.part`, `.temp` or loose cover images.
fn only_file(dir: &Path) -> PathBuf {
    let files: Vec<PathBuf> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1, "expected only the final file: {files:?}");
    files[0].clone()
}

fn extension(file: &Path) -> &str {
    file.extension().and_then(|e| e.to_str()).unwrap_or("")
}

/// ffprobe's view of `file`: `format` and `streams`.
fn probe(file: &Path) -> Value {
    let output = Command::new(bin_dir().join(exe_name("ffprobe")))
        .args(["-v", "error", "-print_format", "json"])
        .args(["-show_format", "-show_streams"])
        .arg(file)
        .output()
        .unwrap();
    serde_json::from_slice(&output.stdout).unwrap()
}

fn streams<'a>(info: &'a Value, kind: &str) -> Vec<&'a Value> {
    info["streams"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["codec_type"] == kind)
        .collect()
}

/// The audio, leaving out the embedded cover (a one-picture "video" stream).
fn audio_codec(info: &Value) -> String {
    let audio = streams(info, "audio");
    assert_eq!(audio.len(), 1, "{info}");
    audio[0]["codec_name"].as_str().unwrap().to_string()
}

fn has_cover(info: &Value) -> bool {
    streams(info, "video")
        .iter()
        .any(|s| s["disposition"]["attached_pic"] == 1)
}

/// The title tag, wherever the container keeps it (format tags in mp3/m4a, stream tags in Ogg).
fn title(info: &Value) -> Option<String> {
    let mut tag_sets = vec![&info["format"]["tags"]];
    tag_sets.extend(
        info["streams"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| &s["tags"]),
    );
    tag_sets.into_iter().find_map(|tags| {
        tags.as_object()?
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("title"))
            .and_then(|(_, value)| value.as_str().map(String::from))
    })
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn video_mp4_with_a_height_limit() {
    let started = Instant::now();
    let dir = TempDir::new("video-mp4");
    let mode = Mode::Video {
        max_height: Some(360),
        container: Some(Container::Mp4),
    };
    let printed = download(&request(ZOO, mode), &dir.0).unwrap();

    let file = only_file(&dir.0);
    assert_printed(printed, &file);
    assert_eq!(extension(&file), "mp4");
    let info = probe(&file);
    assert!(info["format"]["format_name"]
        .as_str()
        .unwrap()
        .contains("mp4"));
    let video = streams(&info, "video");
    assert_eq!(video.len(), 1);
    assert!(
        ["av1", "h264"].contains(&video[0]["codec_name"].as_str().unwrap()),
        "{info}"
    );
    assert!(video[0]["height"].as_u64().unwrap() <= 360);
    assert_eq!(audio_codec(&info), "aac");
    let duration: f64 = info["format"]["duration"]
        .as_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((18.0..20.5).contains(&duration), "duration {duration}");
    eprintln!("video mp4 ≤360p: {:.1} s", started.elapsed().as_secs_f64());
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn video_compatible_mp4_is_h264_and_aac() {
    let started = Instant::now();
    let dir = TempDir::new("video-mp4-compatible");
    let mode = Mode::Video {
        max_height: None,
        container: Some(Container::Mp4Compatible),
    };
    download(&request(ZOO, mode), &dir.0).unwrap();

    let file = only_file(&dir.0);
    assert_eq!(extension(&file), "mp4");
    let info = probe(&file);
    let video = streams(&info, "video");
    assert_eq!(video.len(), 1);
    assert_eq!(video[0]["codec_name"], "h264", "{info}");
    assert_eq!(audio_codec(&info), "aac");
    eprintln!(
        "video compatible mp4: {:.1} s",
        started.elapsed().as_secs_f64()
    );
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn video_webm_from_an_h264_source_falls_back_to_mkv_and_leaves_nothing() {
    let started = Instant::now();
    let dir = TempDir::new("video-webm-fallback");
    let mode = Mode::Video {
        max_height: None,
        container: Some(Container::Webm),
    };
    // Used to fail with "Conversion failed!" and leave a broken .temp.webm.
    let printed = download(&request(PLAIN_MP4, mode), &dir.0).unwrap();

    let file = only_file(&dir.0);
    // The path printed is the mkv it fell back to, not the webm that was asked for.
    assert_printed(printed, &file);
    assert_eq!(extension(&file), "mkv");
    let info = probe(&file);
    // Copied, never re-encoded.
    assert_eq!(streams(&info, "video")[0]["codec_name"], "h264", "{info}");
    // The file carries more than one audio stream; every one must be copied as it is.
    let audio = streams(&info, "audio");
    assert!(
        !audio.is_empty() && audio.iter().all(|s| s["codec_name"] == "aac"),
        "{info}"
    );
    eprintln!("webm fallback: {:.1} s", started.elapsed().as_secs_f64());
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn video_webm_from_a_vp9_source_stays_webm() {
    let started = Instant::now();
    let dir = TempDir::new("video-webm");
    let mode = Mode::Video {
        max_height: Some(360),
        container: Some(Container::Webm),
    };
    download(&request(ZOO, mode), &dir.0).unwrap();

    let file = only_file(&dir.0);
    assert_eq!(extension(&file), "webm");
    let info = probe(&file);
    assert_eq!(audio_codec(&info), "opus");
    eprintln!("video webm: {:.1} s", started.elapsed().as_secs_f64());
}

/// Titles with accents (cp1252 can encode them) and with CJK (it cannot): yt-dlp's own default
/// encoding for a pipe turned the printed path into one that does not exist. Third
/// party videos: if one is removed, swap it for another with such a title.
#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn the_printed_path_is_the_real_file_for_titles_with_accents_and_cjk() {
    for (name, url) in [
        ("accents", "https://www.youtube.com/watch?v=RTq7ZHpfVwY"),
        ("cjk", "https://www.youtube.com/watch?v=FErrKdU_0XM"),
    ] {
        let dir = TempDir::new(&format!("unicode-{name}"));
        let best = request(
            url,
            Mode::Audio {
                format: AudioFormat::Best,
                bitrate_kbps: None,
            },
        );
        let printed = download(&best, &dir.0).unwrap();
        let file = only_file(&dir.0);
        assert!(
            !file.to_string_lossy().is_ascii(),
            "the test video has no non-ASCII title any more: {file:?}"
        );
        assert_printed(printed, &file);
    }
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn audio_best_keeps_the_original_codec_with_cover_and_title() {
    let started = Instant::now();
    let dir = TempDir::new("audio-best");
    let best = request(
        ZOO,
        Mode::Audio {
            format: AudioFormat::Best,
            bitrate_kbps: None,
        },
    );

    // What yt-dlp picks with these same arguments, read from its metadata.
    let mut dump = args(&best, &dir.0);
    dump.insert(dump.len() - 2, "--dump-single-json".into());
    let metadata: Value = serde_json::from_slice(&run(&dump).unwrap()).unwrap();
    let chosen = metadata["acodec"].as_str().unwrap();
    // ffprobe calls AAC "aac" where yt-dlp says "mp4a.40.x".
    let expected = if chosen.starts_with("mp4a") {
        "aac"
    } else {
        chosen
    };

    let printed = download(&best, &dir.0).unwrap();
    let file = only_file(&dir.0);
    assert_printed(printed, &file);
    assert!(["opus", "m4a"].contains(&extension(&file)), "{file:?}");
    let info = probe(&file);
    assert_eq!(audio_codec(&info), expected, "re-encoded?");
    assert!(has_cover(&info), "no embedded cover: {info}");
    assert_eq!(title(&info).as_deref(), Some(ZOO_TITLE));
    eprintln!("audio best: {:.1} s", started.elapsed().as_secs_f64());
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn audio_mp3_with_cover_and_title() {
    let started = Instant::now();
    let dir = TempDir::new("audio-mp3");
    let mode = Mode::Audio {
        format: AudioFormat::Mp3,
        bitrate_kbps: Some(192),
    };
    let printed = download(&request(ZOO, mode), &dir.0).unwrap();

    let file = only_file(&dir.0);
    assert_printed(printed, &file);
    assert_eq!(extension(&file), "mp3");
    let info = probe(&file);
    assert_eq!(audio_codec(&info), "mp3");
    assert!(has_cover(&info), "no embedded cover: {info}");
    assert_eq!(title(&info).as_deref(), Some(ZOO_TITLE));
    eprintln!("audio mp3: {:.1} s", started.elapsed().as_secs_f64());
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn every_other_audio_conversion_gets_its_codec_title_and_cover() {
    // mp3 and Best have their own tests. WAV has no room for a cover (yt-dlp
    // would fail with `--embed-thumbnail`), so it only keeps the title.
    let cases = [
        (AudioFormat::M4a, Some(128), "m4a", "aac", true),
        (AudioFormat::Opus, Some(96), "opus", "opus", true),
        (AudioFormat::Flac, None, "flac", "flac", true),
        (AudioFormat::Wav, None, "wav", "pcm_s16le", false),
    ];
    for (format, bitrate_kbps, ext, codec, cover) in cases {
        let started = Instant::now();
        let dir = TempDir::new("audio-conversions");
        let mode = Mode::Audio {
            format,
            bitrate_kbps,
        };
        let printed = download(&request(ZOO, mode), &dir.0).unwrap();
        let file = only_file(&dir.0);
        assert_printed(printed, &file);
        assert_eq!(extension(&file), ext);
        let info = probe(&file);
        assert_eq!(audio_codec(&info), codec, "{ext}: {info}");
        assert_eq!(has_cover(&info), cover, "{ext}: {info}");
        assert_eq!(title(&info).as_deref(), Some(ZOO_TITLE), "{ext}: {info}");
        eprintln!("audio {ext}: {:.1} s", started.elapsed().as_secs_f64());
    }
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn subtitles_are_embedded_in_every_container_and_no_file_is_left() {
    // "Me at the zoo" has English and German subtitles by hand and no Spanish. Asking
    // for Spanish as well must neither fail nor add a track.
    let cases = [
        (Container::Mp4, "mp4", "mov_text"),
        (Container::Mkv, "mkv", ""),
        (Container::Webm, "webm", "webvtt"),
    ];
    for (container, ext, codec) in cases {
        let started = Instant::now();
        let dir = TempDir::new("subtitles");
        let mode = Mode::Video {
            max_height: Some(360),
            container: Some(container),
        };
        let mut with_subs = request(ZOO, mode);
        with_subs.subtitles = Some(Subtitles {
            langs: vec!["en".into(), "de".into(), "es".into()],
            auto: true,
        });
        let printed = download(&with_subs, &dir.0).unwrap();
        // Only the final file: no `.vtt` or `.srt` beside it, nor anything in the output folder.
        let file = only_file(&dir.0);
        assert_printed(printed, &file);
        assert_eq!(extension(&file), ext);
        let info = probe(&file);
        let tracks = streams(&info, "subtitle");
        let mut languages: Vec<&str> = tracks
            .iter()
            .map(|t| t["tags"]["language"].as_str().unwrap_or(""))
            .collect();
        languages.sort();
        assert_eq!(languages, ["deu", "eng"], "{ext}: {info}");
        if !codec.is_empty() {
            assert!(
                tracks.iter().all(|t| t["codec_name"] == codec),
                "{ext}: {info}"
            );
        }
        // The picture is untouched: still one video and one audio stream.
        assert_eq!(streams(&info, "video").len(), 1, "{ext}");
        assert_eq!(streams(&info, "audio").len(), 1, "{ext}");
        eprintln!(
            "subtitles in {ext}: {:.1} s",
            started.elapsed().as_secs_f64()
        );
    }
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn a_cookies_file_is_used_through_a_private_copy_and_the_original_is_untouched() {
    // With a made-up cookie (not a real one). yt-dlp rewrites the cookie file it is given
    // when it exits, so it must be the copy, and the copy must go when the run is over.
    let user = TempDir::new("cookies-user");
    let original = user.0.join("cookies.txt");
    let content =
        "# Netscape HTTP Cookie File\n.example.invalid\tTRUE\t/\tFALSE\t4102444800\tfake\tvalue\n";
    fs::write(&original, content).unwrap();

    let out = TempDir::new("cookies-out");
    let run_dir = user.0.join("run");
    let copy = CookieCopy::new(&original, &run_dir).unwrap();
    let copy_path = copy.path().to_path_buf();
    let args = formats::args(
        &request(ZOO, audio_best()),
        NameTemplate::default(),
        &out.0,
        &queue::temp_dir(&out.0, ID),
        &bin_dir(),
        Tuning {
            limit_rate_kbps: None,
            cookies: Some(Cookies::File(copy_path.clone())),
        },
    )
    .unwrap();
    assert!(args
        .windows(2)
        .any(|w| w[0] == "--cookies" && w[1] == copy_path.to_string_lossy()));
    let printed = download_run(args, &out.0).unwrap();
    let file = only_file(&out.0);
    assert_printed(printed, &file);

    // yt-dlp saved into the copy (it added its own YouTube cookies) and left the user's file alone.
    let rewritten = fs::read_to_string(&copy_path).unwrap();
    assert!(rewritten.contains("youtube.com"), "{rewritten}");
    assert_eq!(fs::read_to_string(&original).unwrap(), content);
    drop(copy);
    assert!(!copy_path.exists());
    assert!(original.exists());
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn a_cookies_file_that_is_not_netscape_fails_as_a_cookies_error() {
    // What `check_file` stops early; yt-dlp's own answer must be classified the same way.
    let user = TempDir::new("cookies-junk");
    let junk = user.0.join("junk.txt");
    fs::write(&junk, "hello, this is not a cookie file").unwrap();
    let out = TempDir::new("cookies-junk-out");
    let args = formats::args(
        &request(ZOO, audio_best()),
        NameTemplate::default(),
        &out.0,
        &queue::temp_dir(&out.0, ID),
        &bin_dir(),
        Tuning {
            limit_rate_kbps: None,
            cookies: Some(Cookies::File(junk)),
        },
    )
    .unwrap();
    let error = download_run(args, &out.0).unwrap_err();
    assert!(matches!(error, AppError::CookiesUnavailable(_)), "{error}");
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn the_speed_limit_slows_a_download_down() {
    // `--limit-rate 300K` on 4.3 MB of SoundCloud audio (HLS, so it is fragmented). The
    // transfer needs ~14 s plus ~2.5 s to start; unlimited it takes ~3-5 s depending on the
    // network. An absolute bound, then: comparing with an unlimited run would depend on the
    // network of the day. The args turn fragments off with a limit: at 4 at once it took 7.7 s.
    const SOUNDCLOUD: &str = "https://soundcloud.com/forss/flickermood";
    let dir = TempDir::new("speed-limit");
    let args = formats::args(
        &request(SOUNDCLOUD, audio_best()),
        NameTemplate::default(),
        &dir.0,
        &queue::temp_dir(&dir.0, ID),
        &bin_dir(),
        Tuning {
            limit_rate_kbps: Some(300),
            cookies: None,
        },
    )
    .unwrap();
    let started = Instant::now();
    download_run(args, &dir.0).unwrap();
    let elapsed = started.elapsed().as_secs_f64();
    eprintln!("speed limit: {elapsed:.1} s at 300 KB/s");
    assert!(elapsed >= 14.0, "{elapsed:.1} s is not limited");
    // The file is whole (4.3 MB), not cut short by the limit.
    assert!(fs::metadata(only_file(&dir.0)).unwrap().len() > 4_000_000);
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn a_playlist_folder_holds_the_final_file_and_nothing_else_is_left() {
    for mode in [
        audio_best(),
        Mode::Video {
            max_height: Some(360),
            container: Some(Container::Mp4),
        },
    ] {
        let dir = TempDir::new("playlist-folder");
        let mut req = request(ZOO, mode);
        req.folder = Some("Mi lista: ¿rock? <2024>".into());
        let printed = download_named(&req, NameTemplate::Title, &dir.0).unwrap();
        // The output folder holds the subfolder and nothing else (no `.albaro-tmp`, no loose file).
        let sub = only_file(&dir.0);
        assert!(sub.is_dir(), "{sub:?}");
        assert_eq!(
            sub.file_name().unwrap().to_string_lossy(),
            "Mi lista_ ¿rock_ _2024_"
        );
        let file = only_file(&sub);
        assert_printed(printed, &file);
        assert_eq!(stem(&file), ZOO_TITLE);
    }
}

/// The track tag, wherever the container keeps it (like `title`).
fn track(info: &Value) -> Option<String> {
    let mut tag_sets = vec![&info["format"]["tags"]];
    tag_sets.extend(
        info["streams"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| &s["tags"]),
    );
    tag_sets.into_iter().find_map(|tags| {
        tags.as_object()?
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("track"))
            .and_then(|(_, value)| value.as_str().map(String::from))
    })
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn audio_in_a_playlist_is_numbered_in_the_name_and_the_track_tag() {
    for (format, ext) in [(AudioFormat::Mp3, "mp3"), (AudioFormat::Best, "")] {
        let dir = TempDir::new("audio-playlist");
        let mode = Mode::Audio {
            format,
            bitrate_kbps: None,
        };
        let mut numbered = request(ZOO, mode);
        numbered.playlist = Some(PlaylistPosition {
            index: 7,
            count: 24,
        });
        let printed = download_named(&numbered, NameTemplate::Title, &dir.0).unwrap();
        let file = only_file(&dir.0);
        assert_printed(printed, &file);
        assert_eq!(stem(&file), format!("07 - {ZOO_TITLE}"));
        if !ext.is_empty() {
            assert_eq!(extension(&file), ext);
        }
        let info = probe(&file);
        assert_eq!(track(&info).as_deref(), Some("7"), "{info}");
        assert_eq!(title(&info).as_deref(), Some(ZOO_TITLE));
    }
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn video_in_a_playlist_is_numbered_in_the_name_and_nothing_else_is_left() {
    // the number is not only for audio.
    let dir = TempDir::new("video-playlist");
    let mode = Mode::Video {
        max_height: Some(360),
        container: Some(Container::Mp4),
    };
    let mut numbered = request(ZOO, mode);
    numbered.playlist = Some(PlaylistPosition {
        index: 7,
        count: 24,
    });
    let printed = download_named(&numbered, NameTemplate::Title, &dir.0).unwrap();
    let file = only_file(&dir.0);
    assert_printed(printed, &file);
    assert_eq!(stem(&file), format!("07 - {ZOO_TITLE}"));
    assert_eq!(extension(&file), "mp4");
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn missing_video_is_unavailable_and_leaves_nothing() {
    let started = Instant::now();
    let dir = TempDir::new("missing");
    let mode = Mode::Video {
        max_height: None,
        container: None,
    };
    let missing = request("https://www.youtube.com/watch?v=xxxxxxxxxxx", mode);
    let error = download(&missing, &dir.0).unwrap_err();
    assert!(matches!(error, AppError::Unavailable(_)), "{error}");
    assert_eq!(fs::read_dir(&dir.0).unwrap().count(), 0);
    eprintln!("missing video: {:.1} s", started.elapsed().as_secs_f64());
}

// --- output folder and file name ---

fn audio_best() -> Mode {
    Mode::Audio {
        format: AudioFormat::Best,
        bitrate_kbps: None,
    }
}

/// The file's name without its extension, as UTF-8 text.
fn stem(file: &Path) -> String {
    file.file_stem().unwrap().to_string_lossy().into_owned()
}

/// A folder like a user's own: spaces, accents and an `ñ`, which cp1252 (yt-dlp's default for
/// a pipe) would mangle too.
fn user_folder(root: &TempDir) -> PathBuf {
    let dir = root.0.join("Vídeos ñ");
    fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn each_name_template_names_the_file_in_a_folder_with_spaces_and_accents() {
    let started = Instant::now();
    let root = TempDir::new("templates");
    let dir = user_folder(&root);
    for (template, expected) in [
        (NameTemplate::Title, "Me at the zoo"),
        (NameTemplate::TitleId, "Me at the zoo [jNQXAC9IVRw]"),
        (NameTemplate::ChannelTitle, "jawed - Me at the zoo"),
    ] {
        let printed = download_named(&request(ZOO, audio_best()), template, &dir).unwrap();
        let file = only_file(&dir);
        assert_eq!(stem(&file), expected, "{template:?}");
        assert!(["opus", "m4a"].contains(&extension(&file)), "{file:?}");
        // The printed path is the real file, in the custom folder.
        assert_printed(printed, &file);
        assert_eq!(file.parent().unwrap(), dir);
        fs::remove_file(&file).unwrap();
    }
    // A video too: the name also applies to the merged file, not just to extracted audio.
    let mode = Mode::Video {
        max_height: Some(360),
        container: Some(Container::Mp4),
    };
    let printed = download_named(&request(ZOO, mode), NameTemplate::Title, &dir).unwrap();
    let file = only_file(&dir);
    assert_eq!(file.file_name().unwrap(), "Me at the zoo.mp4");
    assert_printed(printed, &file);
    // The temporary folder inside the custom one is gone.
    assert!(!dir.join(".albaro-tmp").exists());
    eprintln!("name templates: {:.1} s", started.elapsed().as_secs_f64());
}

/// `channel` does not exist on SoundCloud (`uploader` does), and a plain file URL has
/// neither: "Channel - Title" must still name the file, with `uploader` and then "Unknown".
#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn channel_and_title_falls_back_to_the_uploader_and_then_to_unknown() {
    let started = Instant::now();
    for (name, url, mode, expected) in [
        (
            "soundcloud",
            "https://soundcloud.com/forss/flickermood",
            audio_best(),
            "Forss - Flickermood",
        ),
        (
            "plain-file",
            "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
            Mode::Video {
                max_height: None,
                container: None,
            },
            "Unknown - Big_Buck_Bunny_360_10s_1MB",
        ),
    ] {
        let root = TempDir::new(&format!("channel-{name}"));
        let dir = user_folder(&root);
        let printed = download_named(&request(url, mode), NameTemplate::ChannelTitle, &dir);
        let file = only_file(&dir);
        assert_eq!(stem(&file), expected, "{name}");
        assert_printed(printed.unwrap(), &file);
    }
    eprintln!("channel fallback: {:.1} s", started.elapsed().as_secs_f64());
}

/// UTF-16 units: what Windows counts against its 260-character limit.
fn utf16_len(path: &Path) -> usize {
    path.to_string_lossy().encode_utf16().count()
}

/// A title over 200 characters, with CJK, in a deep folder. `--replace-in-metadata` swaps the
/// real title (YouTube's own go up to 100 characters) for one like that, before the name is
/// built, exactly where a long one would arrive. This machine has Windows long paths on, so a
/// download would work even without cutting the title: what is checked is the length, both of
/// the final path and of the longest one used on the way (temporary folder + `.f251.webm.part`).
#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn a_very_long_title_in_a_deep_folder_stays_under_the_path_limit() {
    let started = Instant::now();
    let long_title = "とても長いタイトルの動画 very long title ".repeat(8);
    assert!(long_title.chars().count() > 200);
    for template in [
        NameTemplate::Title,
        NameTemplate::TitleId,
        NameTemplate::ChannelTitle,
    ] {
        let root = TempDir::new("long-title");
        // Deep, but not so deep that nothing fits: ~140 characters with the temp folder.
        let mut dir = root.0.clone();
        for part in [
            "carpeta muy larga ñandú",
            "otra carpeta con tildes",
            "tercera",
        ] {
            dir.push(part);
        }
        fs::create_dir_all(&dir).unwrap();
        let mut args = args_named(&request(ZOO, audio_best()), template, &dir);
        let at = args.len() - 2;
        let swap = ["--replace-in-metadata", "title", "^.*$", &long_title];
        args.splice(at..at, swap.map(String::from));
        let printed = download_run(args, &dir).unwrap();

        let file = only_file(&dir);
        assert_printed(printed, &file);
        let name = file.file_name().unwrap();
        let name_len = name.to_string_lossy().encode_utf16().count();
        // Final path, and the intermediate one (a `.part` of the downloaded stream).
        assert!(
            utf16_len(&file) <= 260,
            "{template:?}: {}",
            utf16_len(&file)
        );
        let tmp = queue::temp_dir(&dir, ID);
        let worst = utf16_len(&tmp) + 1 + name_len + ".f251.webm.part".len();
        assert!(worst <= 260, "{template:?}: temporary path of {worst}");
        assert!(name_len <= 255, "{template:?}: name of {name_len}");
        // It was cut (the long title is not there whole) and no character was split.
        assert!(name_len < long_title.encode_utf16().count());
        assert!(!name.to_string_lossy().contains('\u{FFFD}'), "{name:?}");
        eprintln!("{template:?}: name {name_len}, temporary path {worst}");
    }
    eprintln!("long title: {:.1} s", started.elapsed().as_secs_f64());
}
