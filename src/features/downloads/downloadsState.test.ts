import type { Download, Progress } from "@/lib/ipc";
import {
  awaitingNext,
  type DownloadsState,
  downloadPercent,
  EMPTY,
  type Entry,
  globalProgress,
  isKnown,
  newestFirst,
  partOf,
  percentOf,
  reduce,
  taskbarState,
  wholePercent,
} from "./downloadsState";
import { download, progress } from "./testData";

const loaded = (...downloads: Download[]): DownloadsState =>
  reduce(EMPTY, { type: "loaded", downloads });
const entry = (state: DownloadsState, id: number): Entry => state[id];

describe("loading", () => {
  it("builds one entry per download, newest first", () => {
    const state = loaded(download(1), download(3), download(2));
    expect(newestFirst(state).map((e) => e.download.id)).toEqual([3, 2, 1]);
    expect(isKnown(state, 2)).toBe(true);
    expect(isKnown(state, 9)).toBe(false);
  });

  it("a reload keeps the progress of what is still listed and drops the rest", () => {
    let state = loaded(download(1, { state: "active" }), download(2));
    state = reduce(state, {
      type: "progress",
      id: 1,
      progress: progress(),
      now: 10,
    });
    state = reduce(state, {
      type: "loaded",
      downloads: [download(1, { state: "paused" }), download(5)],
    });
    expect(Object.keys(state).sort()).toEqual(["1", "5"]);
    expect(entry(state, 1).progress).toEqual(progress());
    expect(entry(state, 1).download.state).toBe("paused");
    expect(entry(state, 5).progress).toBeNull();
  });
});

describe("events", () => {
  it("download-state updates the state and error of a known id", () => {
    const error = { code: "network" as const, message: "x" };
    const state = reduce(loaded(download(1)), {
      type: "state",
      event: { id: 1, state: "pending", error },
      now: 5,
    });
    expect(entry(state, 1).download).toMatchObject({
      state: "pending",
      error,
    });
  });

  it("an event for an unknown id changes nothing (the hook reloads instead)", () => {
    const before = loaded(download(1));
    expect(
      reduce(before, {
        type: "state",
        event: { id: 9, state: "active", error: null },
        now: 5,
      }),
    ).toBe(before);
    expect(
      reduce(before, { type: "progress", id: 9, progress: progress(), now: 5 }),
    ).toBe(before);
    expect(
      reduce(before, {
        type: "retrying",
        event: { id: 9, attempt: 1, maxAttempts: 5, delayMs: 1 },
      }),
    ).toBe(before);
  });

  it("progress is stored with its time", () => {
    const state = reduce(loaded(download(1, { state: "active" })), {
      type: "progress",
      id: 1,
      progress: progress(),
      now: 42,
    });
    expect(entry(state, 1)).toMatchObject({
      progressAt: 42,
      files: ["a.f1.mp4"],
    });
  });

  it("retrying is shown after its pending state and cleared when it starts", () => {
    let state = reduce(loaded(download(1, { state: "active" })), {
      type: "state",
      event: {
        id: 1,
        state: "pending",
        error: { code: "network", message: "x" },
      },
      now: 5,
    });
    state = reduce(state, {
      type: "retrying",
      event: { id: 1, attempt: 2, maxAttempts: 5, delayMs: 4000 },
    });
    expect(entry(state, 1).retry).toEqual({ attempt: 2, maxAttempts: 5 });
    state = reduce(state, {
      type: "state",
      event: { id: 1, state: "active", error: null },
      now: 9,
    });
    expect(entry(state, 1).retry).toBeNull();
    expect(entry(state, 1).activeAt).toBe(9);
  });

  it("download-finished makes sure of the state and drops a retry", () => {
    let state = loaded(download(1, { state: "active" }));
    state = reduce(state, {
      type: "retrying",
      event: { id: 1, attempt: 1, maxAttempts: 5, delayMs: 1 },
    });
    state = reduce(state, { type: "finished", id: 1 });
    expect(entry(state, 1).download.state).toBe("finished");
    expect(entry(state, 1).retry).toBeNull();
  });

  it("a dismissed download leaves the map", () => {
    const state = reduce(loaded(download(1), download(2)), {
      type: "dismissed",
      id: 1,
    });
    expect(Object.keys(state)).toEqual(["2"]);
  });
});

describe("files of a run (video and audio come as two)", () => {
  const run = (...names: (string | null)[]) => {
    let state = loaded(download(1, { state: "active" }));
    state = reduce(state, {
      type: "state",
      event: { id: 1, state: "active", error: null },
      now: 1,
    });
    names.forEach((filename, i) => {
      state = reduce(state, {
        type: "progress",
        id: 1,
        progress: progress({ filename }),
        now: 2 + i,
      });
    });
    return state;
  };

  it("a new file name is the next part; the same one stays", () => {
    expect(partOf(entry(run("v.mp4"), 1))).toBe(1);
    expect(partOf(entry(run("v.mp4", "v.mp4"), 1))).toBe(1);
    expect(partOf(entry(run("v.mp4", "v.mp4", "a.webm"), 1))).toBe(2);
    expect(entry(run("v.mp4", "a.webm"), 1).files).toEqual(["v.mp4", "a.webm"]);
  });

  it("an update with no file name does not start a part", () => {
    expect(partOf(entry(run("v.mp4", null), 1))).toBe(1);
  });

  it("a new run lists the files again from the first", () => {
    let state = run("v.mp4", "a.webm");
    state = reduce(state, {
      type: "state",
      event: { id: 1, state: "paused", error: null },
      now: 20,
    });
    state = reduce(state, {
      type: "state",
      event: { id: 1, state: "active", error: null },
      now: 30,
    });
    expect(entry(state, 1).files).toEqual([]);
    // The old progress stays (the bar keeps it), but it is older than the start.
    expect(entry(state, 1).progress).not.toBeNull();
    expect(entry(state, 1).progressAt).toBeLessThan(entry(state, 1).activeAt);
    state = reduce(state, {
      type: "progress",
      id: 1,
      progress: progress({ filename: "v.mp4" }),
      now: 35,
    });
    expect(partOf(entry(state, 1))).toBe(1);
  });
});

describe("percentOf", () => {
  it("bytes over total", () => {
    expect(percentOf(progress({ downloadedBytes: 25, totalBytes: 100 }))).toBe(
      25,
    );
  });

  it("is null without a total or downloaded bytes", () => {
    expect(percentOf(progress({ totalBytes: null }))).toBeNull();
    expect(percentOf(progress({ downloadedBytes: null }))).toBeNull();
  });

  it("finished is 100, even a file that was already there (no bytes)", () => {
    expect(
      percentOf(progress({ status: "finished", downloadedBytes: null })),
    ).toBe(100);
  });

  it("fragments win over the estimated total, and never pass 100 (23 of 22)", () => {
    const fragments = progress({
      downloadedBytes: 10,
      totalBytes: 10,
      fragmentIndex: 5,
      fragmentCount: 10,
    });
    expect(percentOf(fragments)).toBe(50);
    expect(
      percentOf({ ...fragments, fragmentIndex: 23, fragmentCount: 22 }),
    ).toBe(100);
    // Bytes beyond the total are capped too.
    expect(percentOf(progress({ downloadedBytes: 150, totalBytes: 100 }))).toBe(
      100,
    );
  });
});

describe("awaitingNext", () => {
  const active = (patch: Partial<Progress>, now = 10) =>
    entry(
      reduce(
        reduce(loaded(download(1, { state: "active" })), {
          type: "state",
          event: { id: 1, state: "active", error: null },
          now: 5,
        }),
        { type: "progress", id: 1, progress: progress(patch), now },
      ),
      1,
    );

  it("is true after a file finished in a running download", () => {
    expect(awaitingNext(active({ status: "finished" }))).toBe(true);
    expect(awaitingNext(active({ status: "downloading" }))).toBe(false);
  });

  it("ignores a finished update from before the last start", () => {
    expect(awaitingNext(active({ status: "finished" }, 3))).toBe(false);
  });

  it("is false when the download is not running", () => {
    const e = active({ status: "finished" });
    expect(
      awaitingNext({ ...e, download: { ...e.download, state: "paused" } }),
    ).toBe(false);
  });
});

// --- overall progress ---

describe("bytes per file", () => {
  it("each file keeps its bytes and size, by name", () => {
    let state = loaded(download(1, { state: "active" }));
    for (const [filename, done, total] of [
      ["v.mp4", 10, 100],
      ["v.mp4", 100, 100],
      ["a.webm", 1, 4],
    ] as const) {
      state = reduce(state, {
        type: "progress",
        id: 1,
        progress: progress({
          filename,
          downloadedBytes: done,
          totalBytes: total,
        }),
        now: 1,
      });
    }
    expect(entry(state, 1).bytes).toEqual({
      "v.mp4": { done: 100, total: 100 },
      "a.webm": { done: 1, total: 4 },
    });
  });

  it("a finished file has all its bytes even when yt-dlp did not say (it was already there)", () => {
    const state = reduce(loaded(download(1, { state: "active" })), {
      type: "progress",
      id: 1,
      progress: progress({
        status: "finished",
        downloadedBytes: null,
        totalBytes: 252182,
      }),
      now: 1,
    });
    expect(entry(state, 1).bytes["a.f1.mp4"]).toEqual({
      done: 252182,
      total: 252182,
    });
  });

  it("a fragmented file has no trustworthy size, and a file with no name is kept under ''", () => {
    const state = reduce(loaded(download(1, { state: "active" })), {
      type: "progress",
      id: 1,
      progress: progress({
        filename: null,
        fragmentIndex: 3,
        fragmentCount: 10,
        totalBytes: 999,
      }),
      now: 1,
    });
    expect(entry(state, 1).bytes[""]).toEqual({ done: 50, total: null });
  });

  it("the bytes survive a new run: a resumed download reports the same files", () => {
    let state = reduce(loaded(download(1, { state: "active" })), {
      type: "progress",
      id: 1,
      progress: progress(),
      now: 1,
    });
    state = reduce(state, {
      type: "state",
      event: { id: 1, state: "active", error: null },
      now: 9,
    });
    expect(entry(state, 1).bytes["a.f1.mp4"]).toEqual({
      done: 50,
      total: 100,
    });
  });
});

describe("downloadPercent", () => {
  const MB = 1024 * 1024;
  const run = (...updates: Partial<Progress>[]) => {
    let state = loaded(download(1, { state: "active" }));
    updates.forEach((update, i) => {
      state = reduce(state, {
        type: "progress",
        id: 1,
        progress: progress(update),
        now: i + 1,
      });
    });
    return entry(state, 1);
  };

  it("is null until the first update", () => {
    const none = entry(loaded(download(1, { state: "active" })), 1);
    expect(downloadPercent(none)).toBeNull();
  });

  it("one file: bytes over size", () => {
    expect(downloadPercent(run({ downloadedBytes: 25, totalBytes: 100 }))).toBe(
      25,
    );
  });

  it("two files: every byte over every size seen, so the jump to the audio does not go back to 0", () => {
    const video = (done: number) => ({
      filename: "v.mp4",
      downloadedBytes: done * MB,
      totalBytes: 680 * MB,
    });
    const audio = (done: number) => ({
      filename: "a.webm",
      downloadedBytes: done * MB,
      totalBytes: 3 * MB,
    });
    const steps = [
      downloadPercent(run(video(340))),
      downloadPercent(run(video(680))),
      // The audio shows up at 0 of 3 MB: 680 of 683.
      downloadPercent(run(video(680), audio(0))),
      downloadPercent(run(video(680), audio(1.5))),
      downloadPercent(run(video(680), audio(3))),
    ] as number[];
    expect(steps[0]).toBe(50);
    expect(steps[1]).toBe(100);
    expect(steps[2]).toBeCloseTo(99.56, 1);
    expect(steps[4]).toBe(100);
    // The only dip is the audio's share (under half a point), never a restart.
    expect(steps[1] - steps[2]).toBeLessThan(0.5);
    expect(steps[2]).toBeLessThan(steps[3]);
    expect(steps[3]).toBeLessThan(steps[4]);
  });

  it("without sizes (fragments) it is the current file's percentage, capped at 100 (23 of 22)", () => {
    const hls = { downloadedBytes: 10, totalBytes: 10, fragmentCount: 22 };
    expect(downloadPercent(run({ ...hls, fragmentIndex: 11 }))).toBe(50);
    expect(downloadPercent(run({ ...hls, fragmentIndex: 23 }))).toBe(100);
  });

  it("a file that never gave its size leaves no percentage at all, not a made-up one", () => {
    const unknown = run(
      { filename: "v.mp4", downloadedBytes: 100, totalBytes: 100 },
      { filename: "a.webm", downloadedBytes: 5, totalBytes: null },
    );
    expect(downloadPercent(unknown)).toBeNull();
  });

  it("never above 100, even if the bytes pass the size", () => {
    expect(
      downloadPercent(run({ downloadedBytes: 150, totalBytes: 100 })),
    ).toBe(100);
  });
});

describe("globalProgress", () => {
  const stateWith = (
    rows: [Download["state"], Partial<Progress> | null][],
  ): DownloadsState => {
    let state = loaded(...rows.map(([s], i) => download(i + 1, { state: s })));
    rows.forEach(([, update], i) => {
      if (update) {
        state = reduce(state, {
          type: "progress",
          id: i + 1,
          progress: progress(update),
          now: 1,
        });
      }
    });
    return state;
  };

  it("nothing running: no count, no percentage", () => {
    expect(globalProgress(EMPTY)).toEqual({ active: 0, percent: null });
    const idle = stateWith([
      ["pending", null],
      ["finished", { downloadedBytes: 100 }],
    ]);
    expect(globalProgress(idle)).toEqual({ active: 0, percent: null });
  });

  it("one running download", () => {
    const one = stateWith([
      ["active", { downloadedBytes: 30, totalBytes: 100 }],
    ]);
    expect(globalProgress(one)).toEqual({ active: 1, percent: 30 });
  });

  it("the mean of the running ones; paused, queued, finished, failed and cancelled are left out", () => {
    const g = globalProgress(
      stateWith([
        ["active", { downloadedBytes: 20, totalBytes: 100 }],
        ["active", { downloadedBytes: 60, totalBytes: 100 }],
        ["paused", { downloadedBytes: 99, totalBytes: 100 }],
        ["pending", null],
        ["finished", { status: "finished" }],
        ["failed", { downloadedBytes: 90, totalBytes: 100 }],
        ["cancelled", { downloadedBytes: 90, totalBytes: 100 }],
      ]),
    );
    expect(g).toEqual({ active: 2, percent: 40 });
  });

  it("a running download that has said nothing yet counts, but is not averaged", () => {
    const g = globalProgress(
      stateWith([
        ["active", { downloadedBytes: 50, totalBytes: 100 }],
        ["active", null],
      ]),
    );
    expect(g).toEqual({ active: 2, percent: 50 });
    expect(globalProgress(stateWith([["active", null]]))).toEqual({
      active: 1,
      percent: null,
    });
  });
});

describe("wholePercent and taskbarState", () => {
  it("rounds down and stops at 99: 100 would still be shown while the audio or the merge is left", () => {
    expect(wholePercent(null)).toBeNull();
    expect(wholePercent(0)).toBe(0);
    expect(wholePercent(45.9)).toBe(45);
    expect(wholePercent(99.56)).toBe(99);
    expect(wholePercent(100)).toBe(99);
    expect(wholePercent(120)).toBe(99);
  });

  it("none without running downloads, a bar with a number, the moving one without", () => {
    expect(taskbarState({ active: 0, percent: null })).toEqual({
      status: "none",
    });
    expect(taskbarState({ active: 0, percent: 50 })).toEqual({
      status: "none",
    });
    expect(taskbarState({ active: 2, percent: 45.9 })).toEqual({
      status: "normal",
      progress: 45,
    });
    expect(taskbarState({ active: 1, percent: null })).toEqual({
      status: "indeterminate",
    });
  });
});

describe("clearing the list", () => {
  const states = [
    "pending",
    "active",
    "paused",
    "finished",
    "failed",
    "cancelled",
  ] as const;
  const mixed = () =>
    loaded(...states.map((state, i) => download(i + 1, { state })));

  it("drops what has ended and keeps what has not", () => {
    const after = reduce(mixed(), { type: "dismissedEnded" });
    expect(
      Object.values(after)
        .map((e) => e.download.state)
        .sort(),
    ).toEqual(["active", "paused", "pending"]);
  });

  it("does nothing to a list with nothing ended, or to an empty one", () => {
    const running = loaded(download(1, { state: "active" }), download(2));
    expect(reduce(running, { type: "dismissedEnded" })).toEqual(running);
    expect(reduce(EMPTY, { type: "dismissedEnded" })).toEqual({});
  });

  it("keeps the progress of what stays", () => {
    const state = reduce(
      loaded(
        download(1, { state: "active" }),
        download(2, { state: "finished" }),
      ),
      {
        type: "progress",
        id: 1,
        progress: progress(),
        now: 5,
      },
    );
    const after = reduce(state, { type: "dismissedEnded" });
    expect(Object.keys(after)).toEqual(["1"]);
    expect(after[1].progress).not.toBeNull();
  });
});
