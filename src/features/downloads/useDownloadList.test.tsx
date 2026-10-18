import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { downloadActions, resetDownloadsStore } from "./downloadsStore";
import { download, progress } from "./testData";
import { useDownloadList } from "./useDownloadList";

afterEach(() => {
  clearMocks();
  resetDownloadsStore();
});

const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

it("gives the ids newest first and the store's actions", async () => {
  mockIPC(
    (cmd) =>
      cmd === "list_downloads" ? [download(1), download(3), download(2)] : null,
    { shouldMockEvents: true },
  );
  const hook = renderHook(() => useDownloadList());
  await waitFor(() => expect(hook.result.current.ids).toEqual([3, 2, 1]));
  expect(hook.result.current.actions).toBe(downloadActions);
});

it("works without a backend (a plain browser or test)", () => {
  const hook = renderHook(() => useDownloadList());
  expect(hook.result.current.ids).toEqual([]);
});

it("the ids array stays the same object while only progress changes", async () => {
  mockIPC(
    (cmd) =>
      cmd === "list_downloads" ? [download(1, { state: "active" })] : null,
    { shouldMockEvents: true },
  );
  let renders = 0;
  const hook = renderHook(() => {
    renders++;
    return useDownloadList();
  });
  await waitFor(() => expect(hook.result.current.ids).toEqual([1]));
  await settle();
  const ids = hook.result.current.ids;
  const before = renders;
  await act(async () => {
    for (let i = 1; i <= 5; i++) {
      await emit("download-progress", {
        id: 1,
        progress: progress({ downloadedBytes: i }),
      });
    }
  });
  expect(hook.result.current.ids).toBe(ids);
  expect(renders).toBe(before);
});

it("under StrictMode it does not double the listeners", async () => {
  mockIPC(
    (cmd) =>
      cmd === "list_downloads" ? [download(1, { state: "active" })] : null,
    { shouldMockEvents: true },
  );
  const hook = renderHook(() => useDownloadList(), { wrapper: StrictMode });
  await waitFor(() => expect(hook.result.current.ids).toEqual([1]));
  await settle();
  const { useDownloadsStore } = await import("./downloadsStore");
  let changes = 0;
  const stop = useDownloadsStore.subscribe((now, before) => {
    if (now.downloads !== before.downloads) changes++;
  });
  await act(async () => {
    await emit("download-progress", { id: 1, progress: progress() });
  });
  stop();
  expect(changes).toBe(1);
});

describe("rows", () => {
  const batch = (id: number, title = "List") => ({ id, title });
  const rowsFor = async (list: ReturnType<typeof download>[]) => {
    mockIPC((cmd) => (cmd === "list_downloads" ? list : null), {
      shouldMockEvents: true,
    });
    const hook = renderHook(() => useDownloadList());
    await waitFor(() =>
      expect(hook.result.current.ids).toHaveLength(list.length),
    );
    return hook;
  };

  it("a batch is one row, placed where its newest member is", async () => {
    const hook = await rowsFor([
      download(1, { batch: batch(7) }),
      download(2),
      download(3, { batch: batch(7) }),
      download(4),
      download(5, { batch: batch(8) }),
      download(6, { batch: batch(8) }),
    ]);
    expect(hook.result.current.rows).toEqual(["b8", "s4", "b7", "s2"]);
    // `ids` still has every download.
    expect(hook.result.current.ids).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it("a batch with one download left is shown as that download", async () => {
    const hook = await rowsFor([
      download(1, { batch: batch(7) }),
      download(2, { batch: batch(7), state: "cancelled" }),
    ]);
    expect(hook.result.current.rows).toHaveLength(1);
    // The cancelled one is still in the list until dismissed, so it counts as a member.
    expect(hook.result.current.rows).toEqual(["b7"]);
    await act(async () => {
      const { dispatch } = (
        await import("./downloadsStore")
      ).useDownloadsStore.getState();
      dispatch({ type: "dismissed", id: 2 });
    });
    expect(hook.result.current.rows).toEqual(["s1"]);
  });

  it("stays the same array while only progress changes", async () => {
    const hook = await rowsFor([
      download(1, { batch: batch(7), state: "active" }),
      download(2, { batch: batch(7), state: "active" }),
    ]);
    await settle();
    const rows = hook.result.current.rows;
    await act(async () => {
      await emit("download-progress", { id: 1, progress: progress() });
    });
    expect(hook.result.current.rows).toBe(rows);
  });
});
