// Runs a sidecar as a child process and streams its output line by line. It knows nothing
// about downloads: callers pass the sidecar name and arguments, read `RunEvent`s from the
// channel and keep the `Run` to cancel it.
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    thread,
    time::Duration,
};

use tauri::{
    async_runtime::{self, Receiver},
    AppHandle,
};
use tauri_plugin_shell::{
    process::{Command, CommandChild, CommandEvent},
    ShellExt,
};

use crate::errors::AppError;

#[derive(Debug)]
pub enum RunEvent {
    Stdout(String),
    Stderr(String),
    /// Always the last event. `Ok` means exit code 0.
    Exited(Result<(), AppError>),
}

/// A running process. Dropping it does not stop the process: call `cancel`.
pub struct Run {
    app: AppHandle,
    child: CommandChild,
    // Shared with the reading task (hence `Arc`); atomic so both sides can touch it without
    // a lock. It tells an exit caused by `cancel` apart from a real failure.
    cancelled: Arc<AtomicBool>,
}

pub fn spawn(
    app: &AppHandle,
    sidecar: &str,
    args: Vec<String>,
) -> Result<(Run, Receiver<RunEvent>), AppError> {
    let command = app
        .shell()
        .sidecar(sidecar)
        .map_err(|e| AppError::Unknown(e.to_string()))?;
    launch(app, command, args)
}

/// Like `spawn`, for an executable at `program` instead of a bundled sidecar (the updated yt-dlp
/// in the data folder). No permission is involved: only Rust launches processes.
pub fn spawn_program(
    app: &AppHandle,
    program: &Path,
    args: Vec<String>,
) -> Result<(Run, Receiver<RunEvent>), AppError> {
    launch(app, app.shell().command(program), args)
}

fn launch(
    app: &AppHandle,
    command: Command,
    args: Vec<String>,
) -> Result<(Run, Receiver<RunEvent>), AppError> {
    let (mut rx, child) = command
        .args(args)
        // Raw chunks instead of the plugin's lines: the plugin also splits on a lone `\r`, so
        // a `\r\n` that arrives in two reads becomes a line plus a fake empty one.
        .set_raw_out(true)
        .spawn()
        .map_err(|e| AppError::Unknown(e.to_string()))?;

    let cancelled = Arc::new(AtomicBool::new(false));
    let task_cancelled = cancelled.clone();
    let (tx, events) = async_runtime::channel(64);

    // `async move` moves `rx`, `tx` and the flag into the task, which outlives this function.
    // Send errors are ignored: if the caller dropped the receiver we still read until exit.
    let pid = child.pid();
    let task_app = app.clone();
    async_runtime::spawn(async move {
        let mut stdout = LineSplitter::new(MAX_LINE_BYTES);
        let mut stderr = LineSplitter::new(MAX_LINE_BYTES).scrubbing();
        let mut stderr_lines = Vec::new();
        let mut stderr_bytes = 0;
        let mut too_big = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(chunk) => {
                    for line in stdout.push(&chunk) {
                        let _ = tx.send(RunEvent::Stdout(line)).await;
                    }
                    // A line over the limit: nothing useful can come of this run. Kill it now
                    // (the end of the run reports why), instead of letting it print on.
                    if stdout.overflowed && !too_big {
                        too_big = true;
                        kill_tree(&task_app, pid).await;
                    }
                }
                CommandEvent::Stderr(chunk) => {
                    for line in stderr.push(&chunk) {
                        if stderr_bytes < MAX_STDERR_BYTES {
                            stderr_bytes += line.len() + 1;
                            stderr_lines.push(line.clone());
                        }
                        let _ = tx.send(RunEvent::Stderr(line)).await;
                    }
                }
                // An I/O error reading the pipes; the process may still be running.
                CommandEvent::Error(msg) => stderr_lines.push(msg),
                // The plugin sends this only after both pipes are closed, so nothing is lost.
                CommandEvent::Terminated(end) => {
                    if let Some(line) = stdout.finish() {
                        let _ = tx.send(RunEvent::Stdout(line)).await;
                    }
                    if let Some(line) = stderr.finish() {
                        stderr_lines.push(line.clone());
                        let _ = tx.send(RunEvent::Stderr(line)).await;
                    }
                    let cancelled = task_cancelled.load(Ordering::SeqCst);
                    let result = if too_big {
                        Err(AppError::Unknown(format!(
                            "yt-dlp printed a line over {} MB: the answer is too big to read",
                            MAX_LINE_BYTES / (1024 * 1024)
                        )))
                    } else {
                        exit_result(end.code, cancelled, &stderr_lines.join("\n"))
                    };
                    let _ = tx.send(RunEvent::Exited(result)).await;
                    break;
                }
                _ => {}
            }
        }
    });

    let run = Run {
        app: app.clone(),
        child,
        cancelled,
    };
    Ok((run, events))
}

impl Run {
    /// Kills the process and every process it started. The channel then ends with
    /// `Exited(Err(Cancelled))`. Takes `self` because a run can only be cancelled once.
    pub async fn cancel(self) {
        self.cancelled.store(true, Ordering::SeqCst);
        kill_tree(&self.app, self.child.pid()).await;
        // Backstop in case the tree kill failed. Errors are ignored: they mean the process
        // is already gone, which is what we want.
        let _ = self.child.kill();
    }

    /// Cancels the run if it is still going after `limit`. Keep the returned
    /// `Deadline` while reading the run's events: dropping it (the run ended in time) disarms
    /// the timer. The `Run` moves to the timer, so the caller can no longer cancel it.
    pub fn cancel_after(self, limit: Duration) -> Deadline {
        // `block_on` is fine here: it runs on the timer's own thread, not on the async runtime.
        after(limit, move || async_runtime::block_on(self.cancel()))
    }
}

/// Disarms its timer when dropped.
pub struct Deadline {
    _disarm: mpsc::Sender<()>,
}

/// Runs `on_timeout` on its own thread once `limit` has passed, unless the returned
/// `Deadline` is dropped first. Dropping it drops the only sender, so `recv_timeout` returns
/// `Disconnected` at once and the thread ends without waiting out the limit.
fn after(limit: Duration, on_timeout: impl FnOnce() + Send + 'static) -> Deadline {
    let (disarm, disarmed) = mpsc::channel();
    thread::spawn(move || {
        if disarmed.recv_timeout(limit) == Err(mpsc::RecvTimeoutError::Timeout) {
            on_timeout();
        }
    });
    Deadline { _disarm: disarm }
}

// yt-dlp.exe is a PyInstaller bootloader that starts the real yt-dlp as a child process,
// which in turn starts ffmpeg and deno. Killing only our PID would leave them running.
// `taskkill /T` walks the tree by parent PID, so it must run while our process is alive.
#[cfg(windows)]
async fn kill_tree(app: &AppHandle, pid: u32) {
    let _ = app
        .shell()
        .command(taskkill_path())
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .await;
}

/// `taskkill` by its full path in the system folder. Started by name, Windows looks for it first in
/// the folder of the app itself and then along the PATH, so a stranger's `taskkill.exe` put in either
/// would run in its place.
#[cfg(windows)]
fn taskkill_path() -> String {
    let system = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
    format!(r"{system}\System32\taskkill.exe")
}

// Same reason on Linux/macOS (the PyInstaller bootloader is there too). There is no `/T`, so
// the tree is listed first with `pgrep -P` (children of each pid, breadth first) and then
// everything is killed in one `kill -KILL`. The parent must still be alive to be listed.
// Known limit: a child started between the listing and the kill survives; a process group would
// close that gap, but the shell plugin cannot spawn the child in its own group.
#[cfg(not(windows))]
async fn kill_tree(app: &AppHandle, pid: u32) {
    let mut tree = vec![pid];
    let mut next = 0;
    while next < tree.len() {
        // pgrep exits 1 with no output when there are no children; that is not an error here.
        if let Ok(out) = app
            .shell()
            .command("pgrep")
            .args(["-P", &tree[next].to_string()])
            .output()
            .await
        {
            let text = String::from_utf8_lossy(&out.stdout);
            tree.extend(
                text.split_whitespace()
                    .filter_map(|p| p.parse::<u32>().ok()),
            );
        }
        next += 1;
    }
    let _ = app
        .shell()
        .command("kill")
        .args(["-KILL"])
        .args(tree.iter().map(u32::to_string))
        .status()
        .await;
}

/// The longest line a run may print. `--dump-single-json` prints a whole video or
/// playlist as ONE line: a normal one is a few hundred KB, a 5000-entry list about 7 MB. Without a
/// limit, a site (or a bug) that never ends a line fills the memory.
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

/// Most of a run's stderr kept for its error message. The rest is still sent as events.
const MAX_STDERR_BYTES: usize = 256 * 1024;

/// Turns raw output chunks into lines. A chunk can end mid-line (or mid UTF-8 character), so
/// the incomplete tail waits for the next chunk. A line longer than `max` is not kept: the
/// splitter drops everything from then on and says so (`overflowed`), and the caller ends the run.
struct LineSplitter {
    pending: Vec<u8>,
    max: usize,
    overflowed: bool,
    /// Take secrets out of every line it returns, the last unterminated one included.
    scrub: bool,
}

impl LineSplitter {
    fn new(max: usize) -> Self {
        Self {
            pending: Vec::new(),
            max,
            overflowed: false,
            scrub: false,
        }
    }

    /// For stderr: yt-dlp quotes cookie values in its warnings, and this is the one place every
    /// line passes through before it is kept, shown, copied or logged.
    fn scrubbing(mut self) -> Self {
        self.scrub = true;
        self
    }

    fn line(&self, bytes: &[u8]) -> String {
        let line = to_line(bytes);
        if self.scrub {
            crate::text::scrub_secrets(&line)
        } else {
            line
        }
    }

    fn append(&mut self, bytes: &[u8]) {
        if self.overflowed {
            return;
        }
        if self.pending.len() + bytes.len() > self.max {
            self.overflowed = true;
            self.pending = Vec::new();
        } else {
            self.pending.extend_from_slice(bytes);
        }
    }

    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        // Only the new chunk is searched for a newline: looking through `pending` again for every
        // chunk of a very long line would take quadratic time.
        let Some(last_newline) = chunk.iter().rposition(|&b| b == b'\n') else {
            self.append(chunk);
            return Vec::new();
        };
        self.append(&chunk[..last_newline]);
        if self.overflowed {
            return Vec::new();
        }
        let complete = std::mem::take(&mut self.pending);
        self.append(&chunk[last_newline + 1..]);
        complete
            .split(|&b| b == b'\n')
            .map(|bytes| self.line(bytes))
            .collect()
    }

    /// The last line when the output did not end with `\n`.
    fn finish(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.pending);
        (!rest.is_empty()).then(|| self.line(&rest))
    }
}

/// Drops the `\r` of a `\r\n` and replaces invalid UTF-8 with `�` instead of failing.
fn to_line(bytes: &[u8]) -> String {
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

fn exit_result(code: Option<i32>, cancelled: bool, stderr: &str) -> Result<(), AppError> {
    match code {
        // Exit 0 wins over a late cancel: the work did finish.
        Some(0) => Ok(()),
        _ if cancelled => Err(AppError::Cancelled("cancelled by the user".into())),
        // Classifying stderr into the other categories is done by classify.rs.
        _ if !stderr.trim().is_empty() => Err(AppError::Unknown(stderr.trim().into())),
        Some(code) => Err(AppError::Unknown(format!("exited with code {code}"))),
        None => Err(AppError::Unknown("terminated by a signal".into())),
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    /// The full-path `taskkill` really kills a whole tree: a `cmd` with a `ping` under
    /// it, like yt-dlp's loader with the real yt-dlp under it. Only the processes started here.
    #[cfg(windows)]
    #[test]
    fn taskkill_by_full_path_kills_the_whole_tree() {
        let path = taskkill_path();
        assert!(std::path::Path::new(&path).is_absolute(), "{path}");
        let mut tree = std::process::Command::new("cmd")
            .args(["/C", "ping -n 60 127.0.0.1 > nul"])
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let killed = std::process::Command::new(path)
            .args(["/PID", &tree.id().to_string(), "/T", "/F"])
            .output()
            .unwrap();
        assert!(killed.status.success(), "{killed:?}");
        let started = Instant::now();
        while tree.try_wait().unwrap().is_none() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "cmd still alive"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn deadline_fires_after_the_limit() {
        let (fired, rx) = mpsc::channel();
        let start = Instant::now();
        let _deadline = after(Duration::from_millis(50), move || fired.send(()).unwrap());
        rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(start.elapsed() >= Duration::from_millis(50));
    }

    #[test]
    fn dropping_the_deadline_disarms_it() {
        let (fired, rx) = mpsc::channel::<()>();
        drop(after(Duration::from_millis(50), move || {
            fired.send(()).unwrap()
        }));
        // The closure (and its sender) is dropped without running: the channel just closes.
        assert_eq!(
            rx.recv_timeout(Duration::from_millis(500)),
            Err(mpsc::RecvTimeoutError::Disconnected)
        );
    }

    #[test]
    fn splits_lines_across_chunks() {
        let mut s = LineSplitter::new(MAX_LINE_BYTES);
        assert_eq!(s.push(b"one\r"), Vec::<String>::new());
        assert_eq!(s.push(b"\ntw"), ["one"]);
        assert_eq!(s.push(b"o\n\nthree\r\nfo"), ["two", "", "three"]);
        assert_eq!(s.push(b"ur"), Vec::<String>::new());
        assert_eq!(s.finish().as_deref(), Some("four"));
        assert_eq!(s.finish(), None);
    }

    #[test]
    fn stderr_never_lets_a_cookie_value_out_not_even_in_the_last_line() {
        let warning = "WARNING: skipping cookie file entry due to invalid length 1: 'this is broken TOPSECRETVALUE'";
        let mut s = LineSplitter::new(MAX_LINE_BYTES).scrubbing();
        // A line split across two chunks, then the last one without a newline (a killed process).
        assert!(s.push(&warning.as_bytes()[..40]).is_empty());
        let lines = s.push(format!("{}\n{warning}", &warning[40..]).as_bytes());
        let last = s.finish();
        for line in lines.iter().chain(last.iter()) {
            assert!(!line.contains("SECRET"), "{line}");
            assert!(line.contains("<removed>"), "{line}");
        }
        assert_eq!((lines.len(), last.is_some()), (1, true));
        // Only stderr is cleaned: stdout (the JSON of a video) is left as it is.
        let mut out = LineSplitter::new(MAX_LINE_BYTES);
        assert_eq!(out.push(format!("{warning}\n").as_bytes()), [warning]);
    }

    #[test]
    fn a_line_over_the_limit_is_dropped_and_reported_without_growing_the_memory() {
        let mut s = LineSplitter::new(100);
        assert_eq!(s.push(b"fine\n"), ["fine"]);
        // A line that never ends: kept up to the limit, then dropped for good.
        for _ in 0..50 {
            assert!(s.push(&[b'x'; 10]).is_empty());
        }
        assert!(s.overflowed);
        assert!(s.pending.is_empty(), "the long line is not kept");
        // Nothing after it is delivered either (the run is being killed).
        assert!(s.push(b"late\nlines\n").is_empty());
        assert_eq!(s.finish(), None);
        // A line exactly at the limit is fine.
        let mut s = LineSplitter::new(100);
        assert_eq!(s.push(&[b'y'; 100]).len(), 0);
        assert!(!s.overflowed);
        assert_eq!(s.push(b"\n").len(), 1);
    }

    #[test]
    fn a_huge_single_line_in_small_chunks_takes_linear_time() {
        // The size of a big JSON, in the 64 KB chunks pipes deliver. The old splitter searched the
        // whole pending buffer for a newline on every chunk: time that grew with the square of the line.
        let mut s = LineSplitter::new(MAX_LINE_BYTES);
        let chunk = vec![b'a'; 64 * 1024];
        let started = Instant::now();
        for _ in 0..(40 * 1024 * 1024 / chunk.len()) {
            assert!(s.push(&chunk).is_empty());
        }
        let lines = s.push(b"\n");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].len(), 40 * 1024 * 1024);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn invalid_utf8_is_replaced_even_when_split() {
        let mut s = LineSplitter::new(MAX_LINE_BYTES);
        // "ñ" is 0xC3 0xB1: split across chunks it must still decode; 0xFF is never valid.
        assert_eq!(s.push(b"a\xC3"), Vec::<String>::new());
        assert_eq!(s.push(b"\xB1 \xFF\n"), ["añ \u{FFFD}"]);
    }

    #[test]
    fn exit_code_becomes_result() {
        assert_eq!(exit_result(Some(0), false, "WARNING: x"), Ok(()));
        assert_eq!(exit_result(Some(0), true, ""), Ok(()));
        assert_eq!(
            exit_result(Some(1), false, "WARNING: x\nERROR: boom\n"),
            Err(AppError::Unknown("WARNING: x\nERROR: boom".into()))
        );
        assert_eq!(
            exit_result(Some(2), false, ""),
            Err(AppError::Unknown("exited with code 2".into()))
        );
        assert!(matches!(
            exit_result(Some(1), true, "ERROR: killed"),
            Err(AppError::Cancelled(_))
        ));
        assert!(matches!(
            exit_result(None, false, ""),
            Err(AppError::Unknown(_))
        ));
    }
}
