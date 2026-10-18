import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { loadSettings, updateSettings } from "@/features/settings/settings";
import type { Download } from "@/lib/ipc";
import { DownloadList } from "./DownloadList";
import {
  downloadActions,
  resetDownloadsStore,
  useDownloadsStore,
} from "./downloadsStore";
import { download } from "./testData";
import { useDownloadList } from "./useDownloadList";

// The list as App draws it: the rows come from `useDownloadList`, which reads the store.
function Harness() {
  const list = useDownloadList();
  return (
    <DownloadList
      rows={list.rows}
      count={list.ids.length}
      actions={downloadActions}
    />
  );
}

const load = (rows: Download[]) =>
  act(() => {
    useDownloadsStore.getState().dispatch({ type: "loaded", downloads: rows });
  });
const rowsLeft = () =>
  Object.keys(useDownloadsStore.getState().downloads).map(Number).sort();
const clearButton = () => screen.queryByRole("button", { name: /^Clear list/ });

let calls: string[];
let hidden: number;

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
  resetDownloadsStore();
  calls = [];
  hidden = 0;
  mockIPC((cmd) => {
    calls.push(cmd);
    if (cmd === "dismiss_ended_downloads") return hidden;
    return null;
  });
});

afterEach(() => clearMocks());

describe("Clear list (what the user asked for after many playlists)", () => {
  it("is not there while nothing has ended", () => {
    load([
      download(1, { state: "active" }),
      download(2),
      download(3, { state: "paused" }),
    ]);
    render(<Harness />);
    expect(clearButton()).toBeNull();
  });

  it("counts finished, failed and cancelled, and only those", () => {
    load([
      download(1, { state: "finished" }),
      download(2, { state: "failed" }),
      download(3, { state: "cancelled" }),
      download(4, { state: "active" }),
      download(5),
    ]);
    render(<Harness />);
    expect(screen.getByRole("button", { name: "Clear list (3)" })).toBeTruthy();
  });

  it("says in its hint that no file is deleted", () => {
    load([download(1, { state: "finished" })]);
    render(<Harness />);
    expect(clearButton()?.getAttribute("title")).toBe(
      "Removes the finished, failed and cancelled downloads from the list. No file is deleted.",
    );
  });

  it("asks the backend once and the list drops what ended, keeping the rest", async () => {
    hidden = 3;
    load([
      download(1, { state: "finished" }),
      download(2, { state: "failed" }),
      download(3, { state: "cancelled" }),
      download(4, { state: "active" }),
      download(5),
    ]);
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear list (3)" }));
    });
    expect(calls.filter((c) => c === "dismiss_ended_downloads")).toHaveLength(
      1,
    );
    expect(rowsLeft()).toEqual([4, 5]);
    // Nothing has ended any more: the button goes.
    expect(clearButton()).toBeNull();
    expect(screen.getByRole("list", { name: "2 downloads" })).toBeTruthy();
  });

  it("clears a playlist's group when all its entries have ended", async () => {
    const batch = { id: 7, title: "My list" };
    load([
      download(1, { state: "finished", batch }),
      download(2, { state: "finished", batch }),
      download(3, { state: "active" }),
    ]);
    render(<Harness />);
    expect(screen.getByText("My list")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear list (2)" }));
    });
    expect(screen.queryByText("My list")).toBeNull();
    expect(rowsLeft()).toEqual([3]);
  });

  it("leaves the list as it was if the backend refuses", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    clearMocks();
    mockIPC((cmd) =>
      cmd === "dismiss_ended_downloads"
        ? Promise.reject({ code: "unknown", message: "database: locked" })
        : null,
    );
    load([download(1, { state: "finished" })]);
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear list (1)" }));
    });
    expect(rowsLeft()).toEqual([1]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("is in Spanish too", () => {
    updateSettings({ language: "es" });
    load([
      download(1, { state: "finished" }),
      download(2, { state: "failed" }),
    ]);
    render(<Harness />);
    expect(
      screen.getByRole("button", { name: "Limpiar lista (2)" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: "Limpiar lista (2)" })
        .getAttribute("title"),
    ).toBe(
      "Quita de la lista las descargas terminadas, fallidas y canceladas. No borra ningún fichero.",
    );
  });
});
