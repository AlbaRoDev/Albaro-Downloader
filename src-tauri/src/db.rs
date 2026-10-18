// SQLite database: the download queue and the settings. Only Rust touches it; the
// frontend gets at it through commands, never with SQL. The queue's rules live in queue.rs;
// what is here are the operations that must be atomic (one lock, one transaction).
use std::{
    path::Path,
    str::FromStr,
    sync::{Mutex, MutexGuard, PoisonError},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};

use crate::{errors::AppError, text, ytdlp::formats::DownloadRequest};

/// Schema scripts in order: script `i` takes the database from version `i` to `i + 1` (the
/// version is `PRAGMA user_version`, 0 in a new file). Never edit a script that has shipped;
/// add a new one at the end.
const MIGRATIONS: &[&str] = &[
    // 1. `request` is the `DownloadRequest` as JSON, so new request options (playlists,
    // subtitles...) need no new columns. Times are milliseconds since the Unix epoch.
    // Progress is not stored: it only means something while yt-dlp is running.
    "CREATE TABLE downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request TEXT NOT NULL,
        state TEXT NOT NULL
            CHECK (state IN ('pending', 'active', 'paused', 'finished', 'failed', 'cancelled')),
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE INDEX downloads_state ON downloads (state);
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );",
    // 2. What the list shows. `title` and `thumbnail` come from the preview, so
    // rows from before have none. `output_path` is the final file, filled when it finishes and
    // never sent to the frontend. `dismissed` hides a row from the list without deleting it
    // (the history reads them all).
    "ALTER TABLE downloads ADD COLUMN title TEXT;
    ALTER TABLE downloads ADD COLUMN thumbnail TEXT;
    ALTER TABLE downloads ADD COLUMN output_path TEXT;
    ALTER TABLE downloads ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0;",
    // 3. Where and how each download is saved, fixed when it is queued so that
    // changing the settings later moves nothing that is already in the queue. NULL (rows from
    // before) means the default folder and name.
    "ALTER TABLE downloads ADD COLUMN out_dir TEXT;
    ALTER TABLE downloads ADD COLUMN name_template TEXT;",
    // 4. The batch a download was queued with: the entries chosen from one playlist
    // share a number, and the list groups them under the playlist's title. NULL (a download
    // queued on its own, and rows from before) means no group.
    "ALTER TABLE downloads ADD COLUMN batch INTEGER;
    ALTER TABLE downloads ADD COLUMN batch_title TEXT;",
];

const MAX_TITLE_CHARS: usize = text::TITLE_MAX;

/// What the list shows about a download besides its request: title and thumbnail, taken by
/// the frontend from the preview's metadata (`enqueue_download`'s `info`). Both optional.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct DownloadInfo {
    pub title: Option<String>,
    pub thumbnail: Option<String>,
}

impl DownloadInfo {
    /// The values as stored. They come from the frontend and go back to it (the thumbnail
    /// ends up in an `<img src>`), so they are bounded: a blank or very long title is cut or
    /// dropped, and a thumbnail that is not an http(s) URL is dropped (the CSP only lets
    /// `https:` through anyway).
    fn cleaned(&self) -> (Option<String>, Option<String>) {
        // The same cleaning as the metadata readers give: one line, no control or
        // direction characters, bounded.
        let title = text::clean_opt(self.title.clone(), MAX_TITLE_CHARS);
        let thumbnail = text::thumbnail(self.thumbnail.clone());
        (title, thumbnail)
    }
}

// Database errors reach the caller as `unknown`: the user cannot act on them, and the message
// keeps SQLite's detail for the logs. With this, `?` converts them on its own.
impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::Unknown(format!("database: {err}"))
    }
}

/// Mirrors the `state` column's CHECK, so states are never loose strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadState {
    Pending,
    Active,
    Paused,
    Finished,
    Failed,
    Cancelled,
}

impl DownloadState {
    pub const ALL: [Self; 6] = [
        Self::Pending,
        Self::Active,
        Self::Paused,
        Self::Finished,
        Self::Failed,
        Self::Cancelled,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Finished => "finished",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

// The trait instead of an inherent `from_str` (clippy asks for it); it also allows
// `"pending".parse::<DownloadState>()`.
impl FromStr for DownloadState {
    type Err = AppError;

    fn from_str(s: &str) -> Result<Self, AppError> {
        Self::ALL
            .into_iter()
            .find(|state| state.as_str() == s)
            .ok_or_else(|| AppError::Unknown(format!("unknown download state: {s}")))
    }
}

/// The entries chosen from one playlist, queued together: the list shows them as a
/// group with one progress. `id` only tells batches apart (the next number, see `next_batch`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Batch {
    pub id: i64,
    /// The playlist's title, cleaned like a download's title.
    pub title: Option<String>,
}

impl Batch {
    /// `title` as stored: trimmed, blank dropped, bounded (it comes from the frontend).
    pub fn new(id: i64, title: Option<&str>) -> Self {
        let title = text::clean_opt(title.map(String::from), MAX_TITLE_CHARS);
        Self { id, title }
    }
}

/// One row of `downloads`, as the frontend gets it (`Download` in ipc.ts).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Download {
    pub id: i64,
    pub request: DownloadRequest,
    /// `None` for rows queued before titles were stored: the list shows the URL instead.
    pub title: Option<String>,
    pub thumbnail: Option<String>,
    pub state: DownloadState,
    /// The last error, if any.
    pub error: Option<StoredError>,
    pub created_at: i64,
    pub updated_at: i64,
    /// The playlist batch it was queued with, if any.
    pub batch: Option<Batch>,
}

/// An `AppError` as stored: same `{ code, message }` shape the frontend gets for errors.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredError {
    pub code: String,
    pub message: String,
}

impl From<&AppError> for StoredError {
    fn from(error: &AppError) -> Self {
        let (code, message) = error.parts();
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

/// Where a download saves its file and how it names it, as stored with the row.
/// Never sent to the frontend. `None` is a row queued before the setting existed: it went to
/// the default folder with the default name, and keeps doing so.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Placement {
    pub out_dir: Option<String>,
    pub name_template: Option<String>,
}

/// A download the queue has just moved to `active`: what the scheduler needs to start it.
#[derive(Debug, Clone, PartialEq)]
pub struct Job {
    pub id: i64,
    pub request: DownloadRequest,
    pub placement: Placement,
}

impl Download {
    fn from_row(row: &Row) -> Result<Self, AppError> {
        let request: String = row.get("request")?;
        let state: String = row.get("state")?;
        let code: Option<String> = row.get("error_code")?;
        let message: Option<String> = row.get("error_message")?;
        let batch: Option<i64> = row.get("batch")?;
        let batch_title: Option<String> = row.get("batch_title")?;
        Ok(Self {
            id: row.get("id")?,
            request: parse_request(&request)?,
            title: row.get("title")?,
            thumbnail: row.get("thumbnail")?,
            state: state.parse()?,
            error: code
                .zip(message)
                .map(|(code, message)| StoredError { code, message }),
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
            batch: batch.map(|id| Batch {
                id,
                title: batch_title,
            }),
        })
    }
}

/// The app's only connection, kept as Tauri state.
///
/// One connection behind one `Mutex` is enough: SQLite allows a single writer at a time
/// anyway, and every access here is a short query (well under a millisecond), so a pool or a
/// reader/writer split would add complexity for no gain.
///
/// Rule: never hold the lock across an `.await`. Take it, query, let it drop, then await.
/// Otherwise the lock stays taken while the task sleeps and every other access blocks its
/// thread. (A `std::sync::MutexGuard` is not `Send`, so in a Tauri async command, whose future
/// must be `Send`, the compiler usually refuses it anyway.)
pub struct Db(Mutex<Connection>);

/// The database holds the addresses the user downloaded from, so on Linux and macOS, where a new
/// file is readable by every user of the machine (0644, in a folder of 0755), the folder is made
/// 0700 and the file 0600 before SQLite opens it; its `-wal` and `-shm` files copy the mode
/// of the main file. On Windows the app's data folder is already the user's own.
#[cfg(unix)]
fn keep_private(path: &Path) -> Result<(), AppError> {
    use std::{
        fs::{OpenOptions, Permissions},
        os::unix::fs::{OpenOptionsExt, PermissionsExt},
    };
    let fail = |what: &str, e: std::io::Error| {
        AppError::Unknown(format!("cannot make {what} private: {e}"))
    };
    if let Some(dir) = path.parent() {
        std::fs::set_permissions(dir, Permissions::from_mode(0o700))
            .map_err(|e| fail("the data folder", e))?;
    }
    // Created with 0600 if it is not there yet, so it is never readable even for an instant.
    OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(path)
        .map_err(|e| fail("the database", e))?;
    std::fs::set_permissions(path, Permissions::from_mode(0o600))
        .map_err(|e| fail("the database", e))
}

impl Db {
    /// Opens (or creates, with its folder) the database file and brings the schema up to date.
    pub fn open(path: &Path) -> Result<Self, AppError> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| {
                AppError::Unknown(format!("cannot create the folder {}: {e}", dir.display()))
            })?;
        }
        #[cfg(unix)]
        keep_private(path)?;
        let conn = Connection::open(path)?;
        // WAL: readers do not block the writer, and a crash mid-write cannot corrupt the file.
        // It is saved in the file, so it sticks. This pragma answers with the new mode, which
        // we do not need (an in-memory database, for instance, stays in "memory").
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
        Self::init(conn)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, AppError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(mut conn: Connection) -> Result<Self, AppError> {
        // Per connection, not saved in the file: SQLite starts with foreign keys off.
        conn.pragma_update(None, "foreign_keys", true)?;
        // A deleted row is overwritten with zeros in the file, not just marked free: the
        // history holds the addresses the user visited, and "delete the history" must mean it.
        conn.pragma_update(None, "secure_delete", true)?;
        // Wait for a lock (a WAL checkpoint, a sqlite3 shell...) instead of failing at once
        // with "database is locked". rusqlite already uses 5 s; set here so it does not
        // depend on the crate's default.
        conn.busy_timeout(Duration::from_secs(5))?;
        migrate(&mut conn, MIGRATIONS)?;
        Ok(Self(Mutex::new(conn)))
    }

    // A poisoned mutex only means a thread panicked while holding it. The connection is still
    // fine (an unfinished transaction rolls back when dropped), so we keep using it.
    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Adds a download in `pending` and returns its id, unless an identical request (same
    /// serialized JSON: same URL and same mode) is still pending, active or paused: two
    /// processes would write the same `.part` at once. Checking and inserting are one
    /// transaction under one lock, like `claim_next`, so two at once cannot both get in.
    /// `placement` is stored with the row but takes no part in telling duplicates: the same
    /// request is the same download whichever folder it was queued for.
    pub fn insert_download(
        &self,
        request: &DownloadRequest,
        info: Option<&DownloadInfo>,
        placement: &Placement,
    ) -> Result<i64, AppError> {
        self.insert_download_in(request, info, placement, None)
    }

    /// `insert_download` for a download that belongs to a `batch`. The batch is only
    /// grouping for the list: like `placement`, it takes no part in telling duplicates.
    pub fn insert_download_in(
        &self,
        request: &DownloadRequest,
        info: Option<&DownloadInfo>,
        placement: &Placement,
        batch: Option<&Batch>,
    ) -> Result<i64, AppError> {
        // Serializing the same `DownloadRequest` always gives the same text (fields in
        // declaration order), so equal requests compare equal as strings.
        let json = serde_json::to_string(request)
            .map_err(|e| AppError::Unknown(format!("cannot store the request: {e}")))?;
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM downloads
                 WHERE request = ?1 AND state IN (?2, ?3, ?4)
                 ORDER BY id LIMIT 1",
                params![
                    json,
                    DownloadState::Pending.as_str(),
                    DownloadState::Active.as_str(),
                    DownloadState::Paused.as_str()
                ],
                |row| row.get(0),
            )
            .optional()?;
        if let Some(id) = existing {
            return Err(AppError::AlreadyQueued(format!(
                "{} is already in the queue (id {id})",
                request.url
            )));
        }
        let (title, thumbnail) = info.map(DownloadInfo::cleaned).unwrap_or_default();
        tx.execute(
            "INSERT INTO downloads
                (request, state, title, thumbnail, out_dir, name_template, batch, batch_title,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                json,
                DownloadState::Pending.as_str(),
                title,
                thumbnail,
                placement.out_dir,
                placement.name_template,
                batch.map(|b| b.id),
                batch.and_then(|b| b.title.as_deref()),
                now_ms()
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(id)
    }

    /// The number for a new batch: one more than the highest in use.
    // Known limit: two batches queued at the very same instant could get the same number and be
    // shown as one group; a person pressing Download twice cannot do that, so no counter table.
    pub fn next_batch(&self) -> Result<i64, AppError> {
        Ok(self.conn().query_row(
            "SELECT COALESCE(MAX(batch), 0) + 1 FROM downloads",
            [],
            |row| row.get(0),
        )?)
    }

    /// Moves every `active` download back to `pending` and returns how many there were. Run
    /// at startup, before the scheduler starts anything: an `active` row left by the last run
    /// has no process, and would hold a slot forever. Their ids are older than anything
    /// queued after, so FIFO puts them first. Kept apart from `transition` on purpose: while
    /// the app runs, `active → pending` is not allowed (a running download is only paused).
    /// One `UPDATE` is atomic on its own (SQLite wraps each statement in a transaction).
    pub fn recover_active(&self) -> Result<usize, AppError> {
        let changed = self.conn().execute(
            "UPDATE downloads SET state = ?1, updated_at = ?2 WHERE state = ?3",
            params![
                DownloadState::Pending.as_str(),
                now_ms(),
                DownloadState::Active.as_str()
            ],
        )?;
        Ok(changed)
    }

    pub fn download(&self, id: i64) -> Result<Option<Download>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM downloads WHERE id = ?1")?;
        // `optional()` turns "no rows" into `None` instead of an error. The row is read
        // inside the closure because `Row` borrows the statement and cannot leave it.
        let download = stmt
            .query_row([id], |row| Ok(Download::from_row(row)))
            .optional()?;
        download.transpose()
    }

    /// The downloads the list shows (not dismissed), oldest first.
    pub fn downloads(&self) -> Result<Vec<Download>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM downloads WHERE dismissed = 0 ORDER BY id")?;
        // Bound to a local first: as the function's last expression, the temporary `Rows`
        // would outlive `stmt`, which it borrows.
        let downloads = collect(stmt.query([])?);
        downloads
    }

    /// The ended downloads (finished, failed, cancelled), dismissed or not, newest first, for the
    /// history. `search` is a piece of the title or the URL (empty: all); `state` and
    /// `kind` (`video` or `audio`) narrow them down. At most `limit` rows.
    // Known limit: LIKE ignores case only for ASCII letters ("ñ" and "É" are matched exactly). An
    // FTS table or a lowercased column would fix it; not worth it for a personal history.
    pub fn history(
        &self,
        search: &str,
        state: Option<DownloadState>,
        kind: Option<&str>,
        limit: u32,
    ) -> Result<Vec<Download>, AppError> {
        // `%`, `_` and the escape character are typed by the user as plain text.
        let pattern = format!(
            "%{}%",
            search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT * FROM downloads
             WHERE state IN ('finished', 'failed', 'cancelled')
               AND (title LIKE ?1 ESCAPE '\\' OR json_extract(request, '$.url') LIKE ?1 ESCAPE '\\')
               AND (?2 IS NULL OR state = ?2)
               AND (?3 IS NULL OR json_extract(request, '$.mode.kind') = ?3)
             ORDER BY id DESC LIMIT ?4",
        )?;
        let downloads = collect(stmt.query(params![
            pattern,
            state.map(DownloadState::as_str),
            kind,
            limit
        ])?);
        downloads
    }

    /// Every output folder a download was queued into (older rows have none and
    /// went to the default one). For finding temporary folders a crash left behind.
    pub fn out_dirs(&self) -> Result<Vec<String>, AppError> {
        let conn = self.conn();
        let mut stmt =
            conn.prepare("SELECT DISTINCT out_dir FROM downloads WHERE out_dir IS NOT NULL")?;
        let dirs = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(dirs)
    }

    /// The downloads in `state`, oldest first (the queue's order).
    #[cfg_attr(not(test), expect(dead_code, reason = "used by the recovery"))]
    pub fn downloads_in(&self, state: DownloadState) -> Result<Vec<Download>, AppError> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT * FROM downloads WHERE state = ?1 ORDER BY id")?;
        let downloads = collect(stmt.query([state.as_str()])?);
        downloads
    }

    pub fn count_in(&self, state: DownloadState) -> Result<u32, AppError> {
        let count = self.conn().query_row(
            "SELECT COUNT(*) FROM downloads WHERE state = ?1",
            [state.as_str()],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// Moves download `id` to `to` if `allowed(from, to)` says yes, and stores `error` (`None`
    /// clears the previous one). Reading the current state, checking it and writing happen in
    /// one transaction under one lock, so nothing can change the row in between. The rules
    /// are passed in (`queue::allowed`): this module stores, the queue decides.
    pub fn transition(
        &self,
        id: i64,
        to: DownloadState,
        error: Option<&AppError>,
        allowed: fn(DownloadState, DownloadState) -> bool,
    ) -> Result<(), AppError> {
        let mut conn = self.conn();
        // Immediate: takes SQLite's write lock at BEGIN. With a single connection the Mutex
        // already serializes everything; with several (the threads test) a deferred
        // transaction could read, then fail to upgrade to a writer.
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let from: Option<String> = tx
            .query_row("SELECT state FROM downloads WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?;
        let from: DownloadState = from
            .ok_or_else(|| AppError::Unknown(format!("no download with id {id}")))?
            .parse()?;
        if !allowed(from, to) {
            // Returning drops `tx` (rollback, nothing was written) and then the lock.
            return Err(AppError::Unknown(format!(
                "download {id} cannot go from {} to {}",
                from.as_str(),
                to.as_str()
            )));
        }
        let (code, message) = error.map(AppError::parts).unzip();
        tx.execute(
            "UPDATE downloads
             SET state = ?2, error_code = ?3, error_message = ?4, updated_at = ?5
             WHERE id = ?1",
            params![id, to.as_str(), code, message, now_ms()],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// If fewer than `max` downloads are active, moves the oldest pending one to `active` and
    /// returns it; otherwise (or with nothing pending) `None`. Pending ids in `skip` are passed
    /// over (a network retry still waiting). Counting and claiming are one
    /// transaction under one lock: two callers at the same time can never both take the last
    /// free slot, nor the same download.
    pub fn claim_next(&self, max: u32, skip: &[i64]) -> Result<Option<Job>, AppError> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let active: u32 = tx.query_row(
            "SELECT COUNT(*) FROM downloads WHERE state = ?1",
            [DownloadState::Active.as_str()],
            |row| row.get(0),
        )?;
        if active >= max {
            return Ok(None);
        }
        // In its own block: `stmt` borrows `tx`, and must be gone before `tx` writes and
        // commits below. Only the first pending row not in `skip` is read.
        let next: Option<(i64, String, Placement)> = {
            let mut stmt = tx.prepare(
                "SELECT id, request, out_dir, name_template
                 FROM downloads WHERE state = ?1 ORDER BY id",
            )?;
            let mut rows = stmt.query([DownloadState::Pending.as_str()])?;
            let mut next = None;
            while let Some(row) = rows.next()? {
                let id: i64 = row.get(0)?;
                if !skip.contains(&id) {
                    let placement = Placement {
                        out_dir: row.get(2)?,
                        name_template: row.get(3)?,
                    };
                    next = Some((id, row.get(1)?, placement));
                    break;
                }
            }
            next
        };
        let Some((id, request, placement)) = next else {
            return Ok(None);
        };
        // Known limit: a request that no longer parses (a `DownloadRequest` change that broke old
        // rows) fails here before anything is written, so it stays pending and blocks the
        // queue. Rows are only written from a valid request; mark it failed if that changes.
        let request = parse_request(&request)?;
        tx.execute(
            "UPDATE downloads SET state = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, DownloadState::Active.as_str(), now_ms()],
        )?;
        tx.commit()?;
        Ok(Some(Job {
            id,
            request,
            placement,
        }))
    }

    /// Where download `id` saves its file, as stored. Read again whenever its temporary folder
    /// is cleaned: the folder lives inside the download's own output folder, not the current
    /// setting's.
    pub fn placement(&self, id: i64) -> Result<Placement, AppError> {
        self.conn()
            .query_row(
                "SELECT out_dir, name_template FROM downloads WHERE id = ?1",
                [id],
                |row| {
                    Ok(Placement {
                        out_dir: row.get(0)?,
                        name_template: row.get(1)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| AppError::Unknown(format!("no download with id {id}")))
    }

    /// The final file of a finished download, as yt-dlp printed it. `None` if it never did.
    pub fn output_path(&self, id: i64) -> Result<Option<String>, AppError> {
        self.conn()
            .query_row(
                "SELECT output_path FROM downloads WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()?
            .ok_or_else(|| AppError::Unknown(format!("no download with id {id}")))
    }

    pub fn set_output_path(&self, id: i64, path: &str) -> Result<(), AppError> {
        self.conn().execute(
            "UPDATE downloads SET output_path = ?2 WHERE id = ?1",
            params![id, path],
        )?;
        Ok(())
    }

    /// Hides download `id` from the list (`dismissed = 1`) if `can(state)` says yes. Reading
    /// the state and writing are one transaction under one lock, like `transition`. Hiding one
    /// already hidden is fine. The row stays: only the list forgets it.
    pub fn dismiss(&self, id: i64, can: fn(DownloadState) -> bool) -> Result<(), AppError> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state: Option<String> = tx
            .query_row("SELECT state FROM downloads WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?;
        let state: DownloadState = state
            .ok_or_else(|| AppError::Unknown(format!("no download with id {id}")))?
            .parse()?;
        if !can(state) {
            return Err(AppError::Unknown(format!(
                "download {id} is {} and cannot be removed from the list yet",
                state.as_str()
            )));
        }
        tx.execute("UPDATE downloads SET dismissed = 1 WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    /// Deletes every finished, failed and cancelled download for good (the history),
    /// whether or not it was cleared from the list, and says how many. What is queued, running or
    /// paused stays, and no downloaded file is touched. A temporary folder a failed download kept
    /// for its retry loses its row here and is swept at the next start like any orphan.
    pub fn clear_history(&self) -> Result<u32, AppError> {
        let deleted = self.conn().execute(
            "DELETE FROM downloads WHERE state IN ('finished', 'failed', 'cancelled')",
            [],
        )?;
        // The deleted rows also sit in the write-ahead log until it is folded into the file;
        // truncating it leaves nothing of them on disk. Failing only means it happens later.
        let _ = self
            .conn()
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
        Ok(deleted as u32)
    }

    /// Hides every download whose state `can` accepts, in one transaction, and says how many it
    /// hid ("clear the list"). The rest, and the rows themselves, are left alone.
    pub fn dismiss_where(&self, can: fn(DownloadState) -> bool) -> Result<u32, AppError> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let rows: Vec<(i64, String)> = tx
            .prepare("SELECT id, state FROM downloads WHERE dismissed = 0")?
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        let mut hidden = 0;
        for (id, state) in rows {
            if can(state.parse()?) {
                tx.execute("UPDATE downloads SET dismissed = 1 WHERE id = ?1", [id])?;
                hidden += 1;
            }
        }
        tx.commit()?;
        Ok(hidden)
    }

    /// Moves download `id` to another output folder, but only while it is `failed`: reading the
    /// state and writing are one transaction under one lock, like `transition`, so a download
    /// that has meanwhile restarted (and has files in its old folder) is never moved from under
    /// its process. The name template stays as it was.
    pub fn set_download_dir(&self, id: i64, dir: &str) -> Result<(), AppError> {
        let mut conn = self.conn();
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let state: Option<String> = tx
            .query_row("SELECT state FROM downloads WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?;
        let state: DownloadState = state
            .ok_or_else(|| AppError::Unknown(format!("no download with id {id}")))?
            .parse()?;
        if state != DownloadState::Failed {
            return Err(AppError::Unknown(format!(
                "download {id} cannot be moved: it is {}, not failed",
                state.as_str()
            )));
        }
        tx.execute(
            "UPDATE downloads SET out_dir = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, dir, now_ms()],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn setting(&self, key: &str) -> Result<Option<String>, AppError> {
        let value = self
            .conn()
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(value)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), AppError> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            [key, value],
        )?;
        Ok(())
    }
}

/// Brings the schema up to date. Each script runs in its own transaction together with its
/// `user_version` bump, so a failure leaves the database at the previous version, never
/// halfway. A database newer than the app is an error and is left untouched.
fn migrate(conn: &mut Connection, scripts: &[&str]) -> Result<(), AppError> {
    let current: u32 = conn.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if current as usize > scripts.len() {
        return Err(AppError::Unknown(format!(
            "the database is at version {current} but this app only knows up to {}; \
             it was probably created by a newer version of the app",
            scripts.len()
        )));
    }
    // `version` is the one each script leaves behind: 1 for the first.
    for (version, script) in (1u32..).zip(scripts).skip(current as usize) {
        // `transaction()` needs `&mut`: while it lives, nothing else can use the connection.
        // If a step fails, `?` returns early and dropping `tx` rolls everything back.
        let tx = conn.transaction()?;
        tx.execute_batch(script)?;
        tx.pragma_update(None, "user_version", version)?;
        tx.commit()?;
    }
    Ok(())
}

fn parse_request(json: &str) -> Result<DownloadRequest, AppError> {
    serde_json::from_str(json)
        .map_err(|e| AppError::Unknown(format!("stored request is not valid: {e}")))
}

fn collect(mut rows: rusqlite::Rows) -> Result<Vec<Download>, AppError> {
    let mut downloads = Vec::new();
    while let Some(row) = rows.next()? {
        downloads.push(Download::from_row(row)?);
    }
    Ok(downloads)
}

/// Milliseconds since the Unix epoch. A clock set before 1970 gives 0 instead of an error.
fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        test_util::TempDir,
        ytdlp::formats::{AudioFormat, Container, Mode},
    };

    fn video() -> DownloadRequest {
        DownloadRequest {
            url: "https://www.youtube.com/watch?v=jNQXAC9IVRw".into(),
            mode: Mode::Video {
                max_height: Some(1080),
                container: Some(Container::Mp4),
            },
            playlist: None,
            folder: None,
            subtitles: None,
        }
    }

    fn audio() -> DownloadRequest {
        DownloadRequest {
            url: "https://soundcloud.com/a/b".into(),
            mode: Mode::Audio {
                format: AudioFormat::Mp3,
                bitrate_kbps: None,
            },
            playlist: None,
            folder: None,
            subtitles: None,
        }
    }

    const LAST: u32 = MIGRATIONS.len() as u32;

    /// Allows every transition: these tests are about storage, the rules are queue.rs's.
    fn any(_: DownloadState, _: DownloadState) -> bool {
        true
    }

    fn version(conn: &Connection) -> u32 {
        conn.pragma_query_value(None, "user_version", |row| row.get(0))
            .unwrap()
    }

    fn table_count(conn: &Connection) -> u32 {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    // --- migrations ---

    #[test]
    fn empty_database_reaches_the_last_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, MIGRATIONS).unwrap();
        assert_eq!(version(&conn), LAST);
        // downloads, settings and SQLite's own sqlite_sequence (AUTOINCREMENT).
        assert_eq!(table_count(&conn), 3);
    }

    #[test]
    fn migrating_twice_changes_nothing() {
        let db = Db::open_in_memory().unwrap();
        let id = db
            .insert_download(&video(), None, &Placement::default())
            .unwrap();
        let mut conn = db.conn();
        migrate(&mut conn, MIGRATIONS).unwrap();
        assert_eq!(version(&conn), LAST);
        drop(conn);
        assert!(db.download(id).unwrap().is_some());
    }

    #[test]
    fn a_newer_database_is_refused_and_left_untouched() {
        let mut conn = Connection::open_in_memory().unwrap();
        let future = LAST + 1;
        conn.pragma_update(None, "user_version", future).unwrap();
        let err = migrate(&mut conn, MIGRATIONS).unwrap_err();
        assert!(err.to_string().contains("newer version"), "{err}");
        assert_eq!(version(&conn), future);
        assert_eq!(table_count(&conn), 0);
    }

    #[test]
    fn a_failed_migration_rolls_back_with_its_version() {
        let mut conn = Connection::open_in_memory().unwrap();
        let scripts = ["CREATE TABLE a (x);", "CREATE TABLE b (x); NOT SQL;"];
        assert!(migrate(&mut conn, &scripts).is_err());
        // The first script stays; the second leaves neither its table nor its version.
        assert_eq!(version(&conn), 1);
        assert_eq!(table_count(&conn), 1);
    }

    // --- downloads and settings ---

    #[test]
    fn requests_round_trip_as_json() {
        let db = Db::open_in_memory().unwrap();
        for request in [video(), audio()] {
            let id = db
                .insert_download(&request, None, &Placement::default())
                .unwrap();
            let stored = db.download(id).unwrap().unwrap();
            assert_eq!(stored.request, request);
            assert_eq!(stored.state, DownloadState::Pending);
            assert_eq!(stored.error, None);
            assert!(stored.created_at > 0);
            assert_eq!(stored.created_at, stored.updated_at);
        }
        assert_eq!(db.download(999).unwrap(), None);
    }

    #[test]
    fn the_check_rejects_an_unknown_state() {
        let db = Db::open_in_memory().unwrap();
        let result = db.conn().execute(
            "INSERT INTO downloads (request, state, created_at, updated_at)
             VALUES ('{}', 'downloading', 0, 0)",
            [],
        );
        assert!(result.unwrap_err().to_string().contains("CHECK"));
    }

    #[test]
    fn lists_keep_id_order_and_counts_match() {
        let db = Db::open_in_memory().unwrap();
        let ids: Vec<i64> = (0..4)
            .map(|n| {
                let mut request = video();
                request.url.push_str(&format!("&n={n}"));
                db.insert_download(&request, None, &Placement::default())
                    .unwrap()
            })
            .collect();
        // Fail the second one, then the first: the list still follows the ids.
        db.transition(ids[1], DownloadState::Failed, None, any)
            .unwrap();
        db.transition(ids[0], DownloadState::Failed, None, any)
            .unwrap();

        let failed: Vec<i64> = db
            .downloads_in(DownloadState::Failed)
            .unwrap()
            .iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(failed, [ids[0], ids[1]]);
        let pending: Vec<i64> = db
            .downloads_in(DownloadState::Pending)
            .unwrap()
            .iter()
            .map(|d| d.id)
            .collect();
        assert_eq!(pending, [ids[2], ids[3]]);
        let all: Vec<i64> = db.downloads().unwrap().iter().map(|d| d.id).collect();
        assert_eq!(all, ids);

        assert_eq!(db.count_in(DownloadState::Failed).unwrap(), 2);
        assert_eq!(db.count_in(DownloadState::Pending).unwrap(), 2);
        assert_eq!(db.count_in(DownloadState::Active).unwrap(), 0);
    }

    #[test]
    fn transition_stores_and_clears_the_error() {
        let db = Db::open_in_memory().unwrap();
        let id = db
            .insert_download(&audio(), None, &Placement::default())
            .unwrap();
        let error = AppError::Network("timed out".into());
        db.transition(id, DownloadState::Failed, Some(&error), any)
            .unwrap();
        let stored = db.download(id).unwrap().unwrap();
        assert_eq!(stored.state, DownloadState::Failed);
        let expected = StoredError {
            code: "network".into(),
            message: "timed out".into(),
        };
        assert_eq!(stored.error, Some(expected));
        assert!(stored.updated_at >= stored.created_at);

        db.transition(id, DownloadState::Pending, None, any)
            .unwrap();
        assert_eq!(db.download(id).unwrap().unwrap().error, None);

        assert!(db
            .transition(999, DownloadState::Active, None, any)
            .is_err());
        // A refused transition writes nothing.
        let none = |_, _| false;
        assert!(db
            .transition(id, DownloadState::Active, None, none)
            .is_err());
        assert_eq!(
            db.download(id).unwrap().unwrap().state,
            DownloadState::Pending
        );
    }

    #[test]
    fn settings_read_write_and_overwrite() {
        let db = Db::open_in_memory().unwrap();
        assert_eq!(db.setting("language").unwrap(), None);
        db.set_setting("language", "es").unwrap();
        assert_eq!(db.setting("language").unwrap().as_deref(), Some("es"));
        db.set_setting("language", "en").unwrap();
        assert_eq!(db.setting("language").unwrap().as_deref(), Some("en"));
    }

    // --- DownloadState ---

    #[test]
    fn states_round_trip_and_unknown_text_is_rejected() {
        for state in DownloadState::ALL {
            assert_eq!(state.as_str().parse::<DownloadState>().unwrap(), state);
        }
        assert!("downloading".parse::<DownloadState>().is_err());
        assert!("Pending".parse::<DownloadState>().is_err());
    }

    // --- real file ---

    #[test]
    fn open_creates_the_file_in_wal_mode_at_the_last_version() {
        let dir = TempDir::new("db");
        // A subfolder that does not exist yet, like app_data_dir() on a first run.
        let path = dir.0.join("data").join("albaro.db");
        let db = Db::open(&path).unwrap();
        let id = db
            .insert_download(&video(), None, &Placement::default())
            .unwrap();
        drop(db);
        assert!(path.exists());

        // Reopening keeps the data and the version.
        let db = Db::open(&path).unwrap();
        assert!(db.download(id).unwrap().is_some());
        let conn = db.conn();
        let mode: String = conn
            .pragma_query_value(None, "journal_mode", |row| row.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        assert_eq!(version(&conn), LAST);
        let foreign_keys: bool = conn
            .pragma_query_value(None, "foreign_keys", |row| row.get(0))
            .unwrap();
        assert!(foreign_keys);
    }
    // --- list data ---

    #[test]
    fn migration_2_keeps_old_rows_with_no_title_and_visible() {
        // A database as version 1 left it, with two rows.
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, &MIGRATIONS[..1]).unwrap();
        assert_eq!(version(&conn), 1);
        let json = serde_json::to_string(&video()).unwrap();
        for state in ["pending", "finished"] {
            conn.execute(
                "INSERT INTO downloads (request, state, created_at, updated_at)
                 VALUES (?1, ?2, 5, 6)",
                params![json, state],
            )
            .unwrap();
        }
        // Opening it again runs the rest of the scripts.
        let db = Db::init(conn).unwrap();
        assert_eq!(version(&db.conn()), LAST);
        let rows = db.downloads().unwrap();
        assert_eq!(rows.len(), 2);
        for row in &rows {
            assert_eq!(
                (row.title.as_deref(), row.thumbnail.as_deref()),
                (None, None)
            );
            assert_eq!((row.created_at, row.updated_at), (5, 6));
            assert_eq!(row.request, video());
            assert_eq!(db.output_path(row.id).unwrap(), None);
        }
        assert_eq!(rows[0].state, DownloadState::Pending);
        assert_eq!(rows[1].state, DownloadState::Finished);
    }

    #[test]
    fn title_and_thumbnail_are_stored_with_the_row() {
        let db = Db::open_in_memory().unwrap();
        let info = DownloadInfo {
            title: Some("  Me at the zoo ".into()),
            thumbnail: Some("https://i.ytimg.com/vi/x/hq.jpg".into()),
        };
        let id = db
            .insert_download(&video(), Some(&info), &Placement::default())
            .unwrap();
        let row = db.download(id).unwrap().unwrap();
        assert_eq!(row.title.as_deref(), Some("Me at the zoo"));
        assert_eq!(
            row.thumbnail.as_deref(),
            Some("https://i.ytimg.com/vi/x/hq.jpg")
        );
        // Without info, both are empty.
        let bare = db
            .insert_download(&audio(), None, &Placement::default())
            .unwrap();
        let row = db.download(bare).unwrap().unwrap();
        assert_eq!((row.title, row.thumbnail), (None, None));
    }

    #[test]
    fn clearing_the_history_deletes_only_what_has_ended_and_leaves_no_trace() {
        let dir = TempDir::new("db-clear-history");
        let path = dir.0.join("albaro.db");
        let db = Db::open(&path).unwrap();
        let secret = "SECRETURL-9f3a1c7d";
        let ids: Vec<i64> = [
            "finished",
            "failed",
            "cancelled",
            "pending",
            "active",
            "paused",
        ]
        .iter()
        .enumerate()
        .map(|(i, state)| {
            let id = db
                .insert_download(
                    &DownloadRequest {
                        url: format!("https://e.com/{secret}-{i}"),
                        mode: crate::ytdlp::formats::Mode::Audio {
                            format: crate::ytdlp::formats::AudioFormat::Best,
                            bitrate_kbps: None,
                        },
                        playlist: None,
                        folder: None,
                        subtitles: None,
                    },
                    None,
                    &Placement::default(),
                )
                .unwrap();
            db.conn()
                .execute(
                    "UPDATE downloads SET state = ?1 WHERE id = ?2",
                    params![state, id],
                )
                .unwrap();
            id
        })
        .collect();
        // One of the ended ones was cleared from the list: it still counts as history.
        db.dismiss(ids[0], |_| true).unwrap();
        assert_eq!(db.clear_history().unwrap(), 3);
        let left: Vec<i64> = {
            let conn = db.conn();
            let mut stmt = conn
                .prepare("SELECT id FROM downloads ORDER BY id")
                .unwrap();
            let rows = stmt.query_map([], |row| row.get(0)).unwrap();
            rows.map(Result::unwrap).collect()
        };
        assert_eq!(left, ids[3..]);
        assert_eq!(db.clear_history().unwrap(), 0);
        // Nothing of the deleted rows is left in the files: not in the database, not in the log.
        drop(db);
        for file in ["albaro.db", "albaro.db-wal"] {
            let bytes = std::fs::read(dir.0.join(file)).unwrap_or_default();
            let found: Vec<usize> = (0..3)
                .filter(|i| {
                    let needle = format!("{secret}-{i}");
                    bytes.windows(needle.len()).any(|w| w == needle.as_bytes())
                })
                .collect();
            assert!(found.is_empty(), "{file} still holds {found:?}");
        }
    }

    /// The history is private to the user, also a database made by an older version.
    #[cfg(unix)]
    #[test]
    fn the_database_and_its_folder_are_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("db-private");
        let path = dir.0.join("data").join("albaro.db");
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        // An old database: made world-readable, in a world-readable folder.
        let db = Db::open(&path).unwrap();
        drop(db);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::set_permissions(
            path.parent().unwrap(),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let db = Db::open(&path).unwrap();
        db.insert_download(&video(), None, &Placement::default())
            .unwrap();
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        for entry in std::fs::read_dir(path.parent().unwrap()).unwrap() {
            let file = entry.unwrap().path();
            assert_eq!(mode(&file) & 0o077, 0, "{file:?} is readable by others");
        }
        assert_eq!(mode(&path), 0o600);
    }

    #[test]
    fn deleted_rows_are_overwritten_not_just_freed() {
        let db = Db::open_in_memory().unwrap();
        let on: i64 = db
            .conn()
            .pragma_query_value(None, "secure_delete", |row| row.get(0))
            .unwrap();
        assert_eq!(on, 1);
    }

    #[test]
    fn what_the_frontend_sends_is_bounded() {
        let long = "x".repeat(MAX_TITLE_CHARS + 50);
        let (title, _) = DownloadInfo {
            title: Some(long),
            thumbnail: None,
        }
        .cleaned();
        // Cut at the limit and marked with an ellipsis.
        assert_eq!(title.unwrap().chars().count(), MAX_TITLE_CHARS + 1);
        let blank = DownloadInfo {
            title: Some("   ".into()),
            thumbnail: None,
        };
        assert_eq!(blank.cleaned(), (None, None));
        // Only http(s) thumbnails, and not absurdly long ones.
        for bad in [
            "javascript:alert(1)",
            "file:///C:/x.png",
            "data:image/svg+xml,<svg/>",
            "",
        ] {
            let info = DownloadInfo {
                title: None,
                thumbnail: Some(bad.into()),
            };
            assert_eq!(info.cleaned().1, None, "{bad}");
        }
        let huge = format!("https://e.com/{}", "a".repeat(text::THUMBNAIL_MAX));
        let info = DownloadInfo {
            title: None,
            thumbnail: Some(huge),
        };
        assert_eq!(info.cleaned().1, None);
    }

    #[test]
    fn info_does_not_change_what_counts_as_a_duplicate() {
        let db = Db::open_in_memory().unwrap();
        let with_title = DownloadInfo {
            title: Some("A".into()),
            thumbnail: None,
        };
        db.insert_download(&video(), Some(&with_title), &Placement::default())
            .unwrap();
        let err = db
            .insert_download(&video(), None, &Placement::default())
            .unwrap_err();
        assert!(matches!(err, AppError::AlreadyQueued(_)), "{err}");
    }

    #[test]
    fn the_output_path_is_read_back_and_unknown_ids_are_an_error() {
        let db = Db::open_in_memory().unwrap();
        let id = db
            .insert_download(&video(), None, &Placement::default())
            .unwrap();
        assert_eq!(db.output_path(id).unwrap(), None);
        db.set_output_path(id, r"C:\out\a.mp4").unwrap();
        assert_eq!(
            db.output_path(id).unwrap().as_deref(),
            Some(r"C:\out\a.mp4")
        );
        assert!(db.output_path(999).is_err());
    }

    #[test]
    fn a_dismissed_row_leaves_the_list_but_stays_in_the_table() {
        let db = Db::open_in_memory().unwrap();
        let keep = db
            .insert_download(&video(), None, &Placement::default())
            .unwrap();
        let hide = db
            .insert_download(&audio(), None, &Placement::default())
            .unwrap();
        db.dismiss(hide, |_| true).unwrap();
        let ids: Vec<i64> = db.downloads().unwrap().iter().map(|d| d.id).collect();
        assert_eq!(ids, [keep]);
        // Still there for anything that asks for it by id (the history, later).
        assert!(db.download(hide).unwrap().is_some());
        // Hiding it again is fine; an unknown id and a refused state are errors.
        db.dismiss(hide, |_| true).unwrap();
        assert!(db.dismiss(999, |_| true).is_err());
        assert!(db.dismiss(keep, |_| false).is_err());
        assert_eq!(db.downloads().unwrap().len(), 1);
    }

    // --- history ---

    #[test]
    fn the_history_holds_every_ended_download_newest_first_and_filters_them() {
        let db = Db::open_in_memory().unwrap();
        let info = |title: &str| DownloadInfo {
            title: Some(title.into()),
            thumbnail: None,
        };
        let add = |request: &DownloadRequest, title: &str| {
            db.insert_download(request, Some(&info(title)), &Placement::default())
                .unwrap()
        };
        // A request identical to a queued one is refused, so each video has its own URL.
        let video_at = |url: &str| DownloadRequest {
            url: url.into(),
            ..video()
        };
        let zoo = add(
            &video_at("https://www.youtube.com/watch?v=zoo"),
            "Me at the zoo",
        );
        let song = add(&audio(), "100% Rock_n_Roll");
        let failed = add(
            &video_at("https://www.youtube.com/watch?v=bad"),
            "Broken one",
        );
        let waiting = add(
            &video_at("https://www.youtube.com/watch?v=wait"),
            "Still queued",
        );
        db.transition(zoo, DownloadState::Active, None, any)
            .unwrap();
        db.transition(zoo, DownloadState::Finished, None, any)
            .unwrap();
        db.transition(song, DownloadState::Finished, None, any)
            .unwrap();
        db.transition(failed, DownloadState::Failed, None, any)
            .unwrap();
        // Hiding a row from the list does not take it out of the history.
        db.dismiss(zoo, |_| true).unwrap();
        let ids = |rows: Vec<Download>| rows.iter().map(|d| d.id).collect::<Vec<_>>();
        let all = ids(db.history("", None, None, 50).unwrap());
        assert_eq!(all, [failed, song, zoo], "queued ones are not history");
        assert!(!all.contains(&waiting));
        assert_eq!(ids(db.history("", None, None, 2).unwrap()), [failed, song]);
        assert_eq!(
            ids(db
                .history("", Some(DownloadState::Finished), None, 50)
                .unwrap()),
            [song, zoo]
        );
        assert_eq!(
            ids(db.history("", None, Some("audio"), 50).unwrap()),
            [song]
        );
        assert_eq!(
            ids(db.history("", None, Some("video"), 50).unwrap()),
            [failed, zoo]
        );
        // The title, case-insensitive, or the URL.
        assert_eq!(ids(db.history("ZOO", None, None, 50).unwrap()), [zoo]);
        assert_eq!(
            ids(db.history("soundcloud.com", None, None, 50).unwrap()),
            [song]
        );
        // `%` and `_` are ordinary characters, not wildcards.
        assert_eq!(ids(db.history("100%", None, None, 50).unwrap()), [song]);
        assert_eq!(ids(db.history("n_R", None, None, 50).unwrap()), [song]);
        assert!(db.history("%", None, None, 50).unwrap().len() == 1);
        assert!(db
            .history("zoo", Some(DownloadState::Failed), None, 50)
            .unwrap()
            .is_empty());
    }

    // --- batches ---

    #[test]
    fn migration_4_leaves_rows_from_version_3_outside_any_batch() {
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, &MIGRATIONS[..3]).unwrap();
        assert_eq!(version(&conn), 3);
        let json = serde_json::to_string(&video()).unwrap();
        conn.execute(
            "INSERT INTO downloads (request, state, created_at, updated_at)
             VALUES (?1, 'pending', 5, 6)",
            params![json],
        )
        .unwrap();
        let db = Db::init(conn).unwrap();
        assert_eq!(version(&db.conn()), LAST);
        assert_eq!(db.downloads().unwrap()[0].batch, None);
        assert_eq!(db.next_batch().unwrap(), 1);
    }

    #[test]
    fn a_batch_is_stored_with_the_row_and_goes_to_the_frontend() {
        let db = Db::open_in_memory().unwrap();
        let batch = Batch::new(db.next_batch().unwrap(), Some("My list"));
        let id = db
            .insert_download_in(&video(), None, &Placement::default(), Some(&batch))
            .unwrap();
        let row = db.download(id).unwrap().unwrap();
        assert_eq!(row.batch, Some(batch));
        let json = serde_json::to_value(&row).unwrap();
        assert_eq!(
            json["batch"],
            serde_json::json!({ "id": 1, "title": "My list" })
        );
        // A download queued on its own has none (null, not missing).
        let alone = db
            .insert_download(&audio(), None, &Placement::default())
            .unwrap();
        let json = serde_json::to_value(db.download(alone).unwrap().unwrap()).unwrap();
        assert!(json["batch"].is_null());
    }

    #[test]
    fn a_batch_takes_no_part_in_telling_duplicates() {
        let db = Db::open_in_memory().unwrap();
        let batch = Batch::new(1, None);
        db.insert_download_in(&video(), None, &Placement::default(), Some(&batch))
            .unwrap();
        assert!(matches!(
            db.insert_download(&video(), None, &Placement::default()),
            Err(AppError::AlreadyQueued(_))
        ));
    }

    #[test]
    fn a_batch_title_is_trimmed_bounded_and_dropped_when_blank() {
        assert_eq!(Batch::new(1, Some("  a  ")).title.as_deref(), Some("a"));
        assert_eq!(Batch::new(1, Some("   ")).title, None);
        assert_eq!(Batch::new(1, None).title, None);
        let long = "x".repeat(MAX_TITLE_CHARS + 50);
        assert_eq!(
            Batch::new(1, Some(&long)).title.unwrap().chars().count(),
            MAX_TITLE_CHARS + 1
        );
    }

    // --- folder and name ---

    #[test]
    fn migration_3_keeps_rows_from_version_2_with_no_placement() {
        // A database as version 2 left it, with two rows (one finished, with its path).
        let mut conn = Connection::open_in_memory().unwrap();
        migrate(&mut conn, &MIGRATIONS[..2]).unwrap();
        assert_eq!(version(&conn), 2);
        let json = serde_json::to_string(&video()).unwrap();
        for (state, title) in [("pending", "A"), ("finished", "B")] {
            conn.execute(
                "INSERT INTO downloads (request, state, title, output_path, created_at, updated_at)
                 VALUES (?1, ?2, ?3, '/old/x.mp4', 5, 6)",
                params![json, state, title],
            )
            .unwrap();
        }
        let db = Db::init(conn).unwrap();
        assert_eq!(version(&db.conn()), LAST);
        let rows = db.downloads().unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].title.as_deref(), Some("A"));
        assert_eq!((rows[1].created_at, rows[1].updated_at), (5, 6));
        assert_eq!(rows[1].request, video());
        for row in &rows {
            // NULL: the default folder and name (queue::resolve).
            assert_eq!(db.placement(row.id).unwrap(), Placement::default());
        }
        assert_eq!(
            db.output_path(rows[1].id).unwrap().as_deref(),
            Some("/old/x.mp4")
        );
        // The old pending row is claimed with an empty placement.
        let job = db.claim_next(3, &[]).unwrap().unwrap();
        assert_eq!(job.id, rows[0].id);
        assert_eq!(job.placement, Placement::default());
    }

    #[test]
    fn the_placement_is_stored_with_the_row_and_read_back() {
        let db = Db::open_in_memory().unwrap();
        let placement = Placement {
            out_dir: Some("/home/ana/Vídeos ñ".into()),
            name_template: Some("channelTitle".into()),
        };
        let id = db.insert_download(&video(), None, &placement).unwrap();
        assert_eq!(db.placement(id).unwrap(), placement);
        let job = db.claim_next(1, &[]).unwrap().unwrap();
        assert_eq!(job.placement, placement);
        assert!(db.placement(999).is_err());
    }

    #[test]
    fn the_placement_never_reaches_the_frontend() {
        let db = Db::open_in_memory().unwrap();
        let placement = Placement {
            out_dir: Some("/secret".into()),
            name_template: Some("title".into()),
        };
        let id = db.insert_download(&video(), None, &placement).unwrap();
        let json = serde_json::to_string(&db.download(id).unwrap().unwrap()).unwrap();
        assert!(
            !json.contains("secret") && !json.contains("outDir"),
            "{json}"
        );
    }

    // --- moving a failed download ---

    #[test]
    fn set_download_dir_writes_only_while_the_download_is_failed() {
        let db = Db::open_in_memory().unwrap();
        let place = Placement {
            out_dir: Some("/old".into()),
            name_template: Some("channelTitle".into()),
        };
        let id = db.insert_download(&video(), None, &place).unwrap();
        // Every state but `failed` refuses, and nothing is written.
        for state in [
            DownloadState::Active,
            DownloadState::Paused,
            DownloadState::Pending,
        ] {
            db.transition(id, state, None, any).unwrap();
            let err = db.set_download_dir(id, "/new").unwrap_err();
            assert!(
                matches!(&err, AppError::Unknown(m) if m.contains("cannot be moved") && m.contains(state.as_str())),
                "{err}"
            );
            assert_eq!(db.placement(id).unwrap(), place);
        }
        db.transition(id, DownloadState::Failed, None, any).unwrap();
        db.set_download_dir(id, "/new").unwrap();
        // Only the folder changes (and the row's time).
        let moved = db.placement(id).unwrap();
        assert_eq!(moved.out_dir.as_deref(), Some("/new"));
        assert_eq!(moved.name_template.as_deref(), Some("channelTitle"));
        // The state moved on in the meantime (a retry that already started): refused again.
        db.transition(id, DownloadState::Pending, None, any)
            .unwrap();
        db.transition(id, DownloadState::Finished, None, any)
            .unwrap();
        assert!(db.set_download_dir(id, "/newer").is_err());
        assert_eq!(db.placement(id).unwrap().out_dir.as_deref(), Some("/new"));
        assert!(db.set_download_dir(999, "/x").is_err());
    }

    #[test]
    fn a_move_racing_a_restart_never_overwrites_a_running_download() {
        use std::sync::{Arc, Barrier};
        let dir = TempDir::new("db-move-race");
        let path = dir.0.join("albaro.db");
        let first = Db::open(&path).unwrap();
        let id = first
            .insert_download(&video(), None, &Placement::default())
            .unwrap();
        first
            .transition(id, DownloadState::Failed, None, any)
            .unwrap();
        // Two connections: one retries (failed → pending), the other tries to move. Either the
        // move comes first and the row is moved and then restarted, or the restart does and the
        // move is refused; never a move of a row that is no longer failed.
        let second = Db::open(&path).unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let b = Arc::clone(&barrier);
        let mover = std::thread::scope(|scope| {
            let handle = scope.spawn(move || {
                b.wait();
                second.set_download_dir(id, "/new")
            });
            barrier.wait();
            first
                .transition(id, DownloadState::Pending, None, any)
                .unwrap();
            handle.join().unwrap()
        });
        let place = first.placement(id).unwrap();
        match mover {
            Ok(()) => assert_eq!(place.out_dir.as_deref(), Some("/new")),
            Err(_) => assert_eq!(place.out_dir, None),
        }
    }
}
