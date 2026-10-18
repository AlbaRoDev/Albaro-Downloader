// Stand-in for the Rust side in `pnpm dev` (a plain browser, no Tauri). main.tsx installs it
// only in development and only outside Tauri, so it never reaches a production build.
//
// `QueueSimulator` copies the queue in src-tauri/src/queue.rs: same states and allowed
// changes, same error messages, the concurrency limit (FIFO), network retries and the same
// event order. Progress goes through the same 100 ms throttle as Rust. All data is made up.
//
// Scenarios, picked by text in the URL:
// - (default)  works. Video: two files from 0 to 100 % (video, then audio), then ~1.5 s of
//              "merging" with no events. Audio: one file.
// - "fail"     fails with `unavailable`, no progress.
// - "offline"  fails with `network` every time: retried 5 times (waits of 300 ms × attempt,
//              not the real 2^n s), then `failed`.
// - "slow"     5 times slower, to have time to pause or cancel. Combines with the others.
// - "playlist" `fetch_metadata` fails with `playlist` like the real one, and `fetch_playlist`
//              lists 24 made-up entries ("big": 300, "huge": 2000, "empty": none; combines with "fail").
// - "h264only" `fetch_metadata` offers only H.264 + AAC, like Reddit (no webm possible).
// - "audioonly" `fetch_metadata` offers only audio, like SoundCloud.
// - "noheight" `fetch_metadata` offers video without heights (the limit selector is off).
// - "live"     `fetch_metadata` says it is a live stream (the download button is off).
// - "nosubs"   `fetch_metadata` lists no subtitle languages (every other video has English by
//              hand and Spanish, Japanese and a made-up "en-orig" automatic).
// - "nopath"   the download finishes but yt-dlp "never printed" its file: "Open folder" fails.
// - "nofolder" `enqueue_download` fails with `folderUnavailable`, as if the folder were gone.
// - "nospace"  fails with `noSpace` (with a technical message) while the download is in the
//              first mock folder, as if that disk were full: "Pick another folder and retry"
//              moves it to the other one, where it works.
// - "login"    fails with `loginRequired` (analysis and download) until a browser is chosen for
//              the cookies in the settings, as the real site would let a signed-in browser in.
// - "badcookies" with cookies chosen (a browser or a file), fails with `cookiesUnavailable`: they
//              cannot be read. `pick_cookies_file` plays the native picker like `pick_output_dir`: a
//              file, "the user cancelled" (nothing changes), another file, in turn.
// A finished download has a made-up file path (the mock never opens anything). The title and
// thumbnail come from `enqueue_download`'s `info`, as given (Rust keeps only an http(s)
// thumbnail; the mock's own is a data: URI so it can be seen without a network).
// `fetch_metadata` returns made-up metadata with an SVG thumbnail as a data: URI.
// The output folder and file name live in memory. `pick_output_dir` plays the native
// picker without opening one: it cycles through "another folder", "the first one again" and
// "the user cancelled" (nothing changes). Each download keeps the folder and name it was queued
// with, as in Rust, and its made-up final path says so.

import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type {
  AppError,
  Batch,
  Browser,
  Download,
  DownloadInfo,
  DownloadRequest,
  DownloadSettings,
  DownloadState,
  Enqueued,
  History,
  Metadata,
  NameTemplate,
  NewDownload,
  OutputSettings,
  Playlist,
  Progress,
} from "./ipc";
import { BROWSERS } from "./ipc";

const START_MS = 300; // the "yt-dlp startup" before the first line
const TICK_MS = 25; // one raw progress line every 25 ms: 40 per second, like yt-dlp
const VIDEO_TICKS = 160; // 4 s for the video file
const AUDIO_TICKS = 40; // 1 s for the audio file
const MERGE_MS = 1500;
const KILL_MS = 100; // the state changes when the "process" has exited, as in Rust
const PROGRESS_INTERVAL_MS = 100; // queue.rs: at most 10 progress events per second
const MAX_RETRIES = 5;
const RETRY_STEP_MS = 300;
const DEFAULT_MAX_CONCURRENT = 3;
const HISTORY_LIMIT = 200;
// The made-up folders the picker alternates between (not real: the mock opens nothing). The second
// has accents and a long name, to see how the folder button copes.
export const MOCK_FOLDERS = [
  "C:\\Mock\\Descargas\\AlbaRo Downloader",
  "D:\\Vídeos ñ\\Una carpeta con un nombre de lo más largo y descriptivo",
];
// The made-up cookies files the picker alternates between (not real: the mock opens nothing).
const MOCK_COOKIE_FILES = [
  "C:\\Mock\\Cookies\\cookies.txt",
  "D:\\Exportado del navegador ñ\\cookies-youtube-con-un-nombre-muy-largo.txt",
];
// The error codes another folder can fix (queue::movable_code).
const MOVABLE = ["noSpace", "folderUnavailable"];
// queue::retry narrows `allowed` to the one step of a manual retry.
const RETRY_RULE = (from: DownloadState, to: DownloadState) =>
  from === "failed" && allowed(from, to);
const NAME_TEMPLATES: NameTemplate[] = ["title", "titleId", "channelTitle"];

// queue::allowed.
const ALLOWED: Record<DownloadState, DownloadState[]> = {
  pending: ["active", "paused", "cancelled"],
  active: ["finished", "failed", "paused", "cancelled"],
  paused: ["pending", "cancelled"],
  failed: ["pending"],
  finished: [],
  cancelled: [],
};

export function allowed(from: DownloadState, to: DownloadState): boolean {
  return ALLOWED[from].includes(to);
}

const error = (code: AppError["code"], message: string): AppError => ({
  code,
  message,
});

// The request as Rust stores it: fields in declaration order, missing options as null. Two
// requests are the same download if this text is the same (db.rs, insert_download).
function normalize(r: DownloadRequest): DownloadRequest {
  const mode =
    r.mode.kind === "video"
      ? {
          kind: r.mode.kind,
          maxHeight: r.mode.maxHeight ?? null,
          container: r.mode.container ?? null,
        }
      : {
          kind: r.mode.kind,
          format: r.mode.format,
          bitrateKbps: r.mode.bitrateKbps ?? null,
        };
  return {
    url: r.url,
    mode,
    ...(r.playlist && { playlist: r.playlist }),
    ...(r.folder && { folder: r.folder }),
  };
}

// ytdlp::check_url.
function checkUrl(url: string) {
  if (!url.startsWith("https://") && !url.startsWith("http://")) {
    throw error(
      "invalidUrl",
      `only http:// and https:// URLs are accepted: ${url}`,
    );
  }
}

// A bad argument never reaches a Rust command: Tauri rejects it with a plain string, not an
// `AppError` (seen in the app: "invalid args `max` for command `set_max_concurrent`: invalid
// value: integer `-1`, expected u32"). `max` is a u32, ids are i64.
function int(cmd: string, args: Record<string, unknown>, key: string): number {
  const value = args[key];
  const type = key === "max" ? "u32" : "i64";
  if (Number.isSafeInteger(value) && (type === "i64" || (value as number) >= 0))
    return value as number;
  throw `invalid args \`${key}\` for command \`${cmd}\`: invalid value: ${JSON.stringify(value)}, expected ${type}`;
}

interface Run {
  timer?: ReturnType<typeof setTimeout>;
  stop: "pause" | "cancel" | null;
  lastSent?: number;
  held: Progress | null; // the newest update held back by the throttle
}

type Emit = (event: string, payload: unknown) => void;

// A row as the simulator keeps it: what Rust stores but never sends is on the side.
interface Row extends Download {
  outputPath: string | null;
  dismissed: boolean;
  // The folder and name it was queued with.
  outDir: string;
  nameTemplate: NameTemplate;
}

// queue::can_dismiss.
const canDismiss = (state: DownloadState) =>
  state === "finished" || state === "failed" || state === "cancelled";

export class QueueSimulator {
  private rows = new Map<number, Row>();
  private runs = new Map<number, Run>();
  // Network retries: attempts used and, while waiting, the timer that ends the wait.
  private retries = new Map<
    number,
    { attempts: number; wait?: ReturnType<typeof setTimeout> }
  >();
  private nextId = 1;
  private nextBatch = 1;
  private max = DEFAULT_MAX_CONCURRENT;
  private outputDir = MOCK_FOLDERS[0];
  private nameTemplate: NameTemplate = "titleId";
  private picks = 0;
  // The limits and the cookies browser, in memory like the rest.
  private limitRateKbps: number | null = null;
  private cookiesBrowser: Browser | null = null;
  private cookiesFile: string | null = null;
  private notifications = true;
  // The language the page last reported; Rust writes the notification and the tray menu
  // in it. Only for tests: the mock shows neither.
  uiLanguage: string | null = null;
  private cookiePicks = 0;

  constructor(private readonly emit: Emit) {}

  // The last progress the taskbar icon was told to show (`setTaskbarProgress`), as Tauri's
  // window command received it. Only for tests: there is no taskbar in a browser.
  taskbar: unknown = null;

  // The final file of a finished download, which the real backend never sends to the frontend.
  // Only for tests: it shows which folder and name the download was queued with.
  finalPath(id: number): string | null {
    return this.rows.get(id)?.outputPath ?? null;
  }

  // Same names and arguments as the Rust commands. Throws an `AppError` like a command that
  // returns `Err`.
  invoke(cmd: string, args: Record<string, unknown> = {}): unknown {
    switch (cmd) {
      case "enqueue_download":
        return this.enqueue(
          args.request as DownloadRequest,
          args.info as DownloadInfo | null | undefined,
        );
      case "enqueue_downloads":
        return this.enqueueMany(
          args.items as NewDownload[],
          args.batchTitle as string | null | undefined,
        );
      case "cancel_download":
        return this.stop(int(cmd, args, "id"), "cancel");
      case "pause_download":
        return this.stop(int(cmd, args, "id"), "pause");
      case "resume_download":
        return this.resume(int(cmd, args, "id"), allowed);
      case "retry_download":
        // queue::retry: only `failed → pending`, with the retry count forgotten.
        return this.resume(int(cmd, args, "id"), RETRY_RULE);
      case "list_downloads":
        return [...this.rows.values()]
          .filter((d) => !d.dismissed)
          .map((row) => this.visible(row));
      case "list_history":
        return this.history(args.search, args.state, args.kind);
      case "dismiss_download":
        return this.dismiss(int(cmd, args, "id"));
      case "clear_history":
        return this.clearHistory();
      case "dismiss_ended_downloads":
        return this.dismissEnded();
      case "reveal_download":
        return this.reveal(int(cmd, args, "id"));
      case "set_max_concurrent":
        return this.setMax(int(cmd, args, "max"));
      case "get_download_settings":
        return {
          maxConcurrent: this.max,
          limitRateKbps: this.limitRateKbps,
          cookiesBrowser: this.cookiesBrowser,
          cookiesFile: this.cookiesFile,
          notifications: this.notifications,
        };
      case "set_notifications":
        return this.setNotifications(args.on);
      // App updates: the simulator never has one.
      case "get_app_update":
        return null;
      case "set_ui_language":
        return this.setUiLanguage(args.language);
      case "set_limit_rate":
        return this.setLimitRate(args.kbps);
      case "set_cookies_browser":
        return this.setCookiesBrowser(args.browser);
      case "pick_cookies_file":
        return this.pickCookiesFile();
      case "get_output_settings":
        return this.output();
      case "set_name_template":
        return this.setNameTemplate(args.template);
      case "pick_output_dir":
        return this.pickOutputDir();
      case "retry_in_other_folder":
        return this.retryInOtherFolder(int(cmd, args, "id"));
      case "fetch_metadata":
        return this.metadata(args.url as string);
      case "fetch_playlist":
        return this.playlist(args.url as string);
      // The window plugin's command behind `setProgressBar`.
      case "plugin:window|set_progress_bar":
        this.taskbar = args.value;
        return null;
      // No plugin in a browser: the page's own clipboard (Chrome asks once for permission).
      case "plugin:clipboard-manager|read_text":
        return navigator.clipboard.readText();
      case "plugin:clipboard-manager|write_text":
        return navigator.clipboard.writeText(args.text as string);
      default:
        throw `command ${cmd} not found`;
    }
  }

  // db::clear_history: every ended download is deleted for good (hidden or not).
  private clearHistory(): number {
    let deleted = 0;
    for (const [id, row] of [...this.rows]) {
      if (canDismiss(row.state)) {
        this.rows.delete(id);
        deleted++;
      }
    }
    return deleted;
  }

  // queue::dismiss_ended: every download that has ended is hidden at once, and it says how many.
  private dismissEnded(): number {
    let hidden = 0;
    for (const row of this.rows.values()) {
      if (!row.dismissed && canDismiss(row.state)) {
        row.dismissed = true;
        hidden++;
      }
    }
    return hidden;
  }

  // queue::dismiss: only a download that has ended; the row stays, hidden.
  private dismiss(id: number): null {
    const row = this.rows.get(id);
    if (!row) throw error("unknown", `no download with id ${id}`);
    if (!canDismiss(row.state)) {
      throw error(
        "unknown",
        `download ${id} is ${row.state} and cannot be removed from the list yet`,
      );
    }
    row.dismissed = true;
    return null;
  }

  // queue::reveal_target, without the file system: a finished download with a path "opens".
  private reveal(id: number): null {
    const row = this.rows.get(id);
    if (!row) throw error("unknown", `no download with id ${id}`);
    if (row.state !== "finished") {
      throw error(
        "unknown",
        `download ${id} is ${row.state}, not finished: there is no file to show`,
      );
    }
    if (!row.outputPath) {
      throw error("unavailable", `download ${id} has no recorded file`);
    }
    return null;
  }

  private output(): OutputSettings {
    return {
      outputDir: this.outputDir,
      nameTemplate: this.nameTemplate,
      folderTooDeep: false,
    };
  }

  // queue::history: every ended row, cleared from the list or not, newest first, filtered; at most
  // HISTORY_LIMIT, with `more` saying there were others.
  private history(search: unknown, state: unknown, kind: unknown): History {
    if (typeof search !== "string") {
      throw "invalid args `search` for command `list_history`: invalid type, expected a string";
    }
    const states = ["finished", "failed", "cancelled"];
    if (state != null && !states.includes(state as string)) {
      throw error("unknown", `unknown download state: ${String(state)}`);
    }
    if (kind != null && kind !== "video" && kind !== "audio") {
      throw error("unknown", `unknown kind: ${String(kind)}`);
    }
    const needle = search.trim().toLowerCase();
    const found = [...this.rows.values()]
      .filter((row) => canDismiss(row.state))
      .filter((row) => (state ? row.state === state : true))
      .filter((row) => (kind ? row.request.mode.kind === kind : true))
      .filter(
        (row) =>
          needle === "" ||
          (row.title ?? "").toLowerCase().includes(needle) ||
          row.request.url.toLowerCase().includes(needle),
      )
      .sort((a, b) => b.id - a.id);
    return {
      items: found.slice(0, HISTORY_LIMIT).map((row) => this.visible(row)),
      more: found.length > HISTORY_LIMIT,
    };
  }

  // A row without what Rust keeps to itself.
  private visible(row: Row): Download {
    const {
      outputPath: _path,
      dismissed: _hidden,
      outDir: _dir,
      nameTemplate: _name,
      ...download
    } = row;
    return structuredClone(download);
  }

  // A bad name never reaches the command: Tauri rejects it with a plain string (serde's message
  // for an enum), not an `AppError`.
  private setNameTemplate(template: unknown): null {
    if (!NAME_TEMPLATES.includes(template as NameTemplate)) {
      throw `invalid args \`template\` for command \`set_name_template\`: unknown variant \`${String(template)}\`, expected one of ${NAME_TEMPLATES.map((n) => `\`${n}\``).join(", ")}`;
    }
    this.nameTemplate = template as NameTemplate;
    return null;
  }

  // The native picker, played: another folder, the first one again, a cancellation, in turn.
  private pickOutputDir(): Promise<OutputSettings> {
    this.pick();
    return Promise.resolve(this.output());
  }

  // One turn of the picker: true if a folder was chosen (and is now the default), false if the
  // user "cancelled".
  private pick(): boolean {
    const turn = this.picks++ % 3;
    if (turn === 2) return false;
    this.outputDir = MOCK_FOLDERS[1 - turn];
    return true;
  }

  // queue::check_movable: a failed download whose error another folder can fix.
  private checkMovable(id: number): Row {
    const row = this.rows.get(id);
    if (!row) throw error("unknown", `no download with id ${id}`);
    const cannot = (why: string) =>
      error("unknown", `download ${id} cannot be moved: ${why}`);
    if (row.state !== "failed") throw cannot(`it is ${row.state}, not failed`);
    if (!row.error) throw cannot("it has no recorded error");
    if (!MOVABLE.includes(row.error.code)) {
      throw cannot(
        `it failed with ${row.error.code}, which another folder does not fix`,
      );
    }
    return row;
  }

  // commands::retry_in_other_folder: checks the download before "opening" the picker; if the
  // user picks a folder, the download moves there (the name stays) and is retried, and the folder
  // is the new default. Cancelling changes nothing.
  private retryInOtherFolder(id: number): Promise<OutputSettings> {
    const row = this.checkMovable(id);
    if (this.pick()) {
      row.outDir = this.outputDir;
      this.transition(id, "pending", null, RETRY_RULE);
      this.forget(id);
      this.state(id);
      this.pump();
    }
    return Promise.resolve(this.output());
  }

  private enqueue(
    request: DownloadRequest,
    info?: DownloadInfo | null,
    batch: Batch | null = null,
  ): number {
    // Rust checks the folder before anything else (queue::add).
    if (request.url.includes("nofolder")) {
      throw error(
        "folderUnavailable",
        `${this.outputDir}: Access is denied. (os error 5)`,
      );
    }
    checkUrl(request.url);
    const normal = normalize(request);
    const key = JSON.stringify(normal);
    for (const d of this.rows.values()) {
      const live = ["pending", "active", "paused"].includes(d.state);
      if (live && JSON.stringify(d.request) === key) {
        throw error(
          "alreadyQueued",
          `${request.url} is already in the queue (id ${d.id})`,
        );
      }
    }
    const id = this.nextId++;
    const now = Date.now();
    this.rows.set(id, {
      id,
      request: normal,
      title: info?.title?.trim() || null,
      thumbnail: info?.thumbnail ?? null,
      state: "pending",
      error: null,
      createdAt: now,
      updatedAt: now,
      batch,
      outputPath: null,
      dismissed: false,
      outDir: this.outputDir,
      nameTemplate: this.nameTemplate,
    });
    this.state(id);
    this.pump();
    return id;
  }

  // queue::add_many: already-queued ones are skipped, any other error stops the batch (what was
  // queued stays).
  private enqueueMany(
    items: NewDownload[],
    batchTitle?: string | null,
  ): Enqueued {
    let queued = 0;
    let skipped = 0;
    // The entries of one playlist share a batch, which the list shows as a group.
    const batch = {
      id: this.nextBatch++,
      title: batchTitle?.trim() || null,
    };
    for (const { request, info } of items) {
      try {
        this.enqueue(request, info, batch);
        queued++;
      } catch (e) {
        if ((e as AppError).code !== "alreadyQueued") throw e;
        skipped++;
      }
    }
    return { queued, skipped };
  }

  private resume(
    id: number,
    rule: (from: DownloadState, to: DownloadState) => boolean,
  ): null {
    this.transition(id, "pending", null, rule);
    this.forget(id);
    this.state(id);
    this.pump();
    return null;
  }

  // queue::stop. With a "process", the reason is noted and the state changes once it has
  // exited; a second stop before that only changes the reason.
  private stop(id: number, stop: "pause" | "cancel"): null {
    const run = this.runs.get(id);
    if (run) {
      if (run.stop === null) {
        clearTimeout(run.timer);
        run.timer = setTimeout(
          () => this.exit(id, error("cancelled", "cancelled by the user")),
          KILL_MS,
        );
      }
      run.stop = stop;
      return null;
    }
    this.transition(id, stop === "pause" ? "paused" : "cancelled", null);
    this.forget(id);
    this.state(id);
    return null;
  }

  private setMax(max: number): null {
    if (max === 0) {
      throw error("unknown", "at least one download must be allowed at a time");
    }
    // queue::MAX_CONCURRENT_LIMIT.
    if (max > 32) {
      throw error("unknown", "at most 32 downloads can run at a time");
    }
    this.max = max;
    this.pump();
    return null;
  }

  // settings::set_limit_rate_kbps: null removes it, 0 is refused; a non-number never reaches the
  // command (Tauri's own text for a bad argument).
  private setLimitRate(kbps: unknown): null {
    if (
      kbps !== null &&
      !(Number.isSafeInteger(kbps) && (kbps as number) >= 0)
    ) {
      throw `invalid args \`kbps\` for command \`set_limit_rate\`: invalid type: ${JSON.stringify(kbps)}, expected u32`;
    }
    if (kbps === 0) {
      throw error("unknown", "the speed limit must be at least 1 KB/s");
    }
    this.limitRateKbps = kbps as number | null;
    return null;
  }

  // A non-boolean never reaches the command (Tauri's own text for a bad argument).
  private setNotifications(on: unknown): null {
    if (typeof on !== "boolean") {
      throw `invalid args \`on\` for command \`set_notifications\`: invalid type: ${JSON.stringify(on)}, expected a boolean`;
    }
    this.notifications = on;
    return null;
  }

  // commands::set_ui_language: only `es` and `en`.
  private setUiLanguage(language: unknown): null {
    if (language !== "es" && language !== "en") {
      throw error("unknown", `unknown language: ${String(language)}`);
    }
    this.uiLanguage = language;
    return null;
  }

  private setCookiesBrowser(browser: unknown): null {
    if (browser !== null && !BROWSERS.includes(browser as Browser)) {
      throw `invalid args \`browser\` for command \`set_cookies_browser\`: unknown variant \`${String(browser)}\`, expected one of ${BROWSERS.map((b) => `\`${b}\``).join(", ")}`;
    }
    this.cookiesBrowser = browser as Browser | null;
    // One source at a time: a browser, or none, drops the file (settings::set_cookies_browser).
    this.cookiesFile = null;
    return null;
  }

  // The native file picker, played: a file, a cancellation, another file, in turn. A file replaces
  // the browser (settings::set_cookies_file).
  private pickCookiesFile(): Promise<DownloadSettings> {
    const turn = this.cookiePicks++ % 3;
    if (turn !== 1) {
      this.cookiesFile = MOCK_COOKIE_FILES[turn === 0 ? 0 : 1];
      this.cookiesBrowser = null;
    }
    return Promise.resolve({
      maxConcurrent: this.max,
      limitRateKbps: this.limitRateKbps,
      cookiesBrowser: this.cookiesBrowser,
      cookiesFile: this.cookiesFile,
      notifications: this.notifications,
    });
  }

  // What `scenario` needs to know: whether any cookies are set, and a name for the error.
  private cookies(): string | null {
    return this.cookiesBrowser ?? (this.cookiesFile ? "file" : null);
  }

  private metadata(url: string): Promise<Metadata> {
    const { slow, failure } = scenario(url, undefined, this.cookies());
    return new Promise((resolve, reject) => {
      checkUrl(url);
      setTimeout(() => {
        if (url.includes("playlist")) {
          reject(
            error(
              "playlist",
              "this URL is a playlist or channel, not one video",
            ),
          );
        } else if (failure) {
          reject(failure);
        } else {
          resolve(fakeMetadata(url));
        }
      }, 500 * slow);
    });
  }

  // playlist::fetch. Any `fail`/`offline`/... in the URL makes the listing fail.
  private playlist(url: string): Promise<Playlist> {
    const { slow, failure } = scenario(url, undefined, this.cookies());
    return new Promise((resolve, reject) => {
      checkUrl(url);
      setTimeout(() => {
        if (failure) reject(failure);
        else resolve(fakePlaylist(url));
      }, 800 * slow);
    });
  }

  // db.rs, transition: the same checks and messages.
  private transition(
    id: number,
    to: DownloadState,
    err: AppError | null,
    rule = allowed,
  ) {
    const row = this.rows.get(id);
    if (!row) throw error("unknown", `no download with id ${id}`);
    if (!rule(row.state, to)) {
      throw error(
        "unknown",
        `download ${id} cannot go from ${row.state} to ${to}`,
      );
    }
    row.state = to;
    row.error = err;
    row.updatedAt = Date.now();
  }

  private state(id: number) {
    const { state, error } = this.rows.get(id) as Download;
    this.emit("download-state", { id, state, error });
  }

  private forget(id: number) {
    clearTimeout(this.retries.get(id)?.wait);
    this.retries.delete(id);
  }

  // queue::pump: starts the oldest pending downloads while there are free slots, skipping
  // those waiting for a network retry.
  private pump() {
    for (;;) {
      const all = [...this.rows.values()];
      if (all.filter((d) => d.state === "active").length >= this.max) return;
      const next = all.find(
        (d) => d.state === "pending" && !this.retries.get(d.id)?.wait,
      );
      if (!next) return;
      this.transition(next.id, "active", next.error);
      this.start(next);
    }
  }

  private start({ id, request }: Download) {
    const run: Run = { stop: null, held: null };
    this.runs.set(id, run);
    // Like Rust: the row keeps a waiting retry's error, the `active` event does not carry it.
    this.emit("download-state", { id, state: "active", error: null });
    const outDir = this.rows.get(id)?.outDir;
    const { slow, failure } = scenario(request.url, outDir, this.cookies());
    if (failure) {
      run.timer = setTimeout(() => this.exit(id, failure), START_MS * slow);
      return;
    }
    const files =
      request.mode.kind === "video"
        ? [
            { name: `Mock video ${id}.fvideo.mp4`, ticks: VIDEO_TICKS },
            { name: `Mock video ${id}.faudio.webm`, ticks: AUDIO_TICKS },
          ]
        : [{ name: `Mock audio ${id}.faudio.webm`, ticks: AUDIO_TICKS }];
    let file = 0;
    let tick = 0;
    const step = () => {
      tick++;
      const { name, ticks } = files[file];
      this.progress(id, run, fakeProgress(name, tick, ticks, TICK_MS * slow));
      if (tick < ticks) {
        run.timer = setTimeout(step, TICK_MS * slow);
      } else if (++file < files.length) {
        tick = 0;
        run.timer = setTimeout(step, TICK_MS * slow);
      } else {
        // A video still has to be merged: no progress meanwhile.
        const merge = request.mode.kind === "video" ? MERGE_MS * slow : 0;
        run.timer = setTimeout(() => this.exit(id, null), merge);
      }
    };
    run.timer = setTimeout(step, START_MS * slow);
  }

  // queue::Throttle: the first update, every `finished`/`error`, and otherwise one per 100 ms.
  private progress(id: number, run: Run, progress: Progress) {
    const now = Date.now();
    const due =
      run.lastSent === undefined || now - run.lastSent >= PROGRESS_INTERVAL_MS;
    if (due || progress.status !== "downloading") {
      run.lastSent = now;
      run.held = null;
      this.emit("download-progress", { id, progress });
    } else {
      run.held = progress;
    }
  }

  // queue::finish: the "process" exited with `failure` (null: success).
  private exit(id: number, failure: AppError | null) {
    const run = this.runs.get(id);
    if (!run) return;
    this.runs.delete(id);
    if (run.held) this.emit("download-progress", { id, progress: run.held });
    if (!failure) {
      this.forget(id);
      this.transition(id, "finished", null);
      const row = this.rows.get(id) as Row;
      const { url, mode, folder } = row.request;
      const name = fakeFileName(row.nameTemplate, `Mock ${mode.kind} ${id}`);
      const ext = mode.kind === "video" ? "mp4" : "opus";
      row.outputPath = url.includes("nopath")
        ? null
        : `${row.outDir}\\${folder ? `${folder}\\` : ""}${name}.${ext}`;
      this.state(id);
      this.emit("download-finished", { id });
    } else if (failure.code === "cancelled") {
      this.forget(id);
      this.transition(id, run.stop === "pause" ? "paused" : "cancelled", null);
      this.state(id);
    } else {
      this.fail(id, failure);
    }
    this.pump();
  }

  // queue::fail_or_retry: a network error with retries left waits in `pending` (through
  // `failed`, both allowed steps) with the error stored; anything else is `failed`.
  private fail(id: number, failure: AppError) {
    const attempt = (this.retries.get(id)?.attempts ?? 0) + 1;
    this.transition(id, "failed", failure);
    if (failure.code === "network" && attempt <= MAX_RETRIES) {
      this.transition(id, "pending", failure);
      const delayMs = RETRY_STEP_MS * attempt;
      // `forget` clears this timer, so it never fires for a cancelled or paused download.
      const wait = setTimeout(() => {
        const entry = this.retries.get(id);
        if (entry) entry.wait = undefined;
        this.pump();
      }, delayMs);
      this.retries.set(id, { attempts: attempt, wait });
      this.state(id);
      this.emit("download-retrying", {
        id,
        attempt,
        maxAttempts: MAX_RETRIES,
        delayMs,
      });
      return;
    }
    this.forget(id);
    this.state(id);
    this.emit("download-failed", { id, error: failure });
  }
}

// `outDir` is the folder a download runs in: the "nospace" scenario only fails in the first one.
function scenario(
  url: string,
  outDir?: string,
  cookies: string | null = null,
): { slow: number; failure: AppError | null } {
  const slow = url.includes("slow") ? 5 : 1;
  if (url.includes("nospace") && outDir === MOCK_FOLDERS[0]) {
    return {
      slow,
      failure: error(
        "noSpace",
        `ERROR: unable to write data: [Errno 28] No space left on device: '${outDir}\\.albaro-tmp\\1\\Mock video.f401.mp4.part'`,
      ),
    };
  }
  if (url.includes("badcookies") && cookies) {
    return {
      slow,
      failure: error(
        "cookiesUnavailable",
        cookies === "file"
          ? "ERROR: 'C:\\Mock\\Cookies\\cookies.txt' does not look like a Netscape format cookies file"
          : `ERROR: Could not copy ${cookies} cookie database. See  https://github.com/yt-dlp/yt-dlp/issues/7271  for more info`,
      ),
    };
  }
  // A signed-in browser gets in: with cookies chosen, the "login" links work.
  if (url.includes("login") && !cookies) {
    return {
      slow,
      failure: error(
        "loginRequired",
        "ERROR: [mock] Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.",
      ),
    };
  }
  if (url.includes("offline")) {
    return {
      slow,
      failure: error(
        "network",
        "ERROR: [mock] Unable to download: simulated network is unreachable",
      ),
    };
  }
  if (url.includes("fail")) {
    return {
      slow,
      failure: error("unavailable", "ERROR: [mock] Simulated video removed"),
    };
  }
  return { slow, failure: null };
}

// The file name each template gives, from the made-up video's title (fetch_metadata's channel
// and id).
function fakeFileName(template: NameTemplate, title: string): string {
  switch (template) {
    case "title":
      return title;
    case "titleId":
      return `${title} [mock0001]`;
    case "channelTitle":
      return `Mock Channel - ${title}`;
  }
}

const FILE_BYTES = 20_000_000;

// Update `tick` of `ticks` for one file; the last one is its `finished`.
function fakeProgress(
  filename: string,
  tick: number,
  ticks: number,
  tickMs: number,
): Progress {
  const done = Math.round((FILE_BYTES * tick) / ticks);
  const speed = tick === 1 ? null : (FILE_BYTES / ticks / tickMs) * 1000;
  return {
    status: tick === ticks ? "finished" : "downloading",
    downloadedBytes: done,
    totalBytes: FILE_BYTES,
    speed,
    eta: speed === null ? null : (FILE_BYTES - done) / speed,
    filename,
    fragmentIndex: null,
    fragmentCount: null,
  };
}

// A made-up 16:9 picture (a play sign on a gradient) as a data: URI, so the preview card shows a
// thumbnail without a network or a real site.
const MOCK_THUMBNAIL = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="g" x2="1" y2="1"><stop offset="0" stop-color="#f4a261"/><stop offset="1" stop-color="#2a3d66"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="160" cy="90" r="34" fill="#fff" fill-opacity=".85"/><path d="M150 72v36l30-18z" fill="#2a3d66"/></svg>',
)}`;

function fakeMetadata(url: string): Metadata {
  const format = (
    formatId: string,
    ext: string,
    vcodec: string,
    acodec: string,
    height: number | null,
    tbr: number,
  ) => ({
    formatId,
    ext,
    vcodec,
    acodec,
    height,
    width: height === null ? null : Math.round((height * 16) / 9),
    fps: height === null ? null : 30,
    tbr,
    abr: height === null ? tbr : null,
    vbr: height === null ? null : tbr,
    filesize: tbr * 125 * 95,
    formatNote: height === null ? "mock audio" : `${height}p (mock)`,
    protocol: "https",
  });
  const opus = format("mock-opus", "webm", "none", "opus", null, 128);
  const aac = format("mock-aac", "m4a", "none", "mp4a.40.2", null, 128);
  const h264 = format(
    "mock-h264-1080",
    "mp4",
    "avc1.640028",
    "none",
    1080,
    4000,
  );
  const scenario = (name: string) => url.includes(name);
  let formats = [
    opus,
    aac,
    h264,
    format("mock-vp9-1440", "webm", "vp9", "none", 1440, 9000),
    format("mock-av1-2160", "mp4", "av01.0.12M.08", "none", 2160, 18000),
  ];
  if (scenario("h264only")) {
    formats = [
      aac,
      format("mock-h264-720", "mp4", "avc1.4d401f", "none", 720, 2000),
      h264,
    ];
  } else if (scenario("audioonly")) {
    formats = [opus, aac];
  } else if (scenario("noheight")) {
    formats = [aac, { ...h264, height: null, width: null }];
  }
  return {
    id: "mock0001",
    // The URL in the title tells previews apart, and a long URL makes a long title.
    title: `Mock video (fake data) for ${url}`,
    channel: "Mock Channel",
    duration: 95,
    thumbnail: MOCK_THUMBNAIL,
    webpageUrl: url,
    extractor: "mock",
    isLive: scenario("live"),
    formats,
    subtitleLanguages: scenario("nosubs")
      ? []
      : [
          { code: "en", name: "English", manual: true, auto: true },
          // A variant code the site uses for the original-language captions.
          {
            code: "en-orig",
            name: "English (original)",
            manual: false,
            auto: true,
          },
          { code: "es", name: "Spanish", manual: false, auto: true },
          { code: "ja", name: "Japanese", manual: false, auto: true },
        ],
  };
}

// 24 entries; "big" in the URL makes 300 (to see scrolling), "huge" 2000 (a whole channel), "toomany" 5000 and
// says there were more, "empty" none, "allgone" all of them
// unavailable. The 3rd has no title and no duration, the 5th is a live stream without duration, and
// the 7th and 11th are a private and a deleted video, which in a real playlist come
// with nothing but a URL.
function fakePlaylist(url: string): Playlist {
  const count = url.includes("empty")
    ? 0
    : url.includes("toomany")
      ? 5000
      : url.includes("huge")
        ? 2000
        : url.includes("big")
          ? 300
          : 24;
  const gone = url.includes("allgone");
  return {
    title: `Mock playlist (fake data) for ${url}`,
    channel: "Mock Channel",
    truncated: url.includes("toomany"),
    entries: Array.from({ length: count }, (_, i) => {
      const unavailable =
        gone || i % 24 === 6 ? "private" : i % 24 === 10 ? "deleted" : null;
      const entryUrl = `https://example.test/watch?v=mock${i + 1}`;
      if (unavailable) {
        return {
          url: entryUrl,
          title: null,
          unavailable,
          duration: null,
          thumbnail: null,
          channel: null,
        } as const;
      }
      return {
        url: entryUrl,
        title:
          i === 2
            ? null
            : `Mock entry ${i + 1}: a title long enough to need ${"more ".repeat((i % 5) * 4)}room`,
        unavailable: null,
        duration: i === 2 || i === 4 ? null : 60 + i * 37,
        thumbnail: i === 2 ? null : MOCK_THUMBNAIL,
        channel: i % 3 === 0 ? "Another Channel" : "Mock Channel",
      };
    }),
  };
}

// Mocked IPC internals, typed only as far as the fix below needs.
type Internals = {
  invoke: (cmd: string, args?: unknown, options?: unknown) => Promise<unknown>;
};

// Makes `invoke` and `listen` (and so every wrapper in ipc.ts) talk to a `QueueSimulator`.
export function installMock() {
  const simulator = new QueueSimulator((event, payload) => {
    void emit(event, payload);
  });
  // `getCurrentWindow()` (the taskbar progress) needs a window label to exist.
  mockWindows("main");
  mockIPC(
    (cmd, args) => simulator.invoke(cmd, args as Record<string, unknown>),
    {
      shouldMockEvents: true,
    },
  );
  // @tauri-apps/api 2.12: `unlisten` sends `{ event, eventId }` but the mock removes the
  // listener named by `id`, so it stays registered and every later emit warns "Couldn't find
  // callback id" (React's StrictMode unlistens on every mount). Pass the id it looks for.
  const internals = (window as unknown as { __TAURI_INTERNALS__: Internals })
    .__TAURI_INTERNALS__;
  const invoke = internals.invoke;
  internals.invoke = (cmd, args, options) =>
    invoke(
      cmd,
      cmd === "plugin:event|unlisten"
        ? { ...(args as object), id: (args as { eventId: number }).eventId }
        : args,
      options,
    );
}
