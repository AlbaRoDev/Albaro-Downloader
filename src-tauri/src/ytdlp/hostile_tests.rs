// Hostile input: strings that come from the page or from a site and end up in a yt-dlp
// command line or in a path. Not fuzzing with a tool: a fixed-seed generator mixes the pieces that
// have hurt other programs (path separators, `..`, device names, `%(...)s` templates, line breaks,
// direction controls, option-looking text) and every result is checked against the properties that
// must hold whatever the input is. Deterministic, so a failure is reproducible.
use std::collections::BTreeSet;
use std::path::{Component, Path};

use serde_json::json;

use super::formats::{args, folder_name, is_language_code, DownloadRequest, NameTemplate};
use super::{check_url, Tuning};

/// xorshift64: enough to shuffle pieces, and the same on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
}

/// The pieces, as text. Direction controls and the like are built from code points: the compiler
/// refuses them written in a literal.
fn pieces() -> Vec<String> {
    let mut p: Vec<String> = [
        "..",
        ".",
        " ",
        "/",
        "\\",
        ":",
        "*",
        "?",
        "\"",
        "<",
        ">",
        "|",
        "%",
        "%(id)s",
        "%(title)s",
        "%(title).150B",
        "{}",
        "$",
        "~",
        "-",
        "--",
        "-x",
        "--exec=calc",
        "-o",
        ",",
        ";",
        "&",
        "`",
        "'",
        "\n",
        "\r\n",
        "\t",
        "\0",
        "CON",
        "nul",
        "Aux.txt",
        "COM1",
        "com9",
        "LPT3",
        "COM\u{b9}",
        "CON .txt",
        "a",
        "Z",
        "é",
        "ñ",
        "日本語",
        "😀",
        "..\\..\\",
        "../../",
        "C:\\Windows",
        "\\\\server\\share",
        "all",
        ".*",
        "en",
        "pt-BR",
        "zh-Hans",
    ]
    .iter()
    .map(ToString::to_string)
    .collect();
    for cp in [
        0x202e, 0x202d, 0x2066, 0x200b, 0x200f, 0xfeff, 0x7f, 0x85, 0xfffd,
    ] {
        p.push(char::from_u32(cp).unwrap().to_string());
    }
    p
}

fn hostile(rng: &mut Rng, pieces: &[String]) -> String {
    (0..1 + rng.below(8))
        .map(|_| pieces[rng.below(pieces.len())].as_str())
        .collect()
}

fn invisible(c: char) -> bool {
    matches!(
        c as u32,
        0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x2069 | 0xFEFF
    )
}

fn reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).trim_end();
    let stem: String = stem
        .chars()
        .map(|c| match c {
            '\u{b9}' => '1',
            '\u{b2}' => '2',
            '\u{b3}' => '3',
            c => c,
        })
        .collect();
    [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ]
    .iter()
    .any(|r| r.eq_ignore_ascii_case(&stem))
}

/// What a folder name must be on every system, whatever it was made from.
fn assert_safe_folder(name: &str, raw: &str) {
    let ctx = format!("{raw:?} -> {name:?}");
    assert!(!name.is_empty(), "{ctx}");
    assert!(
        !name.contains(['<', '>', ':', '"', '/', '\\', '|', '?', '*']),
        "{ctx}"
    );
    assert!(
        !name.chars().any(|c| c.is_control() || invisible(c)),
        "{ctx}"
    );
    assert!(
        !name.starts_with(['.', ' ']) && !name.ends_with(['.', ' ']),
        "{ctx}"
    );
    assert!(name.encode_utf16().count() <= 60, "{ctx}");
    assert!(!reserved(name), "{ctx}");
    // One normal component: it cannot climb out of, or replace, the folder it is joined to.
    let mut components = Path::new(name).components();
    assert!(
        matches!(components.next(), Some(Component::Normal(_))),
        "{ctx}"
    );
    assert!(components.next().is_none(), "{ctx}");
    let out = std::env::temp_dir().join("out");
    assert!(out.join(name).starts_with(&out), "{ctx}");
}

#[test]
fn a_folder_name_is_safe_whatever_it_is_made_from() {
    let pieces = pieces();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut kept = 0;
    for _ in 0..30_000 {
        let raw = hostile(&mut rng, &pieces);
        if let Some(name) = folder_name(&raw) {
            assert_safe_folder(&name, &raw);
            kept += 1;
        }
    }
    // Most inputs keep something; the check above must have had plenty to look at.
    assert!(kept > 10_000, "only {kept} names to check");
}

#[test]
fn known_nasty_folder_names() {
    let cases: [(&str, Option<&str>); 14] = [
        ("..", None),
        ("...", None),
        (" . ", None),
        ("../../Windows", Some("_.._Windows")),
        ("..\\..\\x", Some("_.._x")),
        ("C:\\Windows", Some("C__Windows")),
        ("CON", Some("_CON")),
        ("con.txt", Some("_con.txt")),
        // Windows reads a name with spaces before the dot as the device too.
        ("CON .txt", Some("_CON .txt")),
        ("COM\u{b9}", Some("_COM\u{b9}")),
        ("NUL:", Some("NUL_")),
        ("%(id)s", Some("%(id)s")),
        ("a\nb\0c", Some("a_b_c")),
        ("--exec=calc", Some("--exec=calc")),
    ];
    for (raw, expected) in cases {
        assert_eq!(folder_name(raw).as_deref(), expected, "{raw:?}");
    }
    // A direction override would make "gpj.exe" read as "exe.jpg" in a file manager.
    let rtl = char::from_u32(0x202e).unwrap();
    assert_eq!(folder_name(&format!("a{rtl}b")).as_deref(), Some("a_b"));
}

#[test]
fn only_plain_language_codes_pass() {
    let pieces = pieces();
    let mut rng = Rng(0xD1B5_4A32_D192_ED03);
    for _ in 0..30_000 {
        let code = hostile(&mut rng, &pieces);
        if is_language_code(&code) {
            // `--sub-langs` is a comma-separated list of regular expressions where `-x` excludes
            // and `all` and `.*` match everything: none of that may get through.
            assert!(
                code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'),
                "{code:?}"
            );
            assert!(
                !code.starts_with('-') && !code.eq_ignore_ascii_case("all"),
                "{code:?}"
            );
        }
    }
    for ok in ["es", "en", "pt-BR", "zh-Hans", "es-419", "en-orig"] {
        assert!(is_language_code(ok), "{ok}");
    }
}

/// Every flag the app ever passes (before `--`), from requests with ordinary values.
fn known_flags() -> BTreeSet<String> {
    let modes = [
        json!({"kind": "video", "maxHeight": null, "container": null}),
        json!({"kind": "video", "maxHeight": 1080, "container": "mp4"}),
        json!({"kind": "video", "maxHeight": 720, "container": "mp4Compatible"}),
        json!({"kind": "video", "maxHeight": null, "container": "mkv"}),
        json!({"kind": "video", "maxHeight": null, "container": "webm"}),
        json!({"kind": "audio", "format": "best", "bitrateKbps": null}),
        json!({"kind": "audio", "format": "mp3", "bitrateKbps": 192}),
        json!({"kind": "audio", "format": "wav", "bitrateKbps": null}),
    ];
    let mut flags = BTreeSet::new();
    for mode in modes {
        for limit in [None, Some(512)] {
            let request: DownloadRequest = serde_json::from_value(json!({
                "url": "https://e.test/v", "mode": mode,
                "playlist": {"index": 3, "count": 10}, "folder": "Folder",
                "subtitles": {"langs": ["en", "es"], "auto": true},
            }))
            .unwrap();
            let tuning = Tuning {
                limit_rate_kbps: limit,
                cookies: None,
            };
            let list = run(&request, tuning).unwrap();
            flags.extend(
                before_separator(&list)
                    .iter()
                    .filter(|a| a.starts_with('-'))
                    .cloned(),
            );
        }
    }
    assert!(flags.len() > 20, "{flags:?}");
    flags
}

fn run(request: &DownloadRequest, tuning: Tuning) -> Result<Vec<String>, crate::errors::AppError> {
    let base = std::env::temp_dir().join("albaro-hostile");
    args(
        request,
        NameTemplate::TitleId,
        &base,
        &base.join(".albaro-tmp").join("1"),
        Path::new("bin"),
        tuning,
    )
}

fn before_separator(args: &[String]) -> &[String] {
    let at = args.iter().position(|a| a == "--").expect("no `--`");
    &args[..at]
}

#[test]
fn hostile_requests_never_add_an_option_or_split_an_argument() {
    let known = known_flags();
    let pieces = pieces();
    let mut rng = Rng(0x2545_F491_4F6C_DD1D);
    let base = std::env::temp_dir().join("albaro-hostile");
    let (mut accepted, mut refused) = (0, 0);
    for round in 0..20_000 {
        let url = if round % 4 == 0 {
            hostile(&mut rng, &pieces)
        } else {
            format!("https://{}", hostile(&mut rng, &pieces))
        };
        let langs: Vec<String> = (0..rng.below(4))
            .map(|_| hostile(&mut rng, &pieces))
            .collect();
        let mode = match rng.below(3) {
            0 => json!({"kind": "audio", "format": "mp3", "bitrateKbps": 192}),
            1 => json!({"kind": "video", "maxHeight": 1080, "container": "webm"}),
            _ => json!({"kind": "video", "maxHeight": null, "container": null}),
        };
        let folder = (rng.below(4) != 0).then(|| hostile(&mut rng, &pieces));
        let request: DownloadRequest = serde_json::from_value(json!({
            "url": url, "mode": mode, "folder": folder,
            "playlist": {"index": rng.next() as u32, "count": rng.next() as u32},
            "subtitles": {"langs": langs, "auto": rng.below(2) == 0},
        }))
        .unwrap();
        let Ok(list) = run(&request, Tuning::default()) else {
            refused += 1;
            continue;
        };
        accepted += 1;
        let ctx = format!("{request:?}");
        // The URL is the last argument, alone, right after the one `--`: never an option.
        assert_eq!(list[list.len() - 2], "--", "{ctx}");
        assert_eq!(list[list.len() - 1], request.url, "{ctx}");
        assert_eq!(list.iter().filter(|a| *a == "--").count(), 1, "{ctx}");
        // Nothing the request holds becomes an option of its own, or a line break.
        for arg in before_separator(&list) {
            if arg.starts_with('-') {
                assert!(known.contains(arg), "unexpected option {arg:?} from {ctx}");
            }
            assert!(!arg.contains(['\n', '\r', '\0']), "{arg:?} from {ctx}");
        }
        // The destination stays one folder deep under the chosen one.
        let home = list
            .iter()
            .find_map(|a| a.strip_prefix("home:"))
            .expect("no -P home:");
        let relative = Path::new(home)
            .strip_prefix(&base)
            .unwrap_or_else(|_| panic!("{home:?} left {base:?}: {ctx}"));
        assert!(relative.components().count() <= 1, "{home:?} from {ctx}");
        assert!(
            relative
                .components()
                .all(|c| matches!(c, Component::Normal(_))),
            "{home:?} from {ctx}"
        );
    }
    assert!(
        accepted > 1_000 && refused > 1_000,
        "{accepted} accepted, {refused} refused"
    );
}

#[test]
fn a_url_that_looks_like_an_option_never_reaches_a_command_line() {
    let pieces = pieces();
    let mut rng = Rng(0xA076_1D64_78BD_642F);
    for _ in 0..30_000 {
        let url = hostile(&mut rng, &pieces);
        if check_url(&url).is_ok() {
            assert!(
                url.starts_with("http://") || url.starts_with("https://"),
                "{url:?}"
            );
            assert!(
                !url.chars()
                    .any(|c| c.is_whitespace() || c.is_control() || invisible(c)),
                "{url:?}"
            );
        }
    }
}
