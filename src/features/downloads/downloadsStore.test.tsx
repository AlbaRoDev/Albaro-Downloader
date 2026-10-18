import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, waitFor } from "@testing-library/react";
import type { Download, DownloadSettings, OutputSettings } from "@/lib/ipc";
import {
  downloadActions,
  outputActions,
  resetDownloadsStore,
  settingsActions,
  startDownloadsStore,
  useDownloadsStore,
} from "./downloadsStore";
import { DEFAULT_CHOICE } from "./options";
import { download, progress } from "./testData";

afterEach(() => {
  clearMocks();
  resetDownloadsStore();
});

// A backend that answers `list_downloads` with `current.rows` (read again on every call) and
// records every command. `fail` makes the named command reject with that error.
function backend(
  rows: Download[],
  fail: Record<string, unknown> = {},
  answers: Record<string, unknown> = {},
) {
  const calls: [string, unknown][] = [];
  const current = { rows };
  mockIPC(
    (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd in fail) return Promise.reject(fail[cmd]);
      if (cmd in answers) return answers[cmd];
      return cmd === "list_downloads" ? current.rows : null;
    },
    { shouldMockEvents: true },
  );
  return { calls, current };
}

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

// Starts the store on a backend and waits for the first read and the listeners.
async function start(
  rows: Download[],
  fail: Record<string, unknown> = {},
  answers: Record<string, unknown> = {},
) {
  const b = backend(rows, fail, answers);
  const stop = startDownloadsStore();
  await waitFor(() =>
    expect(Object.keys(useDownloadsStore.getState().downloads).length).toBe(
      rows.length,
    ),
  );
  await settle();
  return { ...b, stop };
}

const downloads = () => useDownloadsStore.getState().downloads;
const state = (id: number) => downloads()[id].download.state;
const listCalls = (calls: [string, unknown][]) =>
  calls.filter(([cmd]) => cmd === "list_downloads").length;

describe("loading and events", () => {
  it("reads the list when it starts", async () => {
    const { stop } = await start([download(1), download(2)]);
    expect(Object.keys(downloads())).toEqual(["1", "2"]);
    stop();
  });

  it("does nothing without a backend (a plain browser or test)", () => {
    const stop = startDownloadsStore();
    expect(downloads()).toEqual({});
    stop();
  });

  it("ignores an answer that is not a list", async () => {
    mockIPC(() => ({ not: "a list" }), { shouldMockEvents: true });
    const stop = startDownloadsStore();
    await settle();
    expect(downloads()).toEqual({});
    stop();
  });

  it("applies download-state to a known row without reading the list again", async () => {
    const { calls, stop } = await start([download(1)]);
    await act(async () => {
      await emit("download-state", { id: 1, state: "active", error: null });
    });
    expect(state(1)).toBe("active");
    expect(listCalls(calls)).toBe(1);
    stop();
  });

  it("a download-state for an unknown id reads the list again", async () => {
    const { calls, current, stop } = await start([download(1)]);
    current.rows = [download(1), download(2)];
    await act(async () => {
      await emit("download-state", { id: 2, state: "pending", error: null });
    });
    await waitFor(() => expect(Object.keys(downloads())).toEqual(["1", "2"]));
    expect(listCalls(calls)).toBe(2);
    stop();
  });

  it("a burst of unknown ids (a queued playlist) costs one read, plus one for those during it", async () => {
    const { calls, current, stop } = await start([]);
    current.rows = [1, 2, 3, 4, 5].map((n) => download(n));
    await act(async () => {
      for (let id = 1; id <= 5; id++) {
        await emit("download-state", { id, state: "pending", error: null });
      }
    });
    await waitFor(() => expect(Object.keys(downloads())).toHaveLength(5));
    await settle();
    // The start read, the first of the burst, and one more for all the rest.
    expect(listCalls(calls)).toBeLessThanOrEqual(3);
    stop();
  });

  it("applies progress, retrying and finished", async () => {
    const { stop } = await start([download(1, { state: "active" })]);
    await act(async () => {
      await emit("download-progress", { id: 1, progress: progress() });
      await emit("download-retrying", {
        id: 1,
        attempt: 2,
        maxAttempts: 5,
        delayMs: 4000,
      });
    });
    expect(downloads()[1].progress?.downloadedBytes).toBe(50);
    expect(downloads()[1].retry).toEqual({ attempt: 2, maxAttempts: 5 });
    await act(async () => {
      await emit("download-finished", { id: 1 });
    });
    expect(state(1)).toBe("finished");
    expect(downloads()[1].retry).toBeNull();
    stop();
  });

  it("a new read keeps the progress of what is still listed", async () => {
    const { current, stop } = await start([download(1, { state: "active" })]);
    await act(async () => {
      await emit("download-progress", { id: 1, progress: progress() });
    });
    current.rows = [download(1, { state: "active" }), download(2)];
    await act(async () => {
      await emit("download-state", { id: 2, state: "pending", error: null });
    });
    await waitFor(() => expect(Object.keys(downloads())).toEqual(["1", "2"]));
    expect(downloads()[1].progress?.downloadedBytes).toBe(50);
    expect(downloads()[1].bytes["a.f1.mp4"]).toEqual({ done: 50, total: 100 });
    stop();
  });
});

describe("subscription", () => {
  it("StrictMode (start, stop, start) leaves one set of listeners: an event counts once", async () => {
    const calls: unknown[] = [];
    mockIPC(
      (cmd, args) => {
        calls.push([cmd, args]);
        return cmd === "list_downloads"
          ? [download(1, { state: "active" })]
          : null;
      },
      { shouldMockEvents: true },
    );
    const stopFirst = startDownloadsStore();
    stopFirst();
    const stopSecond = startDownloadsStore();
    await settle();
    // `retrying` has no idempotent shape to hide a double: count how many listeners it has.
    let hits = 0;
    const unsub = useDownloadsStore.subscribe((store, previous) => {
      if (store.downloads !== previous.downloads) hits++;
    });
    await act(async () => {
      await emit("download-progress", { id: 1, progress: progress() });
    });
    unsub();
    expect(hits).toBe(1);
    stopSecond();
  });

  it("two callers share one subscription: it ends with the last stop", async () => {
    const { stop: stopA } = await start([download(1)]);
    const stopB = startDownloadsStore();
    stopA();
    await act(async () => {
      await emit("download-state", { id: 1, state: "active", error: null });
    });
    expect(state(1)).toBe("active");
    stopB();
    await settle();
    await act(async () => {
      await emit("download-state", { id: 1, state: "paused", error: null });
    });
    expect(state(1)).toBe("active");
  });

  it("after stopping, events change nothing, not even one that arrives before the unlisten completes", async () => {
    const { stop } = await start([download(1)]);
    stop();
    // No wait: the unlisten is asynchronous, the handlers must already ignore events.
    await act(async () => {
      await emit("download-state", { id: 1, state: "active", error: null });
    });
    expect(state(1)).toBe("pending");
    // Stopping twice is harmless.
    stop();
  });

  it("starting again after a full stop works", async () => {
    const { stop } = await start([download(1)]);
    stop();
    await settle();
    const again = startDownloadsStore();
    await settle();
    await act(async () => {
      await emit("download-state", { id: 1, state: "active", error: null });
    });
    expect(state(1)).toBe("active");
    again();
  });
});

describe("actions", () => {
  it("each calls its command with the id", async () => {
    const { calls, stop } = await start([download(4)]);
    await act(async () => {
      downloadActions.pause(4);
      downloadActions.resume(4);
      downloadActions.cancel(4);
      downloadActions.retry(4);
      downloadActions.reveal(4);
    });
    // Not the three reads at the start (the list, the saved folder and name, the settings).
    const sent = calls.filter(
      ([cmd]) =>
        cmd !== "list_downloads" &&
        cmd !== "get_output_settings" &&
        cmd !== "get_download_settings",
    );
    expect(sent).toEqual([
      ["pause_download", { id: 4 }],
      ["resume_download", { id: 4 }],
      ["cancel_download", { id: 4 }],
      ["retry_download", { id: 4 }],
      ["reveal_download", { id: 4 }],
    ]);
    stop();
  });

  it("a refused action leaves a notice with the error's code; the next action clears it", async () => {
    const { stop } = await start([download(4)], {
      pause_download: { code: "unknown", message: "cannot go from x to y" },
    });
    await act(async () => {
      downloadActions.pause(4);
    });
    await waitFor(() =>
      expect(useDownloadsStore.getState().notices[4]).toEqual({
        code: "unknown",
        message: "cannot go from x to y",
      }),
    );
    await act(async () => {
      downloadActions.cancel(4);
    });
    expect(useDownloadsStore.getState().notices[4]).toBeUndefined();
    stop();
  });

  it("a failed reveal says the file is gone, whatever the error", async () => {
    const { stop } = await start([download(4, { state: "finished" })], {
      reveal_download: { code: "unavailable", message: "gone" },
    });
    await act(async () => {
      downloadActions.reveal(4);
    });
    await waitFor(() =>
      expect(useDownloadsStore.getState().notices[4]).toEqual({
        code: "revealFailed",
        message: "",
      }),
    );
    stop();
  });

  it("dismissing removes the row once the backend agrees", async () => {
    const { stop } = await start([
      download(4, { state: "finished" }),
      download(5),
    ]);
    await act(async () => {
      downloadActions.dismiss(4);
    });
    await waitFor(() => expect(Object.keys(downloads())).toEqual(["5"]));
    stop();
  });

  it("a refused dismiss keeps the row and says why", async () => {
    const { stop } = await start([download(4, { state: "active" })], {
      dismiss_download: { code: "unknown", message: "is active" },
    });
    await act(async () => {
      downloadActions.dismiss(4);
    });
    await waitFor(() =>
      expect(useDownloadsStore.getState().notices[4]).toEqual({
        code: "unknown",
        message: "is active",
      }),
    );
    expect(Object.keys(downloads())).toEqual(["4"]);
    stop();
  });

  it("picking another folder and retrying calls its command and shows the folder it returns", async () => {
    const { calls, stop } = await start(
      [download(4, { state: "failed" })],
      {},
      {
        retry_in_other_folder: { outputDir: "D:\\Otra", nameTemplate: "title" },
      },
    );
    await act(async () => {
      downloadActions.retryElsewhere(4);
    });
    await waitFor(() =>
      expect(useDownloadsStore.getState().outputDir).toBe("D:\\Otra"),
    );
    expect(calls).toContainEqual(["retry_in_other_folder", { id: 4 }]);
    // Nothing else changes by itself: the row follows the queue's events.
    expect(state(4)).toBe("failed");
    expect(useDownloadsStore.getState().notices[4]).toBeUndefined();
    stop();
  });

  it("a refused move leaves a notice with the technical message and keeps the folder", async () => {
    useDownloadsStore.setState({ outputDir: "C:\\Descargas" });
    const { stop } = await start([download(4, { state: "failed" })], {
      retry_in_other_folder: {
        code: "unknown",
        message: "download 4 cannot be moved: it is active, not failed",
      },
    });
    await act(async () => {
      downloadActions.retryElsewhere(4);
    });
    await waitFor(() =>
      expect(useDownloadsStore.getState().notices[4]).toEqual({
        code: "unknown",
        message: "download 4 cannot be moved: it is active, not failed",
      }),
    );
    expect(useDownloadsStore.getState().outputDir).toBe("C:\\Descargas");
    stop();
  });

  it("the actions object never changes (rows are memoized on it)", () => {
    expect(downloadActions).toBe(downloadActions);
  });
});

describe("the card's choice", () => {
  it("starts as the default and survives the list loading and a new link", async () => {
    expect(useDownloadsStore.getState().choice).toEqual(DEFAULT_CHOICE);
    const { stop } = await start([download(1)]);
    useDownloadsStore
      .getState()
      .setChoice({ ...DEFAULT_CHOICE, kind: "audio", audioFormat: "mp3" });
    await act(async () => {
      await emit("download-state", { id: 2, state: "pending", error: null });
    });
    expect(useDownloadsStore.getState().choice).toMatchObject({
      kind: "audio",
      audioFormat: "mp3",
    });
    stop();
  });
});

describe("the output folder and name", () => {
  const saved: OutputSettings = {
    outputDir: "C:\\Users\\Ana\\Vídeos ñ",
    nameTemplate: "channelTitle",
    folderTooDeep: false,
  };

  // A backend with the saved settings. `handlers` replace what a command answers.
  function output(handlers: Record<string, (args: unknown) => unknown> = {}) {
    const calls: [string, unknown][] = [];
    mockIPC(
      (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd in handlers) return handlers[cmd](args);
        if (cmd === "list_downloads") return [];
        if (cmd === "get_output_settings") return saved;
        return null;
      },
      { shouldMockEvents: true },
    );
    return calls;
  }

  const read = () => ({
    outputDir: useDownloadsStore.getState().outputDir,
    nameTemplate: useDownloadsStore.getState().nameTemplate,
    folderTooDeep: useDownloadsStore.getState().folderTooDeep,
  });

  it("reads the saved folder and name when it starts", async () => {
    expect(read()).toEqual({
      outputDir: null,
      nameTemplate: "titleId",
      folderTooDeep: false,
    });
    output();
    const stop = startDownloadsStore();
    await waitFor(() => expect(read()).toEqual(saved));
    stop();
  });

  it("knows when the saved folder is too deep, and a refresh of the folder updates it", async () => {
    output({
      get_output_settings: () => ({ ...saved, folderTooDeep: true }),
    });
    const stop = startDownloadsStore();
    await waitFor(() => expect(read().folderTooDeep).toBe(true));
    stop();
  });

  it("keeps the defaults when the answer is not settings, and when it stopped meanwhile", async () => {
    output({ get_output_settings: () => null });
    startDownloadsStore()();
    await settle();
    expect(read()).toEqual({
      outputDir: null,
      nameTemplate: "titleId",
      folderTooDeep: false,
    });
    // Stopped before the answer arrives: ignored, like the list.
    let answer: (settings: OutputSettings) => void = () => {};
    output({
      get_output_settings: () =>
        new Promise<OutputSettings>((resolve) => {
          answer = resolve;
        }),
    });
    const stop = startDownloadsStore();
    await settle();
    stop();
    answer(saved);
    await settle();
    expect(read().outputDir).toBeNull();
  });

  it("a picked folder replaces the shown one, and cancelling leaves it", async () => {
    let next = { ...saved, outputDir: "D:\\Otra" };
    output({ pick_output_dir: () => next });
    await outputActions.pickFolder();
    expect(read().outputDir).toBe("D:\\Otra");
    next = { ...saved, outputDir: "D:\\Otra" }; // cancelled: the same folder comes back
    await outputActions.pickFolder();
    expect(read().outputDir).toBe("D:\\Otra");
    expect(useDownloadsStore.getState().folderProblem).toBeNull();
  });

  it("a refused folder keeps the old one; the next pick clears the reason", async () => {
    useDownloadsStore.setState({ outputDir: "C:\\Descargas" });
    let refuse = true;
    output({
      pick_output_dir: () =>
        refuse
          ? Promise.reject({ code: "folderUnavailable", message: "denied" })
          : { ...saved, outputDir: "C:\\Descargas" },
    });
    await outputActions.pickFolder();
    expect(read().outputDir).toBe("C:\\Descargas");
    expect(useDownloadsStore.getState().folderProblem).toBe(
      "folderUnavailable",
    );
    refuse = false;
    await outputActions.pickFolder();
    expect(useDownloadsStore.getState().folderProblem).toBeNull();
  });

  it("a name that is not an AppError becomes `unknown`", async () => {
    useDownloadsStore.setState({ outputDir: "C:\\Descargas" });
    output({ pick_output_dir: () => Promise.reject("the dialog crashed") });
    await outputActions.pickFolder();
    expect(useDownloadsStore.getState().folderProblem).toBe("unknown");
  });

  it("changing the name shows it at once and saves it", async () => {
    const calls = output();
    const done = outputActions.changeName("title");
    // Before the backend has answered.
    expect(read().nameTemplate).toBe("title");
    await done;
    expect(read().nameTemplate).toBe("title");
    expect(calls).toContainEqual(["set_name_template", { template: "title" }]);
    expect(useDownloadsStore.getState().nameProblem).toBeNull();
  });

  it("goes back to the old name when saving fails, and says why", async () => {
    useDownloadsStore.setState({ nameTemplate: "channelTitle" });
    output({
      set_name_template: () =>
        Promise.reject({ code: "unknown", message: "database is locked" }),
    });
    await outputActions.changeName("title");
    expect(read().nameTemplate).toBe("channelTitle");
    expect(useDownloadsStore.getState().nameProblem).toBe("unknown");
    // The next change clears it.
    output();
    await outputActions.changeName("titleId");
    expect(useDownloadsStore.getState().nameProblem).toBeNull();
  });

  it("is back to the defaults when the store is reset", () => {
    useDownloadsStore.setState({
      outputDir: "C:\\x",
      nameTemplate: "title",
      folderProblem: "unknown",
      nameProblem: "unknown",
    });
    resetDownloadsStore();
    expect(useDownloadsStore.getState()).toMatchObject({
      outputDir: null,
      nameTemplate: "titleId",
      folderProblem: null,
      nameProblem: null,
    });
  });
});

describe("the limits and the cookies", () => {
  const saved: DownloadSettings = {
    maxConcurrent: 3,
    limitRateKbps: null,
    cookiesBrowser: null,
    cookiesFile: null,
    notifications: true,
  };
  const settings = () => useDownloadsStore.getState().settings;
  const problem = () => useDownloadsStore.getState().settingsProblem;

  // A backend that answers the settings read and records every command; `handlers` answer or
  // refuse the named ones.
  function withSettings(
    handlers: Record<string, (args: unknown) => unknown> = {},
    answer: unknown = saved,
  ) {
    const calls: [string, unknown][] = [];
    mockIPC(
      (cmd, args) => {
        calls.push([cmd, args]);
        if (cmd in handlers) return handlers[cmd](args);
        if (cmd === "list_downloads") return [];
        if (cmd === "get_download_settings") return answer;
        return null;
      },
      { shouldMockEvents: true },
    );
    return calls;
  }

  it("has no settings until they are read, then holds what the backend said", async () => {
    expect(settings()).toBeNull();
    withSettings({}, { ...saved, limitRateKbps: 1024, cookiesBrowser: "edge" });
    const stop = startDownloadsStore();
    await waitFor(() =>
      expect(settings()).toEqual({
        maxConcurrent: 3,
        limitRateKbps: 1024,
        cookiesBrowser: "edge",
        cookiesFile: null,
        notifications: true,
      }),
    );
    stop();
  });

  it("ignores an answer that is not settings", async () => {
    withSettings({}, null);
    startDownloadsStore()();
    await settle();
    expect(settings()).toBeNull();
  });

  it("each change shows at once and calls its command", async () => {
    const calls = withSettings();
    const stop = startDownloadsStore();
    await waitFor(() => expect(settings()).toEqual(saved));
    await act(async () => {
      await settingsActions.setMaxConcurrent(5);
      await settingsActions.setLimitRate(2048);
      await settingsActions.setCookiesBrowser("firefox");
    });
    expect(settings()).toEqual({
      maxConcurrent: 5,
      limitRateKbps: 2048,
      cookiesBrowser: "firefox",
      cookiesFile: null,
      notifications: true,
    });
    expect(calls.filter(([cmd]) => /^set_/.test(cmd))).toEqual([
      ["set_max_concurrent", { max: 5 }],
      ["set_limit_rate", { kbps: 2048 }],
      ["set_cookies_browser", { browser: "firefox" }],
    ]);
    // And back to "none" / "no limit".
    await act(async () => {
      await settingsActions.setLimitRate(null);
      await settingsActions.setCookiesBrowser(null);
    });
    expect(settings()).toMatchObject({
      limitRateKbps: null,
      cookiesBrowser: null,
    });
    expect(problem()).toBeNull();
    stop();
  });

  it("the notification setting shows at once, is saved, and goes back if refused", async () => {
    const calls = withSettings({
      set_notifications: (args) =>
        (args as { on: boolean }).on
          ? null
          : Promise.reject({ code: "unknown", message: "no" }),
    });
    const stop = startDownloadsStore();
    await waitFor(() => expect(settings()).toEqual(saved));
    // Off is refused: the box goes back to on, and the reason is kept.
    await act(async () => {
      await settingsActions.setNotifications(false);
    });
    expect(settings()?.notifications).toBe(true);
    expect(problem()).toBe("unknown");
    // On is accepted.
    await act(async () => {
      await settingsActions.setNotifications(true);
    });
    expect(problem()).toBeNull();
    expect(calls.filter(([cmd]) => cmd === "set_notifications")).toEqual([
      ["set_notifications", { on: false }],
      ["set_notifications", { on: true }],
    ]);
    stop();
  });

  it("a refused change goes back to the old value and says why", async () => {
    withSettings({
      set_limit_rate: () =>
        Promise.reject({ code: "unknown", message: "at least 1 KB/s" }),
    });
    const stop = startDownloadsStore();
    await waitFor(() => expect(settings()).toEqual(saved));
    await act(async () => {
      await settingsActions.setLimitRate(0);
    });
    expect(settings()?.limitRateKbps).toBeNull();
    expect(problem()).toBe("unknown");
    // The next change clears the problem.
    await act(async () => {
      await settingsActions.setMaxConcurrent(2);
    });
    expect(problem()).toBeNull();
    stop();
  });

  it("a refusal only undoes its own field, not a change that landed meanwhile", async () => {
    let refuse: (error: unknown) => void = () => {};
    withSettings({
      set_cookies_browser: () =>
        new Promise((_resolve, reject) => {
          refuse = reject;
        }),
    });
    const stop = startDownloadsStore();
    await waitFor(() => expect(settings()).toEqual(saved));
    let pending: Promise<void> = Promise.resolve();
    await act(async () => {
      pending = settingsActions.setCookiesBrowser("chrome");
    });
    expect(settings()?.cookiesBrowser).toBe("chrome");
    await act(async () => {
      await settingsActions.setMaxConcurrent(7);
    });
    await act(async () => {
      refuse({ code: "unknown", message: "no" });
      await pending;
    });
    expect(settings()).toEqual({ ...saved, maxConcurrent: 7 });
    stop();
  });

  it("does nothing before the settings are read", async () => {
    const calls = withSettings();
    await act(async () => {
      await settingsActions.setLimitRate(1024);
    });
    expect(calls).toEqual([]);
    expect(settings()).toBeNull();
  });

  it("opens and closes the panel, and a row can open it", () => {
    expect(useDownloadsStore.getState().settingsOpen).toBe(false);
    downloadActions.openSettings();
    expect(useDownloadsStore.getState().settingsOpen).toBe(true);
    settingsActions.setOpen(false);
    expect(useDownloadsStore.getState().settingsOpen).toBe(false);
  });
});

describe("a cookies file", () => {
  const base: DownloadSettings = {
    maxConcurrent: 3,
    limitRateKbps: null,
    cookiesBrowser: "firefox",
    cookiesFile: null,
    notifications: true,
  };
  const settings = () => useDownloadsStore.getState().settings;
  const problem = () => useDownloadsStore.getState().settingsProblem;

  // Answers the settings read, and `pick_cookies_file` with `picked` (or by `handler`).
  function backend(handler: (cmd: string) => unknown = () => null) {
    const calls: string[] = [];
    mockIPC(
      (cmd) => {
        calls.push(cmd);
        if (cmd === "list_downloads") return [];
        if (cmd === "get_download_settings") return base;
        return handler(cmd);
      },
      { shouldMockEvents: true },
    );
    return calls;
  }

  it("picking a file takes the settings the backend answers, with no browser", async () => {
    const picked = {
      ...base,
      cookiesBrowser: null,
      cookiesFile: "C:\\Users\\Ana\\cookies.txt",
      notifications: true,
    };
    const calls = backend((cmd) =>
      cmd === "pick_cookies_file" ? picked : null,
    );
    const stop = startDownloadsStore();
    await waitFor(() => expect(settings()).toEqual(base));
    await act(async () => {
      await settingsActions.pickCookiesFile();
    });
    expect(settings()).toEqual(picked);
    expect(calls.filter((c) => c === "pick_cookies_file")).toHaveLength(1);
    expect(problem()).toBeNull();
    stop();
  });

  it("cancelling the picker leaves the settings as the backend says (unchanged)", async () => {
    backend((cmd) => (cmd === "pick_cookies_file" ? base : null));
    const stop = startDownloadsStore();
    await waitFor(() => expect(settings()).toEqual(base));
    await act(async () => {
      await settingsActions.pickCookiesFile();
    });
    expect(settings()).toEqual(base);
    stop();
  });

  it("a file that cannot be used keeps the old source and says why", async () => {
    backend((cmd) =>
      cmd === "pick_cookies_file"
        ? Promise.reject({
            code: "cookiesUnavailable",
            message: "not a Netscape file",
          })
        : null,
    );
    const stop = startDownloadsStore();
    await waitFor(() => expect(settings()).toEqual(base));
    await act(async () => {
      await settingsActions.pickCookiesFile();
    });
    expect(settings()).toEqual(base);
    expect(problem()).toBe("cookiesUnavailable");
    stop();
  });

  it("a browser, or none, drops the file at once, like the backend does", async () => {
    const withFile = {
      ...base,
      cookiesBrowser: null,
      cookiesFile: "/home/ana/c.txt",
      notifications: true,
    };
    mockIPC(
      (cmd) => {
        if (cmd === "list_downloads") return [];
        if (cmd === "get_download_settings") return withFile;
        return null;
      },
      { shouldMockEvents: true },
    );
    const stop = startDownloadsStore();
    await waitFor(() => expect(settings()).toEqual(withFile));
    await act(async () => {
      await settingsActions.setCookiesBrowser("edge");
    });
    expect(settings()).toMatchObject({
      cookiesBrowser: "edge",
      cookiesFile: null,
      notifications: true,
    });
    stop();
  });

  it("a refused browser change brings the file back with the old browser", async () => {
    const withFile = {
      ...base,
      cookiesBrowser: null,
      cookiesFile: "/home/ana/c.txt",
      notifications: true,
    };
    mockIPC(
      (cmd) => {
        if (cmd === "list_downloads") return [];
        if (cmd === "get_download_settings") return withFile;
        if (cmd === "set_cookies_browser")
          return Promise.reject({
            code: "unknown",
            message: "database: locked",
          });
        return null;
      },
      { shouldMockEvents: true },
    );
    const stop = startDownloadsStore();
    await waitFor(() => expect(settings()).toEqual(withFile));
    await act(async () => {
      await settingsActions.setCookiesBrowser(null);
    });
    expect(settings()).toEqual(withFile);
    stop();
  });
});
