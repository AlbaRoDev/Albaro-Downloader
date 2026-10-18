// Settings that shape every yt-dlp run: the speed limit and the browser whose cookies
// it may use. Stored in the `settings` table like the output folder; the number of
// simultaneous downloads (queue.rs) is read here too, so the frontend gets all three at once.
// Nothing here is persisted per download: each one reads them when it starts.
use serde::Serialize;

use std::path::{Path, PathBuf};

use crate::{
    cookies::{self, CookieCopy},
    db::Db,
    errors::AppError,
    queue,
    ytdlp::{Browser, Cookies, Tuning},
};

const LIMIT_RATE_KEY: &str = "limit_rate_kbps";
const COOKIES_KEY: &str = "cookies_browser";
const COOKIES_FILE_KEY: &str = "cookies_file";
const NOTIFICATIONS_KEY: &str = "notifications";

/// What the settings panel shows (`DownloadSettings` in ipc.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSettings {
    pub max_concurrent: u32,
    /// The limit for all downloads together, in KB/s. `None`: no limit.
    pub limit_rate_kbps: Option<u32>,
    /// `None`: cookies are never read (the default). At most one of the two cookie sources is set.
    pub cookies_browser: Option<Browser>,
    /// The `cookies.txt` the user picked, as a path.
    pub cookies_file: Option<String>,
    /// Whether a notification says the queue is done. On by default.
    pub notifications: bool,
}

/// The global speed limit. A missing, empty or unreadable value (not a number, or 0) means no
/// limit, as an unreadable `max_concurrent` means the default: a broken setting must not slow
/// every download down.
pub fn limit_rate_kbps(db: &Db) -> Result<Option<u32>, AppError> {
    Ok(db
        .setting(LIMIT_RATE_KEY)?
        .and_then(|value| value.parse().ok())
        .filter(|&kbps| kbps >= 1))
}

/// `None` removes the limit. It reaches downloads that start afterwards: one already running
/// keeps the rate it started with (yt-dlp reads it once).
pub fn set_limit_rate_kbps(db: &Db, kbps: Option<u32>) -> Result<(), AppError> {
    match kbps {
        Some(0) => Err(AppError::Unknown(
            "the speed limit must be at least 1 KB/s".into(),
        )),
        Some(kbps) => db.set_setting(LIMIT_RATE_KEY, &kbps.to_string()),
        None => db.set_setting(LIMIT_RATE_KEY, ""),
    }
}

/// Whether to notify when the queue finishes. On unless explicitly turned off: a missing or
/// unreadable value must not silence the app.
pub fn notifications(db: &Db) -> Result<bool, AppError> {
    Ok(db.setting(NOTIFICATIONS_KEY)?.as_deref() != Some("0"))
}

pub fn set_notifications(db: &Db, on: bool) -> Result<(), AppError> {
    db.set_setting(NOTIFICATIONS_KEY, if on { "1" } else { "0" })
}

/// The browser to read cookies from; an unknown or empty value means none.
pub fn cookies_browser(db: &Db) -> Result<Option<Browser>, AppError> {
    Ok(db
        .setting(COOKIES_KEY)?
        .and_then(|text| Browser::parse(&text)))
}

/// The `cookies.txt` to take cookies from; an empty value means none.
pub fn cookies_file(db: &Db) -> Result<Option<String>, AppError> {
    Ok(db
        .setting(COOKIES_FILE_KEY)?
        .filter(|path| !path.trim().is_empty()))
}

/// Chooses a browser, or `None` for no cookies at all. Either way a cookies file is dropped: there
/// is only one source at a time.
pub fn set_cookies_browser(db: &Db, browser: Option<Browser>) -> Result<(), AppError> {
    db.set_setting(COOKIES_KEY, browser.map_or("", Browser::as_str))?;
    db.set_setting(COOKIES_FILE_KEY, "")
}

/// Chooses a `cookies.txt` if it can be used (`cookies::check_file`), and drops any
/// browser. Otherwise `cookiesUnavailable` and nothing changes. The path is stored as text, so
/// one that is not UTF-8 is refused too.
pub fn set_cookies_file(db: &Db, path: &Path) -> Result<(), AppError> {
    cookies::check_file(path)?;
    let text = path.to_str().ok_or_else(|| {
        AppError::CookiesUnavailable(format!(
            "{}: the path is not valid UTF-8 and cannot be saved",
            path.display()
        ))
    })?;
    db.set_setting(COOKIES_FILE_KEY, text)?;
    db.set_setting(COOKIES_KEY, "")
}

pub fn download_settings(db: &Db) -> Result<DownloadSettings, AppError> {
    Ok(DownloadSettings {
        max_concurrent: queue::max_concurrent(db)?,
        limit_rate_kbps: limit_rate_kbps(db)?,
        cookies_browser: cookies_browser(db)?,
        cookies_file: cookies_file(db)?,
        notifications: notifications(db)?,
    })
}

/// The cookies to use, if any, and the private copy of the user's file that holds them while the
/// run lasts. A cookies file has priority (it can only be set by dropping the browser, so both are
/// never set at once). The copy has to be kept alive as long as the yt-dlp process: it deletes the
/// file when dropped. `run_dir` is where copies go (`cookies::run_dir`).
pub fn cookies(db: &Db, run_dir: &Path) -> Result<(Option<Cookies>, Option<CookieCopy>), AppError> {
    if let Some(file) = cookies_file(db)? {
        let copy = CookieCopy::new(&PathBuf::from(file), run_dir)?;
        let used = Cookies::File(copy.path().to_path_buf());
        return Ok((Some(used), Some(copy)));
    }
    Ok((cookies_browser(db)?.map(Cookies::Browser), None))
}

/// What one download adds to its arguments, and the cookie copy to keep alive while it runs.
/// yt-dlp's `--limit-rate` is per process, so the global limit is split among the downloads that
/// may run at once: together they can never go over it. The price is that a lone download gets
/// only its share (a limit of 3 MB/s with 3 slots gives 1 MB/s each, also when only one is
/// running).
// Known limit: a static split by the slot count; sharing the real total needs the queue to
// re-tune running downloads, which yt-dlp cannot do without a restart.
pub fn tuning(db: &Db, run_dir: &Path) -> Result<(Tuning, Option<CookieCopy>), AppError> {
    let slots = queue::max_concurrent(db)?;
    let (cookies, copy) = cookies(db, run_dir)?;
    let tuning = Tuning {
        limit_rate_kbps: limit_rate_kbps(db)?.map(|total| (total / slots).max(1)),
        cookies,
    };
    Ok((tuning, copy))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::TempDir;

    #[test]
    fn notifications_are_on_unless_turned_off() {
        let db = Db::open_in_memory().unwrap();
        assert!(notifications(&db).unwrap());
        set_notifications(&db, false).unwrap();
        assert!(!notifications(&db).unwrap());
        assert!(!download_settings(&db).unwrap().notifications);
        set_notifications(&db, true).unwrap();
        assert!(download_settings(&db).unwrap().notifications);
        // Whatever else is stored (a hand-edited database) leaves them on.
        db.set_setting(NOTIFICATIONS_KEY, "").unwrap();
        assert!(notifications(&db).unwrap());
        db.set_setting(NOTIFICATIONS_KEY, "off").unwrap();
        assert!(notifications(&db).unwrap());
    }

    const VALID: &str =
        "# Netscape HTTP Cookie File\n.example.invalid\tTRUE\t/\tFALSE\t4102444800\tfake\tvalue\n";

    // Where copies would go; these tests never use a cookies file, so nothing is created there.
    fn run_dir() -> PathBuf {
        PathBuf::from("no-such-folder-cookies-run")
    }

    #[test]
    fn the_limit_defaults_to_none_and_rejects_zero() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(limit_rate_kbps(&db).unwrap(), None);
        assert!(set_limit_rate_kbps(&db, Some(0)).is_err());
        assert_eq!(limit_rate_kbps(&db).unwrap(), None);
        set_limit_rate_kbps(&db, Some(2048)).unwrap();
        assert_eq!(limit_rate_kbps(&db).unwrap(), Some(2048));
        set_limit_rate_kbps(&db, None).unwrap();
        assert_eq!(limit_rate_kbps(&db).unwrap(), None);
    }

    #[test]
    fn an_unreadable_limit_means_no_limit() {
        let db = Db::open_in_memory().unwrap();
        for unreadable in ["abc", "", "-5", "0", "1.5", "10M"] {
            db.set_setting(LIMIT_RATE_KEY, unreadable).unwrap();
            assert_eq!(limit_rate_kbps(&db).unwrap(), None, "{unreadable:?}");
        }
    }

    #[test]
    fn the_browser_defaults_to_none_and_ignores_unknown_values() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(cookies_browser(&db).unwrap(), None);
        set_cookies_browser(&db, Some(Browser::Edge)).unwrap();
        assert_eq!(cookies_browser(&db).unwrap(), Some(Browser::Edge));
        set_cookies_browser(&db, None).unwrap();
        assert_eq!(cookies_browser(&db).unwrap(), None);
        // A hand-edited database never turns into a yt-dlp profile path or keyring.
        for unknown in ["Chrome", "chrome:Default", "firefox+gnomekeyring", "x"] {
            db.set_setting(COOKIES_KEY, unknown).unwrap();
            assert_eq!(cookies_browser(&db).unwrap(), None, "{unknown:?}");
        }
    }

    #[test]
    fn the_settings_come_together_with_their_defaults() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(
            download_settings(&db).unwrap(),
            DownloadSettings {
                max_concurrent: 3,
                limit_rate_kbps: None,
                cookies_browser: None,
                cookies_file: None,
                notifications: true,
            }
        );
        let json = serde_json::to_value(download_settings(&db).unwrap()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "maxConcurrent": 3,
                "limitRateKbps": null,
                "cookiesBrowser": null,
                "cookiesFile": null,
                "notifications": true,
            })
        );
    }

    #[test]
    fn the_limit_is_split_among_the_slots_and_never_below_one() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(tuning(&db, &run_dir()).unwrap().0, Tuning::default());
        set_limit_rate_kbps(&db, Some(3000)).unwrap();
        // The default is 3 slots.
        assert_eq!(
            tuning(&db, &run_dir()).unwrap().0.limit_rate_kbps,
            Some(1000)
        );
        queue::set_max_concurrent(&db, 1).unwrap();
        assert_eq!(
            tuning(&db, &run_dir()).unwrap().0.limit_rate_kbps,
            Some(3000)
        );
        queue::set_max_concurrent(&db, 8).unwrap();
        set_limit_rate_kbps(&db, Some(4)).unwrap();
        assert_eq!(tuning(&db, &run_dir()).unwrap().0.limit_rate_kbps, Some(1));
        set_cookies_browser(&db, Some(Browser::Firefox)).unwrap();
        assert_eq!(
            tuning(&db, &run_dir()).unwrap().0.cookies,
            Some(Cookies::Browser(Browser::Firefox))
        );
    }

    #[test]
    fn a_cookies_file_replaces_the_browser_and_the_other_way_round() {
        let db = Db::open_in_memory().unwrap();
        let dir = TempDir::new("cookies-setting");
        let file = dir.0.join("cookies.txt");
        std::fs::write(&file, VALID).unwrap();
        assert_eq!(cookies_file(&db).unwrap(), None);

        set_cookies_browser(&db, Some(Browser::Firefox)).unwrap();
        set_cookies_file(&db, &file).unwrap();
        assert_eq!(cookies_file(&db).unwrap().as_deref(), file.to_str());
        assert_eq!(cookies_browser(&db).unwrap(), None);

        set_cookies_browser(&db, Some(Browser::Edge)).unwrap();
        assert_eq!(cookies_file(&db).unwrap(), None);
        assert_eq!(cookies_browser(&db).unwrap(), Some(Browser::Edge));

        // "No cookies" clears whichever there was.
        set_cookies_file(&db, &file).unwrap();
        set_cookies_browser(&db, None).unwrap();
        assert_eq!(cookies_file(&db).unwrap(), None);
        assert_eq!(cookies_browser(&db).unwrap(), None);
    }

    #[test]
    fn a_file_that_cannot_be_used_changes_nothing() {
        let db = Db::open_in_memory().unwrap();
        let dir = TempDir::new("cookies-setting-bad");
        let junk = dir.0.join("junk.txt");
        std::fs::write(&junk, "not cookies").unwrap();
        set_cookies_browser(&db, Some(Browser::Firefox)).unwrap();
        for bad in [
            junk,
            dir.0.join("missing.txt"),
            dir.0.clone(),
            PathBuf::from("rel.txt"),
        ] {
            let error = set_cookies_file(&db, &bad).unwrap_err();
            assert!(
                matches!(error, AppError::CookiesUnavailable(_)),
                "{bad:?}: {error}"
            );
        }
        assert_eq!(cookies_browser(&db).unwrap(), Some(Browser::Firefox));
        assert_eq!(cookies_file(&db).unwrap(), None);
    }

    #[test]
    fn an_empty_stored_file_means_none() {
        let db = Db::open_in_memory().unwrap();
        for empty in ["", "   "] {
            db.set_setting(COOKIES_FILE_KEY, empty).unwrap();
            assert_eq!(cookies_file(&db).unwrap(), None, "{empty:?}");
        }
    }

    #[test]
    fn with_a_file_the_download_gets_its_own_copy_and_it_goes_with_the_guard() {
        let db = Db::open_in_memory().unwrap();
        let dir = TempDir::new("cookies-tuning");
        let file = dir.0.join("cookies.txt");
        std::fs::write(&file, VALID).unwrap();
        set_cookies_file(&db, &file).unwrap();
        let run = dir.0.join("run");

        let (tuning, copy) = tuning(&db, &run).unwrap();
        let copy = copy.expect("a copy for the run");
        // yt-dlp is given the copy's path, never the user's file.
        assert_eq!(
            tuning.cookies,
            Some(Cookies::File(copy.path().to_path_buf()))
        );
        assert_ne!(copy.path(), file.as_path());
        let path = copy.path().to_path_buf();
        assert!(path.exists());
        drop(copy);
        assert!(!path.exists());
        assert!(file.exists());

        // A browser needs no copy.
        set_cookies_browser(&db, Some(Browser::Firefox)).unwrap();
        let (tuning, copy) = super::tuning(&db, &run).unwrap();
        assert!(copy.is_none());
        assert_eq!(tuning.cookies, Some(Cookies::Browser(Browser::Firefox)));
    }

    #[test]
    fn a_chosen_file_that_has_since_gone_is_a_cookies_error_at_download_time() {
        let db = Db::open_in_memory().unwrap();
        let dir = TempDir::new("cookies-gone-later");
        let file = dir.0.join("cookies.txt");
        std::fs::write(&file, VALID).unwrap();
        set_cookies_file(&db, &file).unwrap();
        std::fs::remove_file(&file).unwrap();
        let error = tuning(&db, &dir.0.join("run")).unwrap_err();
        assert!(matches!(error, AppError::CookiesUnavailable(_)), "{error}");
    }
}
