// Keeps yt-dlp current without touching the installer. The bundled sidecar stays as it
// is; a newer one is downloaded from yt-dlp's GitHub releases into the app's data folder, checked
// against the release's checksum file (whose OpenPGP signature is verified first),
// smoke-tested and moved into place. `program` then tells
// the runner which one to launch. Everything here is blocking and runs on its own threads.
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex, PoisonError,
    },
    thread,
    time::{Duration, Instant},
};

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::{process::Command, ShellExt};

use crate::errors::AppError;

const LATEST_URL: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";
const DOWNLOAD_BASE: &str = "https://github.com/yt-dlp/yt-dlp/releases/download";
const CHECK_EVERY: Duration = Duration::from_secs(12 * 60 * 60);
/// A failing download asks for an update at once (`update_now`), but not more often than this: a
/// playlist of 300 broken entries would otherwise hit GitHub 300 times.
const MIN_GAP: Duration = Duration::from_secs(60);
const TIMEOUT: Duration = Duration::from_secs(300);
const MAX_BINARY: u64 = 200 * 1024 * 1024;
const EXE: &str = if cfg!(windows) { ".exe" } else { "" };
/// A checksum file or its signature is a couple of KB; this only stops a runaway answer.
const MAX_SUMS: u64 = 1024 * 1024;
/// The only servers the updater talks to: the API that names the latest release, the
/// page that serves the assets and the two hosts GitHub redirects asset downloads to. Redirects
/// are followed by hand, each one checked. If GitHub moves its downloads elsewhere, updating stops
/// (the bundled yt-dlp stays) until the list is changed: failing closed is the point.
const ALLOWED_HOSTS: [&str; 4] = [
    "api.github.com",
    "github.com",
    "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
];
const MAX_REDIRECTS: usize = 5;

/// Bumped each time a new yt-dlp is installed, so a caller can tell whether an update happened
/// while it waited.
static GENERATION: AtomicU32 = AtomicU32::new(0);
/// When the last check ended. The lock is held for the whole check: concurrent callers queue.
static LAST_CHECK: Mutex<Option<Instant>> = Mutex::new(None);

/// The release asset for this system; the same names `scripts/fetch-sidecars.mjs` uses.
fn asset_name() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("yt-dlp.exe"),
        ("windows", "aarch64") => Some("yt-dlp_arm64.exe"),
        ("linux", "x86_64") => Some("yt-dlp_linux"),
        ("linux", "aarch64") => Some("yt-dlp_linux_aarch64"),
        ("macos", _) => Some("yt-dlp_macos"),
        _ => None,
    }
}

fn io(context: &str, e: impl std::fmt::Display) -> AppError {
    AppError::Unknown(format!("yt-dlp update: {context}: {e}"))
}

// ---- Pure parts (tested with sample responses) ----

/// The tag of the latest release (`2026.08.19`) out of GitHub's API answer. Only digits and
/// dots pass: it ends up in a download URL and in a file name.
fn parse_tag(json: &str) -> Result<String, AppError> {
    let value: serde_json::Value = serde_json::from_str(json).map_err(|e| io("release", e))?;
    let tag = value["tag_name"].as_str().unwrap_or_default();
    if version_parts(tag).is_none() {
        return Err(io("release", format!("unexpected tag {tag:?}")));
    }
    Ok(tag.to_string())
}

/// The SHA-256 listed for `name` in a `SHA2-256SUMS` file (`<hash>  <name>` lines).
fn find_checksum(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|line| {
        let (hash, file) = line.split_once(char::is_whitespace)?;
        let file = file.trim().trim_start_matches('*');
        (file == name && hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
    })
}

/// `2026.08.19` (or `2026.08.19.232802`) as numbers; `None` if anything else is in it.
fn version_parts(version: &str) -> Option<Vec<u64>> {
    version.split('.').map(|p| p.parse().ok()).collect()
}

fn is_newer(candidate: &str, current: &str) -> bool {
    match (version_parts(candidate), version_parts(current)) {
        (Some(candidate), Some(current)) => candidate > current,
        _ => false,
    }
}

// ---- The files ----

fn dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join("ytdlp"))
        .map_err(|e| io("no app data folder", e))
}

/// Each version has its own file, so installing never overwrites a yt-dlp that a running
/// download holds open (Windows would refuse).
fn file_name(version: &str) -> String {
    format!("yt-dlp-{version}{EXE}")
}

/// Every installed version in `dir`. A half-written download is `yt-dlp-<v>.new`, which does not
/// parse as a version, so it never shows up here.
fn installed_all(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().into_string().ok()?;
            let version = name.strip_prefix("yt-dlp-")?.strip_suffix(EXE)?;
            version_parts(version)?;
            Some((version.to_string(), entry.path()))
        })
        .collect()
}

/// The newest installed version.
fn installed(dir: &Path) -> Option<(String, PathBuf)> {
    installed_all(dir)
        .into_iter()
        .max_by_key(|(version, _)| version_parts(version))
}

/// Deletes the downloaded yt-dlps except `keep`. Best effort: one a download still runs cannot
/// be deleted on Windows, and the next check tries again.
fn prune(dir: &Path, keep: Option<&str>) {
    for (version, path) in installed_all(dir) {
        if Some(version.as_str()) != keep {
            let _ = fs::remove_file(path);
        }
    }
}

/// The updated yt-dlp to launch, if there is one. The caller falls back to the bundled sidecar
/// otherwise.
pub fn program(app: &AppHandle) -> Option<PathBuf> {
    installed(&dir(app).ok()?).map(|(_, path)| path)
}

/// The updated yt-dlp does not start: delete it, so the bundled one is used from now on.
pub fn discard(app: &AppHandle) {
    if let Ok(dir) = dir(app) {
        prune(&dir, None);
    }
}

/// Writes `body` next to its final place, checks its SHA-256 against `expected`, runs `smoke` on
/// it and renames it to `yt-dlp-<version>`; older versions are then deleted. A failure at any
/// step leaves nothing behind. The rename is the atomic step: the final name only ever holds a
/// complete, checked file.
fn install(
    dir: &Path,
    version: &str,
    mut body: impl Read,
    expected: &str,
    smoke: impl FnOnce(&Path) -> Result<(), AppError>,
) -> Result<PathBuf, AppError> {
    fs::create_dir_all(dir).map_err(|e| io("cannot create the folder", e))?;
    let partial = dir.join(format!("yt-dlp-{version}.new{EXE}"));
    let result = (|| {
        let mut file = File::create(&partial).map_err(|e| io("cannot write", e))?;
        let mut hasher = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let read = body.read(&mut buffer).map_err(|e| io("download", e))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            file.write_all(&buffer[..read])
                .map_err(|e| io("cannot write", e))?;
        }
        // Closed before it runs: Windows will not start a file that is still open for writing.
        drop(file);
        let got = format!("{:x}", hasher.finalize());
        if !got.eq_ignore_ascii_case(expected) {
            return Err(io("checksum mismatch", format!("{got} != {expected}")));
        }
        make_executable(&partial)?;
        smoke(&partial)
    })();
    if let Err(err) = result {
        let _ = fs::remove_file(&partial);
        return Err(err);
    }
    let target = dir.join(file_name(version));
    if let Err(e) = fs::rename(&partial, &target) {
        let _ = fs::remove_file(&partial);
        return Err(io("cannot move it into place", e));
    }
    prune(dir, Some(version));
    Ok(target)
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), AppError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))
        .map_err(|e| io("cannot make it executable", e))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), AppError> {
    Ok(())
}

// ---- Network and processes ----

/// Whether the updater may connect to `url`: https, port 443, no credentials, and one of
/// `ALLOWED_HOSTS`.
pub(crate) fn allowed(url: &str) -> bool {
    let Ok(uri) = url.parse::<ureq::http::Uri>() else {
        return false;
    };
    let Some(authority) = uri.authority() else {
        return false;
    };
    uri.scheme_str() == Some("https")
        && !authority.as_str().contains('@')
        && uri.port_u16().is_none_or(|port| port == 443)
        && ALLOWED_HOSTS.contains(&authority.host().to_ascii_lowercase().as_str())
}

/// GET with redirects followed by hand: every address, the first and each redirect's, must pass
/// `allowed`. A redirect to anywhere else is an error, not a download.
fn get(url: &str) -> Result<ureq::http::Response<ureq::Body>, AppError> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .https_only(true)
        .max_redirects(0)
        .max_redirects_will_error(false)
        .build()
        .into();
    let mut url = url.to_string();
    for _ in 0..=MAX_REDIRECTS {
        if !allowed(&url) {
            return Err(io(
                &url,
                "this server is not on the list the updater may use",
            ));
        }
        let response = agent
            // GitHub's API rejects requests without a User-Agent.
            .get(&url)
            .header("User-Agent", "albaro-downloader")
            .call()
            .map_err(|e| io(&url, e))?;
        if !response.status().is_redirection() {
            return Ok(response);
        }
        url = response
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .ok_or_else(|| io(&url, "a redirect without a location"))?
            .to_string();
    }
    Err(io(&url, "too many redirects"))
}

fn get_text(url: &str) -> Result<String, AppError> {
    get(url)?
        .body_mut()
        .read_to_string()
        .map_err(|e| io(url, e))
}

fn get_bytes(url: &str, limit: u64) -> Result<Vec<u8>, AppError> {
    get(url)?
        .body_mut()
        .with_config()
        .limit(limit)
        .read_to_vec()
        .map_err(|e| io(url, e))
}

/// The SHA-256 of `asset` out of a release's checksum file, once the file's signature has been
/// checked: made by yt-dlp's release key. Nothing in the list is trusted before that.
fn verified_checksum(sums: &[u8], signature: &[u8], asset: &str) -> Result<String, AppError> {
    super::openpgp::verify(sums, signature).map_err(|e| io("the signature of SHA2-256SUMS", e))?;
    let text = std::str::from_utf8(sums).map_err(|e| io("SHA2-256SUMS", e))?;
    find_checksum(text, asset).ok_or_else(|| io("SHA2-256SUMS", format!("no checksum for {asset}")))
}

/// `--version` of a yt-dlp; stdout trimmed.
fn version_of(command: Command) -> Result<String, AppError> {
    // Runs on one of our own threads, never on the async runtime, so blocking here is fine.
    let output = tauri::async_runtime::block_on(command.args(["--version"]).output())
        .map_err(|e| io("cannot run yt-dlp --version", e))?;
    if !output.status.success() {
        return Err(io("yt-dlp --version", "failed"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Looks for a newer yt-dlp and installs it. `Some(version)` when it did.
fn check(app: &AppHandle) -> Result<Option<String>, AppError> {
    let asset = asset_name().ok_or_else(|| io("no build for this system", "unsupported"))?;
    let dir = dir(app)?;
    let mut best = version_of(
        app.shell()
            .sidecar("yt-dlp")
            .map_err(|e| io("bundled yt-dlp", e))?,
    )?;
    // An update of the app can bring a yt-dlp newer than the downloaded one: that one is stale.
    match installed(&dir) {
        Some((version, _)) if is_newer(&version, &best) => best = version,
        _ => prune(&dir, None),
    }
    let tag = parse_tag(&get_text(LATEST_URL)?)?;
    if !is_newer(&tag, &best) {
        return Ok(None);
    }
    let base = format!("{DOWNLOAD_BASE}/{tag}");
    // The checksum file is trusted only if yt-dlp's release key signed it; the binary
    // must then match the checksum, and run `--version` as the release it came from.
    let expected = verified_checksum(
        &get_bytes(&format!("{base}/SHA2-256SUMS"), MAX_SUMS)?,
        &get_bytes(&format!("{base}/SHA2-256SUMS.sig"), MAX_SUMS)?,
        asset,
    )?;
    let mut response = get(&format!("{base}/{asset}"))?;
    let body = response.body_mut().with_config().limit(MAX_BINARY).reader();
    install(&dir, &tag, body, &expected, |path| {
        let got = version_of(app.shell().command(path))?;
        if got == tag {
            Ok(())
        } else {
            Err(io("smoke test", format!("reports {got}, expected {tag}")))
        }
    })?;
    GENERATION.fetch_add(1, Ordering::SeqCst);
    Ok(Some(tag))
}

/// One check, unless one ended less than `min_gap` ago. Errors are logged: updating is never
/// allowed to break anything.
fn refresh(app: &AppHandle, min_gap: Duration) {
    let mut last = LAST_CHECK.lock().unwrap_or_else(PoisonError::into_inner);
    if last.is_some_and(|at| at.elapsed() < min_gap) {
        return;
    }
    match check(app) {
        Ok(Some(version)) => eprintln!("yt-dlp updated to {version}"),
        Ok(None) => {}
        Err(err) => eprintln!("{err}"),
    }
    *last = Some(Instant::now());
}

/// Checks at start and every `CHECK_EVERY`, in the background.
pub fn start(app: AppHandle) {
    thread::spawn(move || loop {
        refresh(&app, Duration::ZERO);
        thread::sleep(CHECK_EVERY);
    });
}

/// A download failed in a way that looks like the site changed: update now (waiting for a check
/// already running) and say whether a new yt-dlp got installed meanwhile, which is the only case
/// where trying again can help. Blocks: call it from a thread of its own.
pub fn update_now(app: &AppHandle) -> bool {
    let before = GENERATION.load(Ordering::SeqCst);
    refresh(app, MIN_GAP);
    GENERATION.load(Ordering::SeqCst) != before
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;
    use crate::test_util::TempDir;

    // Trimmed by hand from GitHub's `releases/latest` answer: the only field read is `tag_name`.
    const RELEASE: &str = r#"{"url":"https://api.github.com/repos/yt-dlp/yt-dlp/releases/1",
        "tag_name":"2026.08.19","name":"yt-dlp 2026.08.19","draft":false,"prerelease":false,
        "assets":[{"name":"yt-dlp.exe"},{"name":"SHA2-256SUMS"}]}"#;

    // The real checksum file and signature of release 2026.08.19 (see openpgp.rs).
    const REAL_SUMS: &[u8] =
        include_bytes!("../../../tests/fixtures/yt-dlp-2026.08.19-SHA2-256SUMS");
    const REAL_SIG: &[u8] =
        include_bytes!("../../../tests/fixtures/yt-dlp-2026.08.19-SHA2-256SUMS.sig");

    #[test]
    fn a_checksum_is_trusted_only_from_a_file_the_release_key_signed() {
        let hash = verified_checksum(REAL_SUMS, REAL_SIG, "yt-dlp.exe").unwrap();
        assert_eq!(hash.len(), 64);
        assert_eq!(
            Some(hash),
            find_checksum(std::str::from_utf8(REAL_SUMS).unwrap(), "yt-dlp.exe")
        );
        // A forged line, the same signature: refused, and nothing is read from the list.
        let text = std::str::from_utf8(REAL_SUMS).unwrap();
        let forged = text.replacen(
            &find_checksum(text, "yt-dlp.exe").unwrap(),
            &"0".repeat(64),
            1,
        );
        let err = verified_checksum(forged.as_bytes(), REAL_SIG, "yt-dlp.exe").unwrap_err();
        assert!(err.to_string().contains("signature"), "{err}");
        // No signature, or junk in its place.
        assert!(verified_checksum(REAL_SUMS, b"", "yt-dlp.exe").is_err());
        assert!(verified_checksum(REAL_SUMS, REAL_SUMS, "yt-dlp.exe").is_err());
        // A real signature with a file name that is not in the list.
        assert!(verified_checksum(REAL_SUMS, REAL_SIG, "yt-dlp_nonexistent").is_err());
    }

    #[test]
    fn a_request_to_an_unlisted_server_is_refused_before_any_connection() {
        let err = get("https://example.com/yt-dlp.exe").err().unwrap();
        assert!(err.to_string().contains("not on the list"), "{err}");
        let err = get("http://github.com/x").err().unwrap();
        assert!(err.to_string().contains("not on the list"), "{err}");
    }

    #[test]
    fn the_updater_talks_only_to_github_over_https_and_follows_no_stranger() {
        for ok in [
            "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest",
            "https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe",
            "https://release-assets.githubusercontent.com/github-production-release-asset/1/x?sp=r",
            "https://objects.githubusercontent.com/x",
            "https://GitHub.com:443/x",
        ] {
            assert!(allowed(ok), "{ok}");
        }
        for bad in [
            "http://github.com/x",
            "https://example.com/x",
            "https://github.com.evil.test/x",
            "https://evil.test/github.com",
            "https://evil.test@github.com/x",
            "https://github.com@evil.test/x",
            "https://user:pw@github.com/x",
            "https://github.com:8443/x",
            "https://raw.githubusercontent.com/x",
            "https://gist.githubusercontent.com/x",
            "https://githubusercontent.com/x",
            "https://sub.github.com/x",
            "file:///C:/x",
            "//github.com/x",
            "github.com/x",
            "",
        ] {
            assert!(!allowed(bad), "{bad}");
        }
    }

    // The format of the release's file: `<sha256>  <asset>` (hashes made up).
    const SUMS: &str = "\
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  yt-dlp
BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB  yt-dlp.exe
cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc *yt-dlp_linux
dddddddd  yt-dlp_short
";

    fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    #[test]
    fn reads_the_tag_and_refuses_anything_that_is_not_a_version() {
        assert_eq!(parse_tag(RELEASE).unwrap(), "2026.08.19");
        for bad in [
            "{}",
            "not json",
            r#"{"tag_name":null}"#,
            r#"{"tag_name":"../evil"}"#,
            r#"{"tag_name":"2026.08.19/x"}"#,
            r#"{"tag_name":"nightly"}"#,
        ] {
            assert!(parse_tag(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn finds_the_checksum_of_exactly_that_asset() {
        assert_eq!(
            find_checksum(SUMS, "yt-dlp.exe").unwrap(),
            "b".repeat(64),
            "lowercased, and not the line of `yt-dlp`"
        );
        assert_eq!(find_checksum(SUMS, "yt-dlp").unwrap(), "a".repeat(64));
        assert_eq!(find_checksum(SUMS, "yt-dlp_linux").unwrap(), "c".repeat(64));
        assert_eq!(find_checksum(SUMS, "yt-dlp_short"), None, "not a SHA-256");
        assert_eq!(find_checksum(SUMS, "yt-dlp_macos"), None);
    }

    #[test]
    fn versions_compare_by_number_not_by_text() {
        assert!(is_newer("2026.08.19", "2026.08.18"));
        assert!(is_newer("2026.10.01", "2026.9.30"), "10 > 9");
        assert!(is_newer("2026.08.19.232802", "2026.08.19"));
        assert!(!is_newer("2026.08.19", "2026.08.19"));
        assert!(!is_newer("2026.08.18", "2026.08.19"));
        assert!(!is_newer("garbage", "2026.08.19"));
        assert!(!is_newer("2026.08.19", "garbage"));
    }

    #[test]
    fn the_newest_installed_version_wins_and_leftovers_are_ignored() {
        let tmp = TempDir::new("ytdlp-installed");
        assert_eq!(installed(&tmp.0), None);
        for name in [
            file_name("2026.08.19"),
            file_name("2026.10.01"),
            file_name("2026.9.30"),
            format!("yt-dlp-2027.01.01.new{EXE}"),
            "notes.txt".into(),
        ] {
            fs::write(tmp.0.join(name), b"x").unwrap();
        }
        let (version, path) = installed(&tmp.0).unwrap();
        assert_eq!(version, "2026.10.01");
        assert_eq!(path, tmp.0.join(file_name("2026.10.01")));
        prune(&tmp.0, Some("2026.10.01"));
        assert_eq!(installed_all(&tmp.0).len(), 1);
        prune(&tmp.0, None);
        assert_eq!(installed(&tmp.0), None);
        assert!(tmp.0.join("notes.txt").exists());
    }

    #[test]
    fn installs_a_checked_file_and_drops_the_older_ones() {
        let tmp = TempDir::new("ytdlp-install");
        fs::write(tmp.0.join(file_name("2026.01.01")), b"old").unwrap();
        let binary = b"pretend this is yt-dlp";
        let mut smoked = None;
        let path = install(
            &tmp.0,
            "2026.08.19",
            Cursor::new(binary),
            &sha256(binary).to_uppercase(),
            |p| {
                smoked = Some(p.to_path_buf());
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(path, tmp.0.join(file_name("2026.08.19")));
        assert_eq!(fs::read(&path).unwrap(), binary);
        // The smoke test ran on the partial file, before it got its final name.
        assert_ne!(smoked.unwrap(), path);
        assert_eq!(fs::read_dir(&tmp.0).unwrap().count(), 1, "old one is gone");
    }

    #[test]
    fn a_wrong_checksum_or_a_failed_smoke_test_leaves_nothing() {
        let tmp = TempDir::new("ytdlp-install-bad");
        let binary = b"pretend this is yt-dlp";
        let err = install(
            &tmp.0,
            "2026.08.19",
            Cursor::new(binary),
            &sha256(b"something else"),
            |_| panic!("must not run a file that failed the checksum"),
        )
        .unwrap_err();
        assert!(err.to_string().contains("checksum mismatch"), "{err}");
        assert_eq!(fs::read_dir(&tmp.0).unwrap().count(), 0);

        let err = install(
            &tmp.0,
            "2026.08.19",
            Cursor::new(binary),
            &sha256(binary),
            |_| Err(AppError::Unknown("does not run".into())),
        )
        .unwrap_err();
        assert!(err.to_string().contains("does not run"), "{err}");
        assert_eq!(fs::read_dir(&tmp.0).unwrap().count(), 0);
        assert_eq!(installed(&tmp.0), None);
    }

    /// The real thing against GitHub (needs internet; run with `--ignored`): the latest release,
    /// its checksum file and its binary for this system go through `install`, and the result
    /// runs and reports that very version. Only the `AppHandle` parts of `check` are left out.
    #[test]
    #[ignore]
    fn the_latest_real_release_installs_and_runs() {
        let tmp = TempDir::new("ytdlp-real");
        let asset = asset_name().unwrap();
        let tag = parse_tag(&get_text(LATEST_URL).unwrap()).unwrap();
        let base = format!("{DOWNLOAD_BASE}/{tag}");
        // The real network path of `check`: the checksum file and its signature (through GitHub's
        // redirects, each checked against the list of servers), verified with the embedded key.
        let expected = verified_checksum(
            &get_bytes(&format!("{base}/SHA2-256SUMS"), MAX_SUMS).unwrap(),
            &get_bytes(&format!("{base}/SHA2-256SUMS.sig"), MAX_SUMS).unwrap(),
            asset,
        )
        .expect("the latest release is signed by yt-dlp's key and lists its own asset");
        let mut response = get(&format!("{base}/{asset}")).unwrap();
        let body = response.body_mut().with_config().limit(MAX_BINARY).reader();
        let path = install(&tmp.0, &tag, body, &expected, |p| {
            let out = std::process::Command::new(p)
                .arg("--version")
                .output()
                .map_err(|e| io("run", e))?;
            assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), tag);
            Ok(())
        })
        .unwrap();
        assert_eq!(installed(&tmp.0).unwrap(), (tag, path));
    }
}
