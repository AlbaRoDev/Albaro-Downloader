// a hostile title becomes a file name. Run by hand, like the other e2e tests:
//
//     cargo test a_hostile_title -- --ignored --nocapture
use std::{
    fs,
    path::{Path, PathBuf},
};

use super::{args_named, download_run, request, PLAIN_MP4};
use crate::{
    test_util::TempDir,
    ytdlp::formats::{Mode, NameTemplate},
};

/// Every file under `dir`, relative to it (folders are walked, not listed).
fn files_under(dir: &Path) -> Vec<PathBuf> {
    let mut found = vec![];
    let mut pending = vec![dir.to_path_buf()];
    while let Some(folder) = pending.pop() {
        for entry in fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
            } else {
                found.push(path.strip_prefix(dir).unwrap().to_path_buf());
            }
        }
    }
    found
}

/// `--replace-in-metadata` puts any text where a site's title would be, before yt-dlp builds the
/// name, so each of these arrives exactly as it would from a page. The output folder sits inside
/// a parent of its own: anything that escaped it would show up there. The title template (no
/// `[id]`) is used because it leaves the title the most room. Each name that comes out is
/// checked, and printed for a look with `--nocapture`.
#[test]
#[ignore = "downloads from the internet; run with: cargo test -- --ignored"]
fn a_hostile_title_stays_a_plain_file_inside_the_output_folder() {
    let rtl = char::from_u32(0x202e).unwrap();
    let mut titles: Vec<String> = [
        r"..\..\evil",
        "../../evil",
        r"C:\Windows\evil",
        "/etc/evil",
        "CON",
        "NUL.txt",
        "COM1",
        "a/b\\c:d*e?f\"g<h>i|j",
        "%(id)s %(title)s %(ext)s",
        ".",
        "..",
        "...",
        " ",
        "trailing dot.",
        "trailing space ",
        "evil\nname\twith\rcontrol",
        "$(calc) `calc` --exec=calc",
        "日本語😀 ñandú",
        "-rf --version",
    ]
    .iter()
    .map(ToString::to_string)
    .collect();
    titles.push(format!("gpj.exe{rtl}4pm"));
    titles.push("x".repeat(400));
    titles.push("ab".repeat(2000));
    let mut problems: Vec<String> = vec![];
    for title in &titles {
        let root = TempDir::new("hostile-title");
        let out = root.0.join("out");
        fs::create_dir_all(&out).unwrap();
        let mode = Mode::Video {
            max_height: None,
            container: None,
        };
        let mut args = args_named(&request(PLAIN_MP4, mode), NameTemplate::Title, &out);
        // Before the app's own title fixes: the hostile text must be what they get to see.
        let at = args
            .iter()
            .position(|a| a == "--replace-in-metadata")
            .expect("the title fixes");
        // The replacement is a `re.sub` template: its backslashes must be doubled.
        let replacement = title.replace('\\', r"\\");
        args.splice(
            at..at,
            ["--replace-in-metadata", "title", "^.*$", &replacement].map(String::from),
        );
        let result = download_run(args, &out);

        let shown: String = title.chars().take(40).collect();
        let outside: Vec<_> = fs::read_dir(&root.0)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|name| name != "out")
            .collect();
        assert!(outside.is_empty(), "{shown:?} wrote outside: {outside:?}");
        let files = files_under(&out);
        if let Err(error) = result {
            eprintln!("{shown:?}: refused by yt-dlp: {error:?}");
            assert!(files.is_empty(), "{shown:?} left {files:?}");
            continue;
        }
        assert_eq!(files.len(), 1, "{shown:?}: {files:?}");
        let name = files[0].to_string_lossy().into_owned();
        eprintln!("{shown:?} -> {name:?}");
        let stem = name
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end()
            .to_ascii_uppercase();
        let mut found = vec![];
        if files[0].components().count() != 1 {
            found.push("a subfolder was made from the title");
        }
        if name.contains(['<', '>', ':', '"', '|', '?', '*']) {
            found.push("a character Windows forbids");
        }
        if name.chars().any(char::is_control) {
            found.push("a control character");
        }
        if name.contains(rtl) {
            found.push("a direction override");
        }
        if name.ends_with(['.', ' ']) {
            found.push("ends with a dot or a space");
        }
        if ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"].contains(&stem.as_str()) {
            found.push("a Windows device name");
        }
        if name.encode_utf16().count() > 255 {
            found.push("longer than 255 units");
        }
        problems.extend(
            found
                .into_iter()
                .map(|p| format!("{shown:?} -> {name:?}: {p}")),
        );
    }
    assert!(problems.is_empty(), "{problems:#?}");
}
