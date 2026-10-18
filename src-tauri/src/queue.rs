// Download queue, in two layers:
// 1. The core: plain functions over `Db` that check every state change against `allowed`.
//    No Tauri, no processes, so the tests drive it with an in-memory database.
// 2. The scheduler: Tauri state that starts yt-dlp for each claimed download and turns the
//    process's exit into the next state. It only adds what needs a real process.
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex, MutexGuard, PoisonError,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{async_runtime::Receiver, AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

use crate::{
    cookies::{self, CookieCopy},
    db::{Batch, Db, Download, DownloadInfo, DownloadState, Job, Placement, StoredError},
    errors::AppError,
    settings,
    ui::{self, Summary, UiLanguage},
    ytdlp::{
        self, classify,
        formats::{self, DownloadRequest, NameTemplate},
        playlist::MAX_ENTRIES,
        progress::{self, Progress, Status},
        runner::{Run, RunEvent},
        updater,
    },
};

// ---------------------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------------------

const MAX_CONCURRENT_KEY: &str = "max_concurrent_downloads";
const MAX_CONCURRENT_LIMIT: u32 = 32;
const DEFAULT_MAX_CONCURRENT: u32 = 3;

/// The allowed state changes; anything else is an error. `finished` and `cancelled` are
/// final. `failed → pending` is the manual retry. Kept here as a pure function and passed to
/// `Db::transition`, which applies it inside its transaction: the queue decides, db.rs stores.
pub fn allowed(from: DownloadState, to: DownloadState) -> bool {
    use DownloadState::*;
    matches!(
        (from, to),
        (Pending, Active | Paused | Cancelled)
            | (Active, Finished | Failed | Paused | Cancelled)
            | (Paused, Pending | Cancelled)
            | (Failed, Pending)
    )
}

/// Adds a download in `pending`. The URL is checked here so a bad one never becomes a row.
/// `info` (title, thumbnail) is only for the list, and `placement` (folder and name)
/// is only stored: neither takes part in telling duplicates.
pub fn enqueue(
    db: &Db,
    request: &DownloadRequest,
    info: Option<&DownloadInfo>,
    placement: &Placement,
) -> Result<i64, AppError> {
    ytdlp::check_url(&request.url)?;
    db.insert_download(request, info, placement)
}

// --- output folder and file name ---

const OUTPUT_DIR_KEY: &str = "output_dir";
const NAME_TEMPLATE_KEY: &str = "name_template";

/// The output folder and name as the user has them now (`OutputSettings` in ipc.ts).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSettings {
    pub output_dir: String,
    pub name_template: NameTemplate,
    /// The folder is so deep that titles would not fit in a path: the frontend warns.
    pub folder_too_deep: bool,
}

/// The folder in use: the saved one, or `default` if none is saved or the saved text is empty
/// or not an absolute path (a hand-edited database must not send files to wherever the app's
/// working folder happens to be).
pub fn output_dir(db: &Db, default: &Path) -> Result<PathBuf, AppError> {
    Ok(db
        .setting(OUTPUT_DIR_KEY)?
        .filter(|dir| !dir.trim().is_empty())
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
        .unwrap_or_else(|| default.to_path_buf()))
}

/// The name in use; a missing, empty or unknown value is the default (`titleId`), as with
/// `max_concurrent`.
pub fn name_template(db: &Db) -> Result<NameTemplate, AppError> {
    Ok(db
        .setting(NAME_TEMPLATE_KEY)?
        .and_then(|text| NameTemplate::parse(&text))
        .unwrap_or_default())
}

pub fn output_settings(db: &Db, default: &Path) -> Result<OutputSettings, AppError> {
    let dir = output_dir(db, default)?;
    Ok(OutputSettings {
        // A six-digit id: the longest temporary folder this folder will see in practice.
        folder_too_deep: formats::too_deep_for_titles(&temp_dir(&dir, 999_999)),
        output_dir: dir.to_string_lossy().into_owned(),
        name_template: name_template(db)?,
    })
}

pub fn set_name_template(db: &Db, template: NameTemplate) -> Result<(), AppError> {
    db.set_setting(NAME_TEMPLATE_KEY, template.as_str())
}

/// The database stores text, so a folder whose path is not valid UTF-8 cannot be remembered.
fn utf8(dir: &Path) -> Result<&str, AppError> {
    dir.to_str().ok_or_else(|| {
        AppError::FolderUnavailable(format!(
            "the path of {} is not valid UTF-8 and cannot be saved",
            dir.display()
        ))
    })
}

/// Saves `dir` as the output folder if it can be used: an absolute path the database can hold
/// (it stores text, so one that is not valid UTF-8 is refused) that exists or can be created
/// and takes files. Otherwise `folderUnavailable` and nothing changes.
pub fn set_output_dir(db: &Db, dir: &Path) -> Result<(), AppError> {
    db.set_setting(OUTPUT_DIR_KEY, checked_dir(dir)?)
}

/// `dir` as the text to store, once it is known to be usable: valid UTF-8, absolute, and
/// `ensure_dir`. Shared by everything that accepts a folder from the user.
fn checked_dir(dir: &Path) -> Result<&str, AppError> {
    let text = utf8(dir)?;
    if !dir.is_absolute() {
        return Err(AppError::FolderUnavailable(format!(
            "{text} is not an absolute path"
        )));
    }
    ensure_dir(dir)?;
    Ok(text)
}

/// Makes sure `dir` exists and a file can be written in it, or says `folderUnavailable`. The
/// check writes (and removes) a tiny file: a folder can exist and still refuse files (a
/// read-only drive, no permission), and `readonly()` says nothing about folders on Windows.
pub fn ensure_dir(dir: &Path) -> Result<(), AppError> {
    static PROBES: AtomicU32 = AtomicU32::new(0);
    let unusable = |why: String| AppError::FolderUnavailable(format!("{}: {why}", dir.display()));
    fs::create_dir_all(dir).map_err(|e| unusable(e.to_string()))?;
    if !dir.is_dir() {
        return Err(unusable("not a folder".into()));
    }
    // The process id and a counter keep two checks at once from meeting on the same file.
    let probe = dir.join(format!(
        ".albaro-write-test-{}-{}",
        std::process::id(),
        PROBES.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&probe, b"").map_err(|e| unusable(e.to_string()))?;
    // Best effort: an empty hidden-ish file left behind is harmless.
    let _ = fs::remove_file(&probe);
    Ok(())
}

// --- "choose another folder and retry" ---

/// Whether a failed download with this error code is worth moving to another folder: the disk is
/// full, or the folder cannot be used. Nothing else is: after `network` the `.part` files are
/// kept in the old folder for the retry, and moving would leave them orphaned; the rest
/// would fail again in any folder.
fn movable_code(code: &str) -> bool {
    matches!(code, "noSpace" | "folderUnavailable")
}

/// Checks that download `id` may be moved: `failed`, with a `movable_code`. Anything else is
/// `unknown` with the reason, as the rest of the queue does. The command calls this before it
/// opens the folder picker, so no dialog appears for a row that could not use the answer.
pub fn check_movable(db: &Db, id: i64) -> Result<(), AppError> {
    let download = db
        .download(id)?
        .ok_or_else(|| AppError::Unknown(format!("no download with id {id}")))?;
    let cannot = |why: String| AppError::Unknown(format!("download {id} cannot be moved: {why}"));
    if download.state != DownloadState::Failed {
        return Err(cannot(format!(
            "it is {}, not failed",
            download.state.as_str()
        )));
    }
    match download.error {
        Some(error) if movable_code(&error.code) => Ok(()),
        Some(error) => Err(cannot(format!(
            "it failed with {}, which another folder does not fix",
            error.code
        ))),
        None => Err(cannot("it has no recorded error".into())),
    }
}

/// Moves the failed download `id` to `new_dir` and queues it again (`failed -> pending`, the
/// normal manual retry, which keeps the name template and forgets any retry count). Only for
/// `check_movable` downloads. The folder is checked first (`folderUnavailable`, nothing
/// changes). If a temporary folder is left in the old one it is deleted: with these two codes it
/// was already removed when the download failed, so this is normally a no-op, and a failure to
/// delete it is only logged. The change of folder is one transaction (`set_download_dir`). The
/// folder also becomes the default one for new downloads (as when picked in the top bar), written
/// last so that nothing about the setting changes if the move is refused. The caller sends the
/// `download-state` event and runs `pump`.
pub fn move_and_retry(
    db: &Db,
    retries: &mut Retries,
    id: i64,
    new_dir: &Path,
    default: &Path,
) -> Result<(), AppError> {
    check_movable(db, id)?;
    let text = checked_dir(new_dir)?;
    let (old_dir, _) = resolve(&db.placement(id)?, default);
    let old_temp = temp_dir(&old_dir, id);
    if let Err(err) = clean_temp(&old_temp, id, Cleanup::Delete) {
        eprintln!("download {id}: cannot clean {}: {err}", old_temp.display());
    }
    db.set_download_dir(id, text)?;
    retry(db, retries, id)?;
    db.set_setting(OUTPUT_DIR_KEY, text)
}

/// The folder and name to store with a download queued now: the current settings, with the
/// folder checked. Fixing them at queue time is what keeps a later change of folder from
/// moving what is already waiting (its `.albaro-tmp/<id>` lives in its own folder).
pub fn placement_now(db: &Db, default: &Path) -> Result<Placement, AppError> {
    let dir = output_dir(db, default)?;
    ensure_dir(&dir)?;
    Ok(Placement {
        out_dir: Some(utf8(&dir)?.to_string()),
        name_template: Some(name_template(db)?.as_str().to_string()),
    })
}

/// What a stored placement means: `None` (older rows) is the default folder and
/// the default name, whatever the settings say now; an unknown name is the default one too.
pub fn resolve(placement: &Placement, default: &Path) -> (PathBuf, NameTemplate) {
    let dir = placement
        .out_dir
        .as_deref()
        .filter(|dir| !dir.is_empty())
        .map_or_else(|| default.to_path_buf(), PathBuf::from);
    let template = placement
        .name_template
        .as_deref()
        .and_then(NameTemplate::parse)
        .unwrap_or_default();
    (dir, template)
}

/// The oldest pending download, now `active`, if there is a free slot. The limit is read on
/// every call, so a new value applies without restarting. `waiting` are pending downloads
/// whose network retry is not due yet (`Retries::waiting`): they are skipped.
pub fn claim_next(db: &Db, waiting: &[i64]) -> Result<Option<Job>, AppError> {
    db.claim_next(max_concurrent(db)?, waiting)
}

/// Clears any earlier error (a retried download that then finishes is not failed). `file` is
/// the final path yt-dlp printed; without one the download is still finished, just with
/// nowhere to reveal. It is written after the state, so a failure to write it leaves a
/// finished download with no path rather than the reverse.
pub fn mark_finished(db: &Db, id: i64, file: Option<&str>) -> Result<(), AppError> {
    db.transition(id, DownloadState::Finished, None, allowed)?;
    if let Some(file) = file {
        // Best effort: the download did finish.
        if let Err(err) = db.set_output_path(id, file) {
            eprintln!("download {id}: cannot store its file path: {err}");
        }
    }
    Ok(())
}

/// Only a download that has ended can leave the list: running or waiting ones are still work.
pub fn can_dismiss(state: DownloadState) -> bool {
    matches!(
        state,
        DownloadState::Finished | DownloadState::Failed | DownloadState::Cancelled
    )
}

/// "Remove from list": hides the row, deletes nothing (neither the row nor the file).
pub fn dismiss(db: &Db, id: i64) -> Result<(), AppError> {
    db.dismiss(id, can_dismiss)
}

/// "Clear the list": hides every finished, failed or cancelled download at once and says how
/// many. What is still queued, running or paused stays. Like `dismiss`, it deletes neither rows
/// nor files.
pub fn dismiss_ended(db: &Db) -> Result<u32, AppError> {
    db.dismiss_where(can_dismiss)
}

/// The most rows one history query returns: newest first, and `more` says there were
/// others. A search narrows it down.
const HISTORY_LIMIT: u32 = 200;

#[derive(Debug, Serialize)]
pub struct History {
    pub items: Vec<Download>,
    pub more: bool,
}

/// The ended downloads for the history screen. `state` is `finished`, `failed` or `cancelled` and
/// `kind` `video` or `audio` (`None`: any); anything else is refused, not ignored.
pub fn history(
    db: &Db,
    search: &str,
    state: Option<&str>,
    kind: Option<&str>,
) -> Result<History, AppError> {
    let state = state.map(str::parse::<DownloadState>).transpose()?;
    if let Some(kind) = kind {
        if kind != "video" && kind != "audio" {
            return Err(AppError::Unknown(format!("unknown kind: {kind}")));
        }
    }
    let mut items = db.history(search.trim(), state, kind, HISTORY_LIMIT + 1)?;
    let more = items.len() > HISTORY_LIMIT as usize;
    items.truncate(HISTORY_LIMIT as usize);
    Ok(History { items, more })
}

/// What "open folder" shows for a finished download.
#[derive(Debug, PartialEq)]
pub enum Reveal {
    /// The file, selected in its folder.
    File(PathBuf),
    /// Only the folder: the file is gone but its folder is not.
    Folder(PathBuf),
}

/// Decides what to show for download `id` from what the database holds (never a path from the
/// frontend). Only a finished download qualifies. No recorded path, or neither the file nor its
/// folder left, is `unavailable`.
pub fn reveal_target(db: &Db, id: i64) -> Result<Reveal, AppError> {
    let download = db
        .download(id)?
        .ok_or_else(|| AppError::Unknown(format!("no download with id {id}")))?;
    if download.state != DownloadState::Finished {
        return Err(AppError::Unknown(format!(
            "download {id} is {}, not finished: there is no file to show",
            download.state.as_str()
        )));
    }
    let path = db
        .output_path(id)?
        .map(PathBuf::from)
        .ok_or_else(|| AppError::Unavailable(format!("download {id} has no recorded file")))?;
    if path.is_file() {
        return Ok(Reveal::File(path));
    }
    match path.parent() {
        Some(dir) if dir.is_dir() => Ok(Reveal::Folder(dir.to_path_buf())),
        _ => Err(AppError::Unavailable(format!(
            "{} and its folder no longer exist",
            path.display()
        ))),
    }
}

pub fn mark_failed(db: &Db, id: i64, error: &AppError) -> Result<(), AppError> {
    db.transition(id, DownloadState::Failed, Some(error), allowed)
}

pub fn pause(db: &Db, id: i64) -> Result<(), AppError> {
    db.transition(id, DownloadState::Paused, None, allowed)
}

/// Back to `pending`; when it starts again yt-dlp continues its `.part` files.
pub fn resume(db: &Db, id: i64) -> Result<(), AppError> {
    db.transition(id, DownloadState::Pending, None, allowed)
}

pub fn cancel(db: &Db, id: i64) -> Result<(), AppError> {
    db.transition(id, DownloadState::Cancelled, None, allowed)
}

/// Manual retry: `failed → pending` only (a paused download is resumed, not retried), with the
/// retry count and any wait forgotten, so it starts at once and counts from zero.
pub fn retry(db: &Db, retries: &mut Retries, id: i64) -> Result<(), AppError> {
    // A closure that captures nothing coerces to the `fn` pointer `transition` takes. It
    // narrows the general rule to the one transition a retry may make.
    let only_from_failed = |from, to| from == DownloadState::Failed && allowed(from, to);
    db.transition(id, DownloadState::Pending, None, only_from_failed)?;
    retries.forget(id);
    Ok(())
}

/// Network errors are retried up to this many times; anything else fails at once.
pub const MAX_RETRIES: u32 = 5;
const MAX_JITTER: Duration = Duration::from_millis(500);

/// The wait before retry number `attempt` (1-based): 2^attempt seconds (2, 4, 8, 16, 32) plus
/// `jitter`, capped at `MAX_JITTER` so it stays small. `None` once the retries are used up.
/// The jitter comes in as a parameter so tests can fix it.
pub fn retry_delay(attempt: u32, jitter: Duration) -> Option<Duration> {
    (1..=MAX_RETRIES)
        .contains(&attempt)
        .then(|| Duration::from_secs(1 << attempt) + jitter.min(MAX_JITTER))
}

/// Network retries in progress, in memory only: how many attempts each
/// download has used, and when the waiting ones may start again. Nothing is persisted: after
/// a restart a waiting download is plain `pending` and starts at once, like any recovered one.
/// A waiting download stays `pending` (it holds no slot), and `claim_next` skips it.
#[derive(Default)]
pub struct Retries {
    attempts: HashMap<i64, u32>,
    not_before: HashMap<i64, Instant>,
}

impl Retries {
    /// Records one more attempt for `id` and returns its number and the wait, or `None` (and
    /// forgets `id`) when the retries are used up.
    fn schedule(&mut self, id: i64, now: Instant, jitter: Duration) -> Option<(u32, Duration)> {
        let attempt = self.attempts.get(&id).map_or(1, |used| used + 1);
        let Some(delay) = retry_delay(attempt, jitter) else {
            self.forget(id);
            return None;
        };
        self.attempts.insert(id, attempt);
        self.not_before.insert(id, now + delay);
        Some((attempt, delay))
    }

    /// The downloads still waiting, for `claim_next` to skip.
    pub fn waiting(&self) -> Vec<i64> {
        self.not_before.keys().copied().collect()
    }

    /// Ends `id`'s wait if it is due; `true` means it may start now. A stale wake-up does
    /// nothing: the wait was dropped (cancel, pause) or replaced by a later one.
    pub fn wake(&mut self, id: i64, now: Instant) -> bool {
        match self.not_before.get(&id) {
            Some(&due) if due <= now => {
                self.not_before.remove(&id);
                true
            }
            _ => false,
        }
    }

    /// Drops the attempts and any wait: the download ended, or was paused or cancelled (a
    /// resumed download starts afresh, with no wait inherited).
    pub fn forget(&mut self, id: i64) {
        self.attempts.remove(&id);
        self.not_before.remove(&id);
    }
}

#[derive(Debug, PartialEq)]
pub enum AfterFailure {
    RetryIn { attempt: u32, delay: Duration },
    Failed,
}

/// An active download failed with `error` (already classified). A network error with retries
/// left goes back to `pending` to wait; anything else, or the last network error, is `failed`.
///
/// Back to `pending` is two allowed steps, `active → failed → pending` (the manual retry):
/// `active → pending` is not in `allowed` on purpose. The network error stays
/// stored while it waits, so the list shows why.
pub fn fail_or_retry(
    db: &Db,
    retries: &mut Retries,
    id: i64,
    error: &AppError,
    now: Instant,
    jitter: Duration,
) -> Result<AfterFailure, AppError> {
    if let AppError::Network(_) = error {
        if let Some((attempt, delay)) = retries.schedule(id, now, jitter) {
            mark_failed(db, id, error)?;
            db.transition(id, DownloadState::Pending, Some(error), allowed)?;
            return Ok(AfterFailure::RetryIn { attempt, delay });
        }
    }
    retries.forget(id);
    mark_failed(db, id, error)?;
    Ok(AfterFailure::Failed)
}

/// At most one progress event per download in this interval: 10 per second.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// Rate limit for one download's `download-progress` events. yt-dlp prints dozens
/// of updates per second (up to ~60 measured), more than any UI needs. Each download's watch
/// task owns one, and it goes away with the task: no shared map, no lock. The caller passes
/// the time, so tests need no sleeping.
#[derive(Default)]
pub struct Throttle {
    last_sent: Option<Instant>,
    /// The newest update held back. Anything sent later supersedes it; otherwise `flush`
    /// hands it over before the final event.
    pending: Option<Progress>,
}

impl Throttle {
    /// Whether `progress` goes out now: always the first one, and `finished` or `error` (the
    /// end of each file: video and audio come as two runs from 0 to 100 %); otherwise only
    /// once 100 ms have passed since the last one sent. There is no timer: a held-back update
    /// waits for the next line that is due, or for `flush`.
    pub fn should_emit(&mut self, now: Instant, progress: &Progress) -> bool {
        let due = self
            .last_sent
            .is_none_or(|last| now.duration_since(last) >= PROGRESS_INTERVAL);
        if due || progress.status != Status::Downloading {
            self.last_sent = Some(now);
            self.pending = None;
            true
        } else {
            self.pending = Some(progress.clone());
            false
        }
    }

    /// The newest held-back update, if nothing newer went out. Emit it before
    /// `download-finished`/`download-failed`, so the UI never sees the end before the latest
    /// progress.
    pub fn flush(&mut self) -> Option<Progress> {
        self.pending.take()
    }
}

/// Where every download keeps its in-between files, inside the output folder.
const TEMP_ROOT: &str = ".albaro-tmp";

/// `<out_dir>/.albaro-tmp/<id>`: download `id`'s own folder for everything yt-dlp writes
/// before the final file (`-P temp:`). The only place that builds this path, from the id
/// alone: nothing from the frontend or yt-dlp goes into it. Inside `out_dir`, not the app data
/// folder, so moving the final file out of it is a rename on the same drive, not a copy of
/// several GB. The id makes it unique: a new download never continues another one's `.part`.
pub fn temp_dir(out_dir: &Path, id: i64) -> PathBuf {
    out_dir.join(TEMP_ROOT).join(id.to_string())
}

/// What to do with a download's temporary folder once it reaches a state.
#[derive(Debug, PartialEq)]
pub enum Cleanup {
    /// Paused, waiting, or failed with a network error: a retry or resume continues the
    /// `.part` files, so they stay.
    Keep,
    /// Cancelled, or failed for good: nothing in it will be used again.
    Delete,
    /// Finished: yt-dlp moved the file out and the folder should be empty. Removed only if it
    /// is, so nothing unexpected is lost.
    RemoveIfEmpty,
}

/// The cleanup for a download that just moved to `state` (with `error`, for `failed`).
pub fn cleanup_for(state: DownloadState, error: Option<&AppError>) -> Cleanup {
    match (state, error) {
        (DownloadState::Cancelled, _) => Cleanup::Delete,
        (DownloadState::Failed, Some(AppError::Network(_))) => Cleanup::Keep,
        (DownloadState::Failed, _) => Cleanup::Delete,
        (DownloadState::Finished, _) => Cleanup::RemoveIfEmpty,
        (DownloadState::Pending | DownloadState::Active | DownloadState::Paused, _) => {
            Cleanup::Keep
        }
    }
}

/// Applies `cleanup` to `dir`, download `id`'s temporary folder, and then removes the
/// `.albaro-tmp` folder too if that left it empty. A folder that does not exist is fine.
/// Refuses (an error, nothing deleted) unless `dir` ends in `.albaro-tmp/<id>`: a last guard
/// against a wrong path ever reaching `remove_dir_all`.
pub fn clean_temp(dir: &Path, id: i64, cleanup: Cleanup) -> io::Result<()> {
    let expected = id.to_string();
    let is_ours = dir.file_name() == Some(OsStr::new(&expected))
        && dir.parent().and_then(Path::file_name) == Some(OsStr::new(TEMP_ROOT));
    if !is_ours {
        return Err(io::Error::other(format!(
            "refusing to delete {}: not a download's temporary folder",
            dir.display()
        )));
    }
    let result = match cleanup {
        Cleanup::Keep => return Ok(()),
        Cleanup::Delete => fs::remove_dir_all(dir),
        Cleanup::RemoveIfEmpty => fs::remove_dir(dir),
    };
    match result {
        Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
        _ => {}
    }
    // Fails, and is meant to, while another download still has its folder in there.
    if let Some(root) = dir.parent() {
        let _ = fs::remove_dir(root);
    }
    Ok(())
}

/// How many downloads may run at once. A missing or unreadable value (not a number, or 0)
/// falls back to the default instead of stopping the queue.
pub fn max_concurrent(db: &Db) -> Result<u32, AppError> {
    let stored = db.setting(MAX_CONCURRENT_KEY)?;
    Ok(stored
        .and_then(|value| value.parse().ok())
        .filter(|&max| max >= 1)
        .unwrap_or(DEFAULT_MAX_CONCURRENT))
}

/// Lowering it stops nothing: running downloads go on, new ones wait for a free slot.
pub fn set_max_concurrent(db: &Db, max: u32) -> Result<(), AppError> {
    if max == 0 {
        return Err(AppError::Unknown(
            "at least one download must be allowed at a time".into(),
        ));
    }
    // The interface offers up to 10. Without a ceiling, a hostile page could ask for billions and
    // start one yt-dlp per queued download at once.
    if max > MAX_CONCURRENT_LIMIT {
        return Err(AppError::Unknown(format!(
            "at most {MAX_CONCURRENT_LIMIT} downloads can run at a time"
        )));
    }
    db.set_setting(MAX_CONCURRENT_KEY, &max.to_string())
}

// ---------------------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------------------

/// Why a running download is being stopped. yt-dlp's exit looks the same either way (the
/// runner reports `cancelled`), so the scheduler writes this down BEFORE killing the process
/// and reads it when the process exits.
pub enum Stop {
    Pause,
    Cancel,
}

struct Running {
    /// `None` once `stop` took it to kill the process (a `Run` can only be cancelled once).
    run: Option<Run>,
    stop: Option<Stop>,
}

/// The downloads with a live process, by id, and the network retries in progress.
///
/// Invariant: while this lock is free, a row is `active` if and only if its id is in
/// `running`. That is why `pump` claims and spawns, and `finish` removes and writes the next
/// state, without letting go of the lock. Lock order is always this one first, then the
/// database's (inside the `Db` calls), so the two can never deadlock.
#[derive(Default)]
pub struct Scheduler(Mutex<State>);

#[derive(Default)]
struct State {
    running: HashMap<i64, Running>,
    retries: Retries,
    /// Downloads already given their one update-and-retry after a broken extractor.
    /// In memory, like `retries`.
    updated_once: HashSet<i64>,
    /// The app is quitting: the processes were killed on purpose, so their exits change
    /// no row, and nothing new starts. The rows stay `active` and the next start resumes them.
    shutting_down: bool,
    /// What finished or failed since the queue was last quiet, for one notification.
    summary: Summary,
    /// The download that finished last, to name it when it was the only one.
    last_finished: Option<i64>,
}

impl Scheduler {
    // Same reasoning as `Db::conn`: a poisoned lock still holds a usable state.
    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

// Event payloads (mirrored in ipc.ts). Several downloads run at once, so each carries its id.
#[derive(Clone, Serialize)]
struct ProgressEvent {
    id: i64,
    progress: Progress,
}

/// Sent after every successful state change. `error` is the one stored with the
/// row: set for `failed`, and for `pending` while a network retry waits.
#[derive(Clone, Serialize)]
struct StateEvent {
    id: i64,
    state: DownloadState,
    error: Option<StoredError>,
}

#[derive(Clone, Serialize)]
struct FinishedEvent {
    id: i64,
}

/// Real failures only: a cancellation sends just its `download-state`.
#[derive(Clone, Serialize)]
struct FailedEvent {
    id: i64,
    error: AppError,
}

/// A network retry was scheduled: attempt `attempt` of `max_attempts` starts in `delay_ms`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RetryingEvent {
    id: i64,
    attempt: u32,
    max_attempts: u32,
    delay_ms: u64,
}

/// Everything the scheduler tells the frontend. Built while the lock is held (only when the
/// database write succeeded) and sent by `emit` once it is released.
enum Event {
    Progress(ProgressEvent),
    State(StateEvent),
    Finished(FinishedEvent),
    Failed(FailedEvent),
    Retrying(RetryingEvent),
}

fn state_event(id: i64, state: DownloadState, error: Option<&AppError>) -> Event {
    let error = error.map(StoredError::from);
    Event::State(StateEvent { id, state, error })
}

/// The one place that sends events to the frontend. Never called with a lock held: sending
/// does not need one, and keeping it out of the critical sections keeps them short. A send
/// error only means no window is listening, so it is ignored.
fn emit(app: &AppHandle, events: impl IntoIterator<Item = Event>) {
    for event in events {
        let _ = match event {
            Event::Progress(payload) => app.emit("download-progress", payload),
            Event::State(payload) => app.emit("download-state", payload),
            Event::Finished(payload) => app.emit("download-finished", payload),
            Event::Failed(payload) => app.emit("download-failed", payload),
            Event::Retrying(payload) => app.emit("download-retrying", payload),
        };
    }
}

/// Shows the finished download's file in the system's file manager (`reveal_target` decides
/// what). The only use of the opener plugin: it has no permission in any capability, so the
/// frontend cannot call it.
pub fn reveal(app: &AppHandle, id: i64) -> Result<(), AppError> {
    let opener = app.opener();
    match reveal_target(&app.state::<Db>(), id)? {
        Reveal::File(file) => opener.reveal_item_in_dir(file),
        Reveal::Folder(dir) => opener.open_path(dir.to_string_lossy(), None::<&str>),
    }
    .map_err(|e| AppError::Unknown(format!("cannot open the file manager: {e}")))
}

/// Queues a download (`pending`), tells the frontend and starts it if there is a free slot.
/// A duplicate or a bad URL fails in `enqueue`, before anything is sent.
pub fn add(
    app: &AppHandle,
    request: &DownloadRequest,
    info: Option<&DownloadInfo>,
) -> Result<i64, AppError> {
    let db = app.state::<Db>();
    // The folder is checked (and created) before the row exists: an unusable one is the
    // user's to fix, and queueing into it would only fail later.
    let placement = placement_now(&db, &default_out_dir(app)?)?;
    let id = enqueue(&db, request, info, &placement)?;
    emit(app, [state_event(id, DownloadState::Pending, None)]);
    pump(app);
    Ok(id)
}

/// One download of a batch (the selected entries of a playlist), as the frontend sends it.
#[derive(Debug, Clone, Deserialize)]
pub struct NewDownload {
    pub request: DownloadRequest,
    pub info: Option<DownloadInfo>,
}

/// What a batch did: `skipped` are the ones already pending, active or paused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Enqueued {
    pub queued: u32,
    pub skipped: u32,
}

/// Queues every item that is not already in the queue, in order; the ids of the new rows come
/// back with the count of the skipped ones. Any other error stops there: what was queued before
/// stays (the list shows it) and the error is returned.
pub fn enqueue_many(
    db: &Db,
    items: &[NewDownload],
    placement: &Placement,
    batch: Option<&Batch>,
) -> (Vec<i64>, u32, Option<AppError>) {
    // A playlist is listed up to `MAX_ENTRIES`, so no honest request is longer. Checked before
    // anything is queued: a hostile page could send millions of rows.
    if items.len() > MAX_ENTRIES {
        let error = AppError::Unknown(format!(
            "at most {MAX_ENTRIES} downloads can be queued at once"
        ));
        return (Vec::new(), 0, Some(error));
    }
    let (mut ids, mut skipped) = (Vec::new(), 0);
    for item in items {
        let queued = ytdlp::check_url(&item.request.url).and_then(|()| {
            db.insert_download_in(&item.request, item.info.as_ref(), placement, batch)
        });
        match queued {
            Ok(id) => ids.push(id),
            Err(AppError::AlreadyQueued(_)) => skipped += 1,
            Err(error) => return (ids, skipped, Some(error)),
        }
    }
    (ids, skipped, None)
}

/// `add` for many downloads at once: one folder check, one `download-state` per new row, and one
/// `pump` at the end instead of one per row.
pub fn add_many(
    app: &AppHandle,
    items: &[NewDownload],
    batch_title: Option<&str>,
) -> Result<Enqueued, AppError> {
    let db = app.state::<Db>();
    let placement = placement_now(&db, &default_out_dir(app)?)?;
    // The entries of one playlist share a batch: the list shows them as a group.
    let batch = Batch::new(db.next_batch()?, batch_title);
    let (ids, skipped, failure) = enqueue_many(&db, items, &placement, Some(&batch));
    emit(
        app,
        ids.iter()
            .map(|&id| state_event(id, DownloadState::Pending, None)),
    );
    pump(app);
    match failure {
        Some(error) => Err(error),
        None => Ok(Enqueued {
            queued: ids.len() as u32,
            skipped,
        }),
    }
}

/// "Choose another folder and retry" for a failed download: `move_and_retry`, then the
/// queue is told and started. Returns the settings now in force (the new folder is among them).
pub fn retry_in_other_folder(
    app: &AppHandle,
    id: i64,
    new_dir: &Path,
) -> Result<OutputSettings, AppError> {
    let db = app.state::<Db>();
    let default = default_out_dir(app)?;
    {
        let scheduler = app.state::<Scheduler>();
        let mut state = scheduler.lock();
        move_and_retry(&db, &mut state.retries, id, new_dir, &default)?;
    } // the lock is released here, before sending anything
    emit(app, [state_event(id, DownloadState::Pending, None)]);
    pump(app);
    output_settings(&db, &default)
}

/// A paused download back to `pending`; yt-dlp continues its `.part` files when it starts.
pub fn resume_download(app: &AppHandle, id: i64) -> Result<(), AppError> {
    resume(&app.state::<Db>(), id)?;
    emit(app, [state_event(id, DownloadState::Pending, None)]);
    pump(app);
    Ok(())
}

/// Manual retry of a failed download, with no retry count or wait carried over.
pub fn retry_download(app: &AppHandle, id: i64) -> Result<(), AppError> {
    {
        let scheduler = app.state::<Scheduler>();
        let mut state = scheduler.lock();
        retry(&app.state::<Db>(), &mut state.retries, id)?;
    } // the lock is released here, before sending anything
    emit(app, [state_event(id, DownloadState::Pending, None)]);
    pump(app);
    Ok(())
}

/// Starts pending downloads while there are free slots. Call it after anything that can free
/// a slot or add work: enqueue, resume, retry, a download ending, a higher limit.
///
/// Two `pump`s at once (a command and a finishing download) cannot start more downloads than
/// the limit: that is `claim_next`'s job (count and claim in one transaction), not this
/// function's. The scheduler lock held here only keeps the map in step with the database.
/// It is synchronous on purpose: claiming and spawning never wait, so no lock meets an
/// `.await`. The `active` event is sent by each download's `watch` task, not here, so it
/// always comes before that download's progress.
pub fn pump(app: &AppHandle) {
    let db = app.state::<Db>();
    let scheduler = app.state::<Scheduler>();
    let mut state = scheduler.lock();
    if state.shutting_down {
        return;
    }
    let waiting = state.retries.waiting();
    let mut events = Vec::new();
    loop {
        let job = match claim_next(&db, &waiting) {
            Ok(Some(job)) => job,
            Ok(None) => break,
            Err(err) => {
                eprintln!("cannot claim the next download: {err}");
                break;
            }
        };
        match start(app, &job) {
            Ok((run, run_events, cookie_copy)) => {
                state.running.insert(
                    job.id,
                    Running {
                        run: Some(run),
                        stop: None,
                    },
                );
                watch(app.clone(), job.id, run_events, cookie_copy);
            }
            // Nothing is running for it, so it fails right away and the loop takes the next.
            Err(err) => match mark_failed(&db, job.id, &err) {
                Ok(()) => events.extend([
                    state_event(job.id, DownloadState::Active, None),
                    state_event(job.id, DownloadState::Failed, Some(&err)),
                    Event::Failed(FailedEvent {
                        id: job.id,
                        error: err,
                    }),
                ]),
                Err(e) => eprintln!("download {}: {e}", job.id),
            },
        }
    }
    drop(state);
    emit(app, events);
}

/// Pauses or cancels download `id`. With a live process, the reason is written down and the
/// process killed; the state changes when it exits (`finish`), so its slot stays taken until
/// the process is really gone. Without one (`pending`, `paused`) only the state changes.
pub async fn stop(app: &AppHandle, id: i64, stop: Stop) -> Result<(), AppError> {
    // The block ends before the `.await`, so the lock guard is dropped first. Holding it
    // while waiting would block every other queue call (and a std `MutexGuard` is not `Send`,
    // so the compiler would reject this async command anyway).
    let (run, events, cleanup) = {
        let db = app.state::<Db>();
        let scheduler = app.state::<Scheduler>();
        let mut state = scheduler.lock();
        match state.running.get_mut(&id) {
            // A second stop before the exit just updates the reason: the last one wins.
            Some(entry) => {
                entry.stop = Some(stop);
                (entry.run.take(), Vec::new(), Cleanup::Keep)
            }
            // No process: `pending` (perhaps waiting for a network retry) or `paused`.
            // Forgetting the retry drops its wait, so the wake-up finds nothing to start.
            None => {
                let to = match stop {
                    Stop::Pause => pause(&db, id).map(|()| DownloadState::Paused)?,
                    Stop::Cancel => cancel(&db, id).map(|()| DownloadState::Cancelled)?,
                };
                state.retries.forget(id);
                (None, vec![state_event(id, to, None)], cleanup_for(to, None))
            }
        }
    };
    // No process holds its files (with one, `finish` cleans once it has exited).
    clean(app, id, cleanup);
    emit(app, events);
    if let Some(run) = run {
        run.cancel().await;
    }
    Ok(())
}

/// `Downloads/AlbaRo Downloader`: where files go until the user picks a folder, and where rows
/// queued before the folder was stored went.
pub fn default_out_dir(app: &AppHandle) -> Result<PathBuf, AppError> {
    let downloads = app
        .path()
        .download_dir()
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    Ok(downloads.join("AlbaRo Downloader"))
}

/// The folder and name download `id` was queued with.
fn placement_of(app: &AppHandle, id: i64) -> Result<(PathBuf, NameTemplate), AppError> {
    let placement = app.state::<Db>().placement(id)?;
    Ok(resolve(&placement, &default_out_dir(app)?))
}

/// Launches `job`. The third value is the private copy of the user's cookies file, if one is set
///: the caller keeps it alive as long as the process runs, and it deletes the file when
/// dropped.
fn start(
    app: &AppHandle,
    job: &Job,
) -> Result<(Run, Receiver<RunEvent>, Option<CookieCopy>), AppError> {
    let (out, template) = resolve(&job.placement, &default_out_dir(app)?);
    // The folder may have gone since it was queued (a drive that is no longer there): the
    // download fails with `folderUnavailable` instead of yt-dlp's own message.
    // Known limit: this touches the disk while `pump` holds the scheduler lock; a dead network
    // drive could stall it for a while. Move the check outside the lock if that ever shows up.
    ensure_dir(&out)?;
    // The speed limit and the cookies are read now, so they reach every download that starts
    // after the user changes them.
    let (tuning, cookie_copy) = settings::tuning(&app.state::<Db>(), &cookies::run_dir(app)?)?;
    let args = formats::args(
        &job.request,
        template,
        &out,
        &temp_dir(&out, job.id),
        &ytdlp::bin_dir()?,
        tuning,
    )?;
    let (run, events) = ytdlp::spawn(app, args)?;
    Ok((run, events, cookie_copy))
}

/// Best effort: a folder that cannot be cleaned is logged, and changes neither the state nor
/// any event. Called with no lock held and, for a download with a process, only once that
/// process has exited (Windows cannot delete a file that is still open). Plain `std::fs`: it
/// runs outside any `.await`, and unlinking a few files takes milliseconds even when they are
/// GB in size.
fn clean(app: &AppHandle, id: i64, cleanup: Cleanup) {
    if cleanup == Cleanup::Keep {
        return;
    }
    // The download's own folder, not the one in the settings now.
    let dir = match placement_of(app, id) {
        Ok((out, _)) => temp_dir(&out, id),
        Err(err) => return eprintln!("download {id}: cannot clean its temporary files: {err}"),
    };
    if let Err(err) = clean_temp(&dir, id, cleanup) {
        eprintln!("download {id}: cannot clean {}: {err}", dir.display());
    }
}

/// Sends one download's events while it runs (`active`, its progress) and handles its exit,
/// in a Tokio task. Everything about one run comes from this task, in order.
fn watch(app: AppHandle, id: i64, mut events: Receiver<RunEvent>, cookie_copy: Option<CookieCopy>) {
    // `async move` moves `app` (a cheap handle; the caller passed a clone), `id`, the receiver
    // and the cookie copy into the task, which outlives `pump`. Nothing borrowed from `pump` can
    // go in.
    tauri::async_runtime::spawn(async move {
        // Held until the task ends, which is when the process has exited: then the copy goes.
        let _cookie_copy = cookie_copy;
        // The row is already `active` (`claim_next` wrote it before the spawn).
        emit(&app, [state_event(id, DownloadState::Active, None)]);
        // Owned by this task alone (moved in with it), so it needs no lock, and it is dropped
        // when the download's run ends. A retry is a new run with a fresh one.
        let mut throttle = Throttle::default();
        // The final file's path, printed once it is in place (the last one wins).
        let mut file: Option<String> = None;
        while let Some(event) = events.recv().await {
            match event {
                RunEvent::Stdout(line) if progress::parse_file(&line).is_some() => {
                    file = progress::parse_file(&line).map(String::from);
                }
                RunEvent::Stdout(line) => match progress::parse_line(&line) {
                    Ok(Some(progress)) => {
                        if throttle.should_emit(Instant::now(), &progress) {
                            emit(&app, [Event::Progress(ProgressEvent { id, progress })]);
                        }
                    }
                    Ok(None) => {}
                    // One unreadable line must not stop the download: log it and go on.
                    Err(err) => {
                        eprintln!("download {id}: unreadable progress line ({err}): {line}")
                    }
                },
                RunEvent::Stderr(line) => eprintln!("yt-dlp [{id}]: {line}"),
                // Always the last event: the channel closes after it. The held-back update
                // goes first, from this same task, so it reaches the UI before the state event.
                RunEvent::Exited(result) => {
                    if let Some(progress) = throttle.flush() {
                        emit(&app, [Event::Progress(ProgressEvent { id, progress })]);
                    }
                    finish(&app, id, result, file.take())
                }
            }
        }
    });
}

/// Turns a process exit into the download's next state (final, or waiting for a network
/// retry), sends its events, then fills the freed slot.
fn finish(app: &AppHandle, id: i64, result: Result<(), AppError>, file: Option<String>) {
    let db = app.state::<Db>();
    let scheduler = app.state::<Scheduler>();
    let mut state = scheduler.lock();
    let stop = state.running.remove(&id).and_then(|entry| entry.stop);
    // Quitting killed this process on purpose: the row stays `active` for the next start.
    if state.shutting_down {
        return;
    }
    let mut events = Vec::new();
    // Stays `Keep` unless the state change below is written.
    let mut cleanup = Cleanup::Keep;
    // Set when the site looks changed and this download has not had its update yet.
    let mut update_and_retry = false;
    // Finished, paused or cancelled ends any retry (a resumed download starts afresh); a
    // failure is left to `fail_or_retry`, which keeps counting network retries. Each event is
    // queued only once its database write succeeded.
    let stored = match (result, stop) {
        // Exit 0 wins over a late pause or cancel: the file is complete.
        (Ok(()), _) => {
            state.retries.forget(id);
            mark_finished(&db, id, file.as_deref()).map(|()| {
                state.summary.finished += 1;
                state.last_finished = Some(id);
                cleanup = cleanup_for(DownloadState::Finished, None);
                events.extend([
                    state_event(id, DownloadState::Finished, None),
                    Event::Finished(FinishedEvent { id }),
                ])
            })
        }
        (Err(AppError::Cancelled(_)), Some(Stop::Pause)) => {
            state.retries.forget(id);
            pause(&db, id).map(|()| events.push(state_event(id, DownloadState::Paused, None)))
        }
        // A cancellation is not a failure: only its state event, no `download-failed`.
        (Err(AppError::Cancelled(_)), _) => {
            state.retries.forget(id);
            cancel(&db, id).map(|()| {
                cleanup = cleanup_for(DownloadState::Cancelled, None);
                events.push(state_event(id, DownloadState::Cancelled, None))
            })
        }
        (Err(error), _) => {
            let error = classify::refine(error);
            let outcome = fail_or_retry(
                &db,
                &mut state.retries,
                id,
                &error,
                Instant::now(),
                jitter(),
            );
            outcome.map(|after| match after {
                AfterFailure::RetryIn { attempt, delay } => {
                    eprintln!(
                        "download {id}: network error, retry {attempt}/{MAX_RETRIES} in {:.1} s: {}",
                        delay.as_secs_f64(),
                        error.parts().1
                    );
                    wake_after(app.clone(), id, delay);
                    events.extend([
                        state_event(id, DownloadState::Pending, Some(&error)),
                        Event::Retrying(RetryingEvent {
                            id,
                            attempt,
                            max_attempts: MAX_RETRIES,
                            delay_ms: delay.as_millis() as u64,
                        }),
                    ]);
                }
                AfterFailure::Failed => {
                    state.summary.failed += 1;
                    update_and_retry = matches!(error, AppError::ExtractorBroken(_))
                        && state.updated_once.insert(id);
                    cleanup = cleanup_for(DownloadState::Failed, Some(&error));
                    events.extend([
                        state_event(id, DownloadState::Failed, Some(&error)),
                        Event::Failed(FailedEvent { id, error }),
                    ])
                }
            })
        }
    };
    // Released before sending and before `pump`, which takes the same lock (std mutexes are
    // not reentrant).
    drop(state);
    if let Err(err) = stored {
        eprintln!("download {id}: {err}");
    }
    // The process has exited, so its files are closed and can be deleted. Before the events,
    // so a UI that sees `cancelled` finds the folder already gone.
    clean(app, id, cleanup);
    emit(app, events);
    pump(app);
    if update_and_retry {
        update_then_retry(app.clone(), id);
    }
    notify_if_idle(app);
}

/// Whether anything is running, or queued (a download waiting for a network retry is queued).
fn busy(state: &State, db: &Db) -> Result<bool, AppError> {
    Ok(!state.running.is_empty() || db.count_in(DownloadState::Pending)? > 0)
}

/// Whether the app has downloads in progress or waiting: closing the window then hides it in the
/// tray instead of quitting. Unknown counts as yes: better to keep going than to drop
/// the work.
pub fn has_work(app: &AppHandle) -> bool {
    let scheduler = app.state::<Scheduler>();
    let state = scheduler.lock();
    busy(&state, &app.state::<Db>()).unwrap_or(true)
}

/// Quitting: kills every download's process tree, so no yt-dlp or ffmpeg outlives the
/// app (they did, for a few seconds, before). The rows are left as they are, `active`,
/// and so is the `.part` data: the next start turns them back to `pending` and yt-dlp continues.
/// Nothing new starts after this. Blocks until the processes are killed (`taskkill`, quick).
pub fn shutdown(app: &AppHandle) {
    let runs: Vec<Run> = {
        let scheduler = app.state::<Scheduler>();
        let mut state = scheduler.lock();
        state.shutting_down = true;
        state
            .running
            .values_mut()
            .filter_map(|entry| entry.run.take())
            .collect()
    };
    tauri::async_runtime::block_on(async {
        for run in runs {
            run.cancel().await;
        }
    });
}

/// When the queue has gone quiet, says so once for everything that finished or failed since the
/// last time: a playlist of 300 is one notification, not 300. Nothing is shown if the
/// user turned it off, or while the window is in front (they can see it).
fn notify_if_idle(app: &AppHandle) {
    let summary = {
        let db = app.state::<Db>();
        let scheduler = app.state::<Scheduler>();
        let mut state = scheduler.lock();
        match busy(&state, &db) {
            Ok(false) => {}
            Ok(true) => return,
            Err(err) => return eprintln!("cannot tell whether the queue is idle: {err}"),
        }
        let mut summary = std::mem::take(&mut state.summary);
        let last = state.last_finished.take();
        if summary.finished == 1 && summary.failed == 0 {
            summary.only_title = last
                .and_then(|id| db.download(id).ok().flatten())
                .map(|row| row.title.unwrap_or(row.request.url));
        }
        summary
    };
    let Some((title, body)) = ui::idle_message(app.state::<UiLanguage>().get(), &summary) else {
        return;
    };
    if !settings::notifications(&app.state::<Db>()).unwrap_or(true) || window_in_front(app) {
        return;
    }
    if let Err(err) = app.notification().builder().title(title).body(body).show() {
        eprintln!("cannot show the notification: {err}");
    }
}

/// The window is visible and has the focus.
fn window_in_front(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false) && window.is_focused().unwrap_or(false)
    })
}

/// Deletes the temporary folders (`<out>/.albaro-tmp/<id>`) that nothing needs: their download is
/// gone from the database (it was deleted, or ids started over), finished, cancelled, or failed
/// with anything but a network error (those keep their `.part` for the retry). Called once at
/// start, after the recovery and before anything runs, over every folder a download went to.
/// Returns how many it removed; one that cannot be removed is logged and left.
pub fn sweep_orphans(db: &Db, default: &Path) -> Result<u32, AppError> {
    let mut dirs: BTreeSet<PathBuf> = db.out_dirs()?.into_iter().map(PathBuf::from).collect();
    dirs.insert(default.to_path_buf());
    dirs.insert(output_dir(db, default)?);
    let mut removed = 0;
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir.join(TEMP_ROOT)) else {
            continue;
        };
        for entry in entries.flatten() {
            let Some(id) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<i64>().ok())
            else {
                continue;
            };
            let needed = db.download(id)?.is_some_and(|row| match row.state {
                DownloadState::Finished | DownloadState::Cancelled => false,
                DownloadState::Failed => row.error.is_some_and(|e| e.code == "network"),
                _ => true,
            });
            if needed {
                continue;
            }
            match clean_temp(&entry.path(), id, Cleanup::Delete) {
                Ok(()) => removed += 1,
                Err(err) => eprintln!("cannot remove {}: {err}", entry.path().display()),
            }
        }
    }
    Ok(removed)
}

/// A download failed because the site seems to have changed: fetch a newer yt-dlp
/// and, only if one got installed, run the download again once. It shows as `failed` meanwhile
/// and goes back to `pending` through the manual retry. A thread of its own: the update blocks.
fn update_then_retry(app: AppHandle, id: i64) {
    std::thread::spawn(move || {
        if updater::update_now(&app) {
            if let Err(err) = retry_download(&app, id) {
                eprintln!("download {id}: cannot retry after the update: {err}");
            }
        }
    });
}

/// Starts `id` again once its retry wait is over. A plain thread that sleeps: it holds no
/// lock and nothing borrowed while it waits (`app` is moved in, a cheap handle).
// Known limit: one sleeping OS thread per waiting retry (a few at most, ≤ 32 s each); move to a
// timer on the async runtime if many downloads can wait at once.
fn wake_after(app: AppHandle, id: i64, delay: Duration) {
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        let due = app
            .state::<Scheduler>()
            .lock()
            .retries
            .wake(id, Instant::now());
        if due {
            pump(&app);
        }
    });
}

// Known limit: the clock's microseconds as cheap randomness (no `rand` crate); enough to keep
// retries from lining up. Microseconds, not nanoseconds: Windows' clock ticks every 100 ns,
// so `nanos % 500` could only be 0, 100, 200, 300 or 400 (seen in practice).
fn jitter() -> Duration {
    let micros = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.subsec_micros());
    Duration::from_millis(u64::from(micros) % MAX_JITTER.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashSet,
        sync::{Arc, Barrier},
        thread,
        time::Duration,
    };

    use super::*;
    use crate::{
        test_util::TempDir,
        ytdlp::formats::{AudioFormat, Container, Mode, PlaylistPosition},
    };
    use DownloadState::*;

    fn request(n: u32) -> DownloadRequest {
        DownloadRequest {
            url: format!("https://example.com/video/{n}"),
            mode: Mode::Video {
                max_height: Some(720),
                container: Some(Container::Mp4),
            },
            playlist: None,
            folder: None,
            subtitles: None,
        }
    }

    fn state(db: &Db, id: i64) -> DownloadState {
        db.download(id).unwrap().unwrap().state
    }

    /// A download in `state`, reached through allowed steps only. Each gets its own URL, so
    /// none is a duplicate of an earlier one.
    fn download_in(db: &Db, target: DownloadState) -> i64 {
        let n = db.downloads().unwrap().len() as u32 + 1000;
        let id = enqueue(db, &request(n), None, &Placement::default()).unwrap();
        move_to(db, id, target);
        id
    }

    /// Takes a new (`pending`) download to `target` through allowed steps only.
    fn move_to(db: &Db, id: i64, target: DownloadState) {
        let path: &[DownloadState] = match target {
            Pending => &[],
            Active => &[Active],
            Paused => &[Paused],
            Finished => &[Active, Finished],
            Failed => &[Active, Failed],
            Cancelled => &[Cancelled],
        };
        for &to in path {
            db.transition(id, to, None, allowed).unwrap();
        }
        assert_eq!(state(db, id), target);
    }

    const VALID: [(DownloadState, DownloadState); 10] = [
        (Pending, Active),
        (Pending, Paused),
        (Pending, Cancelled),
        (Active, Finished),
        (Active, Failed),
        (Active, Paused),
        (Active, Cancelled),
        (Paused, Pending),
        (Paused, Cancelled),
        (Failed, Pending),
    ];

    // --- transitions ---

    #[test]
    fn every_pair_follows_the_table_and_a_refusal_changes_nothing() {
        let db = Db::open_in_memory().unwrap();
        for from in DownloadState::ALL {
            for to in DownloadState::ALL {
                let valid = VALID.contains(&(from, to));
                assert_eq!(allowed(from, to), valid, "{from:?} -> {to:?}");
                let id = download_in(&db, from);
                let before = db.download(id).unwrap().unwrap();
                let result = db.transition(id, to, None, allowed);
                if valid {
                    result.unwrap();
                    assert_eq!(state(&db, id), to);
                } else {
                    let err = result.unwrap_err();
                    assert!(err.to_string().contains("cannot go from"), "{err}");
                    assert_eq!(db.download(id).unwrap().unwrap(), before);
                }
            }
        }
    }

    // --- enqueue and claim ---

    #[test]
    fn enqueue_adds_pending_and_rejects_bad_urls() {
        let db = Db::open_in_memory().unwrap();
        let id = enqueue(&db, &request(1), None, &Placement::default()).unwrap();
        assert_eq!(state(&db, id), Pending);
        let mut bad = request(2);
        bad.url = "--exec=calc.exe".into();
        assert!(matches!(
            enqueue(&db, &bad, None, &Placement::default()),
            Err(AppError::InvalidUrl(_))
        ));
        assert_eq!(db.downloads().unwrap().len(), 1);
    }

    #[test]
    fn claim_is_fifo_and_returns_the_request() {
        let db = Db::open_in_memory().unwrap();
        let ids: Vec<i64> = (1..=3)
            .map(|n| enqueue(&db, &request(n), None, &Placement::default()).unwrap())
            .collect();
        for (n, &id) in (1..=3).zip(&ids) {
            let job = claim_next(&db, &[]).unwrap().unwrap();
            assert_eq!(job.id, id);
            assert_eq!(job.request, request(n));
            assert_eq!(state(&db, id), Active);
        }
        assert_eq!(claim_next(&db, &[]).unwrap(), None);
    }

    #[test]
    fn claim_respects_the_limit_and_never_repeats_a_job() {
        let db = Db::open_in_memory().unwrap();
        set_max_concurrent(&db, 2).unwrap();
        let ids: Vec<i64> = (1..=3)
            .map(|n| enqueue(&db, &request(n), None, &Placement::default()).unwrap())
            .collect();
        let first = claim_next(&db, &[]).unwrap().unwrap();
        let second = claim_next(&db, &[]).unwrap().unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(claim_next(&db, &[]).unwrap(), None);
        assert_eq!(db.count_in(Active).unwrap(), 2);
        assert_eq!(db.count_in(Pending).unwrap(), 1);
        assert_eq!(state(&db, ids[2]), Pending);
        // A finished one frees its slot for the third.
        mark_finished(&db, first.id, None).unwrap();
        assert_eq!(claim_next(&db, &[]).unwrap().unwrap().id, ids[2]);
    }

    #[test]
    fn changing_the_limit_never_touches_active_downloads() {
        let db = Db::open_in_memory().unwrap();
        for n in 1..=5 {
            enqueue(&db, &request(n), None, &Placement::default()).unwrap();
        }
        set_max_concurrent(&db, 2).unwrap();
        while claim_next(&db, &[]).unwrap().is_some() {}
        assert_eq!(db.count_in(Active).unwrap(), 2);

        // Lower: both keep running, nothing new starts.
        set_max_concurrent(&db, 1).unwrap();
        assert_eq!(claim_next(&db, &[]).unwrap(), None);
        assert_eq!(db.count_in(Active).unwrap(), 2);
        assert_eq!(db.count_in(Pending).unwrap(), 3);

        // Higher: two more can start.
        set_max_concurrent(&db, 4).unwrap();
        while claim_next(&db, &[]).unwrap().is_some() {}
        assert_eq!(db.count_in(Active).unwrap(), 4);
        assert_eq!(db.count_in(Pending).unwrap(), 1);
    }

    // --- pause, resume, cancel ---

    #[test]
    fn pause_resume_and_cancel_from_every_state() {
        let db = Db::open_in_memory().unwrap();
        type Action = fn(&Db, i64) -> Result<(), AppError>;
        let actions: [(&str, Action, DownloadState); 3] = [
            ("pause", pause, Paused),
            ("resume", resume, Pending),
            ("cancel", cancel, Cancelled),
        ];
        for (name, action, to) in actions {
            for from in DownloadState::ALL {
                let id = download_in(&db, from);
                let result = action(&db, id);
                assert_eq!(result.is_ok(), allowed(from, to), "{name} from {from:?}");
                let expected = if result.is_ok() { to } else { from };
                assert_eq!(state(&db, id), expected, "{name} from {from:?}");
            }
        }
    }

    // --- errors ---

    #[test]
    fn mark_failed_stores_the_error_and_mark_finished_clears_it() {
        let db = Db::open_in_memory().unwrap();
        let id = download_in(&db, Active);
        mark_failed(&db, id, &AppError::Unavailable("Video unavailable".into())).unwrap();
        let error = db.download(id).unwrap().unwrap().error.unwrap();
        assert_eq!(
            (error.code.as_str(), error.message.as_str()),
            ("unavailable", "Video unavailable")
        );

        // Manual retry: failed → pending → active → finished, and the old error is gone.
        resume(&db, id).unwrap();
        db.transition(id, Active, None, allowed).unwrap();
        mark_finished(&db, id, None).unwrap();
        let stored = db.download(id).unwrap().unwrap();
        assert_eq!((stored.state, stored.error), (Finished, None));
    }

    // --- concurrency setting ---

    #[test]
    fn concurrency_setting_defaults_validates_and_survives_bad_values() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(max_concurrent(&db).unwrap(), 3);
        assert!(set_max_concurrent(&db, 0).is_err());
        assert!(set_max_concurrent(&db, MAX_CONCURRENT_LIMIT + 1).is_err());
        assert!(set_max_concurrent(&db, u32::MAX).is_err());
        assert_eq!(max_concurrent(&db).unwrap(), 3);
        set_max_concurrent(&db, MAX_CONCURRENT_LIMIT).unwrap();
        set_max_concurrent(&db, 3).unwrap();
        set_max_concurrent(&db, 5).unwrap();
        assert_eq!(max_concurrent(&db).unwrap(), 5);
        for unreadable in ["abc", "", "-2", "0", "2.5"] {
            db.set_setting(MAX_CONCURRENT_KEY, unreadable).unwrap();
            assert_eq!(max_concurrent(&db).unwrap(), 3, "{unreadable:?}");
        }
    }

    // --- recovery at startup ---

    #[test]
    fn recovery_moves_only_active_back_to_pending() {
        let db = Db::open_in_memory().unwrap();
        let ids: Vec<(i64, DownloadState)> = DownloadState::ALL
            .into_iter()
            .chain([Active])
            .map(|state| (download_in(&db, state), state))
            .collect();
        let before = db.downloads().unwrap();

        assert_eq!(db.recover_active().unwrap(), 2);
        for (&(id, was), row) in ids.iter().zip(&before) {
            let now = db.download(id).unwrap().unwrap();
            if was == Active {
                assert_eq!(now.state, Pending);
            } else {
                assert_eq!(&now, row, "{was:?} must stay as it was");
            }
        }
        assert_eq!(db.count_in(Active).unwrap(), 0);
        // Idempotent: nothing left to recover.
        assert_eq!(db.recover_active().unwrap(), 0);
    }

    #[test]
    fn recovered_ghosts_restart_first_within_the_limit() {
        let db = Db::open_in_memory().unwrap();
        let ids: Vec<i64> = (1..=4)
            .map(|n| enqueue(&db, &request(n), None, &Placement::default()).unwrap())
            .collect();
        // The last run had 3 running (limit 3) when it closed; the 4th was waiting.
        set_max_concurrent(&db, 3).unwrap();
        while claim_next(&db, &[]).unwrap().is_some() {}
        assert_eq!(db.count_in(Active).unwrap(), 3);

        set_max_concurrent(&db, 2).unwrap();
        assert_eq!(db.recover_active().unwrap(), 3);
        assert_eq!(claim_next(&db, &[]).unwrap().unwrap().id, ids[0]);
        assert_eq!(claim_next(&db, &[]).unwrap().unwrap().id, ids[1]);
        assert_eq!(claim_next(&db, &[]).unwrap(), None);
        assert_eq!(state(&db, ids[2]), Pending);
        assert_eq!(state(&db, ids[3]), Pending);
    }

    // --- duplicates ---

    #[test]
    fn a_duplicate_is_refused_while_the_first_is_pending_active_or_paused() {
        for first_state in [Pending, Active, Paused] {
            let db = Db::open_in_memory().unwrap();
            let id = enqueue(&db, &request(1), None, &Placement::default()).unwrap();
            move_to(&db, id, first_state);
            let err = enqueue(&db, &request(1), None, &Placement::default()).unwrap_err();
            // Its own code, not `unknown`; the raw message keeps the id.
            let expected = format!("already in the queue (id {id})");
            assert!(
                matches!(&err, AppError::AlreadyQueued(m) if m.contains(&expected)),
                "{first_state:?}: {err}"
            );
            assert_eq!(db.downloads().unwrap().len(), 1);
        }
    }

    fn item(n: u32) -> NewDownload {
        NewDownload {
            request: request(n),
            info: None,
        }
    }

    #[test]
    fn a_batch_queues_in_order_and_skips_what_is_already_queued() {
        let db = Db::open_in_memory().unwrap();
        let placement = Placement::default();
        let first = enqueue(&db, &request(2), None, &placement).unwrap();
        // 2 is already pending; 3 appears twice in the batch itself.
        let items = [item(1), item(2), item(3), item(3), item(4)];
        let (ids, skipped, failure) = enqueue_many(&db, &items, &placement, None);
        assert_eq!((ids.len(), skipped, failure), (3, 2, None));
        assert!(first < ids[0] && ids.windows(2).all(|w| w[0] < w[1]));
        let urls: Vec<String> = db
            .downloads()
            .unwrap()
            .into_iter()
            .map(|d| d.request.url)
            .collect();
        let expected: Vec<String> = [2, 1, 3, 4]
            .iter()
            .map(|n| format!("https://example.com/video/{n}"))
            .collect();
        assert_eq!(urls, expected);
    }

    #[test]
    fn a_batch_tags_every_row_it_queues_and_not_the_skipped_ones() {
        let db = Db::open_in_memory().unwrap();
        let placement = Placement::default();
        // Queued on its own before: skipped, and it stays outside the batch.
        let alone = enqueue(&db, &request(2), None, &placement).unwrap();
        let batch = Batch::new(db.next_batch().unwrap(), Some("  My list "));
        let (ids, skipped, _) =
            enqueue_many(&db, &[item(1), item(2), item(3)], &placement, Some(&batch));
        assert_eq!((ids.len(), skipped), (2, 1));
        let rows = db.downloads().unwrap();
        assert_eq!(rows.iter().find(|d| d.id == alone).unwrap().batch, None);
        for id in ids {
            let tagged = rows.iter().find(|d| d.id == id).unwrap().batch.clone();
            assert_eq!(
                tagged,
                Some(Batch {
                    id: 1,
                    title: Some("My list".into())
                })
            );
        }
        // The next playlist gets another number.
        assert_eq!(db.next_batch().unwrap(), 2);
    }

    #[test]
    fn a_batch_longer_than_any_playlist_listing_is_refused_before_queueing_anything() {
        let db = Db::open_in_memory().unwrap();
        let items: Vec<NewDownload> = (0..MAX_ENTRIES as u32 + 1).map(item).collect();
        let (ids, skipped, failure) = enqueue_many(&db, &items, &Placement::default(), None);
        assert_eq!((ids.len(), skipped), (0, 0));
        assert!(matches!(failure, Some(AppError::Unknown(m)) if m.contains("at most")));
        assert!(db.downloads().unwrap().is_empty());
        // Exactly the limit is a whole playlist and goes through.
        let (ids, _, failure) =
            enqueue_many(&db, &items[..MAX_ENTRIES], &Placement::default(), None);
        assert_eq!((ids.len(), failure), (MAX_ENTRIES, None));
    }

    #[test]
    fn a_batch_stops_at_a_real_error_and_keeps_what_it_queued() {
        let db = Db::open_in_memory().unwrap();
        let mut bad = item(2);
        bad.request.url = "file:///etc/passwd".into();
        let (ids, skipped, failure) =
            enqueue_many(&db, &[item(1), bad, item(3)], &Placement::default(), None);
        assert_eq!((ids.len(), skipped), (1, 0));
        assert!(matches!(failure, Some(AppError::InvalidUrl(_))));
        assert_eq!(db.downloads().unwrap().len(), 1);
    }

    #[test]
    fn the_same_video_at_two_positions_is_two_downloads() {
        let db = Db::open_in_memory().unwrap();
        let at = |index| {
            let mut i = item(1);
            i.request.playlist = Some(PlaylistPosition { index, count: 5 });
            i
        };
        let (ids, skipped, _) =
            enqueue_many(&db, &[at(1), at(1), at(4)], &Placement::default(), None);
        assert_eq!((ids.len(), skipped), (2, 1));
        // And it is not the plain download of that video either.
        assert!(enqueue(&db, &request(1), None, &Placement::default()).is_ok());
    }

    #[test]
    fn a_duplicate_is_accepted_once_the_first_has_ended() {
        for first_state in [Finished, Failed, Cancelled] {
            let db = Db::open_in_memory().unwrap();
            let id = enqueue(&db, &request(1), None, &Placement::default()).unwrap();
            move_to(&db, id, first_state);
            let again = enqueue(&db, &request(1), None, &Placement::default()).unwrap();
            assert_ne!(again, id, "{first_state:?}");
        }
    }

    #[test]
    fn same_url_with_another_mode_is_not_a_duplicate() {
        let db = Db::open_in_memory().unwrap();
        let base = request(1);
        enqueue(&db, &base, None, &Placement::default()).unwrap();
        let others = [
            Mode::Video {
                max_height: Some(1080),
                container: Some(Container::Mp4),
            },
            Mode::Video {
                max_height: Some(720),
                container: Some(Container::Mkv),
            },
            Mode::Audio {
                format: AudioFormat::Best,
                bitrate_kbps: None,
            },
        ];
        for mode in others {
            let other = DownloadRequest {
                url: base.url.clone(),
                mode,
                playlist: None,
                folder: None,
                subtitles: None,
            };
            enqueue(&db, &other, None, &Placement::default()).unwrap();
        }
        assert_eq!(db.downloads().unwrap().len(), 4);
    }

    // --- network retries ---

    const NO_JITTER: Duration = Duration::ZERO;

    fn network() -> AppError {
        AppError::Network("Unable to download webpage: getaddrinfo failed".into())
    }

    /// Fails active download `id` with `error` at `now`.
    fn fail(
        db: &Db,
        retries: &mut Retries,
        id: i64,
        error: &AppError,
        now: Instant,
    ) -> AfterFailure {
        fail_or_retry(db, retries, id, error, now, NO_JITTER).unwrap()
    }

    #[test]
    fn retry_delay_doubles_stops_after_five_and_caps_the_jitter() {
        let secs: Vec<u64> = (1..=MAX_RETRIES)
            .map(|n| retry_delay(n, NO_JITTER).unwrap().as_secs())
            .collect();
        assert_eq!(secs, [2, 4, 8, 16, 32]);
        assert_eq!(retry_delay(0, NO_JITTER), None);
        assert_eq!(retry_delay(MAX_RETRIES + 1, NO_JITTER), None);
        let small = Duration::from_millis(120);
        assert_eq!(retry_delay(1, small), Some(Duration::from_millis(2120)));
        // A jitter beyond the cap counts as the cap.
        assert_eq!(
            retry_delay(3, Duration::from_secs(10)),
            Some(Duration::from_millis(8500))
        );
        // The production jitter stays within the cap, and is not stuck on a few values.
        let samples: HashSet<Duration> = (0..200)
            .map(|_| {
                thread::sleep(Duration::from_micros(37));
                jitter()
            })
            .collect();
        assert!(samples.iter().all(|&j| j < MAX_JITTER));
        assert!(samples.len() > 20, "only {} distinct values", samples.len());
    }

    #[test]
    fn only_network_errors_wait_and_the_wait_frees_the_slot() {
        let db = Db::open_in_memory().unwrap();
        set_max_concurrent(&db, 1).unwrap();
        let mut retries = Retries::default();
        let now = Instant::now();

        let id = enqueue(&db, &request(1), None, &Placement::default()).unwrap();
        let other = enqueue(&db, &request(2), None, &Placement::default()).unwrap();
        assert_eq!(claim_next(&db, &retries.waiting()).unwrap().unwrap().id, id);
        let outcome = fail(&db, &mut retries, id, &network(), now);
        assert_eq!(
            outcome,
            AfterFailure::RetryIn {
                attempt: 1,
                delay: Duration::from_secs(2)
            }
        );
        // Waiting: back to pending with the error kept, and its slot goes to the next one.
        let row = db.download(id).unwrap().unwrap();
        assert_eq!(row.state, Pending);
        assert_eq!(row.error.unwrap().code, "network");
        assert_eq!(retries.waiting(), [id]);
        assert_eq!(
            claim_next(&db, &retries.waiting()).unwrap().unwrap().id,
            other
        );

        for error in [
            AppError::Unavailable("Video unavailable".into()),
            AppError::Unknown("HTTP Error 403: Forbidden".into()),
            AppError::LoginRequired("Sign in to confirm your age".into()),
        ] {
            let id = download_in(&db, Active);
            assert_eq!(
                fail(&db, &mut retries, id, &error, now),
                AfterFailure::Failed
            );
            let row = db.download(id).unwrap().unwrap();
            assert_eq!(row.state, Failed);
            assert_eq!(row.error.unwrap().code, error.parts().0);
            assert!(!retries.waiting().contains(&id));
        }
    }

    #[test]
    fn the_sixth_network_error_fails_with_that_error() {
        let db = Db::open_in_memory().unwrap();
        let mut retries = Retries::default();
        let id = enqueue(&db, &request(1), None, &Placement::default()).unwrap();
        let mut now = Instant::now();
        for attempt in 1..=MAX_RETRIES {
            // Not claimable until the wait is over.
            if attempt > 1 {
                assert_eq!(claim_next(&db, &retries.waiting()).unwrap(), None);
                now += Duration::from_secs(60);
                assert!(retries.wake(id, now));
            }
            assert_eq!(claim_next(&db, &retries.waiting()).unwrap().unwrap().id, id);
            let delay = retry_delay(attempt, NO_JITTER).unwrap();
            let outcome = fail(&db, &mut retries, id, &network(), now);
            assert_eq!(outcome, AfterFailure::RetryIn { attempt, delay });
        }
        now += Duration::from_secs(60);
        assert!(retries.wake(id, now));
        claim_next(&db, &retries.waiting()).unwrap().unwrap();
        let last = AppError::Network("timed out".into());
        assert_eq!(
            fail(&db, &mut retries, id, &last, now),
            AfterFailure::Failed
        );
        let row = db.download(id).unwrap().unwrap();
        assert_eq!(row.state, Failed);
        let stored = row.error.unwrap();
        assert_eq!(
            (stored.code.as_str(), stored.message.as_str()),
            ("network", "timed out")
        );
        // Nothing left in memory for it.
        assert!(retries.waiting().is_empty());
        assert!(retries.attempts.is_empty());
    }

    #[test]
    fn a_wake_up_only_counts_once_the_wait_is_due() {
        let db = Db::open_in_memory().unwrap();
        let mut retries = Retries::default();
        let id = download_in(&db, Active);
        let now = Instant::now();
        fail(&db, &mut retries, id, &network(), now);
        assert!(!retries.wake(id, now + Duration::from_secs(1)));
        assert!(retries.wake(id, now + Duration::from_secs(2)));
        assert!(
            !retries.wake(id, now + Duration::from_secs(3)),
            "already woken"
        );
    }

    #[test]
    fn cancel_during_the_wait_drops_the_retry() {
        let db = Db::open_in_memory().unwrap();
        let mut retries = Retries::default();
        let id = download_in(&db, Active);
        let now = Instant::now();
        fail(&db, &mut retries, id, &network(), now);
        // What `stop` does for a download without a process.
        cancel(&db, id).unwrap();
        retries.forget(id);
        assert_eq!(state(&db, id), Cancelled);
        assert!(!retries.wake(id, now + Duration::from_secs(60)));
        assert!(retries.waiting().is_empty());
    }

    #[test]
    fn pause_during_the_wait_and_resume_start_afresh() {
        let db = Db::open_in_memory().unwrap();
        let mut retries = Retries::default();
        let id = download_in(&db, Active);
        let now = Instant::now();
        fail(&db, &mut retries, id, &network(), now);
        claim_next(&db, &retries.waiting()).unwrap();
        // The second attempt failed too, so the next wait would be 4 s.
        retries.wake(id, now + Duration::from_secs(60));
        claim_next(&db, &retries.waiting()).unwrap().unwrap();
        fail(&db, &mut retries, id, &network(), now);

        pause(&db, id).unwrap();
        retries.forget(id);
        assert!(!retries.wake(id, now + Duration::from_secs(60)));
        resume(&db, id).unwrap();
        // No inherited wait: it can start right away, and counts from the first retry again.
        assert_eq!(claim_next(&db, &retries.waiting()).unwrap().unwrap().id, id);
        let outcome = fail(&db, &mut retries, id, &network(), now);
        assert_eq!(
            outcome,
            AfterFailure::RetryIn {
                attempt: 1,
                delay: Duration::from_secs(2)
            }
        );
    }

    // --- manual retry ---

    #[test]
    fn manual_retry_only_from_failed_and_unknown_ids_fail() {
        let db = Db::open_in_memory().unwrap();
        let mut retries = Retries::default();
        for from in DownloadState::ALL {
            let id = download_in(&db, from);
            if from == Failed {
                db.transition(id, Failed, Some(&network()), |_, _| true)
                    .unwrap();
            }
            let before = db.download(id).unwrap().unwrap();
            let result = retry(&db, &mut retries, id);
            if from == Failed {
                result.unwrap();
                let row = db.download(id).unwrap().unwrap();
                assert_eq!((row.state, row.error), (Pending, None));
            } else {
                let err = result.unwrap_err();
                assert!(
                    err.to_string().contains("cannot go from"),
                    "{from:?}: {err}"
                );
                assert_eq!(db.download(id).unwrap().unwrap(), before, "{from:?}");
            }
        }
        let err = retry(&db, &mut retries, 999).unwrap_err();
        assert!(err.to_string().contains("no download with id 999"), "{err}");
    }

    #[test]
    fn manual_retry_forgets_attempts_and_waits() {
        let db = Db::open_in_memory().unwrap();
        let mut retries = Retries::default();
        let id = download_in(&db, Failed);
        // Leftovers from automatic retries (normally gone once it fails, but must not survive).
        retries.schedule(id, Instant::now(), NO_JITTER);
        retries.schedule(id, Instant::now(), NO_JITTER);
        retry(&db, &mut retries, id).unwrap();
        assert!(retries.waiting().is_empty());
        assert!(retries.attempts.is_empty());
        // Starts at once, and a new network error counts from the first retry again.
        assert_eq!(claim_next(&db, &retries.waiting()).unwrap().unwrap().id, id);
        let outcome = fail(&db, &mut retries, id, &network(), Instant::now());
        assert_eq!(
            outcome,
            AfterFailure::RetryIn {
                attempt: 1,
                delay: Duration::from_secs(2)
            }
        );
    }

    // --- temporary files ---

    #[test]
    fn temp_dir_is_the_id_inside_albaro_tmp() {
        let out = Path::new("downloads");
        assert_eq!(temp_dir(out, 42), out.join(".albaro-tmp").join("42"));
    }

    #[test]
    fn only_network_failures_keep_their_files() {
        let every_error = [
            AppError::Network("timed out".into()),
            AppError::ExtractorBroken("x".into()),
            AppError::Unavailable("x".into()),
            AppError::NoSpace("x".into()),
            AppError::Ffmpeg("x".into()),
            AppError::JsRuntimeMissing("x".into()),
            AppError::Cancelled("x".into()),
            AppError::InvalidUrl("x".into()),
            AppError::LoginRequired("x".into()),
            AppError::UnsupportedUrl("x".into()),
            AppError::Unknown("x".into()),
        ];
        for error in &every_error {
            let expected = if let AppError::Network(_) = error {
                Cleanup::Keep
            } else {
                Cleanup::Delete
            };
            assert_eq!(cleanup_for(Failed, Some(error)), expected, "{error}");
        }
        assert_eq!(cleanup_for(Cancelled, None), Cleanup::Delete);
        assert_eq!(cleanup_for(Finished, None), Cleanup::RemoveIfEmpty);
        // Waiting for a network retry, paused, or still queued: never deleted.
        assert_eq!(cleanup_for(Pending, Some(&every_error[0])), Cleanup::Keep);
        for state in [Pending, Active, Paused] {
            assert_eq!(cleanup_for(state, None), Cleanup::Keep, "{state:?}");
        }
    }

    /// An output folder with a final file and download 7's temporary folder with files in it.
    fn output_with_temp(name: &str) -> (TempDir, PathBuf, PathBuf) {
        let out = TempDir::new(name);
        let final_file = out.0.join("video [abc].mp4");
        fs::write(&final_file, b"final").unwrap();
        let temp = temp_dir(&out.0, 7);
        fs::create_dir_all(&temp).unwrap();
        fs::write(temp.join("video [abc].f401.mp4.part"), b"part").unwrap();
        fs::write(temp.join("video [abc].temp.webm"), b"temp").unwrap();
        (out, final_file, temp)
    }

    #[test]
    fn delete_removes_the_folder_with_its_files_and_nothing_else() {
        let (out, final_file, temp) = output_with_temp("clean-delete");
        clean_temp(&temp, 7, Cleanup::Delete).unwrap();
        assert!(!temp.exists());
        // `.albaro-tmp` was left empty, so it goes too; the final file next to it stays.
        assert!(!out.0.join(".albaro-tmp").exists());
        assert_eq!(fs::read(&final_file).unwrap(), b"final");
        // Again, now that nothing is there: not an error.
        clean_temp(&temp, 7, Cleanup::Delete).unwrap();
    }

    #[test]
    fn delete_leaves_another_downloads_folder_alone() {
        let (out, _, temp) = output_with_temp("clean-other");
        let other = temp_dir(&out.0, 8);
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("other.part"), b"other").unwrap();
        clean_temp(&temp, 7, Cleanup::Delete).unwrap();
        assert!(!temp.exists());
        assert_eq!(fs::read(other.join("other.part")).unwrap(), b"other");
    }

    #[test]
    fn keep_touches_nothing_and_remove_if_empty_only_removes_empty_folders() {
        let (_out, _, temp) = output_with_temp("clean-keep");
        clean_temp(&temp, 7, Cleanup::Keep).unwrap();
        assert_eq!(fs::read_dir(&temp).unwrap().count(), 2);
        // Not empty: an error, and nothing is lost.
        assert!(clean_temp(&temp, 7, Cleanup::RemoveIfEmpty).is_err());
        assert_eq!(fs::read_dir(&temp).unwrap().count(), 2);
        for entry in fs::read_dir(&temp).unwrap() {
            fs::remove_file(entry.unwrap().path()).unwrap();
        }
        clean_temp(&temp, 7, Cleanup::RemoveIfEmpty).unwrap();
        assert!(!temp.exists());
    }

    #[test]
    fn delete_refuses_anything_but_a_downloads_temp_folder() {
        let (out, final_file, temp) = output_with_temp("clean-refuse");
        let refused = [
            (out.0.clone(), 7),                        // the output folder itself
            (out.0.join(".albaro-tmp"), 7),            // the parent of every download
            (temp.clone(), 8),                         // another id than the folder's
            (out.0.join("elsewhere").join("7"), 7),    // right id, wrong parent
            (out.0.join(".albaro-tmp").join("x7"), 7), // not the id
            (final_file.clone(), 7),                   // a file
        ];
        for (dir, id) in refused {
            let err = clean_temp(&dir, id, Cleanup::Delete).unwrap_err();
            assert!(err.to_string().contains("refusing"), "{dir:?}: {err}");
        }
        assert!(temp.exists());
        assert!(final_file.exists());
    }

    // --- progress throttle ---

    fn progress(status: Status, downloaded: f64) -> Progress {
        serde_json::from_value(serde_json::json!({
            "status": status,
            "downloaded_bytes": downloaded,
            "total_bytes": 1000.0,
            "filename": "video.f401.mp4",
        }))
        .unwrap()
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn throttle_sends_the_first_drops_inside_100_ms_and_sends_at_100_ms() {
        let mut throttle = Throttle::default();
        let t0 = Instant::now();
        assert!(throttle.should_emit(t0, &progress(Status::Downloading, 1.0)));
        assert!(!throttle.should_emit(t0 + ms(40), &progress(Status::Downloading, 2.0)));
        assert!(!throttle.should_emit(t0 + ms(99), &progress(Status::Downloading, 3.0)));
        assert!(throttle.should_emit(t0 + ms(100), &progress(Status::Downloading, 4.0)));
        // The interval counts from the last one sent, not from the last one seen.
        assert!(!throttle.should_emit(t0 + ms(150), &progress(Status::Downloading, 5.0)));
        assert!(throttle.should_emit(t0 + ms(200), &progress(Status::Downloading, 6.0)));
    }

    #[test]
    fn throttle_always_sends_finished_and_error() {
        let mut throttle = Throttle::default();
        let t0 = Instant::now();
        assert!(throttle.should_emit(t0, &progress(Status::Downloading, 1.0)));
        assert!(throttle.should_emit(t0 + ms(1), &progress(Status::Finished, 1000.0)));
        // The audio file starts right after the video's `finished`: its first update waits.
        assert!(!throttle.should_emit(t0 + ms(2), &progress(Status::Downloading, 10.0)));
        assert!(throttle.should_emit(t0 + ms(3), &progress(Status::Error, 10.0)));
    }

    #[test]
    fn each_download_has_its_own_throttle() {
        let (mut a, mut b) = (Throttle::default(), Throttle::default());
        let t0 = Instant::now();
        assert!(a.should_emit(t0, &progress(Status::Downloading, 1.0)));
        assert!(b.should_emit(t0 + ms(10), &progress(Status::Downloading, 1.0)));
        assert!(!a.should_emit(t0 + ms(20), &progress(Status::Downloading, 2.0)));
        assert!(!b.should_emit(t0 + ms(30), &progress(Status::Downloading, 2.0)));
        assert!(a.should_emit(t0 + ms(100), &progress(Status::Downloading, 3.0)));
        assert!(!b.should_emit(t0 + ms(100), &progress(Status::Downloading, 3.0)));
    }

    #[test]
    fn flush_hands_over_the_newest_held_back_update_once() {
        let mut throttle = Throttle::default();
        let t0 = Instant::now();
        throttle.should_emit(t0, &progress(Status::Downloading, 1.0));
        throttle.should_emit(t0 + ms(10), &progress(Status::Downloading, 2.0));
        throttle.should_emit(t0 + ms(20), &progress(Status::Downloading, 3.0));
        assert_eq!(throttle.flush(), Some(progress(Status::Downloading, 3.0)));
        assert_eq!(throttle.flush(), None);
    }

    #[test]
    fn nothing_to_flush_when_the_newest_update_went_out() {
        let mut throttle = Throttle::default();
        assert_eq!(throttle.flush(), None, "no updates at all");
        let t0 = Instant::now();
        throttle.should_emit(t0, &progress(Status::Downloading, 1.0));
        throttle.should_emit(t0 + ms(10), &progress(Status::Downloading, 2.0));
        // A newer update that goes out supersedes the held-back one.
        assert!(throttle.should_emit(t0 + ms(100), &progress(Status::Downloading, 3.0)));
        assert_eq!(throttle.flush(), None);
        throttle.should_emit(t0 + ms(110), &progress(Status::Downloading, 4.0));
        assert!(throttle.should_emit(t0 + ms(111), &progress(Status::Finished, 1000.0)));
        assert_eq!(throttle.flush(), None);
    }

    // --- threads ---

    /// Several threads, each with its own connection to the same file (so SQLite's locking
    /// is what keeps them apart, not our Mutex), claim and finish 40 downloads with a limit
    /// of 2. No moment may have more than 2 active, and every download is claimed once.
    #[test]
    fn concurrent_claims_never_exceed_the_limit() {
        let dir = TempDir::new("queue-threads");
        let path = dir.0.join("albaro.db");
        let db = Db::open(&path).unwrap();
        set_max_concurrent(&db, 2).unwrap();
        let ids: HashSet<i64> = (1..=40)
            .map(|n| enqueue(&db, &request(n), None, &Placement::default()).unwrap())
            .collect();

        let workers: Vec<_> = (0..6)
            .map(|_| {
                let path = path.clone();
                thread::spawn(move || {
                    let db = Db::open(&path).unwrap();
                    let mut claimed = Vec::new();
                    loop {
                        match claim_next(&db, &[]).unwrap() {
                            Some(job) => {
                                // Hold it a moment, like a real download, so claims overlap.
                                thread::sleep(Duration::from_millis(2));
                                assert!(db.count_in(Active).unwrap() <= 2);
                                claimed.push(job.id);
                                mark_finished(&db, job.id, None).unwrap();
                            }
                            None if db.count_in(Pending).unwrap() == 0 => break,
                            None => thread::yield_now(),
                        }
                    }
                    claimed
                })
            })
            .collect();

        let mut claimed = Vec::new();
        for worker in workers {
            claimed.extend(worker.join().unwrap());
        }
        assert_eq!(claimed.len(), ids.len(), "a download was claimed twice");
        assert_eq!(claimed.into_iter().collect::<HashSet<_>>(), ids);
        assert_eq!(db.count_in(Finished).unwrap(), 40);
    }

    /// Eight threads, each with its own connection, enqueue the same request at the same
    /// moment (the barrier releases them together): exactly one gets in.
    #[test]
    fn concurrent_duplicates_let_only_one_in() {
        let dir = TempDir::new("queue-duplicates");
        let path = dir.0.join("albaro.db");
        let db = Db::open(&path).unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let path = path.clone();
                // `Arc` so every thread owns a handle to the same barrier; the closure must
                // be `'static`, so it cannot borrow one from this function.
                let barrier = Arc::clone(&barrier);
                thread::spawn(move || {
                    let db = Db::open(&path).unwrap();
                    barrier.wait();
                    enqueue(&db, &request(1), None, &Placement::default())
                })
            })
            .collect();
        let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        for err in results.iter().filter_map(|r| r.as_ref().err()) {
            assert!(matches!(err, AppError::AlreadyQueued(_)), "{err}");
        }
        assert_eq!(db.downloads().unwrap().len(), 1);
    }
    // --- the list ---

    fn info(title: &str) -> DownloadInfo {
        DownloadInfo {
            title: Some(title.into()),
            thumbnail: Some("https://i.example/t.jpg".into()),
        }
    }

    #[test]
    fn enqueue_keeps_the_info_when_given_and_works_without() {
        let db = Db::open_in_memory().unwrap();
        let with = enqueue(&db, &request(1), Some(&info("One")), &Placement::default()).unwrap();
        let without = enqueue(&db, &request(2), None, &Placement::default()).unwrap();
        let row = db.download(with).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("One"));
        assert_eq!(row.thumbnail.as_deref(), Some("https://i.example/t.jpg"));
        assert_eq!(db.download(without).unwrap().unwrap().title, None);
        // A bad URL still fails before anything is stored.
        let mut bad = request(3);
        bad.url = "--version".into();
        assert!(matches!(
            enqueue(&db, &bad, Some(&info("x")), &Placement::default()),
            Err(AppError::InvalidUrl(_))
        ));
        assert_eq!(db.downloads().unwrap().len(), 2);
    }

    #[test]
    fn a_duplicate_has_its_own_code_and_is_not_retried() {
        let db = Db::open_in_memory().unwrap();
        enqueue(&db, &request(1), None, &Placement::default()).unwrap();
        let err = enqueue(
            &db,
            &request(1),
            Some(&info("again")),
            &Placement::default(),
        )
        .unwrap_err();
        assert_eq!(err.parts().0, "alreadyQueued");
        assert!(
            err.parts().1.contains("is already in the queue (id "),
            "{err}"
        );
        // Only `network` is retried.
        let id = download_in(&db, Active);
        let mut retries = Retries::default();
        let outcome =
            fail_or_retry(&db, &mut retries, id, &err, Instant::now(), Duration::ZERO).unwrap();
        assert_eq!(outcome, AfterFailure::Failed);
    }

    #[test]
    fn finishing_stores_the_path_and_no_path_is_still_finished() {
        let db = Db::open_in_memory().unwrap();
        let with = download_in(&db, Active);
        mark_finished(&db, with, Some(r"C:\out\a.mp4")).unwrap();
        assert_eq!(state(&db, with), Finished);
        assert_eq!(
            db.output_path(with).unwrap().as_deref(),
            Some(r"C:\out\a.mp4")
        );
        let without = download_in(&db, Active);
        mark_finished(&db, without, None).unwrap();
        assert_eq!(state(&db, without), Finished);
        assert_eq!(db.output_path(without).unwrap(), None);
    }

    #[test]
    fn dismiss_is_allowed_only_for_the_three_final_states() {
        for target in DownloadState::ALL {
            let db = Db::open_in_memory().unwrap();
            let id = download_in(&db, target);
            let result = dismiss(&db, id);
            if matches!(target, Finished | Failed | Cancelled) {
                result.unwrap();
                assert!(db.downloads().unwrap().is_empty(), "{target:?}");
                // The row is kept, with its state.
                assert_eq!(state(&db, id), target);
            } else {
                let err = result.unwrap_err();
                let text = err.to_string();
                assert!(
                    text.contains(target.as_str()) && text.contains("cannot be removed"),
                    "{text}"
                );
                assert_eq!(db.downloads().unwrap().len(), 1, "{target:?}");
            }
            assert_eq!(
                can_dismiss(target),
                matches!(target, Finished | Failed | Cancelled)
            );
        }
        let db = Db::open_in_memory().unwrap();
        assert!(dismiss(&db, 42).is_err());
    }

    #[test]
    fn clearing_the_list_hides_only_what_has_ended_and_counts_it() {
        let db = Db::open_in_memory().unwrap();
        let ids: Vec<(i64, _)> = DownloadState::ALL
            .into_iter()
            .map(|target| (download_in(&db, target), target))
            .collect();
        let ended = ids
            .iter()
            .filter(|(_, target)| matches!(target, Finished | Failed | Cancelled))
            .count() as u32;
        assert_eq!(dismiss_ended(&db).unwrap(), ended);
        // What is left is exactly what has not ended, still in its state.
        let left: Vec<DownloadState> = db.downloads().unwrap().iter().map(|d| d.state).collect();
        assert_eq!(left.len() as u32, DownloadState::ALL.len() as u32 - ended);
        assert!(left
            .iter()
            .all(|s| !matches!(s, Finished | Failed | Cancelled)));
        // Every row is still in the table, with its state.
        for (id, target) in &ids {
            assert_eq!(state(&db, *id), *target);
        }
        // Nothing left to hide the second time.
        assert_eq!(dismiss_ended(&db).unwrap(), 0);
    }

    #[test]
    fn clearing_an_empty_list_hides_nothing() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(dismiss_ended(&db).unwrap(), 0);
    }

    #[test]
    fn a_dismissed_download_does_not_count_for_duplicates_or_the_slots() {
        let db = Db::open_in_memory().unwrap();
        let id = download_in(&db, Finished);
        dismiss(&db, id).unwrap();
        // The same request can be queued again (it was already allowed after finishing).
        enqueue(&db, &request(1000), None, &Placement::default()).unwrap();
        assert_eq!(db.downloads().unwrap().len(), 1);
    }

    #[test]
    fn reveal_refuses_a_download_that_is_not_finished_or_has_no_path() {
        let db = Db::open_in_memory().unwrap();
        for target in [Pending, Active, Paused, Failed, Cancelled] {
            let id = download_in(&db, target);
            let err = reveal_target(&db, id).unwrap_err();
            assert!(matches!(err, AppError::Unknown(_)), "{target:?}: {err}");
            assert!(err.to_string().contains("not finished"), "{err}");
        }
        assert!(reveal_target(&db, 999).is_err());
        // Finished, but yt-dlp never printed the path.
        let id = download_in(&db, Finished);
        let err = reveal_target(&db, id).unwrap_err();
        assert!(matches!(err, AppError::Unavailable(_)), "{err}");
    }

    #[test]
    fn reveal_picks_the_file_then_its_folder_then_gives_up() {
        let db = Db::open_in_memory().unwrap();
        let out = TempDir::new("reveal");
        let folder = out.0.join("Downloads");
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("a.mp4");
        fs::write(&file, b"x").unwrap();
        let id = download_in(&db, Active);
        mark_finished(&db, id, file.to_str()).unwrap();

        assert_eq!(reveal_target(&db, id).unwrap(), Reveal::File(file.clone()));
        // The file was moved or deleted: its folder is shown instead.
        fs::remove_file(&file).unwrap();
        assert_eq!(
            reveal_target(&db, id).unwrap(),
            Reveal::Folder(folder.clone())
        );
        // The folder is gone too.
        fs::remove_dir(&folder).unwrap();
        let err = reveal_target(&db, id).unwrap_err();
        assert!(matches!(err, AppError::Unavailable(_)), "{err}");
    }

    // --- output folder and file name ---

    /// A folder like a user's own: spaces and accents.
    fn user_dir(root: &TempDir) -> PathBuf {
        root.0.join("Vídeos ñ")
    }

    fn fallback(root: &TempDir) -> PathBuf {
        root.0.join("default")
    }

    #[test]
    fn the_folder_setting_defaults_when_missing_empty_or_not_absolute() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("setting-dir");
        let default = fallback(&root);
        assert_eq!(output_dir(&db, &default).unwrap(), default);
        for bad in ["", "   ", "relative/folder", "Descargas"] {
            db.set_setting(OUTPUT_DIR_KEY, bad).unwrap();
            assert_eq!(output_dir(&db, &default).unwrap(), default, "{bad:?}");
        }
        let custom = user_dir(&root);
        db.set_setting(OUTPUT_DIR_KEY, custom.to_str().unwrap())
            .unwrap();
        assert_eq!(output_dir(&db, &default).unwrap(), custom);
    }

    #[test]
    fn the_name_setting_defaults_when_missing_empty_or_unknown() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(name_template(&db).unwrap(), NameTemplate::TitleId);
        for bad in ["", "Title", "%(title)s", "channel"] {
            db.set_setting(NAME_TEMPLATE_KEY, bad).unwrap();
            assert_eq!(
                name_template(&db).unwrap(),
                NameTemplate::TitleId,
                "{bad:?}"
            );
        }
        for template in [
            NameTemplate::Title,
            NameTemplate::TitleId,
            NameTemplate::ChannelTitle,
        ] {
            set_name_template(&db, template).unwrap();
            assert_eq!(name_template(&db).unwrap(), template);
        }
        assert_eq!(
            db.setting(NAME_TEMPLATE_KEY).unwrap().as_deref(),
            Some("channelTitle")
        );
    }

    #[test]
    fn history_validates_its_filters_and_says_when_there_is_more() {
        let db = Db::open_in_memory().unwrap();
        for n in 0..HISTORY_LIMIT + 5 {
            let id = enqueue(&db, &request(n), None, &Placement::default()).unwrap();
            move_to(&db, id, Finished);
        }
        let first = history(&db, "", None, None).unwrap();
        assert_eq!(first.items.len(), HISTORY_LIMIT as usize);
        assert!(first.more);
        // Newest first.
        assert!(first.items[0].id > first.items[1].id);
        let one = history(&db, " video/204 ", Some("finished"), Some("video")).unwrap();
        assert_eq!(one.items.len(), 1, "the search is trimmed");
        assert!(!one.more);
        for (state, kind) in [(Some("bogus"), None), (None, Some("image"))] {
            assert!(history(&db, "", state, kind).is_err());
        }
        // The frontend gets camelCase keys.
        let json = serde_json::to_value(&one).unwrap();
        assert_eq!(json["more"], false);
        assert_eq!(json["items"][0]["state"], "finished");
    }

    #[test]
    fn a_folder_too_deep_for_titles_is_flagged() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("settings-deep");
        let default = fallback(&root);
        assert!(!output_settings(&db, &default).unwrap().folder_too_deep);
        // ~170+ UTF-16 units leave no room for 20 bytes of title under 260.
        let deep = root.0.join("x".repeat(200));
        fs::create_dir_all(&deep).unwrap();
        set_output_dir(&db, &deep).unwrap();
        let settings = output_settings(&db, &default).unwrap();
        assert!(settings.folder_too_deep);
        assert_eq!(
            serde_json::to_value(&settings).unwrap()["folderTooDeep"],
            true
        );
    }

    // --- quitting, notifications and the sweep of leftover folders ---

    #[test]
    fn the_queue_is_busy_while_something_runs_or_waits_but_not_for_paused_or_ended() {
        let db = Db::open_in_memory().unwrap();
        let mut state = State::default();
        assert!(!busy(&state, &db).unwrap());
        for done in [Finished, Failed, Cancelled, Paused] {
            download_in(&db, done);
        }
        assert!(!busy(&state, &db).unwrap(), "ended and paused are not work");
        // Queued (also a download waiting for a network retry, which is `pending`) is work.
        let queued = download_in(&db, Pending);
        assert!(busy(&state, &db).unwrap());
        db.transition(queued, Cancelled, None, allowed).unwrap();
        assert!(!busy(&state, &db).unwrap());
        // A process alive is work even though its row is `active`, not `pending`.
        state.running.insert(
            queued,
            Running {
                run: None,
                stop: None,
            },
        );
        assert!(busy(&state, &db).unwrap());
    }

    /// A folder `<dir>/.albaro-tmp/<name>` with a file in it.
    fn leftover(dir: &Path, name: &str) -> PathBuf {
        let folder = dir.join(TEMP_ROOT).join(name);
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("video.f401.mp4.part"), b"x").unwrap();
        folder
    }

    fn failed_with(db: &Db, error: AppError) -> i64 {
        let id = download_in(db, Active);
        db.transition(id, Failed, Some(&error), allowed).unwrap();
        id
    }

    #[test]
    fn the_sweep_removes_only_the_temporary_folders_nothing_needs() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("sweep");
        let default = fallback(&root);
        let other = user_dir(&root);
        set_output_dir(&db, &other).unwrap();

        // Downloads in every state, queued to the default folder (no placement) ...
        let finished = download_in(&db, Finished);
        let cancelled = download_in(&db, Cancelled);
        let active = download_in(&db, Active);
        let paused = download_in(&db, Paused);
        let pending = download_in(&db, Pending);
        let net = failed_with(&db, AppError::Network("timed out".into()));
        let broken = failed_with(&db, AppError::Unknown("boom".into()));
        // ... and one queued to another folder, which the sweep must find there.
        let elsewhere = {
            let placement = Placement {
                out_dir: Some(root.0.join("elsewhere").to_string_lossy().into_owned()),
                name_template: None,
            };
            let id = enqueue(&db, &request(5000), None, &placement).unwrap();
            move_to(&db, id, Finished);
            id
        };
        let folders: Vec<(i64, PathBuf)> =
            [finished, cancelled, active, paused, pending, net, broken]
                .into_iter()
                .map(|id| (id, leftover(&default, &id.to_string())))
                .collect();
        let far = leftover(&root.0.join("elsewhere"), &elsewhere.to_string());
        // No row at all (the database was deleted), in the current folder; and a folder that is
        // not a download id, which is none of the sweep's business.
        let gone = leftover(&other, "999");
        let notes = leftover(&default, "notes");

        assert_eq!(sweep_orphans(&db, &default).unwrap(), 5);
        let kept = |id: i64| folders.iter().find(|(i, _)| *i == id).unwrap().1.exists();
        // Over, or gone: removed.
        assert!(!kept(finished) && !kept(cancelled) && !kept(broken));
        assert!(!far.exists() && !gone.exists());
        // Still needed: a download in progress, queued, paused, or waiting to retry its network
        // error keeps its `.part` files.
        assert!(kept(active) && kept(paused) && kept(pending) && kept(net));
        assert!(notes.exists());
        // An emptied `.albaro-tmp` goes with its last folder.
        assert!(!other.join(TEMP_ROOT).exists());
        assert!(!root.0.join("elsewhere").join(TEMP_ROOT).exists());
        // Sweeping again finds nothing more.
        assert_eq!(sweep_orphans(&db, &default).unwrap(), 0);
    }

    #[test]
    fn the_sweep_with_nothing_to_sweep_is_fine() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("sweep-empty");
        assert_eq!(sweep_orphans(&db, &fallback(&root)).unwrap(), 0);
    }

    #[test]
    fn output_settings_report_what_is_in_force() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("settings-report");
        let default = fallback(&root);
        let first = output_settings(&db, &default).unwrap();
        assert_eq!(first.output_dir, default.to_string_lossy());
        assert_eq!(first.name_template, NameTemplate::TitleId);
        // The frontend gets camelCase keys and the name as its camelCase text.
        let json = serde_json::to_value(&first).unwrap();
        assert_eq!(json["nameTemplate"], "titleId");
        assert!(json["outputDir"].is_string());

        let custom = user_dir(&root);
        set_output_dir(&db, &custom).unwrap();
        set_name_template(&db, NameTemplate::Title).unwrap();
        let now = output_settings(&db, &default).unwrap();
        assert_eq!(now.output_dir, custom.to_string_lossy());
        assert_eq!(now.name_template, NameTemplate::Title);
    }

    #[test]
    fn a_picked_folder_is_created_checked_and_saved() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("pick-ok");
        let nested = user_dir(&root).join("a").join("b");
        set_output_dir(&db, &nested).unwrap();
        assert!(nested.is_dir());
        assert_eq!(
            db.setting(OUTPUT_DIR_KEY).unwrap().as_deref(),
            nested.to_str()
        );
        // The write check leaves nothing behind.
        assert_eq!(fs::read_dir(&nested).unwrap().count(), 0);
    }

    #[test]
    fn a_folder_that_cannot_be_used_is_refused_and_the_setting_stays() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("pick-bad");
        let good = user_dir(&root);
        set_output_dir(&db, &good).unwrap();
        let file = root.0.join("a file");
        fs::write(&file, b"x").unwrap();
        for bad in [
            file.clone(),
            file.join("inside"),
            PathBuf::from("relative"),
            PathBuf::new(),
        ] {
            let err = set_output_dir(&db, &bad).unwrap_err();
            assert!(
                matches!(err, AppError::FolderUnavailable(_)),
                "{bad:?}: {err}"
            );
        }
        assert_eq!(
            db.setting(OUTPUT_DIR_KEY).unwrap().as_deref(),
            good.to_str()
        );
    }

    /// A path that is not valid text: a lone surrogate on Windows, a stray byte elsewhere.
    fn not_utf8(root: &Path) -> PathBuf {
        #[cfg(windows)]
        {
            use std::{ffi::OsString, os::windows::ffi::OsStringExt};
            let mut name: Vec<u16> = root.as_os_str().to_string_lossy().encode_utf16().collect();
            name.extend("\\bad".encode_utf16());
            name.push(0xD800);
            PathBuf::from(OsString::from_wide(&name))
        }
        #[cfg(unix)]
        {
            use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
            root.join(OsStr::from_bytes(b"bad\xFF"))
        }
    }

    #[test]
    fn a_path_that_is_not_utf8_is_refused_with_a_clear_message() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("pick-utf8");
        let bad = not_utf8(&root.0);
        assert!(bad.to_str().is_none());
        let err = set_output_dir(&db, &bad).unwrap_err();
        assert!(
            matches!(&err, AppError::FolderUnavailable(m) if m.contains("UTF-8")),
            "{err}"
        );
        assert_eq!(db.setting(OUTPUT_DIR_KEY).unwrap(), None);
        // Nothing was created for it either.
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }

    #[test]
    fn ensure_dir_creates_and_reports_what_it_cannot() {
        let root = TempDir::new("ensure");
        let dir = user_dir(&root).join("new");
        ensure_dir(&dir).unwrap();
        ensure_dir(&dir).unwrap(); // already there is fine
        assert!(dir.is_dir());
        let file = root.0.join("f");
        fs::write(&file, b"x").unwrap();
        for bad in [file.clone(), file.join("sub")] {
            assert!(matches!(
                ensure_dir(&bad),
                Err(AppError::FolderUnavailable(_))
            ));
        }
    }

    #[test]
    fn queueing_into_a_folder_that_cannot_be_used_is_folder_unavailable_and_adds_nothing() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("queue-bad-folder");
        let file = root.0.join("a file");
        fs::write(&file, b"x").unwrap();
        // The setting points at a file (e.g. the folder was replaced by one).
        db.set_setting(OUTPUT_DIR_KEY, file.to_str().unwrap())
            .unwrap();
        let err = placement_now(&db, &fallback(&root)).unwrap_err();
        assert!(matches!(err, AppError::FolderUnavailable(_)), "{err}");
        assert!(db.downloads().unwrap().is_empty());
        // It is permanent: only `network` is retried.
        let id = download_in(&db, Active);
        let outcome = fail_or_retry(
            &db,
            &mut Retries::default(),
            id,
            &err,
            Instant::now(),
            Duration::ZERO,
        )
        .unwrap();
        assert_eq!(outcome, AfterFailure::Failed);
    }

    #[test]
    fn a_download_keeps_the_folder_and_name_it_was_queued_with() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("queue-fixed");
        let default = fallback(&root);
        let first_dir = user_dir(&root);
        set_output_dir(&db, &first_dir).unwrap();
        set_name_template(&db, NameTemplate::Title).unwrap();
        let place = placement_now(&db, &default).unwrap();
        let first = enqueue(&db, &request(1), None, &place).unwrap();

        // The settings change afterwards...
        let second_dir = root.0.join("Otra carpeta");
        set_output_dir(&db, &second_dir).unwrap();
        set_name_template(&db, NameTemplate::ChannelTitle).unwrap();
        let place = placement_now(&db, &default).unwrap();
        let second = enqueue(&db, &request(2), None, &place).unwrap();

        // ...and the first one did not move, the second took the new ones.
        let stored = db.placement(first).unwrap();
        assert_eq!(stored.out_dir.as_deref(), first_dir.to_str());
        assert_eq!(stored.name_template.as_deref(), Some("title"));
        let stored = db.placement(second).unwrap();
        assert_eq!(stored.out_dir.as_deref(), second_dir.to_str());
        assert_eq!(stored.name_template.as_deref(), Some("channelTitle"));

        // The scheduler gets them in the job, in queue order.
        let job = claim_next(&db, &[]).unwrap().unwrap();
        assert_eq!(job.id, first);
        assert_eq!(
            resolve(&job.placement, &default),
            (first_dir, NameTemplate::Title)
        );
        let job = claim_next(&db, &[]).unwrap().unwrap();
        assert_eq!(
            resolve(&job.placement, &default),
            (second_dir, NameTemplate::ChannelTitle)
        );
    }

    #[test]
    fn a_paused_download_resumes_in_its_own_folder() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("queue-paused");
        let default = fallback(&root);
        let old = user_dir(&root);
        set_output_dir(&db, &old).unwrap();
        let place = placement_now(&db, &default).unwrap();
        let id = enqueue(&db, &request(1), None, &place).unwrap();
        claim_next(&db, &[]).unwrap().unwrap();
        pause(&db, id).unwrap();
        // The user picks another folder while it is paused.
        set_output_dir(&db, &root.0.join("nueva")).unwrap();
        resume(&db, id).unwrap();
        let job = claim_next(&db, &[]).unwrap().unwrap();
        assert_eq!(job.id, id);
        assert_eq!(resolve(&job.placement, &default).0, old);
    }

    #[test]
    fn rows_from_before_have_no_placement_and_mean_the_default_whatever_the_settings_say() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("queue-legacy");
        let default = fallback(&root);
        // Queued the old way: no folder, no name.
        let id = enqueue(&db, &request(1), None, &Placement::default()).unwrap();
        // The user has since chosen something else.
        set_output_dir(&db, &user_dir(&root)).unwrap();
        set_name_template(&db, NameTemplate::ChannelTitle).unwrap();
        let job = claim_next(&db, &[]).unwrap().unwrap();
        assert_eq!(job.id, id);
        assert_eq!(job.placement, Placement::default());
        assert_eq!(
            resolve(&job.placement, &default),
            (default, NameTemplate::TitleId)
        );
    }

    #[test]
    fn resolve_falls_back_on_empty_and_unknown_values() {
        let default = Path::new("/d");
        for place in [
            Placement::default(),
            Placement {
                out_dir: Some(String::new()),
                name_template: Some("nonsense".into()),
            },
        ] {
            assert_eq!(
                resolve(&place, default),
                (default.to_path_buf(), NameTemplate::TitleId)
            );
        }
        let place = Placement {
            out_dir: Some("/x y".into()),
            name_template: Some("title".into()),
        };
        assert_eq!(
            resolve(&place, default),
            (PathBuf::from("/x y"), NameTemplate::Title)
        );
    }

    #[test]
    fn two_folders_do_not_make_a_request_a_different_download() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("queue-dup");
        let a = Placement {
            out_dir: user_dir(&root).to_str().map(String::from),
            name_template: Some("title".into()),
        };
        enqueue(&db, &request(1), None, &a).unwrap();
        let b = Placement {
            out_dir: Some(root.0.join("b").to_string_lossy().into_owned()),
            name_template: Some("titleId".into()),
        };
        let err = enqueue(&db, &request(1), None, &b).unwrap_err();
        assert!(matches!(err, AppError::AlreadyQueued(_)), "{err}");
    }

    #[test]
    fn temporary_files_are_cleaned_inside_a_custom_folder() {
        let root = TempDir::new("clean-custom");
        let out = user_dir(&root);
        let temp = temp_dir(&out, 9);
        fs::create_dir_all(&temp).unwrap();
        fs::write(temp.join("Canción [x].f251.webm.part"), b"p").unwrap();
        let other = temp_dir(&out, 10);
        fs::create_dir_all(&other).unwrap();

        clean_temp(&temp, 9, Cleanup::Delete).unwrap();
        assert!(!temp.exists());
        // Another download's folder, in the same custom folder, is not touched, and neither is
        // the shared `.albaro-tmp` that still holds it.
        assert!(other.is_dir());
        clean_temp(&other, 10, Cleanup::Delete).unwrap();
        assert!(!out.join(TEMP_ROOT).exists());
        assert!(out.is_dir());
    }

    #[test]
    fn reveal_works_in_a_custom_folder() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("reveal-custom");
        let folder = user_dir(&root);
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join("Canción ñandú [x].opus");
        fs::write(&file, b"x").unwrap();
        let id = download_in(&db, Active);
        mark_finished(&db, id, file.to_str()).unwrap();
        assert_eq!(reveal_target(&db, id).unwrap(), Reveal::File(file.clone()));
        fs::remove_file(&file).unwrap();
        assert_eq!(reveal_target(&db, id).unwrap(), Reveal::Folder(folder));
    }

    // --- choose another folder and retry ---

    /// A download queued in folder `dir` with name `template`, run and failed with `error`.
    fn failed_in(db: &Db, dir: &Path, template: &str, n: u32, error: &AppError) -> i64 {
        let place = Placement {
            out_dir: dir.to_str().map(String::from),
            name_template: Some(template.into()),
        };
        let id = enqueue(db, &request(n), None, &place).unwrap();
        assert_eq!(claim_next(db, &[]).unwrap().unwrap().id, id);
        mark_failed(db, id, error).unwrap();
        id
    }

    fn no_space() -> AppError {
        AppError::NoSpace("ERROR: [Errno 28] No space left on device".into())
    }

    fn folder_gone() -> AppError {
        AppError::FolderUnavailable("D:/gone: the drive is not ready".into())
    }

    fn move_dir(db: &Db, id: i64, dir: &Path, default: &Path) -> Result<(), AppError> {
        move_and_retry(db, &mut Retries::default(), id, dir, default)
    }

    #[test]
    fn a_disk_full_or_unusable_folder_failure_moves_and_goes_back_to_pending() {
        for error in [no_space(), folder_gone()] {
            let db = Db::open_in_memory().unwrap();
            let root = TempDir::new("move-ok");
            let old = user_dir(&root);
            let new = root.0.join("Otra carpeta ñ");
            let id = failed_in(&db, &old, "channelTitle", 1, &error);

            move_dir(&db, id, &new, &fallback(&root)).unwrap();

            let row = db.download(id).unwrap().unwrap();
            assert_eq!(row.state, Pending, "{error}");
            assert_eq!(row.error, None);
            let place = db.placement(id).unwrap();
            // The folder changes, the name does not.
            assert_eq!(place.out_dir.as_deref(), new.to_str());
            assert_eq!(place.name_template.as_deref(), Some("channelTitle"));
            assert!(new.is_dir());
            // The new folder is now the default for the next downloads.
            assert_eq!(output_dir(&db, &fallback(&root)).unwrap(), new);
            // And it is the one the scheduler starts it in.
            let job = claim_next(&db, &[]).unwrap().unwrap();
            assert_eq!(job.id, id);
            assert_eq!(
                resolve(&job.placement, &fallback(&root)),
                (new, NameTemplate::ChannelTitle)
            );
        }
    }

    #[test]
    fn only_a_failed_download_with_one_of_the_two_codes_can_move() {
        let root = TempDir::new("move-refused");
        let new = root.0.join("nueva");
        let old = user_dir(&root);
        // Failed for other reasons: another folder does not fix them (and `network` keeps its
        // `.part` in the old one).
        for error in [
            AppError::Network("timed out".into()),
            AppError::Unavailable("removed".into()),
            AppError::Unknown("???".into()),
            AppError::Ffmpeg("conversion failed".into()),
        ] {
            let db = Db::open_in_memory().unwrap();
            let id = failed_in(&db, &old, "title", 1, &error);
            let err = move_dir(&db, id, &new, &fallback(&root)).unwrap_err();
            assert!(
                matches!(&err, AppError::Unknown(m) if m.starts_with(&format!("download {id} cannot be moved: "))),
                "{error}: {err}"
            );
            let row = db.download(id).unwrap().unwrap();
            assert_eq!(row.state, Failed);
            assert_eq!(row.error.map(|e| e.code), Some(error.parts().0.to_string()));
            assert_eq!(db.placement(id).unwrap().out_dir.as_deref(), old.to_str());
            assert!(!new.exists(), "nothing was created for {error}");
        }
        // Not failed at all.
        for state in [Pending, Active, Paused, Finished, Cancelled] {
            let db = Db::open_in_memory().unwrap();
            let place = Placement {
                out_dir: old.to_str().map(String::from),
                name_template: Some("title".into()),
            };
            let id = enqueue(&db, &request(1), None, &place).unwrap();
            move_to(&db, id, state);
            let err = move_dir(&db, id, &new, &fallback(&root)).unwrap_err();
            assert!(
                matches!(&err, AppError::Unknown(m) if m.contains("cannot be moved") && m.contains(state.as_str())),
                "{state:?}: {err}"
            );
            assert_eq!(db.download(id).unwrap().unwrap().state, state);
            assert_eq!(db.placement(id).unwrap().out_dir.as_deref(), old.to_str());
        }
        // No such download.
        let db = Db::open_in_memory().unwrap();
        let err = move_dir(&db, 999, &new, &fallback(&root)).unwrap_err();
        assert!(matches!(&err, AppError::Unknown(m) if m.contains("no download with id 999")));
        assert_eq!(db.setting(OUTPUT_DIR_KEY).unwrap(), None);
    }

    #[test]
    fn an_unusable_new_folder_refuses_the_move_and_changes_nothing() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("move-bad-folder");
        let old = user_dir(&root);
        let id = failed_in(&db, &old, "titleId", 1, &no_space());
        let file = root.0.join("a file");
        fs::write(&file, b"x").unwrap();
        for bad in [file.clone(), file.join("sub"), PathBuf::from("relative")] {
            let err = move_dir(&db, id, &bad, &fallback(&root)).unwrap_err();
            assert!(
                matches!(err, AppError::FolderUnavailable(_)),
                "{bad:?}: {err}"
            );
        }
        let bad = not_utf8(&root.0);
        let err = move_dir(&db, id, &bad, &fallback(&root)).unwrap_err();
        assert!(matches!(&err, AppError::FolderUnavailable(m) if m.contains("UTF-8")));
        let row = db.download(id).unwrap().unwrap();
        assert_eq!(row.state, Failed);
        assert_eq!(row.error.map(|e| e.code), Some("noSpace".to_string()));
        assert_eq!(db.placement(id).unwrap().out_dir.as_deref(), old.to_str());
        assert_eq!(db.setting(OUTPUT_DIR_KEY).unwrap(), None);
    }

    #[test]
    fn a_temporary_folder_left_in_the_old_folder_is_deleted_and_nothing_else() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("move-leftover");
        let old = user_dir(&root);
        let id = failed_in(&db, &old, "title", 1, &no_space());
        let other = failed_in(&db, &old, "title", 2, &no_space());
        for n in [id, other] {
            let temp = temp_dir(&old, n);
            fs::create_dir_all(&temp).unwrap();
            fs::write(temp.join("a [x].f401.mp4.part"), b"p").unwrap();
        }
        let keep = old.join("ya descargado.mp4");
        fs::write(&keep, b"done").unwrap();

        move_dir(&db, id, &root.0.join("nueva"), &fallback(&root)).unwrap();

        assert!(!temp_dir(&old, id).exists());
        // The other failed download's leftovers, and the finished files, stay.
        assert!(temp_dir(&old, other).is_dir());
        assert!(keep.is_file());
    }

    #[test]
    fn nothing_to_clean_is_fine_and_a_moved_download_can_move_again() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("move-twice");
        let id = failed_in(&db, &user_dir(&root), "title", 1, &no_space());
        let (b, c) = (root.0.join("b"), root.0.join("c"));
        move_dir(&db, id, &b, &fallback(&root)).unwrap();
        // It fails again, now in b: the next move goes from b.
        claim_next(&db, &[]).unwrap().unwrap();
        mark_failed(&db, id, &no_space()).unwrap();
        move_dir(&db, id, &c, &fallback(&root)).unwrap();
        assert_eq!(db.placement(id).unwrap().out_dir.as_deref(), c.to_str());
        assert_eq!(output_dir(&db, &fallback(&root)).unwrap(), c);
    }

    #[test]
    fn a_waiting_retry_count_is_forgotten_by_the_move() {
        let db = Db::open_in_memory().unwrap();
        let root = TempDir::new("move-forgets");
        let id = failed_in(&db, &user_dir(&root), "title", 1, &no_space());
        let mut retries = Retries::default();
        retries.schedule(id, Instant::now(), Duration::ZERO);
        move_and_retry(&db, &mut retries, id, &root.0.join("n"), &fallback(&root)).unwrap();
        assert!(retries.waiting().is_empty());
    }
}
