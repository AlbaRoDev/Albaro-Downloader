// The progress of a batch: the entries chosen from one playlist. Pure, over the
// entries of the store.
import { downloadPercent, type Entry } from "./downloadsState";

export interface BatchSummary {
  // Downloads that still count: everything except the cancelled ones (cancelling one entry takes
  // it out of the batch, as dismissing it does).
  total: number;
  finished: number;
  // Downloads that failed. They are counted apart and left out of `percent`: a batch with a
  // broken entry could otherwise never reach 100.
  failed: number;
  // Whole number 0-100 over the downloads that can still finish, or null when there are none.
  // Like the global bar, it stays at 99 or below until every one of them is done.
  percent: number | null;
  // Nothing is left to do: every download that can finish has.
  done: boolean;
}

export function batchSummary(entries: Entry[]): BatchSummary {
  const live = entries.filter((e) => e.download.state !== "cancelled");
  const failed = live.filter((e) => e.download.state === "failed").length;
  const counted = live.filter((e) => e.download.state !== "failed");
  const finished = counted.filter(
    (e) => e.download.state === "finished",
  ).length;
  // A finished one is 100; one that has not started (or reported nothing yet) is 0; a paused one
  // keeps where it stopped.
  const sum = counted.reduce(
    (total, e) =>
      total +
      (e.download.state === "finished" ? 100 : (downloadPercent(e) ?? 0)),
    0,
  );
  const done = counted.length > 0 && finished === counted.length;
  return {
    total: live.length,
    finished,
    failed,
    percent:
      counted.length === 0
        ? null
        : done
          ? 100
          : Math.min(99, Math.floor(sum / counted.length)),
    done,
  };
}
