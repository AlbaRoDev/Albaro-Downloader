// Lists a playlist or channel with `yt-dlp --flat-playlist -J`: one fast call that
// returns every entry's title, duration and thumbnail without resolving the videos themselves.
// Each entry is downloaded later as a video of its own.
use std::{path::Path, time::Duration};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::{
    check_url, js_runtime,
    metadata::{is_playlist, run_json, unreadable},
    Cookies,
};
use crate::{
    errors::AppError,
    text::{self, NAME_MAX, TITLE_MAX},
};

/// Sent to the frontend in camelCase (mirrored by `Playlist` in ipc.ts).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub title: Option<String>,
    pub channel: Option<String>,
    /// In the order yt-dlp lists them; nested playlists are flattened (see `flatten`). At most
    /// `MAX_ENTRIES`.
    pub entries: Vec<PlaylistEntry>,
    /// The list had more entries than `MAX_ENTRIES`; the rest were not read.
    pub truncated: bool,
}

/// Most entries listed. Measured in the interface: 2000 entries open in
/// ~250 ms, so 5000 stay usable; and 5000 entries are ~7 MB of JSON, where a channel of 100,000
/// videos would be ~130 MB. yt-dlp is asked for one more, to tell a list of exactly this size
/// from a cut one.
pub const MAX_ENTRIES: usize = 5000;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistEntry {
    /// The video's own URL: what gets queued.
    pub url: String,
    /// `None` for an unavailable video: its placeholder title is not a title.
    pub title: Option<String>,
    /// Why this entry cannot be downloaded, if yt-dlp already says so. Such an entry
    /// has no title, duration, thumbnail or channel either.
    pub unavailable: Option<Unavailable>,
    /// Seconds. Missing for live streams and unavailable videos.
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub channel: Option<String>,
}

/// A playlist entry that is listed but cannot be downloaded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Unavailable {
    Private,
    Deleted,
}

/// What yt-dlp puts in an entry's title when the video is private or deleted, in English (it asks
/// YouTube in English): the entry is otherwise empty (checked on a real playlist with 3 private and
/// 6 deleted among 162 videos: no duration, no channel, availability `null`, and a generic
/// thumbnail). Compared whole, so a real title that merely starts with `[Private video]` is not
/// mistaken for one. Another language or another site's wording just leaves the entry selectable:
/// it then fails alone when downloaded, like any other.
// Known limit: only these two placeholders, as seen; add one when a real playlist shows it.
fn unavailable_from_title(title: &str) -> Option<Unavailable> {
    match title {
        "[Private video]" => Some(Unavailable::Private),
        "[Deleted video]" => Some(Unavailable::Deleted),
        _ => None,
    }
}

// What yt-dlp prints, read leniently: anything missing is `None`, anything unknown is ignored.
#[derive(Deserialize)]
struct RawPlaylist {
    title: Option<String>,
    channel: Option<String>,
    uploader: Option<String>,
    #[serde(default)]
    entries: Vec<Option<RawEntry>>,
}

#[derive(Deserialize)]
struct RawEntry {
    url: Option<String>,
    webpage_url: Option<String>,
    title: Option<String>,
    duration: Option<f64>,
    channel: Option<String>,
    uploader: Option<String>,
    thumbnail: Option<String>,
    thumbnails: Option<Vec<RawThumbnail>>,
    /// Set when the entry is itself a playlist (a channel's tabs).
    entries: Option<Vec<Option<RawEntry>>>,
}

#[derive(Deserialize)]
struct RawThumbnail {
    url: Option<String>,
}

/// A big channel takes a while to page through; a video's 60 s would cut it off.
const TIMEOUT: Duration = Duration::from_secs(180);

fn args(url: &str, bin_dir: &Path, cookies: Option<&Cookies>) -> Vec<String> {
    let mut args = vec![
        "--dump-single-json".into(),
        "--flat-playlist".into(),
        // Stops yt-dlp after this many entries (per list: each tab of a channel gets as many),
        // instead of paging through a huge channel to build a JSON nobody can use.
        "--playlist-end".into(),
        (MAX_ENTRIES + 1).to_string(),
        "--js-runtimes".into(),
        js_runtime(bin_dir),
    ];
    // The browser cookies the user chose: a video that asks for a login fails to
    // analyse without them, long before the download.
    if let Some(cookies) = cookies {
        args.extend(cookies.args());
    }
    // Ends yt-dlp's options: whatever follows is a URL, never an option.
    args.extend(["--".into(), url.into()]);
    args
}

/// Lists the playlist or channel at `url`. Gives up after `TIMEOUT`.
pub async fn fetch(
    app: &AppHandle,
    url: &str,
    bin_dir: &Path,
    cookies: Option<&Cookies>,
) -> Result<Playlist, AppError> {
    check_url(url)?;
    parse(&run_json(app, args(url, bin_dir, cookies), TIMEOUT).await?)
}

fn parse(json: &str) -> Result<Playlist, AppError> {
    if !is_playlist(json)? {
        return Err(AppError::Unknown("this URL is not a playlist".into()));
    }
    let raw: RawPlaylist = serde_json::from_str(json).map_err(unreadable)?;
    let mut entries = Vec::new();
    flatten(raw.entries, &mut entries);
    let truncated = entries.len() > MAX_ENTRIES;
    entries.truncate(MAX_ENTRIES);
    Ok(Playlist {
        title: text::clean_opt(raw.title, TITLE_MAX),
        channel: text::clean_opt(raw.channel.or(raw.uploader), NAME_MAX),
        entries,
        truncated,
    })
}

// A channel link is a playlist of playlists (YouTube: its Videos, Live and Shorts tabs), each
// holding its own entries. They are flattened into one list, in order, instead of asking the
// user to choose a tab; the same video in two tabs would appear twice.
// An entry without an http(s) URL cannot be downloaded (the queue refuses it) and is left out.
fn flatten(raw: Vec<Option<RawEntry>>, out: &mut Vec<PlaylistEntry>) {
    for entry in raw.into_iter().flatten() {
        // One past the limit is enough to know the list was cut; the rest is not worth reading.
        if out.len() > MAX_ENTRIES {
            return;
        }
        if let Some(nested) = entry.entries {
            flatten(nested, out);
        } else if let Some(url) = entry
            .url
            .or(entry.webpage_url)
            .filter(|url| check_url(url).is_ok())
        {
            // yt-dlp sorts thumbnails from smallest to largest; the last one is the sharpest.
            let from_list = entry
                .thumbnails
                .and_then(|list| list.into_iter().rev().find_map(|t| t.url));
            let unavailable = entry.title.as_deref().and_then(unavailable_from_title);
            out.push(if unavailable.is_some() {
                PlaylistEntry {
                    url,
                    title: None,
                    unavailable,
                    duration: None,
                    thumbnail: None,
                    channel: None,
                }
            } else {
                PlaylistEntry {
                    url,
                    title: text::clean_opt(entry.title, TITLE_MAX),
                    unavailable: None,
                    duration: entry.duration.filter(|d| d.is_finite() && *d >= 0.0),
                    thumbnail: text::thumbnail(entry.thumbnail.or(from_list)),
                    channel: text::clean_opt(entry.channel.or(entry.uploader), NAME_MAX),
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ytdlp::Browser;

    // Real output of the bundled yt-dlp (2026.08.19), see tests/fixtures: a YouTube playlist, and
    // a channel link limited to 3 entries per tab with `--playlist-items 1:3`.
    const PLAYLIST: &str = include_str!("../../../tests/fixtures/playlist-youtube.json");
    const CHANNEL: &str = include_str!("../../../tests/fixtures/playlist-channel-tabs.json");
    // 18 entries cut from a real YouTube playlist (162 videos): its 3 private and 6 deleted
    // ones, each after the video that came before it.
    const UNAVAILABLE: &str = include_str!("../../../tests/fixtures/playlist-unavailable.json");
    const ONE_VIDEO: &str = include_str!("../../../tests/fixtures/metadata-soundcloud.json");

    fn entries_json(n: usize) -> String {
        let entries: Vec<String> = (0..n)
            .map(|i| format!(r#"{{"url": "https://e.com/v{i}", "title": "V{i}"}}"#))
            .collect();
        format!(
            r#"{{"_type": "playlist", "title": "P", "entries": [{}]}}"#,
            entries.join(",")
        )
    }

    #[test]
    fn a_list_over_the_limit_is_cut_and_says_so() {
        let exact = parse(&entries_json(MAX_ENTRIES)).unwrap();
        assert_eq!((exact.entries.len(), exact.truncated), (MAX_ENTRIES, false));
        let over = parse(&entries_json(MAX_ENTRIES + 1)).unwrap();
        assert_eq!((over.entries.len(), over.truncated), (MAX_ENTRIES, true));
        // A hundred thousand: still cut, and the order is the list's.
        let huge = parse(&entries_json(100_000)).unwrap();
        assert_eq!((huge.entries.len(), huge.truncated), (MAX_ENTRIES, true));
        assert_eq!(huge.entries[4999].url, "https://e.com/v4999");
        // yt-dlp is told where to stop, one past the limit to tell the cases apart.
        let args = args("https://e.com/l", Path::new("bin"), None);
        let at = args.iter().position(|a| a == "--playlist-end").unwrap();
        assert_eq!(args[at + 1], (MAX_ENTRIES + 1).to_string());
    }

    #[test]
    fn a_channel_of_huge_tabs_is_cut_as_a_whole() {
        let tab = |n: usize| {
            let inner = entries_json(n);
            let inner: serde_json::Value = serde_json::from_str(&inner).unwrap();
            inner["entries"].clone()
        };
        let json = serde_json::json!({"_type": "playlist", "title": "C", "entries": [
            {"entries": tab(MAX_ENTRIES + 1)}, {"entries": tab(MAX_ENTRIES + 1)}
        ]});
        let p = parse(&json.to_string()).unwrap();
        assert_eq!((p.entries.len(), p.truncated), (MAX_ENTRIES, true));
    }

    #[test]
    fn hostile_entries_come_out_clean() {
        let rtl = char::from_u32(0x202E).unwrap();
        let json = serde_json::json!({"_type": "playlist", "title": format!("L{rtl}ist\n"), "entries": [{
            "url": "https://e.com/v",
            "title": format!("{}\u{0}\n{rtl}x", "T".repeat(10_000)),
            "channel": "C\r\nD",
            "thumbnail": "javascript:alert(1)",
            "thumbnails": [{"url": "https://e.com/small.jpg"}, {"url": "file:///C:/x.png"}],
            "duration": -1
        }]});
        let p = parse(&json.to_string()).unwrap();
        assert_eq!(p.title.as_deref(), Some("List"));
        let e = &p.entries[0];
        assert_eq!(e.title.as_ref().unwrap().chars().count(), 1001);
        assert_eq!(e.channel.as_deref(), Some("C  D"));
        // The sharpest thumbnail is the last one listed, and it is not an address that can travel.
        assert_eq!(e.thumbnail, None);
        assert_eq!(e.duration, None);
    }

    #[test]
    fn deeply_nested_entries_are_an_error_and_not_a_stack_overflow() {
        let depth = 100_000;
        let json = format!(
            "{}[]{}",
            r#"[{"entries":"#.repeat(depth),
            "}]".repeat(depth)
        );
        let doc = format!(r#"{{"_type": "playlist", "entries": {json}}}"#);
        assert!(parse(&doc).is_err());
    }

    #[test]
    fn youtube_playlist_lists_every_entry_in_order() {
        let p = parse(PLAYLIST).unwrap();
        assert_eq!(p.title.as_deref(), Some("New This Week"));
        assert_eq!(p.channel.as_deref(), Some("Music"));
        assert_eq!(p.entries.len(), 47);
        let first = &p.entries[0];
        assert_eq!(first.url, "https://www.youtube.com/watch?v=b53QJYP-lqY");
        assert_eq!(
            first.title.as_deref(),
            Some("Troye Sivan - Rush (Official Video)")
        );
        assert_eq!(first.duration, Some(223.0));
        assert_eq!(first.channel.as_deref(), Some("Troye Sivan"));
        // The last of the four thumbnails, the biggest (336 px wide).
        assert!(first
            .thumbnail
            .as_deref()
            .is_some_and(|t| t.contains("CNACELwB")));
        assert!(p.entries.iter().all(|e| e.url.starts_with("https://")));
    }

    #[test]
    fn a_channel_is_flattened_across_its_tabs() {
        let p = parse(CHANNEL).unwrap();
        assert_eq!(p.title.as_deref(), Some("YouTube"));
        // Three tabs, three entries each; none of the tabs themselves is an entry.
        assert_eq!(p.entries.len(), 9);
        assert!(p
            .entries
            .iter()
            .all(|e| e.url.contains("/watch?v=") || e.url.contains("/shorts/")));
    }

    #[test]
    fn entries_without_a_url_are_dropped_and_the_rest_is_optional() {
        let json = r#"{"_type": "playlist", "uploader": "u", "entries": [
            null,
            {"title": "no url"},
            {"url": "file:///etc/passwd"},
            {"webpage_url": "https://e.com/2", "uploader": "x", "thumbnail": "https://e.com/t.jpg",
             "thumbnails": [{"url": "https://e.com/other.jpg"}], "new_field": 1},
            {"url": "https://e.com/3", "title": null, "duration": null, "thumbnails": [{}]}]}"#;
        let p = parse(json).unwrap();
        assert_eq!((p.title, p.channel.as_deref()), (None, Some("u")));
        assert_eq!(p.entries.len(), 2);
        // `thumbnail` wins over the list; `uploader` stands in for `channel`.
        assert_eq!(
            p.entries[0].thumbnail.as_deref(),
            Some("https://e.com/t.jpg")
        );
        assert_eq!(p.entries[0].channel.as_deref(), Some("x"));
        assert_eq!(p.entries[1].thumbnail, None);
    }

    #[test]
    fn private_and_deleted_videos_are_marked_and_the_rest_still_lists() {
        let p = parse(UNAVAILABLE).unwrap();
        assert_eq!(p.entries.len(), 18);
        let marked = |u| {
            p.entries
                .iter()
                .filter(|e| e.unavailable == Some(u))
                .count()
        };
        assert_eq!(marked(Unavailable::Private), 3);
        assert_eq!(marked(Unavailable::Deleted), 6);
        // The order is kept, and nothing is left of the placeholder.
        let kinds: String = p
            .entries
            .iter()
            .map(|e| match e.unavailable {
                None => '.',
                Some(Unavailable::Private) => 'P',
                Some(Unavailable::Deleted) => 'D',
            })
            .collect();
        assert_eq!(kinds, ".P.P.D.P.D.D.D.D.D");
        for e in p.entries.iter().filter(|e| e.unavailable.is_some()) {
            assert_eq!(
                (&e.title, e.duration, &e.thumbnail, &e.channel),
                (&None, None, &None, &None)
            );
            assert!(e.url.starts_with("https://www.youtube.com/watch?v="));
        }
        // The other 9 are ordinary entries.
        let ok: Vec<_> = p
            .entries
            .iter()
            .filter(|e| e.unavailable.is_none())
            .collect();
        assert_eq!(ok.len(), 9);
        assert!(ok
            .iter()
            .all(|e| e.title.is_some() && e.duration.is_some() && e.thumbnail.is_some()));
    }

    #[test]
    fn only_the_whole_placeholder_counts() {
        let json = r#"{"_type": "playlist", "entries": [
            {"url": "https://e.com/1", "title": "[Private video] a real title"},
            {"url": "https://e.com/2", "title": "[private video]"},
            {"url": "https://e.com/3", "title": "[Deleted video]"}]}"#;
        let p = parse(json).unwrap();
        let flags: Vec<_> = p.entries.iter().map(|e| e.unavailable).collect();
        assert_eq!(flags, [None, None, Some(Unavailable::Deleted)]);
        assert_eq!(
            p.entries[0].title.as_deref(),
            Some("[Private video] a real title")
        );
    }

    #[test]
    fn frontend_gets_the_reason_in_camel_case() {
        let value = serde_json::to_value(parse(UNAVAILABLE).unwrap()).unwrap();
        let reasons: Vec<&str> = value["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| e["unavailable"].as_str())
            .collect();
        assert_eq!(reasons.len(), 9);
        assert!(reasons.iter().all(|r| *r == "private" || *r == "deleted"));
        assert!(value["entries"][0]["unavailable"].is_null());
    }

    #[test]
    fn an_empty_playlist_is_not_an_error() {
        assert!(parse(r#"{"_type": "playlist"}"#)
            .unwrap()
            .entries
            .is_empty());
    }

    #[test]
    fn a_single_video_or_broken_json_is_refused() {
        assert!(
            matches!(parse(ONE_VIDEO), Err(AppError::Unknown(m)) if m.contains("not a playlist"))
        );
        assert!(matches!(
            parse(r#"{"_type": "playlist", "entries": "#),
            Err(AppError::Unknown(_))
        ));
    }

    #[test]
    fn frontend_gets_camel_case() {
        let value = serde_json::to_value(parse(PLAYLIST).unwrap()).unwrap();
        assert_eq!(value["entries"][0]["duration"], 223.0);
        assert!(value["entries"][0].get("webpageUrl").is_none());
    }

    #[test]
    fn playlist_listing_uses_the_chosen_cookies() {
        let args = args(
            "https://example.com/p",
            Path::new("bin"),
            Some(&Cookies::Browser(Browser::Brave)),
        );
        assert_eq!(args[args.len() - 2..], ["--", "https://example.com/p"]);
        let at = args
            .iter()
            .position(|a| a == "--cookies-from-browser")
            .unwrap();
        assert_eq!(args[at + 1], "brave");
    }

    #[test]
    fn args_list_flat_and_end_with_the_url() {
        let args = args("https://example.com/p", Path::new("bin"), None);
        assert_eq!(args[args.len() - 2..], ["--", "https://example.com/p"]);
        assert!(args.contains(&"--flat-playlist".to_string()));
        assert!(args.contains(&"--dump-single-json".to_string()));
        // A `watch?v=x&list=y` link must list the playlist here.
        assert!(!args.contains(&"--no-playlist".to_string()));
        assert!(!args.contains(&"--playlist-items".to_string()));
    }
}
