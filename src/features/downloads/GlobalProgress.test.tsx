import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { act, render, renderHook, screen } from "@testing-library/react";
import { loadSettings, updateSettings } from "@/features/settings/settings";
import type { Download, Progress } from "@/lib/ipc";
import { EMPTY, reduce } from "./downloadsState";
import { resetDownloadsStore, useDownloadsStore } from "./downloadsStore";
import { GlobalProgress, useTaskbarProgress } from "./GlobalProgress";
import { download, progress } from "./testData";

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
  resetDownloadsStore();
});

afterEach(() => {
  clearMocks();
  resetDownloadsStore();
});

// Puts rows in the store: [state, last progress update or null].
const setRows = (rows: [Download["state"], Partial<Progress> | null][]) => {
  let state = reduce(EMPTY, {
    type: "loaded",
    downloads: rows.map(([s], i) => download(i + 1, { state: s })),
  });
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
  act(() => useDownloadsStore.setState({ downloads: state }));
};

const bar = () => screen.queryByRole("progressbar");
const at = (percent: number): Partial<Progress> => ({
  downloadedBytes: percent,
  totalBytes: 100,
});

describe("the top bar's summary", () => {
  it("shows nothing while no download is running (but keeps its place)", () => {
    const { container } = render(<GlobalProgress />);
    expect(bar()).toBeNull();
    expect(container.firstElementChild?.className).toContain("flex-1");
    setRows([
      ["pending", null],
      ["paused", at(50)],
      ["finished", { status: "finished" }],
    ]);
    expect(bar()).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("appears with the first running download and goes with the last", () => {
    render(<GlobalProgress />);
    setRows([["active", at(45)]]);
    expect(screen.getByText("1 downloading · 45 %")).toBeTruthy();
    setRows([["finished", { status: "finished" }]]);
    expect(bar()).toBeNull();
    expect(screen.queryByText(/downloading/)).toBeNull();
  });

  it("counts the running ones and averages their percentage", () => {
    render(<GlobalProgress />);
    setRows([
      ["active", at(30)],
      ["active", at(60)],
      ["paused", at(99)],
      ["pending", null],
    ]);
    expect(screen.getByText("2 downloading · 45 %")).toBeTruthy();
    expect(bar()?.getAttribute("aria-valuenow")).toBe("45");
    expect(
      (bar()?.firstElementChild as HTMLElement | undefined)?.style.width,
    ).toBe("45%");
  });

  it("rounds down and never says 100 while something is still running", () => {
    render(<GlobalProgress />);
    setRows([["active", { downloadedBytes: 99.7, totalBytes: 100 }]]);
    expect(screen.getByText("1 downloading · 99 %")).toBeTruthy();
    // All the bytes of the file seen so far, with the audio or the merge still to come.
    setRows([["active", at(100)]]);
    expect(screen.getByText("1 downloading · 99 %")).toBeTruthy();
  });

  it("without any percentage yet: the count only, and a bar with no value that pulses", () => {
    render(<GlobalProgress />);
    setRows([["active", null]]);
    expect(screen.getByText("1 downloading")).toBeTruthy();
    expect(bar()?.getAttribute("aria-valuenow")).toBeNull();
    expect(bar()?.firstElementChild?.className).toContain("animate-pulse");
  });

  it("takes no minimum width while nothing runs, so the folder button keeps its room", () => {
    const { container } = render(<GlobalProgress />);
    expect((container.firstChild as HTMLElement).className).toContain(
      "min-w-0",
    );
    expect((container.firstChild as HTMLElement).className).not.toContain(
      "min-w-36",
    );
  });

  it("reads in Spanish", () => {
    updateSettings({ language: "es" });
    render(<GlobalProgress />);
    setRows([
      ["active", at(30)],
      ["active", at(60)],
    ]);
    expect(screen.getByText("2 descargando · 45 %")).toBeTruthy();
  });

  it("is a 2 px bar on the header's bottom edge, and the text is cut, never wider than the bar", () => {
    render(<GlobalProgress />);
    setRows([["active", at(10)]]);
    expect(bar()?.className).toContain("h-0.5");
    expect(bar()?.className).toContain("bottom-0");
    expect(bar()?.className).toContain("inset-x-0");
    const text = screen.getByText("1 downloading · 10 %");
    expect(text.className).toContain("truncate");
    expect(text.className).toContain("min-w-0");
    // A floor while something runs, so the folder button is what gives way...
    expect(text.parentElement?.className).toContain("min-w-36");
    expect(text.parentElement?.className).toContain("flex-1");
    // No live region: it would read every update aloud.
    expect(document.querySelector("[aria-live]")).toBeNull();
  });
});

describe("the taskbar icon", () => {
  // The calls the window plugin gets for `setProgressBar`.
  function backend() {
    const calls: unknown[] = [];
    mockWindows("main");
    mockIPC((cmd, args) => {
      if (cmd === "plugin:window|set_progress_bar") {
        calls.push((args as { value: unknown }).value);
      }
      return null;
    });
    return calls;
  }

  it("follows the global progress and is called only when the whole number changes", () => {
    const calls = backend();
    renderHook(() => useTaskbarProgress());
    // Nothing running at the start: the icon is already as it should be.
    expect(calls).toEqual([]);

    setRows([["active", null]]);
    setRows([["active", at(10)]]);
    setRows([["active", { downloadedBytes: 10.4, totalBytes: 100 }]]);
    setRows([["active", { downloadedBytes: 10.9, totalBytes: 100 }]]);
    setRows([["active", at(11)]]);
    setRows([
      ["active", at(11)],
      ["pending", null],
    ]);
    setRows([["paused", at(11)]]);
    setRows([["active", at(11)]]);

    expect(calls).toEqual([
      { status: "indeterminate" }, //: running, no number yet
      { status: "normal", progress: 10 },
      { status: "normal", progress: 11 },
      { status: "none" }, // paused: nothing running
      { status: "normal", progress: 11 },
    ]);
  });

  it("goes back to nothing when the last download ends", () => {
    const calls = backend();
    renderHook(() => useTaskbarProgress());
    setRows([["active", at(50)]]);
    setRows([["finished", { status: "finished" }]]);
    expect(calls).toEqual([
      { status: "normal", progress: 50 },
      { status: "none" },
    ]);
  });

  it("a refused call is logged, not thrown", async () => {
    mockWindows("main");
    mockIPC(() => Promise.reject("not allowed"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    renderHook(() => useTaskbarProgress());
    setRows([["active", at(5)]]);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
