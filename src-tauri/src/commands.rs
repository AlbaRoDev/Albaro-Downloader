// What the frontend can ask of the backend. A thin layer: every queue command goes
// through queue.rs, which checks the state change against `queue::allowed`, writes it and
// sends `download-state`. None touches the database by itself. All are `async` so they run on
// Tauri's async runtime, not the main thread.
use std::path::PathBuf;

use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{
    app_update::{self, UpdateInfo},
    cookies,
    db::{Db, Download, DownloadInfo},
    errors::AppError,
    queue::{self, Enqueued, NewDownload, OutputSettings, Stop},
    settings::{self, DownloadSettings},
    tray,
    ui::{Language, UiLanguage},
    ytdlp::{
        self,
        formats::{DownloadRequest, NameTemplate},
        metadata::{self, Metadata},
        playlist::{self, Playlist},
        Browser,
    },
};

/// Queues the download and returns its id; it starts as soon as there is a free slot. An
/// identical request still pending, active or paused is rejected (`alreadyQueued`). `info`
/// (title, thumbnail) is what the list shows; it may be left out.
#[tauri::command]
pub async fn enqueue_download(
    app: AppHandle,
    request: DownloadRequest,
    info: Option<DownloadInfo>,
) -> Result<i64, AppError> {
    queue::add(&app, &request, info.as_ref())
}

/// Queues many downloads at once (the selected entries of a playlist). Those already
/// pending, active or paused are skipped, not errors; any other error stops the batch (what was
/// queued before stays). `batch_title` (the playlist's) names the group the list shows them in
///. See `queue::add_many`.
#[tauri::command]
pub async fn enqueue_downloads(
    app: AppHandle,
    items: Vec<NewDownload>,
    batch_title: Option<String>,
) -> Result<Enqueued, AppError> {
    queue::add_many(&app, &items, batch_title.as_deref())
}

#[tauri::command]
pub async fn cancel_download(app: AppHandle, id: i64) -> Result<(), AppError> {
    queue::stop(&app, id, Stop::Cancel).await
}

/// Kills the process but keeps its `.part` files, so resuming continues where it was.
#[tauri::command]
pub async fn pause_download(app: AppHandle, id: i64) -> Result<(), AppError> {
    queue::stop(&app, id, Stop::Pause).await
}

#[tauri::command]
pub async fn resume_download(app: AppHandle, id: i64) -> Result<(), AppError> {
    queue::resume_download(&app, id)
}

/// Only for a failed download: back to `pending`, with no retry count or wait carried over.
#[tauri::command]
pub async fn retry_download(app: AppHandle, id: i64) -> Result<(), AppError> {
    queue::retry_download(&app, id)
}

#[tauri::command]
pub async fn list_downloads(db: State<'_, Db>) -> Result<Vec<Download>, AppError> {
    db.downloads()
}

/// The history screen: every finished, failed or cancelled download, even those
/// cleared from the list, newest first, filtered by a search text, a state and a kind.
#[tauri::command]
pub async fn list_history(
    db: State<'_, Db>,
    search: String,
    state: Option<String>,
    kind: Option<String>,
) -> Result<queue::History, AppError> {
    queue::history(&db, &search, state.as_deref(), kind.as_deref())
}

/// Deletes the history for good: every finished, failed and cancelled download, also
/// those cleared from the list, and says how many. What is queued, running or paused stays; no
/// downloaded file is touched.
#[tauri::command]
pub async fn clear_history(db: State<'_, Db>) -> Result<u32, AppError> {
    db.clear_history()
}

/// Hides a finished, failed or cancelled download from the list. Deletes nothing.
#[tauri::command]
pub async fn dismiss_download(db: State<'_, Db>, id: i64) -> Result<(), AppError> {
    queue::dismiss(&db, id)
}

/// "Clear the list": hides every finished, failed or cancelled download at once and returns how
/// many it hid. Active, queued and paused ones stay. Deletes nothing.
#[tauri::command]
pub async fn dismiss_ended_downloads(db: State<'_, Db>) -> Result<u32, AppError> {
    queue::dismiss_ended(&db)
}

/// Shows a finished download's file in the file manager. The path comes from the database, never
/// from the frontend.
#[tauri::command]
pub async fn reveal_download(app: AppHandle, id: i64) -> Result<(), AppError> {
    queue::reveal(&app, id)
}

/// The output folder and file name the next download will use.
#[tauri::command]
pub async fn get_output_settings(
    app: AppHandle,
    db: State<'_, Db>,
) -> Result<OutputSettings, AppError> {
    queue::output_settings(&db, &queue::default_out_dir(&app)?)
}

/// Only affects downloads queued from now on: each one keeps the name it was queued with.
#[tauri::command]
pub async fn set_name_template(db: State<'_, Db>, template: NameTemplate) -> Result<(), AppError> {
    queue::set_name_template(&db, template)
}

/// Opens the system's folder picker, starting in `current` if it exists, and waits for the user.
/// `None` is a cancellation. The picker waits on a blocking-pool thread (it returns only when the
/// user closes it, perhaps minutes later): it takes no lock and keeps the UI and the queue
/// running meanwhile. Shared by every command that asks for a folder, so they all behave alike.
async fn pick_folder(
    app: AppHandle,
    window: WebviewWindow,
    current: PathBuf,
) -> Result<Option<PathBuf>, AppError> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file().set_parent(&window);
        if current.is_dir() {
            dialog = dialog.set_directory(&current);
        }
        dialog.blocking_pick_folder()
    })
    .await
    .map_err(|e| AppError::Unknown(format!("the folder picker failed: {e}")))?;
    picked
        .map(|path| {
            path.into_path()
                .map_err(|e| AppError::FolderUnavailable(format!("not a local folder: {e}")))
        })
        .transpose()
}

/// Opens the folder picker and, if the user chooses one that can be used, saves it. Cancelling
/// changes nothing. Either way the settings now in force come back, so the frontend never sends
/// a path.
#[tauri::command]
pub async fn pick_output_dir(
    app: AppHandle,
    window: WebviewWindow,
    db: State<'_, Db>,
) -> Result<OutputSettings, AppError> {
    let default = queue::default_out_dir(&app)?;
    let current = queue::output_dir(&db, &default)?;
    if let Some(dir) = pick_folder(app, window, current).await? {
        queue::set_output_dir(&db, &dir)?;
    }
    queue::output_settings(&db, &default)
}

/// For a download that failed with `noSpace` or `folderUnavailable`: picks a folder,
/// moves the download there and retries it; the folder also becomes the default, as with
/// `pick_output_dir`. Cancelling the picker changes nothing and does not retry. Anything else
/// than such a failed download is refused before the picker opens. Returns the settings now in
/// force.
#[tauri::command]
pub async fn retry_in_other_folder(
    app: AppHandle,
    window: WebviewWindow,
    db: State<'_, Db>,
    id: i64,
) -> Result<OutputSettings, AppError> {
    queue::check_movable(&db, id)?;
    let default = queue::default_out_dir(&app)?;
    let current = queue::output_dir(&db, &default)?;
    match pick_folder(app.clone(), window, current).await? {
        Some(dir) => queue::retry_in_other_folder(&app, id, &dir),
        None => queue::output_settings(&db, &default),
    }
}

/// Takes effect at once: a higher limit starts waiting downloads, a lower one stops none.
#[tauri::command]
pub async fn set_max_concurrent(
    app: AppHandle,
    db: State<'_, Db>,
    max: u32,
) -> Result<(), AppError> {
    queue::set_max_concurrent(&db, max)?;
    queue::pump(&app);
    Ok(())
}

/// The simultaneous downloads, the speed limit and the cookies browser.
#[tauri::command]
pub async fn get_download_settings(db: State<'_, Db>) -> Result<DownloadSettings, AppError> {
    settings::download_settings(&db)
}

/// Turns the "queue is done" notification on or off.
#[tauri::command]
pub async fn set_notifications(db: State<'_, Db>, on: bool) -> Result<(), AppError> {
    settings::set_notifications(&db, on)
}

/// The page's language, `es` or `en`: the notification and the tray menu are written by
/// Rust, in that language. Called at start and whenever the language changes.
#[tauri::command]
pub async fn set_ui_language(
    app: AppHandle,
    state: State<'_, UiLanguage>,
    language: String,
) -> Result<(), AppError> {
    let language = Language::parse(&language)
        .ok_or_else(|| AppError::Unknown(format!("unknown language: {language}")))?;
    state.set(language);
    tray::relabel(&app, language);
    Ok(())
}

/// The limit for all downloads together, in KB/s; `None` removes it. It reaches the downloads
/// that start from now on.
#[tauri::command]
pub async fn set_limit_rate(db: State<'_, Db>, kbps: Option<u32>) -> Result<(), AppError> {
    settings::set_limit_rate_kbps(&db, kbps)
}

/// The browser whose cookies yt-dlp may read, for videos that ask for a login; `None` (the
/// default) never reads any. The value is one of a closed list, never free text.
#[tauri::command]
pub async fn set_cookies_browser(
    db: State<'_, Db>,
    browser: Option<Browser>,
) -> Result<(), AppError> {
    settings::set_cookies_browser(&db, browser)
}

/// Opens the system's file picker for a `cookies.txt` and, if the user picks one that can
/// be used, saves it as the source of cookies (dropping any browser). Cancelling changes nothing; a
/// file that cannot be used is `cookiesUnavailable` and nothing changes. Either way the settings now
/// in force come back, so the frontend never sends a path. Like the folder picker, it waits on a
/// blocking-pool thread and takes no lock.
#[tauri::command]
pub async fn pick_cookies_file(
    app: AppHandle,
    window: WebviewWindow,
    db: State<'_, Db>,
) -> Result<DownloadSettings, AppError> {
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_parent(&window)
            .add_filter("cookies.txt", &["txt"])
            .blocking_pick_file()
    })
    .await
    .map_err(|e| AppError::Unknown(format!("the file picker failed: {e}")))?;
    if let Some(file) = picked {
        let path = file
            .into_path()
            .map_err(|e| AppError::CookiesUnavailable(format!("not a local file: {e}")))?;
        settings::set_cookies_file(&db, &path)?;
    }
    settings::download_settings(&db)
}

/// Title, duration, formats... of the video at `url`. Async, so the UI keeps responding
/// while yt-dlp runs (it takes seconds).
#[tauri::command]
pub async fn fetch_metadata(
    app: AppHandle,
    db: State<'_, Db>,
    url: String,
) -> Result<Metadata, AppError> {
    // The copy of the cookies file (if any) lives until the analysis is over.
    let (cookies, _copy) = settings::cookies(&db, &cookies::run_dir(&app)?)?;
    metadata::fetch(&app, &url, &ytdlp::bin_dir()?, cookies.as_ref()).await
}

/// The entries of a playlist or channel, for the user to pick from. `fetch_metadata`
/// says when a link needs this (it fails with `playlist`).
#[tauri::command]
pub async fn fetch_playlist(
    app: AppHandle,
    db: State<'_, Db>,
    url: String,
) -> Result<Playlist, AppError> {
    let (cookies, _copy) = settings::cookies(&db, &cookies::run_dir(&app)?)?;
    playlist::fetch(&app, &url, &ytdlp::bin_dir()?, cookies.as_ref()).await
}

/// The new version of the app found by the last check, if any. The page also hears
/// `app-update-available`, but may start after it was sent.
#[tauri::command]
pub async fn get_app_update(app: AppHandle) -> Option<UpdateInfo> {
    app_update::pending(&app)
}

/// Installs that update and restarts the app. Only when the user presses the button, and not while
/// downloads are running.
#[tauri::command]
pub async fn install_app_update(app: AppHandle) -> Result<(), AppError> {
    app_update::install(&app).await
}
