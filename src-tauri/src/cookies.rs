// A `cookies.txt` file exported from a browser, for the browsers whose own cookies yt-dlp
// cannot read on Windows (Chrome, Edge and Brave encrypt them "app-bound", issue 10927) and for
// choosing which account to use.
//
// yt-dlp REWRITES the cookie file it is given when it exits (checked with 2026.08.19: it adds its
// own YouTube cookies and saves them back), creates it if it is missing, and crashes on a
// read-only one. With three downloads at once, they would overwrite each other's copy of the
// user's file. So the app never hands yt-dlp the user's file: every run gets a private copy
// (`CookieCopy`) in the app's data folder, deleted when the run ends.
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use tauri::{AppHandle, Manager};

use crate::errors::AppError;

/// A cookie file is text and small; this only stops a wrong pick (a video, a disk image) from
/// being read whole into memory.
const MAX_BYTES: u64 = 10 * 1024 * 1024;

/// The first line of the Netscape format, with or without the word (what yt-dlp itself accepts).
const HEADERS: [&str; 2] = ["# netscape http cookie file", "# http cookie file"];

fn unusable(path: &Path, why: impl std::fmt::Display) -> AppError {
    AppError::CookiesUnavailable(format!("{}: {why}", path.display()))
}

/// Whether `path` can be used as the cookies file: an absolute path (never one that could be read as
/// a yt-dlp option) to an existing, readable, not-huge file that starts like a Netscape cookie
/// file. yt-dlp would say the last one itself, but only on the first download.
pub fn check_file(path: &Path) -> Result<(), AppError> {
    if !path.is_absolute() {
        return Err(unusable(path, "not an absolute path"));
    }
    let meta = fs::metadata(path).map_err(|e| unusable(path, e))?;
    if !meta.is_file() {
        return Err(unusable(path, "not a file"));
    }
    if meta.len() > MAX_BYTES {
        return Err(unusable(path, "too big to be a cookies file"));
    }
    let bytes = fs::read(path).map_err(|e| unusable(path, e))?;
    let text = String::from_utf8_lossy(&bytes);
    let first = text
        .trim_start_matches('\u{feff}')
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_lowercase();
    if HEADERS.iter().any(|header| first.starts_with(header)) {
        Ok(())
    } else {
        Err(unusable(
            path,
            "does not look like a Netscape format cookies file (it should start with \"# Netscape HTTP Cookie File\")",
        ))
    }
}

/// A private copy of the user's cookies file for ONE yt-dlp run, deleted when this is dropped
/// (when the run ends, or if it never starts). Keep it alive as long as the process runs.
#[derive(Debug)]
pub struct CookieCopy {
    path: PathBuf,
}

impl CookieCopy {
    /// Checks `source` and copies it into `dir`. `fs::read` + `fs::write` and not `fs::copy`:
    /// the copy must be writable (yt-dlp saves into it) even if the original is read-only.
    pub fn new(source: &Path, dir: &Path) -> Result<Self, AppError> {
        check_file(source)?;
        static NEXT: AtomicU64 = AtomicU64::new(0);
        create_private_dir(dir).map_err(|e| unusable(dir, e))?;
        let path = dir.join(format!(
            "run-{}-{}.txt",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let bytes = fs::read(source).map_err(|e| unusable(source, e))?;
        let mut file = create_private_file(&path).map_err(|e| unusable(&path, e))?;
        // Owned from here: if writing fails, the half-written copy goes with `copy`.
        let copy = Self { path };
        file.write_all(&bytes)
            .map_err(|e| unusable(&copy.path, e))?;
        Ok(copy)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// The folder of the copies, readable by the user only. On Windows the app's data
/// folder already inherits the user's own permissions (checked: SYSTEM, Administrators and the
/// user, nobody else); on Linux and macOS a new folder is 0755 by default, which lets other
/// users of the machine in.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(dir)
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

/// A new file (never an existing one or a link put there beforehand), created readable and
/// writable by the user only, so the cookies are never visible to others even for an instant.
fn create_private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

impl Drop for CookieCopy {
    fn drop(&mut self) {
        // Best effort: a copy that cannot be deleted is removed with the folder at the next start.
        let _ = fs::remove_file(&self.path);
    }
}

/// The folder of the private copies: inside the app's data folder, never the download folder.
pub fn run_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("cookies-run"))
        .map_err(|e| AppError::Unknown(format!("no app data folder: {e}")))
}

/// Deletes whatever a crash left in `dir` (copies whose run never got to end). Called once at
/// start, before any download runs.
pub fn remove_stale(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::TempDir;

    const VALID: &str =
        "# Netscape HTTP Cookie File\n.example.invalid\tTRUE\t/\tFALSE\t4102444800\tfake\tvalue\n";

    fn file(dir: &TempDir, name: &str, content: &str) -> PathBuf {
        let path = dir.0.join(name);
        fs::write(&path, content).unwrap();
        path
    }

    fn is_cookies_error(result: Result<(), AppError>) -> bool {
        matches!(result, Err(AppError::CookiesUnavailable(_)))
    }

    #[test]
    fn a_netscape_file_passes_in_every_form_yt_dlp_accepts() {
        let dir = TempDir::new("cookies-valid");
        for (name, content) in [
            ("a.txt", VALID.to_string()),
            ("no-word.txt", "# HTTP Cookie File\n".to_string()),
            ("blank-first.txt", format!("\n\n{VALID}")),
            ("bom.txt", format!("\u{feff}{VALID}")),
            ("crlf.txt", VALID.replace('\n', "\r\n")),
            ("lower.txt", VALID.to_lowercase()),
            ("header-only.txt", "# Netscape HTTP Cookie File".to_string()),
        ] {
            check_file(&file(&dir, name, &content)).unwrap_or_else(|e| panic!("{name}: {e}"));
        }
    }

    #[test]
    fn what_is_not_a_cookies_file_is_refused_with_its_path_and_why() {
        let dir = TempDir::new("cookies-invalid");
        for (name, content) in [
            ("junk.txt", "hello, this is not a cookie file"),
            ("empty.txt", ""),
            ("json.txt", "[{\"name\": \"x\"}]"),
        ] {
            assert!(
                is_cookies_error(check_file(&file(&dir, name, content))),
                "{name}"
            );
        }
        let error = check_file(&file(&dir, "junk2.txt", "nope"))
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("junk2.txt") && error.contains("Netscape"),
            "{error}"
        );
        // Missing, a folder, and a relative path (which could be read as an option).
        assert!(is_cookies_error(check_file(&dir.0.join("missing.txt"))));
        assert!(is_cookies_error(check_file(&dir.0)));
        assert!(is_cookies_error(check_file(Path::new("cookies.txt"))));
        assert!(is_cookies_error(check_file(Path::new("--exec=calc"))));
    }

    #[test]
    fn a_huge_file_is_refused_without_reading_it() {
        let dir = TempDir::new("cookies-huge");
        let path = dir.0.join("big.txt");
        let big = fs::File::create(&path).unwrap();
        big.set_len(MAX_BYTES + 1).unwrap();
        let error = check_file(&path).unwrap_err().to_string();
        assert!(error.contains("too big"), "{error}");
    }

    /// Cookies are sessions: no other user of the machine may read the copy, from the moment it
    /// exists.
    #[cfg(unix)]
    #[test]
    fn the_copy_and_its_folder_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("cookies-private");
        let source = file(&dir, "cookies.txt", VALID);
        let run = dir.0.join("run");
        let copy = CookieCopy::new(&source, &run).unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(copy.path()), 0o600);
        assert_eq!(mode(&run), 0o700);
    }

    #[test]
    fn a_copy_never_replaces_or_follows_something_already_there() {
        let dir = TempDir::new("cookies-no-clobber");
        let target = dir.0.join("existing.txt");
        fs::write(&target, "mine").unwrap();
        assert!(create_private_file(&target).is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "mine");
    }

    #[test]
    fn the_copy_has_the_content_and_goes_when_dropped() {
        let dir = TempDir::new("cookies-copy");
        let source = file(&dir, "cookies.txt", VALID);
        let run = dir.0.join("run");
        let copy = CookieCopy::new(&source, &run).unwrap();
        let copy_path = copy.path().to_path_buf();
        assert_eq!(fs::read_to_string(&copy_path).unwrap(), VALID);
        assert!(copy_path.starts_with(&run));
        // The user's file is where it was.
        assert_eq!(fs::read_to_string(&source).unwrap(), VALID);
        drop(copy);
        assert!(!copy_path.exists());
        assert!(source.exists());
    }

    #[test]
    fn every_run_gets_its_own_copy_so_yt_dlp_processes_never_share_one() {
        let dir = TempDir::new("cookies-copies");
        let source = file(&dir, "cookies.txt", VALID);
        let run = dir.0.join("run");
        let a = CookieCopy::new(&source, &run).unwrap();
        let b = CookieCopy::new(&source, &run).unwrap();
        assert_ne!(a.path(), b.path());
        // One process rewriting its copy (as yt-dlp does) changes neither the other nor the original.
        fs::write(a.path(), "rewritten").unwrap();
        assert_eq!(fs::read_to_string(b.path()).unwrap(), VALID);
        assert_eq!(fs::read_to_string(&source).unwrap(), VALID);
        drop(a);
        assert!(b.path().exists());
    }

    #[test]
    fn the_copy_is_writable_even_if_the_original_is_read_only() {
        let dir = TempDir::new("cookies-readonly");
        let source = file(&dir, "cookies.txt", VALID);
        let mut permissions = fs::metadata(&source).unwrap().permissions();
        permissions.set_readonly(true);
        fs::set_permissions(&source, permissions.clone()).unwrap();
        let copy = CookieCopy::new(&source, &dir.0.join("run")).unwrap();
        // yt-dlp saves into it when it exits: that must work.
        fs::write(copy.path(), "saved").unwrap();
        drop(copy);
        // Let the temp folder be deleted afterwards.
        #[allow(clippy::permissions_set_readonly_false)]
        permissions.set_readonly(false);
        fs::set_permissions(&source, permissions).unwrap();
    }

    #[test]
    fn a_source_that_went_missing_is_a_cookies_error_and_nothing_is_created() {
        let dir = TempDir::new("cookies-gone");
        let run = dir.0.join("run");
        let result = CookieCopy::new(&dir.0.join("gone.txt"), &run);
        assert!(matches!(result, Err(AppError::CookiesUnavailable(_))));
        assert!(!run.exists());
    }

    #[test]
    fn leftovers_of_a_crash_are_removed_at_start() {
        let dir = TempDir::new("cookies-stale");
        let run = dir.0.join("run");
        fs::create_dir_all(&run).unwrap();
        fs::write(run.join("run-1-0.txt"), VALID).unwrap();
        remove_stale(&run);
        assert!(!run.exists());
        // Nothing there is not a problem.
        remove_stale(&run);
    }
}
