import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import {
  asAppError,
  cancelDownload,
  clearHistory,
  type DownloadRequest,
  dismissDownload,
  dismissEndedDownloads,
  enqueueDownload,
  enqueueDownloads,
  fetchMetadata,
  fetchPlaylist,
  getAppUpdate,
  getDownloadSettings,
  getOutputSettings,
  installAppUpdate,
  isBackendAvailable,
  listDownloads,
  listHistory,
  onDownloadFailed,
  onDownloadFinished,
  onDownloadProgress,
  onDownloadRetrying,
  onDownloadState,
  pauseDownload,
  pickCookiesFile,
  pickOutputDir,
  readClipboardText,
  resumeDownload,
  retryDownload,
  retryInOtherFolder,
  revealDownload,
  setCookiesBrowser,
  setLimitRate,
  setMaxConcurrent,
  setNameTemplate,
  setNotifications,
  setTaskbarProgress,
  setUiLanguage,
  writeClipboardText,
} from "./ipc";
import { installMock } from "./ipc.mock";

const request: DownloadRequest = {
  url: "https://example.test/watch?v=1",
  mode: { kind: "audio", format: "best", bitrateKbps: null },
};

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("each wrapper calls its command with the argument names Rust expects", async () => {
  const calls: unknown[] = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    return null;
  });
  await enqueueDownload(request);
  await enqueueDownload(request, { title: "A title", thumbnail: null });
  await enqueueDownloads(
    [{ request }, { request, info: { title: null, thumbnail: null } }],
    "A list",
  );
  await dismissDownload(6);
  await dismissEndedDownloads();
  await clearHistory();
  await revealDownload(7);
  await cancelDownload(1);
  await pauseDownload(2);
  await resumeDownload(3);
  await retryDownload(4);
  await listDownloads();
  await listHistory("zoo", "failed", null);
  await listHistory("", null, "audio");
  await setMaxConcurrent(5);
  await fetchMetadata("https://example.test/a");
  await fetchPlaylist("https://example.test/p");
  await readClipboardText();
  await getOutputSettings();
  await setNameTemplate("channelTitle");
  await pickOutputDir();
  await retryInOtherFolder(8);
  await getDownloadSettings();
  await setNotifications(false);
  await setLimitRate(2048);
  await setLimitRate(null);
  await setCookiesBrowser("firefox");
  await setCookiesBrowser(null);
  await pickCookiesFile();
  await writeClipboardText("unknown: boom");
  expect(calls).toEqual([
    ["enqueue_download", { request }],
    // The list's title and thumbnail go along as `info`.
    [
      "enqueue_download",
      { request, info: { title: "A title", thumbnail: null } },
    ],
    [
      "enqueue_downloads",
      {
        items: [
          { request },
          { request, info: { title: null, thumbnail: null } },
        ],
        batchTitle: "A list",
      },
    ],
    ["dismiss_download", { id: 6 }],
    ["dismiss_ended_downloads", {}],
    ["clear_history", {}],
    ["reveal_download", { id: 7 }],
    ["cancel_download", { id: 1 }],
    ["pause_download", { id: 2 }],
    ["resume_download", { id: 3 }],
    ["retry_download", { id: 4 }],
    ["list_downloads", {}],
    ["list_history", { search: "zoo", state: "failed", kind: null }],
    ["list_history", { search: "", state: null, kind: "audio" }],
    ["set_max_concurrent", { max: 5 }],
    ["fetch_metadata", { url: "https://example.test/a" }],
    ["fetch_playlist", { url: "https://example.test/p" }],
    ["plugin:clipboard-manager|read_text", {}],
    ["get_output_settings", {}],
    ["set_name_template", { template: "channelTitle" }],
    ["pick_output_dir", {}],
    ["retry_in_other_folder", { id: 8 }],
    ["get_download_settings", {}],
    ["set_notifications", { on: false }],
    ["set_limit_rate", { kbps: 2048 }],
    ["set_limit_rate", { kbps: null }],
    ["set_cookies_browser", { browser: "firefox" }],
    ["set_cookies_browser", { browser: null }],
    ["pick_cookies_file", {}],
    ["plugin:clipboard-manager|write_text", { text: "unknown: boom" }],
  ]);
});

it("a refused folder reaches the caller as an AppError with its own code", async () => {
  const refused = { code: "folderUnavailable", message: "/x: denied" };
  mockIPC(() => Promise.reject(refused));
  await expect(pickOutputDir().catch(asAppError)).resolves.toEqual(refused);
  // Tauri's own refusal of a bad name is a plain string: `unknown`, text kept.
  expect(asAppError("invalid args `template`")).toEqual({
    code: "unknown",
    message: "invalid args `template`",
  });
});

it("each listener receives its event's payload", async () => {
  mockIPC(() => null, { shouldMockEvents: true });
  const listeners = [
    ["download-progress", onDownloadProgress],
    ["download-state", onDownloadState],
    ["download-finished", onDownloadFinished],
    ["download-failed", onDownloadFailed],
    ["download-retrying", onDownloadRetrying],
  ] as const;
  for (const [event, on] of listeners) {
    const cb = vi.fn();
    await on(cb);
    await emit(event, { id: 7, event });
    expect(cb).toHaveBeenCalledExactlyOnceWith({ id: 7, event });
  }
});

it("asAppError keeps an AppError and turns anything else into unknown", () => {
  const network = { code: "network", message: "timed out" };
  expect(asAppError(network)).toEqual(network);
  // Tauri rejects a bad argument with a plain string.
  expect(asAppError("invalid args `max`")).toEqual({
    code: "unknown",
    message: "invalid args `max`",
  });
  expect(asAppError({ code: "made-up", message: "x" }).code).toBe("unknown");
  expect(asAppError({ code: "network" }).code).toBe("unknown");
  expect(asAppError(undefined)).toEqual({
    code: "unknown",
    message: "undefined",
  });
  expect(asAppError(null).code).toBe("unknown");
  expect(asAppError(new Error("boom")).code).toBe("unknown");
});

it("a backend is available only once invoke is mocked (or in Tauri)", () => {
  expect(isBackendAvailable()).toBe(false);
  mockIPC(() => null);
  expect(isBackendAvailable()).toBe(true);
});

it("installMock serves the wrappers, and an unlistened handler gets nothing", async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, "warn");
  installMock();
  const removed = vi.fn();
  const unlisten = await onDownloadState(removed);
  await unlisten();
  const states = vi.fn();
  await onDownloadState(states);

  const id = await enqueueDownload(request);
  await expect(enqueueDownload(request)).rejects.toEqual({
    code: "alreadyQueued",
    message: `${request.url} is already in the queue (id ${id})`,
  });
  expect(states.mock.calls.map(([e]) => e.state)).toEqual([
    "pending",
    "active",
  ]);
  expect((await listDownloads())[0]).toMatchObject({ id, state: "active" });
  expect(removed).not.toHaveBeenCalled();
  // The mocks' own bug (see installMock) shows up as this warning.
  expect(warn).not.toHaveBeenCalled();
});

describe("setTaskbarProgress", () => {
  it("sends the three states of the window plugin's progress bar", async () => {
    const calls: unknown[] = [];
    mockWindows("main");
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return null;
    });
    await setTaskbarProgress({ status: "normal", progress: 40 });
    await setTaskbarProgress({ status: "indeterminate" });
    await setTaskbarProgress({ status: "none" });
    expect(calls).toEqual([
      [
        "plugin:window|set_progress_bar",
        { label: "main", value: { status: "normal", progress: 40 } },
      ],
      [
        "plugin:window|set_progress_bar",
        { label: "main", value: { status: "indeterminate" } },
      ],
      [
        "plugin:window|set_progress_bar",
        { label: "main", value: { status: "none" } },
      ],
    ]);
  });

  it("does nothing without a backend", async () => {
    await expect(
      setTaskbarProgress({ status: "none" }),
    ).resolves.toBeUndefined();
  });

  it("rejects when the backend refuses (a missing permission)", async () => {
    mockWindows("main");
    mockIPC(() => Promise.reject("not allowed"));
    await expect(setTaskbarProgress({ status: "none" })).rejects.toBe(
      "not allowed",
    );
  });
});

describe("app update", () => {
  it("asks Rust for the pending update and for the installation", async () => {
    // No backend at all (a plain browser): there is no update.
    await expect(getAppUpdate()).resolves.toBeNull();
    const calls: unknown[] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return cmd === "get_app_update" ? { version: "1.2.3" } : null;
    });
    await expect(getAppUpdate()).resolves.toEqual({ version: "1.2.3" });
    await installAppUpdate();
    expect(calls).toEqual([
      ["get_app_update", {}],
      ["install_app_update", {}],
    ]);
  });
});

describe("setUiLanguage", () => {
  it("tells Rust the language, and does nothing without a backend", async () => {
    // No backend at all (a plain browser): resolves and calls nothing.
    await expect(setUiLanguage("es")).resolves.toBeUndefined();
    const calls: unknown[] = [];
    mockIPC((cmd, args) => {
      calls.push([cmd, args]);
      return null;
    });
    await setUiLanguage("en");
    expect(calls).toEqual([["set_ui_language", { language: "en" }]]);
  });
});
