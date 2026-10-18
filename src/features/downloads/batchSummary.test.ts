import type { Download } from "@/lib/ipc";
import { batchSummary } from "./batchSummary";
import { EMPTY, reduce } from "./downloadsState";
import { download, progress } from "./testData";

// Entries as the store builds them: loaded from the list, then given progress.
function entries(
  rows: Partial<Download>[],
  percents: Record<number, number> = {},
) {
  let state = reduce(EMPTY, {
    type: "loaded",
    downloads: rows.map((patch, i) => download(i + 1, patch)),
  });
  for (const [id, percent] of Object.entries(percents)) {
    state = reduce(state, {
      type: "progress",
      id: Number(id),
      progress: progress({ downloadedBytes: percent, totalBytes: 100 }),
      now: 10,
    });
  }
  return Object.values(state);
}

describe("batchSummary", () => {
  it("is empty and unknown with no downloads", () => {
    expect(batchSummary([])).toEqual({
      total: 0,
      finished: 0,
      failed: 0,
      percent: null,
      done: false,
    });
  });

  it("counts every state: queued ones are 0, finished ones 100, running ones their own", () => {
    const s = batchSummary(
      entries(
        [
          { state: "finished" },
          { state: "active" },
          { state: "pending" },
          { state: "paused" },
        ],
        { 2: 60, 4: 40 },
      ),
    );
    // (100 + 60 + 0 + 40) / 4
    expect(s).toMatchObject({ total: 4, finished: 1, failed: 0, percent: 50 });
    expect(s.done).toBe(false);
  });

  it("an active download that has reported nothing yet is 0", () => {
    expect(
      batchSummary(entries([{ state: "active" }, { state: "finished" }])),
    ).toMatchObject({ percent: 50 });
  });

  it("never reaches 100 while one is still to finish, and is 100 when all are done", () => {
    const almost = batchSummary(
      entries([{ state: "finished" }, { state: "active" }], { 2: 100 }),
    );
    expect(almost.percent).toBe(99);
    const all = batchSummary(
      entries([{ state: "finished" }, { state: "finished" }]),
    );
    expect(all).toMatchObject({ percent: 100, finished: 2, done: true });
  });

  it("a failed download is counted apart and does not hold the bar down", () => {
    const s = batchSummary(
      entries([
        { state: "finished" },
        { state: "failed" },
        { state: "failed" },
        { state: "finished" },
      ]),
    );
    expect(s).toMatchObject({ total: 4, finished: 2, failed: 2, percent: 100 });
    expect(s.done).toBe(true);
  });

  it("a cancelled download leaves the batch altogether", () => {
    const s = batchSummary(
      entries([
        { state: "finished" },
        { state: "cancelled" },
        { state: "pending" },
      ]),
    );
    expect(s).toMatchObject({ total: 2, finished: 1, percent: 50 });
  });

  it("with only failed or cancelled ones left there is no percentage", () => {
    const s = batchSummary(
      entries([{ state: "failed" }, { state: "cancelled" }]),
    );
    expect(s).toMatchObject({
      total: 1,
      failed: 1,
      percent: null,
      done: false,
    });
  });
});
