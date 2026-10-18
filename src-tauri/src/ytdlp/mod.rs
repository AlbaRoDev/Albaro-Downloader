pub mod classify;
pub mod formats;
pub mod metadata;
pub mod openpgp;
pub mod playlist;
pub mod progress;
pub mod runner;
pub mod updater;

#[cfg(test)]
mod e2e_tests;

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{async_runtime::Receiver, AppHandle};

use crate::errors::AppError;
use runner::{Run, RunEvent};

/// Rejects anything that is not an http(s) URL before it reaches yt-dlp. The URL comes from
/// the frontend and becomes a yt-dlp argument: one starting with `-` would be read as an
/// option (some, like `--exec`, run commands), and `file://` would read local files. Argument
/// lists also put `--` before the URL, so even a URL that slipped through is never an option.
///
/// Also refuses a URL longer than `MAX_URL_LEN` or with spaces or control characters (a real URL has
/// none; a hostile page could otherwise store megabytes, or put a line break in an argument), and
/// never echoes more than a short start of a bad one into the error.
pub fn check_url(url: &str) -> Result<(), AppError> {
    let start = || url.chars().take(100).collect::<String>();
    if url.len() > MAX_URL_LEN {
        return Err(AppError::InvalidUrl(format!(
            "the URL is longer than {MAX_URL_LEN} bytes: {}...",
            start()
        )));
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(AppError::InvalidUrl(format!(
            "only http:// and https:// URLs are accepted: {}",
            start()
        )));
    }
    if url
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || is_invisible(c))
    {
        return Err(AppError::InvalidUrl(format!(
            "the URL has spaces, control or invisible characters: {}",
            start()
        )));
    }
    Ok(())
}

/// Characters that draw nothing but change how a URL reads: the right-to-left and other direction
/// controls (a classic way to make a link look like another) and the zero-width ones.
pub(crate) fn is_invisible(c: char) -> bool {
    // Numbers, not characters: the compiler refuses direction controls written in a literal.
    matches!(
        c as u32,
        0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x2069 | 0xFEFF
    )
}

/// The frontend already stops at 2048 characters when pasting; this is the backend's own, generous
/// limit (a command line holds about 32 KB on Windows).
const MAX_URL_LEN: usize = 8192;

/// Where Tauri puts the sidecars: next to the app executable.
pub fn bin_dir() -> Result<PathBuf, AppError> {
    let exe = std::env::current_exe().map_err(|e| AppError::Unknown(e.to_string()))?;
    exe.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| AppError::Unknown("cannot locate the executable directory".into()))
}

/// Launches yt-dlp: the updated copy from the data folder if there is one, the bundled sidecar
/// otherwise. If the updated copy cannot even start (damaged, removed by an
/// antivirus), it is deleted and the bundled one runs instead. A copy that starts and then fails
/// is not second-guessed: a failed download is an ordinary result.
pub fn spawn(app: &AppHandle, args: Vec<String>) -> Result<(Run, Receiver<RunEvent>), AppError> {
    if let Some(program) = updater::program(app) {
        match runner::spawn_program(app, &program, args.clone()) {
            Ok(started) => return Ok(started),
            Err(err) => {
                eprintln!("updated yt-dlp does not start, using the bundled one: {err}");
                updater::discard(app);
            }
        }
    }
    runner::spawn(app, "yt-dlp", args)
}

/// The browsers whose cookies yt-dlp may read (`--cookies-from-browser`). A closed list
/// on purpose: the value becomes a yt-dlp argument, and yt-dlp's own syntax
/// (`BROWSER[+KEYRING][:PROFILE]`) would let a free text pick a profile path or a keyring.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Browser {
    Chrome,
    Edge,
    Firefox,
    Brave,
    Opera,
    Vivaldi,
    Chromium,
    /// macOS only; on other systems yt-dlp reports it cannot read them.
    Safari,
}

impl Browser {
    /// yt-dlp's name for it, which is also what is stored and what the frontend sends.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Chrome => "chrome",
            Self::Edge => "edge",
            Self::Firefox => "firefox",
            Self::Brave => "brave",
            Self::Opera => "opera",
            Self::Vivaldi => "vivaldi",
            Self::Chromium => "chromium",
            Self::Safari => "safari",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [
            Self::Chrome,
            Self::Edge,
            Self::Firefox,
            Self::Brave,
            Self::Opera,
            Self::Vivaldi,
            Self::Chromium,
            Self::Safari,
        ]
        .into_iter()
        .find(|browser| browser.as_str() == text)
    }

    /// The two arguments that make yt-dlp use this browser's cookies.
    pub fn args(self) -> [String; 2] {
        ["--cookies-from-browser".into(), self.as_str().into()]
    }
}

/// Where yt-dlp takes cookies from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cookies {
    Browser(Browser),
    /// A private copy of the user's `cookies.txt` for this run (`cookies::CookieCopy`), never the
    /// user's own file: yt-dlp rewrites the file it is given.
    File(PathBuf),
}

impl Cookies {
    /// The two arguments that make yt-dlp use these cookies.
    pub fn args(&self) -> [String; 2] {
        match self {
            Self::Browser(browser) => browser.args(),
            Self::File(path) => ["--cookies".into(), path.to_string_lossy().into_owned()],
        }
    }
}

/// What the user's settings add to the arguments of a download, read once
/// when it starts. `limit_rate_kbps` is already this process's share of the global limit.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tuning {
    pub limit_rate_kbps: Option<u32>,
    pub cookies: Option<Cookies>,
}

impl Tuning {
    pub fn extend(&self, args: &mut Vec<String>) {
        if let Some(kbps) = self.limit_rate_kbps {
            args.extend(["--limit-rate".into(), format!("{kbps}K")]);
        }
        if let Some(cookies) = &self.cookies {
            args.extend(cookies.args());
        }
    }
}

/// Value for `--js-runtimes`: yt-dlp needs Deno (a sidecar next to the executable, in
/// `bin_dir`) to solve YouTube's JS challenges.
pub fn js_runtime(bin_dir: &Path) -> String {
    let deno = bin_dir.join(if cfg!(windows) { "deno.exe" } else { "deno" });
    format!("deno:{}", deno.to_string_lossy())
}

#[cfg(test)]
mod hostile_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tuning_adds_only_what_is_set() {
        let mut args = vec![];
        Tuning::default().extend(&mut args);
        assert!(args.is_empty());
        Tuning {
            limit_rate_kbps: Some(512),
            cookies: Some(Cookies::Browser(Browser::Firefox)),
        }
        .extend(&mut args);
        assert_eq!(
            args,
            ["--limit-rate", "512K", "--cookies-from-browser", "firefox"]
        );
        // A cookies file goes in as `--cookies <path>`, in one argument whatever the path holds.
        let mut file_args = vec![];
        Tuning {
            limit_rate_kbps: None,
            cookies: Some(Cookies::File(PathBuf::from("C:\\data\\a b\\run-1-0.txt"))),
        }
        .extend(&mut file_args);
        assert_eq!(file_args, ["--cookies", "C:\\data\\a b\\run-1-0.txt"]);
    }

    #[test]
    fn browsers_round_trip_through_their_name_and_json() {
        for text in [
            "chrome", "edge", "firefox", "brave", "opera", "vivaldi", "chromium", "safari",
        ] {
            let browser = Browser::parse(text).unwrap();
            assert_eq!(browser.as_str(), text);
            assert_eq!(
                serde_json::to_string(&browser).unwrap(),
                format!("\"{text}\"")
            );
            assert_eq!(
                serde_json::from_str::<Browser>(&format!("\"{text}\"")).unwrap(),
                browser
            );
        }
        // Nothing yt-dlp would read as a profile path or a keyring.
        for bad in [
            "",
            "Chrome",
            "chrome:Default",
            "firefox+gnomekeyring",
            "--exec",
        ] {
            assert_eq!(Browser::parse(bad), None, "{bad}");
            assert!(
                serde_json::from_str::<Browser>(&format!("\"{bad}\"")).is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn only_http_urls_pass() {
        assert!(check_url("https://www.youtube.com/watch?v=jNQXAC9IVRw").is_ok());
        assert!(check_url("http://example.com/v").is_ok());
        for bad in [
            "--version",
            "--exec=calc.exe",
            "-o",
            "file:///etc/passwd",
            "C:\\Windows\\win.ini",
            " https://example.com",
            "ftp://example.com/v",
            "",
            "https://example.com/a b",
            "https://example.com/a
b --exec=calc",
            "https://example.com/a b",
            "https://example.com/a	b",
        ] {
            assert!(
                matches!(check_url(bad), Err(AppError::InvalidUrl(_))),
                "{bad}"
            );
        }
    }

    #[test]
    fn a_url_with_a_direction_override_is_refused() {
        // Built from the code point: the compiler refuses such a character in a literal.
        let rtl = char::from_u32(0x202e).unwrap();
        assert!(check_url(&format!("https://example.com/a{rtl}b")).is_err());
    }

    #[test]
    fn a_huge_url_is_refused_and_not_echoed_whole() {
        let at_the_limit = format!("https://e.test/{}", "a".repeat(MAX_URL_LEN - 15));
        assert!(check_url(&at_the_limit).is_ok());
        let huge = format!("https://e.test/{}", "a".repeat(5_000_000));
        let Err(AppError::InvalidUrl(message)) = check_url(&huge) else {
            panic!("a 5 MB URL must be refused")
        };
        assert!(
            message.len() < 300,
            "the error echoed {} bytes",
            message.len()
        );
        let Err(AppError::InvalidUrl(message)) = check_url(&"-".repeat(1_000_000)) else {
            panic!("an option must be refused")
        };
        assert!(message.len() < 300);
    }
}
