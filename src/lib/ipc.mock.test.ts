import type {
  AppError,
  Download,
  DownloadRequest,
  DownloadSettings,
  DownloadState,
  History,
  Metadata,
  OutputSettings,
  Playlist,
  Progress,
} from "./ipc";
import { allowed, MOCK_FOLDERS, QueueSimulator } from "./ipc.mock";

interface Logged {
  event: string;
  // biome-ignore lint/suspicious/noExplicitAny: test payloads of several event types
  payload: any;
  at: number;
}

let log: Logged[];
let sim: QueueSimulator;

beforeEach(() => {
  vi.useFakeTimers();
  log = [];
  sim = new QueueSimulator((event, payload) =>
    log.push({ event, payload, at: Date.now() }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

const video = (url = "https://example.test/v"): DownloadRequest => ({
  url,
  mode: { kind: "video", maxHeight: null, container: null },
});
const audio = (url = "https://example.test/a"): DownloadRequest => ({
  url,
  mode: { kind: "audio", format: "best", bitrateKbps: null },
});

const enqueue = (request: DownloadRequest) =>
  sim.invoke("enqueue_download", { request }) as number;
const list = () => sim.invoke("list_downloads") as Download[];
const row = (id: number) => list().find((d) => d.id === id) as Download;
const of = (id: number) => log.filter((e) => e.payload.id === id);
const states = (id: number) =>
  of(id)
    .filter((e) => e.event === "download-state")
    .map((e) => e.payload.state as DownloadState);
// Arrays have no `.at()` with tsconfig's ES2020 lib.
const last = <T>(items: T[]): T => items[items.length - 1];
const progress = (id: number) =>
  of(id).filter((e) => e.event === "download-progress");

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("did not throw");
}

describe("transitions", () => {
  it("allows exactly queue.rs's table", () => {
    const table = [
      "pending>active",
      "pending>paused",
      "pending>cancelled",
      "active>finished",
      "active>failed",
      "active>paused",
      "active>cancelled",
      "paused>pending",
      "paused>cancelled",
      "failed>pending",
    ];
    const all: DownloadState[] = [
      "pending",
      "active",
      "paused",
      "finished",
      "failed",
      "cancelled",
    ];
    for (const from of all) {
      for (const to of all) {
        expect(allowed(from, to), `${from}>${to}`).toBe(
          table.includes(`${from}>${to}`),
        );
      }
    }
  });

  // A download in `state`. Max 1 and a slow download first, so `pending` stays pending.
  function inState(state: DownloadState): number {
    sim.invoke("set_max_concurrent", { max: 1 });
    if (state === "pending") enqueue(audio("https://example.test/slow"));
    const id = enqueue(
      audio(`https://example.test/${state === "failed" ? "fail" : state}`),
    );
    if (state === "paused") sim.invoke("pause_download", { id });
    if (state === "cancelled") sim.invoke("cancel_download", { id });
    if (["paused", "cancelled", "finished", "failed"].includes(state)) {
      vi.advanceTimersByTime(5000);
    }
    expect(row(id).state).toBe(state);
    return id;
  }

  const commands = [
    ["pause_download", "paused"],
    ["cancel_download", "cancelled"],
    ["resume_download", "pending"],
    ["retry_download", "pending"],
  ] as const;
  const states: DownloadState[] = [
    "pending",
    "active",
    "paused",
    "finished",
    "failed",
    "cancelled",
  ];
  for (const state of states) {
    for (const [cmd, to] of commands) {
      // An active download is paused or cancelled once its process exits; retry only
      // takes a failed one.
      const ok =
        cmd === "retry_download" ? state === "failed" : allowed(state, to);
      it(`${cmd} on a ${state} download ${ok ? "works" : "is rejected"}`, () => {
        const id = inState(state);
        if (ok) {
          expect(sim.invoke(cmd, { id })).toBeNull();
        } else {
          expect(thrown(() => sim.invoke(cmd, { id }))).toEqual({
            code: "unknown",
            message: `download ${id} cannot go from ${state} to ${to}`,
          });
          expect(row(id).state).toBe(state);
        }
      });
    }
  }

  it("rejects an unknown id", () => {
    expect(thrown(() => sim.invoke("cancel_download", { id: 999 }))).toEqual({
      code: "unknown",
      message: "no download with id 999",
    });
  });
});

describe("enqueue", () => {
  it("rejects a duplicate while it is pending, active or paused, not after", () => {
    const id = enqueue(video());
    // Same request with the fields in another order and a missing option: same download.
    const same = {
      mode: { container: null, kind: "video" },
      url: video().url,
    } as unknown as DownloadRequest;
    expect(thrown(() => enqueue(same))).toEqual({
      code: "alreadyQueued",
      message: `https://example.test/v is already in the queue (id ${id})`,
    });
    // Another mode is another download.
    expect(enqueue(audio(video().url))).toBe(id + 1);
    sim.invoke("cancel_download", { id });
    vi.advanceTimersByTime(1000);
    expect(enqueue(video())).toBe(id + 2);
  });

  it("rejects what is not an http(s) URL, like check_url", () => {
    expect(thrown(() => enqueue(audio("--exec=calc.exe")))).toEqual({
      code: "invalidUrl",
      message: "only http:// and https:// URLs are accepted: --exec=calc.exe",
    });
    expect(list()).toEqual([]);
  });

  it("rejects a max of 0, and a bad argument like Tauri (a string)", () => {
    expect(thrown(() => sim.invoke("set_max_concurrent", { max: 0 }))).toEqual({
      code: "unknown",
      message: "at least one download must be allowed at a time",
    });
    expect(
      typeof thrown(() => sim.invoke("set_max_concurrent", { max: -1 })),
    ).toBe("string");
    expect(typeof thrown(() => sim.invoke("pause_download", {}))).toBe(
      "string",
    );
  });
});

describe("queue", () => {
  it("runs at most the max at once, oldest first", () => {
    sim.invoke("set_max_concurrent", { max: 2 });
    const ids = [1, 2, 3].map((n) =>
      enqueue(audio(`https://example.test/${n}`)),
    );
    expect(list().map((d) => d.state)).toEqual(["active", "active", "pending"]);

    vi.advanceTimersByTime(10_000);
    let active = 0;
    let most = 0;
    for (const e of log) {
      if (e.event !== "download-state") continue;
      active += e.payload.state === "active" ? 1 : 0;
      most = Math.max(most, active);
      active -= e.payload.state === "finished" ? 1 : 0;
    }
    expect(most).toBeLessThanOrEqual(2);
    expect(list().map((d) => d.state)).toEqual([
      "finished",
      "finished",
      "finished",
    ]);
    // The third starts right when the first one finishes.
    const firstDone = log.findIndex(
      (e) => e.event === "download-finished" && e.payload.id === ids[0],
    );
    const thirdActive = log.findIndex(
      (e) =>
        e.event === "download-state" &&
        e.payload.id === ids[2] &&
        e.payload.state === "active",
    );
    expect(thirdActive).toBe(firstDone + 1);
  });

  it("a higher max starts waiting downloads at once", () => {
    sim.invoke("set_max_concurrent", { max: 1 });
    enqueue(audio("https://example.test/1"));
    const id = enqueue(audio("https://example.test/2"));
    expect(row(id).state).toBe("pending");
    sim.invoke("set_max_concurrent", { max: 2 });
    expect(row(id).state).toBe("active");
  });
});

describe("events", () => {
  it("a video: state before finished, two files, a quiet merge, nothing after", () => {
    const id = enqueue(video());
    vi.advanceTimersByTime(20_000);
    const events = of(id).map((e) => e.event);
    expect(states(id)).toEqual(["pending", "active", "finished"]);
    expect(events.slice(-2)).toEqual(["download-state", "download-finished"]);
    expect(events).not.toContain("download-failed");

    const updates = progress(id);
    const files = [...new Set(updates.map((e) => e.payload.progress.filename))];
    expect(files).toHaveLength(2);
    // Each file ends with its own `finished` at 100 %.
    for (const file of files) {
      const end: Progress = last(
        updates.filter((e) => e.payload.progress.filename === file),
      ).payload.progress;
      expect(end.status).toBe("finished");
      expect(end.downloadedBytes).toBe(end.totalBytes);
    }
    // ~1.5 s of merging with no events before the end.
    const lastProgress = last(updates);
    const done = last(of(id));
    expect(done.at - lastProgress.at).toBeGreaterThanOrEqual(1500);
  });

  it("an audio download is one file", () => {
    const id = enqueue(audio());
    vi.advanceTimersByTime(5000);
    const files = new Set(progress(id).map((e) => e.payload.progress.filename));
    expect(files.size).toBe(1);
    expect(states(id)).toEqual(["pending", "active", "finished"]);
  });

  it("sends at most one progress per 100 ms (10 per second)", () => {
    const id = enqueue(video());
    vi.advanceTimersByTime(20_000);
    const updates = progress(id);
    // 5 s of downloading at 40 raw lines per second: ~50 sent, not ~200.
    expect(updates.length).toBeGreaterThan(40);
    expect(updates.length).toBeLessThan(60);
    for (let i = 1; i < updates.length; i++) {
      if (updates[i].payload.progress.status === "downloading") {
        expect(updates[i].at - updates[i - 1].at).toBeGreaterThanOrEqual(100);
      }
    }
    // Any 1 s window: 10, plus a forced `finished` at most.
    for (const e of updates) {
      const window = updates.filter((u) => u.at >= e.at && u.at < e.at + 1000);
      expect(window.length).toBeLessThanOrEqual(11);
    }
  });

  it("cancelling sends the held-back progress and then only `cancelled`", () => {
    const id = enqueue(video());
    vi.advanceTimersByTime(1060); // sent at 1000 ms, then 1025 and 1050 held back
    sim.invoke("cancel_download", { id });
    expect(row(id).state).toBe("active"); // until the process exits
    const sent = progress(id).length;
    vi.advanceTimersByTime(20_000);
    expect(progress(id).length).toBe(sent + 1);
    const events = of(id).map((e) => e.event);
    expect(events.slice(-2)).toEqual(["download-progress", "download-state"]);
    expect(states(id)).toEqual(["pending", "active", "cancelled"]);
    expect(events).not.toContain("download-failed");
  });

  it("pausing keeps the row, resuming starts it again", () => {
    const id = enqueue(audio());
    vi.advanceTimersByTime(500);
    sim.invoke("pause_download", { id });
    sim.invoke("cancel_download", { id }); // a second stop before the exit: the last wins
    sim.invoke("pause_download", { id });
    vi.advanceTimersByTime(1000);
    expect(states(id)).toEqual(["pending", "active", "paused"]);
    sim.invoke("resume_download", { id });
    vi.advanceTimersByTime(5000);
    expect(states(id)).toEqual([
      "pending",
      "active",
      "paused",
      "pending",
      "active",
      "finished",
    ]);
  });

  it("a failure: `failed` with its error, then download-failed", () => {
    const id = enqueue(audio("https://example.test/fail"));
    vi.advanceTimersByTime(5000);
    expect(of(id).map((e) => e.event)).toEqual([
      "download-state",
      "download-state",
      "download-state",
      "download-failed",
    ]);
    const error = last(of(id)).payload.error as AppError;
    expect(error.code).toBe("unavailable");
    expect(row(id)).toMatchObject({ state: "failed", error });
    sim.invoke("retry_download", { id });
    expect(states(id).slice(-2)).toEqual(["pending", "active"]);
  });
});

describe("network retries (offline)", () => {
  it("retries 5 times with growing waits, then fails", () => {
    const id = enqueue(audio("https://example.test/offline"));
    vi.advanceTimersByTime(60_000);
    const retrying = of(id).filter((e) => e.event === "download-retrying");
    expect(retrying.map((e) => e.payload)).toEqual(
      [1, 2, 3, 4, 5].map((attempt) => ({
        id,
        attempt,
        maxAttempts: 5,
        delayMs: 300 * attempt,
      })),
    );
    // Each wait: `pending` with the network error, right before its retrying event.
    const waiting = of(id).filter(
      (e) => e.event === "download-state" && e.payload.state === "pending",
    );
    expect(waiting.slice(1).map((e) => e.payload.error.code)).toEqual(
      Array(5).fill("network"),
    );
    expect(states(id).slice(-1)).toEqual(["failed"]);
    expect(last(of(id)).event).toBe("download-failed");
    expect(row(id).error?.code).toBe("network");
  });

  it("a waiting retry holds no slot, and cancelling it stops the retries", () => {
    sim.invoke("set_max_concurrent", { max: 1 });
    const offline = enqueue(audio("https://example.test/offline"));
    const other = enqueue(audio("https://example.test/ok"));
    vi.advanceTimersByTime(310); // the first attempt failed: waiting 300 ms
    expect(row(offline).state).toBe("pending");
    expect(row(other).state).toBe("active");
    sim.invoke("cancel_download", { id: offline });
    vi.advanceTimersByTime(60_000);
    expect(states(offline).slice(-1)).toEqual(["cancelled"]);
    expect(
      of(offline).filter((e) => e.event === "download-retrying"),
    ).toHaveLength(1);
  });
});

it("slow is 5 times slower", () => {
  const normal = enqueue(audio("https://example.test/a"));
  const slow = enqueue(audio("https://example.test/slow"));
  vi.advanceTimersByTime(2000);
  expect(row(normal).state).toBe("finished");
  expect(row(slow).state).toBe("active");
  vi.advanceTimersByTime(4000); // 6 s: still under 5 × 1.3 s
  expect(row(slow).state).toBe("active");
  vi.advanceTimersByTime(1000);
  expect(row(slow).state).toBe("finished");
});

describe("fetch_metadata", () => {
  const fetch = (url: string) =>
    sim.invoke("fetch_metadata", { url }) as Promise<Metadata>;

  it("returns made-up metadata with AV1 and H.264 formats", async () => {
    const result = fetch("https://example.test/v");
    vi.advanceTimersByTime(500);
    const m = await result;
    expect(m.webpageUrl).toBe("https://example.test/v");
    const codecs = m.formats.map((f) => f.vcodec);
    expect(codecs.some((c) => c?.startsWith("av01"))).toBe(true);
    expect(codecs.some((c) => c?.startsWith("avc1"))).toBe(true);
    expect(codecs).toContain("none"); // audio-only formats
  });

  it("has scenarios for an H.264-only, an audio-only, a heightless and a live source", async () => {
    const meta = async (name: string) => {
      const result = fetch(`https://example.test/${name}`);
      vi.advanceTimersByTime(500);
      return result;
    };
    const h264 = await meta("h264only");
    expect(h264.formats.every((f) => !/^(vp|av01)/.test(f.vcodec ?? ""))).toBe(
      true,
    );
    const audio = await meta("audioonly");
    expect(audio.formats.every((f) => f.vcodec === "none")).toBe(true);
    const flat = await meta("noheight");
    expect(flat.formats.every((f) => f.height === null)).toBe(true);
    expect((await meta("live")).isLive).toBe(true);
    expect((await meta("normal")).isLive).toBe(false);
  });

  it("fails on a playlist with `playlist`, like the real one", async () => {
    const result = fetch("https://example.test/playlist?list=1");
    vi.advanceTimersByTime(500);
    await expect(result).rejects.toMatchObject({ code: "playlist" });
  });

  it("fetch_playlist marks a private and a deleted video, or all of them", async () => {
    const list = (url: string) => {
      const result = sim.invoke("fetch_playlist", { url }) as Promise<Playlist>;
      vi.advanceTimersByTime(800);
      return result;
    };
    const p = await list("https://example.test/playlist?list=1");
    expect(p.entries.map((e) => e.unavailable).filter(Boolean)).toEqual([
      "private",
      "deleted",
    ]);
    expect(p.entries[6]).toMatchObject({
      title: null,
      duration: null,
      thumbnail: null,
    });
    const all = await list("https://example.test/playlist-allgone");
    expect(all.entries.every((e) => e.unavailable === "private")).toBe(true);
  });

  it("fetch_playlist lists made-up entries, some without title or duration", async () => {
    const list = (url: string) => {
      const result = sim.invoke("fetch_playlist", { url }) as Promise<Playlist>;
      vi.advanceTimersByTime(800);
      return result;
    };
    const p = await list("https://example.test/playlist?list=1");
    expect(p.entries).toHaveLength(24);
    expect(p.entries[2]).toMatchObject({ title: null, duration: null });
    expect(p.entries[0].url).toMatch(/^https:\/\//);
    expect(
      (await list("https://example.test/playlist-big")).entries,
    ).toHaveLength(300);
    // A whole channel, to see how a very long list copes.
    expect(
      (await list("https://example.test/playlist-huge")).entries,
    ).toHaveLength(2000);
    expect((await list("https://example.test/playlist-empty")).entries).toEqual(
      [],
    );
    const failing = sim.invoke("fetch_playlist", {
      url: "https://example.test/playlist-fail",
    });
    vi.advanceTimersByTime(800);
    await expect(failing).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      sim.invoke("fetch_playlist", { url: "file:///etc/passwd" }),
    ).rejects.toMatchObject({ code: "invalidUrl" });
  });

  it("fails on a bad URL at once", async () => {
    await expect(fetch("file:///etc/passwd")).rejects.toMatchObject({
      code: "invalidUrl",
    });
  });
});

describe("enqueue_downloads", () => {
  const batch = (...urls: string[]) =>
    sim.invoke("enqueue_downloads", {
      items: urls.map((url) => ({ request: audio(url) })),
    }) as { queued: number; skipped: number };

  it("queues in order and skips what is already queued", () => {
    sim.invoke("enqueue_download", {
      request: audio("https://example.test/b"),
    });
    expect(
      batch(
        "https://example.test/a",
        "https://example.test/b",
        "https://example.test/c",
      ),
    ).toEqual({ queued: 2, skipped: 1 });
    const urls = (sim.invoke("list_downloads") as Download[]).map(
      (d) => d.request.url,
    );
    expect(urls).toEqual([
      "https://example.test/b",
      "https://example.test/a",
      "https://example.test/c",
    ]);
  });

  it("stops at a real error and keeps what it queued", () => {
    expect(() =>
      batch("https://example.test/a", "file:///x", "https://example.test/c"),
    ).toThrow();
    expect(sim.invoke("list_downloads") as Download[]).toHaveLength(1);
  });

  it("gives the entries of one call a batch with the playlist's title, and each call its own", () => {
    const call = (title: string | null, ...urls: string[]) =>
      sim.invoke("enqueue_downloads", {
        items: urls.map((url) => ({ request: audio(url) })),
        batchTitle: title,
      });
    call("  My list ", "https://example.test/a", "https://example.test/b");
    call(null, "https://example.test/c");
    sim.invoke("enqueue_download", {
      request: audio("https://example.test/d"),
    });
    const rows = sim.invoke("list_downloads") as Download[];
    expect(rows.map((d) => d.batch)).toEqual([
      { id: 1, title: "My list" },
      { id: 1, title: "My list" },
      { id: 2, title: null },
      null,
    ]);
  });

  it("a folder tells downloads apart", () => {
    const withFolder = (folder?: string) => ({
      request: {
        ...audio("https://example.test/a"),
        ...(folder && { folder }),
      },
    });
    expect(
      sim.invoke("enqueue_downloads", {
        items: [withFolder("My list"), withFolder(), withFolder("My list")],
      }),
    ).toEqual({ queued: 2, skipped: 1 });
  });

  it("tells the same entry at two positions apart", () => {
    const at = (index: number) => ({
      request: {
        ...audio("https://example.test/a"),
        playlist: { index, count: 5 },
      },
    });
    const result = sim.invoke("enqueue_downloads", {
      items: [at(1), at(1), at(2)],
    });
    expect(result).toEqual({ queued: 2, skipped: 1 });
  });
});

describe("the list", () => {
  const withInfo = (url: string, title = "A title") =>
    sim.invoke("enqueue_download", {
      request: audio(url),
      info: { title, thumbnail: "https://i.test/t.jpg" },
    }) as number;
  const hidden = (id: number) => !list().some((d) => d.id === id);

  it("keeps the title and thumbnail it was given, and sends no path or flag", () => {
    const id = withInfo("https://example.test/one", "  One  ");
    expect(row(id)).toMatchObject({
      title: "One",
      thumbnail: "https://i.test/t.jpg",
    });
    expect(Object.keys(row(id)).sort()).toEqual([
      "batch",
      "createdAt",
      "error",
      "id",
      "request",
      "state",
      "thumbnail",
      "title",
      "updatedAt",
    ]);
    // Without info: nothing, like the old rows.
    const bare = enqueue(audio("https://example.test/two"));
    expect(row(bare)).toMatchObject({ title: null, thumbnail: null });
  });

  it("the duplicate has its own code", () => {
    const id = withInfo("https://example.test/dup");
    expect(thrown(() => withInfo("https://example.test/dup", "Other"))).toEqual(
      {
        code: "alreadyQueued",
        message: `https://example.test/dup is already in the queue (id ${id})`,
      },
    );
  });

  it("dismisses only a download that has ended, and keeps it out of the list", () => {
    sim.invoke("set_max_concurrent", { max: 1 });
    const running = withInfo("https://example.test/slow");
    const waiting = withInfo("https://example.test/waiting");
    vi.advanceTimersByTime(400);
    expect(row(running).state).toBe("active");
    for (const id of [running, waiting]) {
      const state = row(id).state;
      expect(thrown(() => sim.invoke("dismiss_download", { id }))).toEqual({
        code: "unknown",
        message: `download ${id} is ${state} and cannot be removed from the list yet`,
      });
      expect(hidden(id)).toBe(false);
    }
    sim.invoke("cancel_download", { id: waiting });
    expect(sim.invoke("dismiss_download", { id: waiting })).toBeNull();
    expect(hidden(waiting)).toBe(true);
    // Again is fine; an unknown id is an error.
    expect(sim.invoke("dismiss_download", { id: waiting })).toBeNull();
    expect(thrown(() => sim.invoke("dismiss_download", { id: 99 }))).toEqual({
      code: "unknown",
      message: "no download with id 99",
    });
  });

  it("a dismissed download's request can be queued again", () => {
    const id = withInfo("https://example.test/again");
    vi.advanceTimersByTime(3000);
    expect(row(id).state).toBe("finished");
    sim.invoke("dismiss_download", { id });
    expect(withInfo("https://example.test/again")).toBe(id + 1);
  });

  it("reveal works for a finished download only, like queue::reveal_target", () => {
    sim.invoke("set_max_concurrent", { max: 1 });
    const done = withInfo("https://example.test/done");
    const next = withInfo("https://example.test/next-slow");
    vi.advanceTimersByTime(400);
    expect(thrown(() => sim.invoke("reveal_download", { id: done }))).toEqual({
      code: "unknown",
      message: `download ${done} is active, not finished: there is no file to show`,
    });
    vi.advanceTimersByTime(1500);
    expect(row(done).state).toBe("finished");
    expect(sim.invoke("reveal_download", { id: done })).toBeNull();
    expect(row(next).state).not.toBe("finished");
    expect(thrown(() => sim.invoke("reveal_download", { id: 99 }))).toEqual({
      code: "unknown",
      message: "no download with id 99",
    });
  });

  it("a finished download whose file path never came cannot be revealed", () => {
    const id = withInfo("https://example.test/nopath");
    vi.advanceTimersByTime(3000);
    expect(row(id).state).toBe("finished");
    expect(thrown(() => sim.invoke("reveal_download", { id }))).toEqual({
      code: "unavailable",
      message: `download ${id} has no recorded file`,
    });
  });
});

describe("the taskbar progress", () => {
  it("keeps the last value the window plugin was sent", () => {
    expect(sim.taskbar).toBeNull();
    const value = { status: "normal", progress: 25 };
    expect(
      sim.invoke("plugin:window|set_progress_bar", { label: "main", value }),
    ).toBeNull();
    expect(sim.taskbar).toEqual(value);
    sim.invoke("plugin:window|set_progress_bar", {
      label: "main",
      value: { status: "none" },
    });
    expect(sim.taskbar).toEqual({ status: "none" });
  });
});

describe("the output folder and file name", () => {
  const settings = () => sim.invoke("get_output_settings") as OutputSettings;
  const pick = () => sim.invoke("pick_output_dir") as Promise<OutputSettings>;
  const [first, second] = MOCK_FOLDERS;

  it("starts on the default folder and the default name", () => {
    expect(settings()).toEqual({
      outputDir: first,
      nameTemplate: "titleId",
      folderTooDeep: false,
    });
  });

  it("the picker alternates between two folders and then plays a cancellation", async () => {
    expect((await pick()).outputDir).toBe(second);
    expect((await pick()).outputDir).toBe(first);
    // Cancelled: nothing changes, and it still answers with the settings in force.
    expect(await pick()).toEqual({
      outputDir: first,
      nameTemplate: "titleId",
      folderTooDeep: false,
    });
    expect(settings().outputDir).toBe(first);
    expect((await pick()).outputDir).toBe(second);
    expect(settings().outputDir).toBe(second);
  });

  it("saves the name, and an unknown one is refused with a text, as Tauri does", () => {
    for (const template of ["title", "channelTitle", "titleId"]) {
      expect(sim.invoke("set_name_template", { template })).toBeNull();
      expect(settings().nameTemplate).toBe(template);
    }
    for (const bad of ["Title", "", "%(title)s", 3, undefined]) {
      const error = thrown(() =>
        sim.invoke("set_name_template", { template: bad }),
      );
      expect(typeof error).toBe("string");
      expect(error).toContain("invalid args `template`");
    }
    expect(settings().nameTemplate).toBe("titleId");
  });

  it("each download keeps the folder and name it was queued with", async () => {
    sim.invoke("set_name_template", { template: "title" });
    const one = enqueue(video("https://example.test/one"));
    // The settings change while the first is still running...
    await pick();
    sim.invoke("set_name_template", { template: "channelTitle" });
    const two = enqueue(audio("https://example.test/two"));
    vi.advanceTimersByTime(8000);
    expect(row(one).state).toBe("finished");
    expect(row(two).state).toBe("finished");
    // ...and the first did not move.
    expect(sim.finalPath(one)).toBe(`${first}\\Mock video ${one}.mp4`);
    expect(sim.finalPath(two)).toBe(
      `${second}\\Mock Channel - Mock audio ${two}.opus`,
    );
  });

  it("all three names, by the video's title", () => {
    const names: string[] = [];
    for (const template of ["title", "titleId", "channelTitle"]) {
      sim.invoke("set_name_template", { template });
      const id = enqueue(audio(`https://example.test/${template}`));
      vi.advanceTimersByTime(3000);
      names.push((sim.finalPath(id) as string).slice(first.length + 1));
    }
    expect(names).toEqual([
      expect.stringMatching(/^Mock audio \d+\.opus$/),
      expect.stringMatching(/^Mock audio \d+ \[mock0001\]\.opus$/),
      expect.stringMatching(/^Mock Channel - Mock audio \d+\.opus$/),
    ]);
  });

  it("the folder and name are never part of what the list returns", () => {
    const id = enqueue(video());
    expect(Object.keys(row(id)).sort()).toEqual([
      "batch",
      "createdAt",
      "error",
      "id",
      "request",
      "state",
      "thumbnail",
      "title",
      "updatedAt",
    ]);
  });

  it("the nofolder scenario fails with folderUnavailable and queues nothing", () => {
    const failure = thrown(() =>
      enqueue(video("https://example.test/nofolder")),
    );
    expect(failure).toMatchObject({ code: "folderUnavailable" });
    expect(list()).toEqual([]);
    expect(log).toEqual([]);
    // Like Rust, the folder is checked before the URL.
    expect(
      thrown(() =>
        sim.invoke("enqueue_download", { request: video("nofolder") }),
      ),
    ).toMatchObject({ code: "folderUnavailable" });
  });
});

describe("errors with an action", () => {
  const retryElsewhere = (id: number) =>
    sim.invoke("retry_in_other_folder", { id }) as Promise<OutputSettings>;
  const [first, second] = MOCK_FOLDERS;

  it("nospace fails with noSpace and a technical message while in the first folder", () => {
    const id = enqueue(video("https://example.test/nospace"));
    vi.advanceTimersByTime(400);
    const failed = row(id);
    expect(failed.state).toBe("failed");
    expect(failed.error?.code).toBe("noSpace");
    expect(failed.error?.message).toContain("No space left on device");
    expect(
      last(of(id).filter((e) => e.event === "download-failed")).payload,
    ).toEqual({ id, error: failed.error });
  });

  it("login fails with loginRequired", () => {
    const id = enqueue(video("https://example.test/login"));
    vi.advanceTimersByTime(400);
    expect(row(id).error?.code).toBe("loginRequired");
    // Nothing to fix by moving: refused before the picker, with the reason.
    expect(thrown(() => sim.invoke("retry_in_other_folder", { id }))).toEqual({
      code: "unknown",
      message: `download ${id} cannot be moved: it failed with loginRequired, which another folder does not fix`,
    });
  });

  it("another folder fixes nospace: it moves there, retries and works", async () => {
    sim.invoke("set_name_template", { template: "channelTitle" });
    const id = enqueue(audio("https://example.test/nospace"));
    vi.advanceTimersByTime(400);
    expect(row(id).state).toBe("failed");
    // Retrying in the same (full) folder fails again.
    sim.invoke("retry_download", { id });
    vi.advanceTimersByTime(400);
    expect(row(id).state).toBe("failed");

    const settings = await retryElsewhere(id);
    // The picker played "another folder": it is the new default and the answer.
    expect(settings).toEqual({
      outputDir: second,
      nameTemplate: "channelTitle",
      folderTooDeep: false,
    });
    // `failed → pending` (with its event) and straight on to `active`: there is a free slot.
    expect(states(id).slice(-2)).toEqual(["pending", "active"]);
    expect(row(id).state).toBe("active");
    expect(row(id).error).toBeNull();
    vi.advanceTimersByTime(3000);
    expect(row(id).state).toBe("finished");
    // The name did not change; the folder did.
    expect(sim.finalPath(id)).toBe(
      `${second}\\Mock Channel - Mock audio ${id}.opus`,
    );
  });

  it("cancelling the picker changes nothing and retries nothing", async () => {
    const id = enqueue(audio("https://example.test/nospace"));
    vi.advanceTimersByTime(400);
    // Turns of the picker: another folder, the first again, then a cancellation.
    await sim.invoke("pick_output_dir");
    await sim.invoke("pick_output_dir");
    const before = list();
    const after = await retryElsewhere(id);
    expect(after).toEqual({
      outputDir: first,
      nameTemplate: "titleId",
      folderTooDeep: false,
    });
    expect(list()).toEqual(before);
    expect(row(id).state).toBe("failed");
  });

  it("is refused for every state but failed, and for other errors, with Rust's messages", () => {
    const finished = enqueue(audio("https://example.test/done"));
    vi.advanceTimersByTime(3000);
    sim.invoke("set_max_concurrent", { max: 1 });
    const active = enqueue(video("https://example.test/running-slow"));
    const pending = enqueue(video("https://example.test/waiting"));
    const paused = enqueue(video("https://example.test/to-pause"));
    sim.invoke("pause_download", { id: paused });
    const cancelled = enqueue(video("https://example.test/to-cancel"));
    sim.invoke("cancel_download", { id: cancelled });
    for (const [id, state] of [
      [finished, "finished"],
      [active, "active"],
      [pending, "pending"],
      [paused, "paused"],
      [cancelled, "cancelled"],
    ] as const) {
      expect(row(id).state).toBe(state);
      expect(thrown(() => sim.invoke("retry_in_other_folder", { id }))).toEqual(
        {
          code: "unknown",
          message: `download ${id} cannot be moved: it is ${state}, not failed`,
        },
      );
    }
    sim.invoke("cancel_download", { id: active });
    vi.advanceTimersByTime(200);
    sim.invoke("cancel_download", { id: pending });
    sim.invoke("set_max_concurrent", { max: 3 });
    const gone = enqueue(video("https://example.test/fail"));
    vi.advanceTimersByTime(400);
    expect(row(gone).error?.code).toBe("unavailable");
    expect(
      thrown(() => sim.invoke("retry_in_other_folder", { id: gone })),
    ).toEqual({
      code: "unknown",
      message: `download ${gone} cannot be moved: it failed with unavailable, which another folder does not fix`,
    });
    expect(
      thrown(() => sim.invoke("retry_in_other_folder", { id: 999 })),
    ).toEqual({
      code: "unknown",
      message: "no download with id 999",
    });
    // The picker was never played for any of them.
    expect(
      (sim.invoke("get_output_settings") as OutputSettings).outputDir,
    ).toBe(first);
  });

  it("a bad id is a Tauri text, like the other commands", () => {
    expect(
      thrown(() => sim.invoke("retry_in_other_folder", { id: "x" })),
    ).toContain("invalid args `id`");
  });
});

describe("the clipboard", () => {
  it("write_text goes to the page's own clipboard, as read_text comes from it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await sim.invoke("plugin:clipboard-manager|write_text", {
      text: "noSpace: boom",
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("noSpace: boom");
    vi.unstubAllGlobals();
  });
});

describe("the limits and the cookies browser", () => {
  const settings = () => sim.invoke("get_download_settings");

  it("starts with the defaults and keeps what is set", () => {
    expect(settings()).toEqual({
      maxConcurrent: 3,
      limitRateKbps: null,
      cookiesBrowser: null,
      cookiesFile: null,
      notifications: true,
    });
    sim.invoke("set_max_concurrent", { max: 5 });
    sim.invoke("set_limit_rate", { kbps: 2048 });
    sim.invoke("set_cookies_browser", { browser: "firefox" });
    expect(settings()).toEqual({
      maxConcurrent: 5,
      limitRateKbps: 2048,
      cookiesBrowser: "firefox",
      cookiesFile: null,
      notifications: true,
    });
    sim.invoke("set_limit_rate", { kbps: null });
    sim.invoke("set_cookies_browser", { browser: null });
    expect(settings()).toMatchObject({
      limitRateKbps: null,
      cookiesBrowser: null,
    });
  });

  it("a limit of 0 is an AppError; anything that is not a number never reaches the command", () => {
    expect(thrown(() => sim.invoke("set_limit_rate", { kbps: 0 }))).toEqual({
      code: "unknown",
      message: "the speed limit must be at least 1 KB/s",
    });
    for (const bad of ["fast", -1, 1.5]) {
      expect(
        String(thrown(() => sim.invoke("set_limit_rate", { kbps: bad }))),
      ).toContain("invalid args `kbps` for command `set_limit_rate`");
    }
    expect(settings()).toMatchObject({ limitRateKbps: null });
  });

  it("only a browser from the list is accepted, as Tauri would say", () => {
    for (const bad of ["Chrome", "chrome:Default", "", 3]) {
      expect(
        String(
          thrown(() => sim.invoke("set_cookies_browser", { browser: bad })),
        ),
      ).toContain("unknown variant");
    }
    expect(settings()).toMatchObject({ cookiesBrowser: null });
  });

  it('"login" fails until a browser is chosen, in the download and in the analysis', async () => {
    const url = "https://example.test/login";
    const id = enqueue(video(url));
    vi.advanceTimersByTime(400);
    expect(row(id).error?.code).toBe("loginRequired");
    const analysis = sim.invoke("fetch_metadata", { url }) as Promise<Metadata>;
    const failing = expect(analysis).rejects.toMatchObject({
      code: "loginRequired",
    });
    await vi.advanceTimersByTimeAsync(600);
    await failing;

    sim.invoke("set_cookies_browser", { browser: "firefox" });
    const again = sim.invoke("fetch_metadata", { url }) as Promise<Metadata>;
    await vi.advanceTimersByTimeAsync(600);
    await expect(again).resolves.toMatchObject({ title: expect.any(String) });
    sim.invoke("retry_download", { id });
    await vi.advanceTimersByTimeAsync(10000);
    expect(row(id).state).toBe("finished");
  });

  it('"badcookies" fails with cookiesUnavailable only once a browser is chosen', () => {
    const url = "https://example.test/badcookies";
    const fine = enqueue(video(url));
    vi.advanceTimersByTime(10000);
    expect(row(fine).state).toBe("finished");
    sim.invoke("set_cookies_browser", { browser: "chrome" });
    const id = enqueue(video(`${url}2`));
    vi.advanceTimersByTime(400);
    expect(row(id).error?.code).toBe("cookiesUnavailable");
    expect(row(id).error?.message).toContain("chrome");
  });
});

describe("subtitle languages in the analysis", () => {
  const analyse = async (url: string) => {
    const result = sim.invoke("fetch_metadata", { url }) as Promise<Metadata>;
    await vi.advanceTimersByTimeAsync(600);
    return result;
  };

  it("lists a few, manual and automatic", async () => {
    const languages = (await analyse("https://example.test/v"))
      .subtitleLanguages;
    expect(languages.map((l) => l.code)).toEqual(["en", "en-orig", "es", "ja"]);
    expect(languages[0]).toMatchObject({ manual: true, auto: true });
    expect(languages[2]).toMatchObject({ manual: false, auto: true });
  });

  it('"nosubs" lists none', async () => {
    expect(
      (await analyse("https://example.test/nosubs")).subtitleLanguages,
    ).toEqual([]);
  });
});

describe("clearing the list (dismiss_ended_downloads)", () => {
  it("hides every download that has ended, says how many, and leaves the rest", () => {
    const done = enqueue(video("https://example.test/a"));
    const failed = enqueue(video("https://example.test/fail"));
    vi.advanceTimersByTime(10000);
    expect([row(done).state, row(failed).state]).toEqual([
      "finished",
      "failed",
    ]);
    const cancelled = enqueue(video("https://example.test/c"));
    sim.invoke("cancel_download", { id: cancelled });
    vi.advanceTimersByTime(300);
    const running = enqueue(video("https://example.test/slow"));
    vi.advanceTimersByTime(400);
    expect(row(running).state).toBe("active");

    expect(sim.invoke("dismiss_ended_downloads")).toBe(3);
    expect(list().map((d) => d.id)).toEqual([running]);
    // Nothing is left to hide the second time.
    expect(sim.invoke("dismiss_ended_downloads")).toBe(0);
  });

  it("an empty list hides nothing", () => {
    expect(sim.invoke("dismiss_ended_downloads")).toBe(0);
  });
});

describe("a cookies file", () => {
  const pick = () =>
    sim.invoke("pick_cookies_file") as Promise<DownloadSettings>;

  it("the picker plays a file, a cancellation and another file, in turn", async () => {
    const first = await pick();
    expect(first.cookiesFile).toBe("C:\\Mock\\Cookies\\cookies.txt");
    // Cancelled: nothing changes.
    expect((await pick()).cookiesFile).toBe(first.cookiesFile);
    const third = await pick();
    expect(third.cookiesFile).not.toBe(first.cookiesFile);
    expect(third.cookiesFile).toMatch(/cookies-youtube/);
    // And round again.
    expect((await pick()).cookiesFile).toBe(first.cookiesFile);
  });

  it("a file replaces the browser, and a browser (or none) replaces the file", async () => {
    sim.invoke("set_cookies_browser", { browser: "firefox" });
    const picked = await pick();
    expect(picked).toMatchObject({ cookiesBrowser: null });
    expect(picked.cookiesFile).not.toBeNull();
    sim.invoke("set_cookies_browser", { browser: "edge" });
    expect(sim.invoke("get_download_settings")).toMatchObject({
      cookiesBrowser: "edge",
      cookiesFile: null,
      notifications: true,
    });
    await pick();
    sim.invoke("set_cookies_browser", { browser: null });
    expect(sim.invoke("get_download_settings")).toMatchObject({
      cookiesBrowser: null,
      cookiesFile: null,
      notifications: true,
    });
  });

  it('a file lets the "login" links in, and "badcookies" fails it with its own message', async () => {
    await pick();
    const id = enqueue(video("https://example.test/login"));
    vi.advanceTimersByTime(10000);
    expect(row(id).state).toBe("finished");
    const bad = enqueue(video("https://example.test/badcookies"));
    vi.advanceTimersByTime(400);
    expect(row(bad).error?.code).toBe("cookiesUnavailable");
    expect(row(bad).error?.message).toContain(
      "does not look like a Netscape format cookies file",
    );
  });
});

describe("the history (list_history)", () => {
  const history = (search = "", state: unknown = null, kind: unknown = null) =>
    sim.invoke("list_history", { search, state, kind }) as History;

  // Three ended downloads, one of them cleared from the list, and one still running.
  function ended() {
    const song = enqueue(audio("https://example.test/song-one"));
    const clip = enqueue(video("https://example.test/clip"));
    const bad = enqueue(video("https://example.test/fail"));
    vi.advanceTimersByTime(10000);
    sim.invoke("dismiss_download", { id: song });
    const running = enqueue(video("https://example.test/slow"));
    vi.advanceTimersByTime(400);
    return { song, clip, bad, running };
  }

  it("holds every ended download, cleared or not, newest first, and nothing running", () => {
    const { song, clip, bad, running } = ended();
    const ids = history().items.map((d) => d.id);
    expect(ids).toEqual([bad, clip, song]);
    expect(ids).not.toContain(running);
    expect(history().more).toBe(false);
    // The list does not show the cleared one; the history does.
    expect(list().map((d) => d.id)).not.toContain(song);
    // Nothing of what Rust keeps to itself.
    expect(Object.keys(history().items[0])).not.toContain("outputPath");
  });

  it("filters by state, kind and a piece of the title or link, ignoring case", () => {
    const { song, clip, bad } = ended();
    const ids = (h: History) => h.items.map((d) => d.id);
    expect(ids(history("", "failed"))).toEqual([bad]);
    expect(ids(history("", "finished"))).toEqual([clip, song]);
    expect(ids(history("", null, "audio"))).toEqual([song]);
    expect(ids(history("", null, "video"))).toEqual([bad, clip]);
    expect(ids(history("SONG-ONE"))).toEqual([song]);
    expect(ids(history("  clip  "))).toEqual([clip]);
    expect(ids(history("nothing like this"))).toEqual([]);
  });

  it("cuts at 200 rows and says there were more", () => {
    for (let n = 0; n < 205; n++) {
      sim.invoke("enqueue_download", {
        request: audio(`https://example.test/a${n}`),
      });
      vi.advanceTimersByTime(10);
    }
    vi.advanceTimersByTime(200000);
    const answer = history();
    expect(answer.items).toHaveLength(200);
    expect(answer.more).toBe(true);
  });

  it("refuses what the backend refuses", () => {
    expect(thrown(() => history("", "active"))).toEqual({
      code: "unknown",
      message: "unknown download state: active",
    });
    expect(thrown(() => history("", null, "image"))).toEqual({
      code: "unknown",
      message: "unknown kind: image",
    });
    expect(typeof thrown(() => history(5 as unknown as string))).toBe("string");
  });
});

describe("notifications and the language", () => {
  it("notifications are on until turned off, and a non-boolean is refused like Tauri does", () => {
    const settings = () =>
      sim.invoke("get_download_settings") as DownloadSettings;
    expect(settings().notifications).toBe(true);
    sim.invoke("set_notifications", { on: false });
    expect(settings().notifications).toBe(false);
    sim.invoke("set_notifications", { on: true });
    expect(settings().notifications).toBe(true);
    expect(
      typeof thrown(() => sim.invoke("set_notifications", { on: "yes" })),
    ).toBe("string");
  });

  it("the language is es or en, and anything else is refused", () => {
    sim.invoke("set_ui_language", { language: "es" });
    expect(sim.uiLanguage).toBe("es");
    expect(
      thrown(() => sim.invoke("set_ui_language", { language: "fr" })),
    ).toEqual({
      code: "unknown",
      message: "unknown language: fr",
    });
    expect(sim.uiLanguage).toBe("es");
  });
});
