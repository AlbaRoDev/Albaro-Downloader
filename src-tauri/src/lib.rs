mod app_update;
mod commands;
mod cookies;
mod db;
mod errors;
#[cfg(test)]
mod link_tests;
mod queue;
mod settings;
#[cfg(test)]
mod test_util;
mod text;
mod tray;
mod ui;
mod ytdlp;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The clipboard plugin is only for the "Paste link" button: the capability allows reading
    // text and nothing else. WebView2 would ask the user before letting the page
    // read the clipboard itself.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Only used from Rust, to show a finished download's file. No capability
        // grants it to the frontend, so the page cannot open anything itself.
        .plugin(tauri_plugin_opener::init())
        // Only used from Rust, for the folder picker. No `dialog:*` permission is
        // in any capability, so the page cannot open dialogs itself.
        .plugin(tauri_plugin_dialog::init())
        // Only used from Rust, to say the queue is done. No `notification:*` permission
        // is in any capability, so the page cannot show notifications itself.
        .plugin(tauri_plugin_notification::init())
        // Only used from Rust, to look for a new version of the app. No `updater:*`
        // permission is in any capability, so the page cannot check or install anything itself.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // The window can only show the app itself.
        .plugin(navigation_guard());

    // Dev-only bridge that lets an MCP client screenshot, inspect and drive the native window.
    // It listens on localhost only and requires a random token (written to a file in the temp
    // folder). TCP is used because the default named pipe path does not match on Windows.
    // The `cfg` keeps it out of release builds.
    #[cfg(all(debug_assertions, not(target_os = "linux")))]
    let builder = builder.plugin(tauri_plugin_mcp::init_with_config(
        tauri_plugin_mcp::PluginConfig::new("AlbaRo Downloader".to_string())
            .start_socket_server(true)
            .tcp_localhost(4000),
    ));

    // `run` returns a Result; we report the error and exit instead of calling
    // `expect()`, which would panic with a less readable message.
    if let Err(err) = builder
        // Registered before `setup` runs, so the first `pump` below finds it.
        .manage(queue::Scheduler::default())
        // The page's language, for the texts Rust writes.
        .manage(ui::UiLanguage::default())
        // The update the last check found.
        .manage(app_update::Pending::default())
        // Closing the window while downloads run hides it in the tray instead; with
        // nothing to do (or no tray to hide in) it closes, and with it the app.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if tray::exists(app) && queue::has_work(app) {
                    api.prevent_close();
                    // Hiding can only fail if the window is already gone.
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            // Tauri panics if `setup` returns an error (and release builds abort on panic), so
            // a database that cannot open is reported here and the app exits with code 1.
            let db = open_db(app).unwrap_or_else(|err| {
                eprintln!("cannot open the database: {err}");
                std::process::exit(1)
            });
            // Downloads left `active` by the last run have no process: back to `pending`
            // before anything starts, so they resume first. Failing here is as
            // fatal as failing to open: those rows would hold their slots forever.
            match db.recover_active() {
                Ok(0) => {}
                Ok(count) => eprintln!("resuming {count} download(s) left active"),
                Err(err) => {
                    eprintln!("cannot recover the queue: {err}");
                    std::process::exit(1)
                }
            }
            app.manage(db);
            // Private copies of the cookies file that a crash left behind; nothing runs
            // yet, so none is in use.
            if let Ok(dir) = cookies::run_dir(app.handle()) {
                cookies::remove_stale(&dir);
            }
            // Temporary folders whose download is over or gone (a crash, a deleted database): with
            // the recovery done and nothing running yet, it is safe to look.
            match queue::default_out_dir(app.handle())
                .and_then(|default| queue::sweep_orphans(&app.state::<db::Db>(), &default))
            {
                Ok(0) => {}
                Ok(count) => eprintln!("removed {count} temporary folder(s) left behind"),
                Err(err) => eprintln!("cannot look for leftover temporary folders: {err}"),
            }
            // The tray icon; without one the window simply closes (see `on_window_event`).
            if let Err(err) = tray::create(app.handle(), app.default_window_icon().cloned()) {
                eprintln!("no tray icon: {err}");
            }
            // Starts the recovered and pending downloads (up to the limit).
            queue::pump(app.handle());
            // Looks for a newer yt-dlp now and every few hours, in the background.
            ytdlp::updater::start(app.handle().clone());
            // And for a new version of the app itself, which only tells the user.
            app_update::start(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::enqueue_download,
            commands::enqueue_downloads,
            commands::cancel_download,
            commands::pause_download,
            commands::resume_download,
            commands::retry_download,
            commands::list_downloads,
            commands::list_history,
            commands::clear_history,
            commands::dismiss_download,
            commands::dismiss_ended_downloads,
            commands::reveal_download,
            commands::set_max_concurrent,
            commands::get_download_settings,
            commands::set_limit_rate,
            commands::set_cookies_browser,
            commands::set_notifications,
            commands::set_ui_language,
            commands::pick_cookies_file,
            commands::get_output_settings,
            commands::set_name_template,
            commands::pick_output_dir,
            commands::retry_in_other_folder,
            commands::fetch_metadata,
            commands::fetch_playlist,
            commands::get_app_update,
            commands::install_app_update
        ])
        .run(tauri::generate_context!())
    {
        eprintln!("error while running tauri application: {err}");
        std::process::exit(1);
    }
}

/// Refuses to take the window anywhere but the app's own pages. Without it, script running in the
/// page could send the window to any site (`location.href = ...`): the site would get no access to
/// the app (the capabilities only apply to the app's own origin, checked), but the user would be
/// looking at a stranger's page inside the app's window and might type something into it. The app
/// has no links to other sites: it never needs to leave.
fn navigation_guard() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|_webview, url| is_app_page(url))
        .build()
}

/// The app's own origin: `tauri.localhost` on Windows, `tauri://localhost` elsewhere, and in
/// development the Vite server.
fn is_app_page(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => true,
        "http" | "https" => {
            let host = url.host_str().unwrap_or_default();
            host == "tauri.localhost"
                || (cfg!(debug_assertions)
                    && (host == "localhost" || host == "127.0.0.1")
                    && url.port() == Some(1420))
        }
        _ => false,
    }
}

/// `albaro.db` in the app's data folder (named after the identifier, `dev.albaro.downloader`).
fn open_db(app: &tauri::App) -> Result<db::Db, errors::AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| errors::AppError::Unknown(format!("no app data folder: {e}")))?;
    db::Db::open(&dir.join("albaro.db"))
}

#[cfg(test)]
mod tests {
    use super::is_app_page;

    fn page(url: &str) -> bool {
        is_app_page(&url.parse().unwrap())
    }

    #[test]
    fn only_the_apps_own_pages_may_be_shown() {
        assert!(page("http://tauri.localhost/"));
        assert!(page("https://tauri.localhost/index.html"));
        assert!(page("tauri://localhost/"));
        for other in [
            "https://example.com/",
            "http://example.com/",
            // A look-alike host must not pass.
            "https://tauri.localhost.evil.test/",
            "https://evil.test/tauri.localhost",
            "https://user@evil.test/",
            "file:///C:/Windows/win.ini",
            "data:text/html,<script>1</script>",
            "javascript:alert(1)",
            "about:blank",
            "ftp://tauri.localhost/",
        ] {
            assert!(!page(other), "{other}");
        }
    }

    /// What the page may ask of Tauri itself. Adding a permission must be a decision made
    /// here, with its reason: `core:default` alone would let the page change the tray icon and
    /// menus, read paths and emit events; `shell`, `dialog`, `opener`, `fs`, `notification` and
    /// `updater` are only ever used from Rust.
    #[test]
    fn the_page_gets_exactly_the_permissions_it_needs() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let mut permissions: Vec<&str> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                p.as_str()
                    .expect("a permission with a scope is not expected")
            })
            .collect();
        permissions.sort_unstable();
        assert_eq!(
            permissions,
            [
                "clipboard-manager:allow-read-text",
                "clipboard-manager:allow-write-text",
                "core:event:allow-listen",
                "core:event:allow-unlisten",
                "core:window:allow-set-progress-bar",
            ]
        );
        assert_eq!(capability["windows"], serde_json::json!(["main"]));
        assert!(
            capability.get("remote").is_none(),
            "no remote origin may use IPC"
        );
    }

    #[test]
    fn the_dev_server_is_allowed_only_in_debug_builds() {
        assert_eq!(page("http://localhost:1420/"), cfg!(debug_assertions));
        assert!(!page("http://localhost:8080/"));
    }
}
