import { act, fireEvent, render, screen } from "@testing-library/react";
import { loadSettings, updateSettings } from "@/features/settings/settings";
import type { Download } from "@/lib/ipc";
import { BatchGroup } from "./BatchGroup";
import {
  downloadActions,
  resetDownloadsStore,
  useDownloadsStore,
} from "./downloadsStore";
import { download, progress } from "./testData";

const batch = { id: 7, title: "My list" };
const member = (id: number, patch: Partial<Download> = {}) =>
  download(id, { batch, title: `Song ${id}`, ...patch });

function load(rows: Download[]) {
  act(() => {
    useDownloadsStore.getState().dispatch({ type: "loaded", downloads: rows });
  });
}

const show = () =>
  render(
    <ul>
      <BatchGroup batchId={7} actions={downloadActions} />
    </ul>,
  );

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
});

afterEach(() => resetDownloadsStore());

it("shows the playlist's name, how many finished and one progress, with the rows closed", () => {
  load([
    member(1, { state: "finished" }),
    member(2, { state: "pending" }),
    member(3, { state: "pending" }),
    member(4, { state: "pending" }),
  ]);
  show();
  const header = screen.getByRole("button", { name: /My list/ });
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(screen.getByText("1 of 4 finished")).toBeTruthy();
  expect(screen.getByText("25 %")).toBeTruthy();
  const bar = screen.getByRole("progressbar", { name: "My list" });
  expect(bar.getAttribute("aria-valuenow")).toBe("25");
  // Closed: no rows.
  expect(screen.queryByText("Song 1")).toBeNull();
});

it("opens to show every download, and closes again", () => {
  load([member(1), member(2)]);
  show();
  const header = screen.getByRole("button", { name: /My list/ });
  fireEvent.click(header);
  expect(header.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Song 1")).toBeTruthy();
  expect(screen.getByText("Song 2")).toBeTruthy();
  // The newest on top, like the rest of the list.
  const titles = screen.getAllByText(/^Song \d$/).map((e) => e.textContent);
  expect(titles).toEqual(["Song 2", "Song 1"]);
  fireEvent.click(header);
  expect(screen.queryByText("Song 1")).toBeNull();
});

it("follows the progress of its downloads", () => {
  load([member(1, { state: "active" }), member(2, { state: "pending" })]);
  show();
  expect(screen.getByText("0 %")).toBeTruthy();
  act(() => {
    useDownloadsStore.getState().dispatch({
      type: "progress",
      id: 1,
      progress: progress({ downloadedBytes: 80, totalBytes: 100 }),
      now: 10,
    });
  });
  // (80 + 0) / 2
  expect(screen.getByText("40 %")).toBeTruthy();
});

it("counts the failed ones apart and still reaches 100 with the rest", () => {
  load([
    member(1, { state: "finished" }),
    member(2, { state: "failed" }),
    member(3, { state: "failed" }),
  ]);
  show();
  expect(screen.getByText("1 of 3 finished · 2 failed")).toBeTruthy();
  expect(screen.getByText("100 %")).toBeTruthy();
});

it("has a name when the playlist had none, and speaks Spanish", () => {
  updateSettings({ language: "es" });
  load([
    member(1, { state: "finished", batch: { id: 7, title: null } }),
    member(2, { state: "failed", batch: { id: 7, title: null } }),
  ]);
  show();
  expect(screen.getByText("Lista de reproducción")).toBeTruthy();
  expect(screen.getByText("1 de 2 terminada · 1 con error")).toBeTruthy();
});

it("a long name is cut instead of widening the row", () => {
  load([
    member(1, { batch: { id: 7, title: "x".repeat(300) } }),
    member(2, { batch: { id: 7, title: "x".repeat(300) } }),
  ]);
  show();
  expect(screen.getByText("x".repeat(300)).className).toContain("truncate");
});
