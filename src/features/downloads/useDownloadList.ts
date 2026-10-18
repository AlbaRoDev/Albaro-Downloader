import { useEffect } from "react";
import { useShallow } from "zustand/react/shallow";
import type { DownloadsState } from "./downloadsState";
import {
  type DownloadActions,
  downloadActions,
  startDownloadsStore,
  useDownloadsStore,
} from "./downloadsStore";

interface Slice {
  downloads: DownloadsState;
}

// The ids of the downloads in the list, newest first. A new array only when an id comes or goes
// (`useShallow` compares the items), so progress updates do not render whoever uses this.
const newestIds = (store: Slice) =>
  Object.keys(store.downloads)
    .map(Number)
    .sort((a, b) => b - a);

// What the list shows, newest first, as keys: "s<id>" for a download on its own and "b<batch>" for
// the entries of one playlist queued together, placed where its newest member is. A
// batch with a single download left (the others cancelled or dismissed) is shown as that download.
// Only keys, so the array is as stable as `newestIds`: the group and its rows read their own
// progress from the store.
const rowKeys = (store: Slice) => {
  const members = new Map<number, number>();
  for (const { download } of Object.values(store.downloads)) {
    if (download.batch) {
      members.set(download.batch.id, (members.get(download.batch.id) ?? 0) + 1);
    }
  }
  const seen = new Set<number>();
  const keys: string[] = [];
  for (const id of newestIds(store)) {
    const batch = store.downloads[id].download.batch?.id;
    if (batch === undefined || members.get(batch) === 1) keys.push(`s${id}`);
    else if (!seen.has(batch)) {
      seen.add(batch);
      keys.push(`b${batch}`);
    }
  }
  return keys;
};

// The download list: starts the store (it loads the list and follows the events,
// until the caller goes away) and gives the ids (all downloads), the rows to show and the actions.
// Each row reads its own entry from the store, so an update repaints that row only.
export function useDownloadList(): {
  ids: number[];
  rows: string[];
  actions: DownloadActions;
} {
  useEffect(() => startDownloadsStore(), []);
  const ids = useDownloadsStore(useShallow(newestIds));
  const rows = useDownloadsStore(useShallow(rowKeys));
  return { ids, rows, actions: downloadActions };
}
