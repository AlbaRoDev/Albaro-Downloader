// Updates of the app itself, through `tauri-plugin-updater`. It only ever tells the
// user: the page shows "version X is available" and nothing is downloaded or installed until the
// user presses the button. The plugin is used from Rust only and no capability grants it to the
// page. Updates are signed with Tauri's own key (the public half is in `tauri.conf.json`); the
// plugin refuses an artifact whose signature does not match. Unrelated to the yt-dlp updater
// (`ytdlp/updater.rs`), which replaces a sidecar, not the app.
use std::{sync::Mutex, thread, time::Duration};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{errors::AppError, queue};

/// First look a little after start, so it does not compete with the first downloads.
const FIRST_CHECK: Duration = Duration::from_secs(20);
const CHECK_EVERY: Duration = Duration::from_secs(12 * 60 * 60);

/// The update the last check found, kept until it is installed.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

/// What the page is told: the version only. The release notes come from the update server, so they
/// stay out of the interface.
#[derive(Clone, Serialize)]
pub struct UpdateInfo {
    version: String,
}

/// Looks now and then, in a thread of its own; errors (no connection, no release yet) are only
/// logged, because an update check must never bother the user.
pub fn start(app: AppHandle) {
    thread::spawn(move || {
        thread::sleep(FIRST_CHECK);
        loop {
            if let Err(err) = tauri::async_runtime::block_on(check(&app)) {
                eprintln!("app update check failed: {err}");
            }
            thread::sleep(CHECK_EVERY);
        }
    });
}

async fn check(app: &AppHandle) -> Result<(), String> {
    let mut builder = app.updater_builder();
    // To try an update by hand: a local `latest.json` in a debug build. Release
    // builds only ever ask the endpoint in `tauri.conf.json`, over HTTPS.
    #[cfg(debug_assertions)]
    if let Ok(url) = std::env::var("ALBARO_UPDATE_URL") {
        let url = url.parse().map_err(|e| format!("ALBARO_UPDATE_URL: {e}"))?;
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let update = builder
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let Some(update) = update else { return Ok(()) };
    // The manifest says where the installer is; the signature protects its content, and the
    // address is held to the same list of servers as yt-dlp's updater.
    if !download_allowed(&update) {
        return Err(format!(
            "the update is served from {}, which is not on the list of servers the app may use",
            update.download_url.host_str().unwrap_or("?")
        ));
    }
    let info = UpdateInfo {
        version: update.version.clone(),
    };
    if let Ok(mut pending) = app.state::<Pending>().0.lock() {
        *pending = Some(update);
    }
    // The page may not be listening yet; it asks with `get_app_update` when it starts.
    let _ = app.emit("app-update-available", info);
    Ok(())
}

/// Whether the installer's address is one the app may fetch from: https, GitHub's hosts. A debug
/// build trying an update by hand (`ALBARO_UPDATE_URL`) may use its own server.
fn download_allowed(update: &Update) -> bool {
    (cfg!(debug_assertions) && std::env::var_os("ALBARO_UPDATE_URL").is_some())
        || crate::ytdlp::updater::allowed(update.download_url.as_str())
}

/// The update found so far, if any.
pub fn pending(app: &AppHandle) -> Option<UpdateInfo> {
    let pending = app.state::<Pending>();
    let pending = pending.0.lock().ok()?;
    pending.as_ref().map(|u| UpdateInfo {
        version: u.version.clone(),
    })
}

/// Downloads, verifies and installs the update, then restarts. Refuses while there are downloads
/// (installing closes the app); the page also disables its button then. On Windows the installer
/// ends the app itself, and elsewhere `restart` does.
pub async fn install(app: &AppHandle) -> Result<(), AppError> {
    if queue::has_work(app) {
        return Err(AppError::Unknown(
            "downloads are in progress; finish or cancel them before updating".into(),
        ));
    }
    let update = app
        .state::<Pending>()
        .0
        .lock()
        .map_err(|_| AppError::Unknown("update state is poisoned".into()))?
        // Cloned, not taken: if the download fails, the user can press the button again.
        .clone()
        .ok_or_else(|| AppError::Unknown("no update is available".into()))?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| AppError::Unknown(format!("update failed: {e}")))?;
    queue::shutdown(app);
    app.restart()
}

#[cfg(test)]
mod tests {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use minisign_verify::{PublicKey, Signature};

    // What the shipped app trusts (tauri.conf.json) and a file signed with the real private key by
    // `tauri signer sign --app-version 0.2.0`, the way the release workflow signs. The
    // signature file holds what `latest.json` carries in its `signature` field.
    const CONFIG: &str = include_str!("../tauri.conf.json");
    const FILE: &[u8] = include_bytes!("../../tests/fixtures/app-update-fixture.bin");
    const SIGNATURE: &str = include_str!("../../tests/fixtures/app-update-fixture.bin.sig");

    fn config() -> serde_json::Value {
        serde_json::from_str(CONFIG).unwrap()
    }

    fn text(base64: &str) -> String {
        String::from_utf8(STANDARD.decode(base64.trim()).unwrap()).unwrap()
    }

    fn key() -> PublicKey {
        let updater = &config()["plugins"]["updater"];
        PublicKey::decode(&text(updater["pubkey"].as_str().unwrap())).unwrap()
    }

    #[test]
    fn what_the_release_key_signs_verifies_with_the_key_in_the_app() {
        let signature = Signature::decode(&text(SIGNATURE)).unwrap();
        key().verify(FILE, &signature, true).unwrap();
        // The version is in the part the signature covers, and `requireSignedVersion` reads it.
        assert!(
            signature
                .trusted_comment()
                .split('\t')
                .any(|field| field == "version:0.2.0"),
            "{}",
            signature.trusted_comment()
        );
        assert_eq!(config()["plugins"]["updater"]["requireSignedVersion"], true);
    }

    #[test]
    fn a_changed_installer_or_another_key_is_refused() {
        let signature = Signature::decode(&text(SIGNATURE)).unwrap();
        for at in [0, 10, FILE.len() - 1] {
            let mut bad = FILE.to_vec();
            bad[at] ^= 1;
            assert!(key().verify(&bad, &signature, true).is_err(), "byte {at}");
        }
        assert!(key().verify(b"", &signature, true).is_err());
        // The same signature against a different public key (a made-up but well-formed one).
        let other = "untrusted comment: minisign public key: 0000000000000000\nRWQAAAAAAAAAAGwtTGE5r3T8EBY1XQFdaWT5iM3fJcr0Fvg10gD8V0LXEFZ2kz8F\n";
        if let Ok(other) = PublicKey::decode(other) {
            assert!(other.verify(FILE, &signature, true).is_err());
        }
    }

    /// The only server the app asks about updates is GitHub, over HTTPS, and nothing weakens that.
    #[test]
    fn the_app_asks_one_server_over_https_and_trusts_no_insecure_transport() {
        let updater = &config()["plugins"]["updater"];
        let endpoints = updater["endpoints"].as_array().unwrap();
        assert_eq!(endpoints.len(), 1);
        assert_eq!(
            endpoints[0],
            "https://github.com/AlbaRoDev/Albaro-Downloader/releases/latest/download/latest.json"
        );
        for weakening in [
            "dangerousInsecureTransportProtocol",
            "dangerousAcceptInvalidCerts",
            "dangerousAcceptInvalidHostnames",
            "allowDowngrades",
        ] {
            assert!(updater.get(weakening).is_none(), "{weakening} is set");
        }
    }
}
