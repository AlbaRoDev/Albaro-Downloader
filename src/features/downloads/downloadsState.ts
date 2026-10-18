// The download list's state: a pure reducer over a map by id, fed by
// `list_downloads` and the queue's events. Zustand (downloadsStore.ts) wraps it. Nothing
// here reads the clock: actions carry the time they happened, so tests need no timers.
import type {
  Download,
  Progress,
  RetryingEvent,
  StateEvent,
  TaskbarProgress,
} from "@/lib/ipc";

// One row. `progress` is the latest update of the current file; the rest is what the row needs
// to tell its runs and files apart.
export interface Entry {
  download: Download;
  progress: Progress | null;
  // When `progress` arrived and when the download last became `active` (ms). An update older
  // than the last start belongs to a previous run: it is shown, frozen, until a new one comes.
  progressAt: number;
  activeAt: number;
  // The files yt-dlp has reported in this run, in order. Video + audio are two files: the bar
  // is the current file's, and the file's position is the row's "Part N".
  files: string[];
  // What each file has downloaded and its size (null if unknown or an estimate that jumps, as
  // in fragmented downloads), by file name, kept across runs: a resumed download reports the
  // same files again. Feeds the overall percentage (`downloadPercent`).
  bytes: Record<string, { done: number; total: number | null }>;
  // A network retry waiting to start, from `download-retrying`.
  retry: { attempt: number; maxAttempts: number } | null;
}

export type DownloadsState = Record<number, Entry>;

export const EMPTY: DownloadsState = {};

export type Action =
  | { type: "loaded"; downloads: Download[] }
  | { type: "state"; event: StateEvent; now: number }
  | { type: "progress"; id: number; progress: Progress; now: number }
  | { type: "retrying"; event: RetryingEvent }
  | { type: "finished"; id: number }
  | { type: "dismissed"; id: number }
  // The list was cleared: whatever has ended goes (see `hasEnded`).
  | { type: "dismissedEnded" };

// `download-state` of an id the list does not have (queued from the preview card, or by
// another window) has nothing to update: the caller reloads the list instead.
export const isKnown = (state: DownloadsState, id: number) => id in state;

const fresh = (download: Download): Entry => ({
  download,
  progress: null,
  progressAt: 0,
  activeAt: 0,
  files: [],
  bytes: {},
  retry: null,
});

// Updates one entry, or does nothing for an id the list does not have.
function update(
  state: DownloadsState,
  id: number,
  change: (entry: Entry) => Entry,
): DownloadsState {
  const entry = state[id];
  return entry ? { ...state, [id]: change(entry) } : state;
}

export function reduce(state: DownloadsState, action: Action): DownloadsState {
  switch (action.type) {
    // The list is the truth about which rows exist; what only events know (progress) stays.
    case "loaded": {
      const next: DownloadsState = {};
      for (const download of action.downloads) {
        const old = state[download.id];
        next[download.id] = old ? { ...old, download } : fresh(download);
      }
      return next;
    }
    case "state":
      return update(state, action.event.id, (entry) => {
        const { state: to, error } = action.event;
        const download = { ...entry.download, state: to, error };
        // A new run: the files are listed again from the first. The old progress stays as it
        // was (a resumed download continues from there), marked as old by `activeAt`.
        if (to === "active") {
          return {
            ...entry,
            download,
            files: [],
            activeAt: action.now,
            retry: null,
          };
        }
        // `download-retrying` comes right after this event, with the attempt number.
        return { ...entry, download, retry: null };
      });
    case "progress":
      return update(state, action.id, (entry) => {
        const { progress } = action;
        const file = progress.filename;
        const known = file === null || entry.files.includes(file);
        // A file that finished has all of its bytes, even when yt-dlp did not say how many
        // (one that was already there). Fragmented files have no trustworthy total.
        const done =
          progress.status === "finished"
            ? (progress.downloadedBytes ?? progress.totalBytes ?? 0)
            : (progress.downloadedBytes ?? 0);
        const total = progress.fragmentCount ? null : progress.totalBytes;
        return {
          ...entry,
          progress,
          progressAt: action.now,
          files: known ? entry.files : [...entry.files, file],
          bytes: { ...entry.bytes, [file ?? ""]: { done, total } },
        };
      });
    case "retrying":
      return update(state, action.event.id, (entry) => ({
        ...entry,
        retry: {
          attempt: action.event.attempt,
          maxAttempts: action.event.maxAttempts,
        },
      }));
    // `download-state` "finished" came first; this makes sure of it and drops any retry.
    case "finished":
      return update(state, action.id, (entry) => ({
        ...entry,
        download: { ...entry.download, state: "finished" },
        retry: null,
      }));
    case "dismissed": {
      const { [action.id]: _removed, ...rest } = state;
      return rest;
    }
    case "dismissedEnded":
      return Object.fromEntries(
        Object.entries(state).filter(([, entry]) => !hasEnded(entry)),
      );
  }
}

// Finished, failed or cancelled: what "Clear the list" removes (queue.rs, `can_dismiss`).
export const hasEnded = (entry: Entry) =>
  entry.download.state === "finished" ||
  entry.download.state === "failed" ||
  entry.download.state === "cancelled";

// The newest first, as the list shows them.
export function newestFirst(state: DownloadsState): Entry[] {
  return Object.values(state).sort((a, b) => b.download.id - a.download.id);
}

// How far along the current file is, 0 to 100, or null if the update says nothing. Fragmented
// downloads (HLS, DASH) use their fragments: their estimated total jumps around, while the
// fragment count only grows. yt-dlp can report one past the count (23 of 22 seen on
// SoundCloud), so it is capped. A file that already existed sends a single `finished`.
export function percentOf(progress: Progress): number | null {
  const { downloadedBytes: done, totalBytes: total, fragmentCount } = progress;
  let percent: number | null = null;
  if (progress.status === "finished") percent = 100;
  else if (fragmentCount) {
    percent = ((progress.fragmentIndex ?? 0) / fragmentCount) * 100;
  } else if (done !== null && total) percent = (done / total) * 100;
  return percent === null ? null : Math.min(100, Math.max(0, percent));
}

// The current file's number in this run (1-based): the second file of a video is "Part 2".
export function partOf(entry: Entry): number {
  const file = entry.progress?.filename;
  const index = file ? entry.files.indexOf(file) : -1;
  return index === -1 ? Math.max(1, entry.files.length) : index + 1;
}

// A file finished, the download is still running and nothing newer has come: it may be the
// merge (ffmpeg) or the start of the next file. The row decides, after a short delay, which
// text to show.
export function awaitingNext(entry: Entry): boolean {
  return (
    entry.download.state === "active" &&
    entry.progress?.status === "finished" &&
    entry.progressAt >= entry.activeAt
  );
}

// How far along ONE download is overall, 0 to 100, or null while nothing is known. Video and
// audio are two files of very different size, so the percentage of each would jump 100 → 0 →
// 100: instead, every byte of every file seen so far over every size seen so far, which only
// dips by the (small) share of the next file when it shows up. Without trustworthy sizes (a
// fragmented download, or a file that never said) it falls back to the current file's own
// percentage, from its fragments. Never above 100.
export function downloadPercent(entry: Entry): number | null {
  if (entry.progress === null) return null;
  const parts = Object.values(entry.bytes);
  const sized = parts.every((part) => part.total !== null && part.total > 0);
  if (parts.length > 0 && sized) {
    const total = parts.reduce((sum, part) => sum + (part.total ?? 0), 0);
    const done = parts.reduce((sum, part) => sum + part.done, 0);
    return Math.min(100, Math.max(0, (done / total) * 100));
  }
  return percentOf(entry.progress);
}

// The downloads running now (state `active`) and their mean percentage. Paused, queued and
// finished ones do not count, and neither does an active one that has reported nothing yet: it
// is in `active`, but there is nothing to average. `percent` is null when none has a number.
export interface GlobalProgress {
  active: number;
  percent: number | null;
}

export function globalProgress(state: DownloadsState): GlobalProgress {
  const running = Object.values(state).filter(
    (entry) => entry.download.state === "active",
  );
  const percents = running
    .map(downloadPercent)
    .filter((percent): percent is number => percent !== null);
  const percent =
    percents.length === 0
      ? null
      : percents.reduce((sum, p) => sum + p, 0) / percents.length;
  return { active: running.length, percent };
}

// What to show of `globalProgress` as a whole number: rounded down and at most 99. It is only
// shown while something is running, and a running download that has all its bytes so far is
// not done: the audio file is still to come, or the merge, and the next file would make the
// number dip from 100. null when there is no number.
export const wholePercent = (percent: number | null) =>
  percent === null ? null : Math.min(99, Math.floor(percent));

// The taskbar icon's state for `globalProgress`: nothing running → none; a number → a
// determinate bar; running but no number yet → the moving one.
export function taskbarState(global: GlobalProgress): TaskbarProgress {
  if (global.active === 0) return { status: "none" };
  const percent = wholePercent(global.percent);
  return percent === null
    ? { status: "indeterminate" }
    : { status: "normal", progress: percent };
}
