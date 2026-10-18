import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { loadSettings, updateSettings } from "@/features/settings/settings";
import type { Download, History } from "@/lib/ipc";
import { HistoryView } from "./HistoryView";

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
});

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function row(id: number, extra: Partial<Download> = {}): Download {
  return {
    id,
    request: {
      url: `https://example.test/v/${id}`,
      mode: { kind: "video", maxHeight: null, container: "mp4" },
    },
    title: `Title ${id}`,
    thumbnail: null,
    state: "finished",
    error: null,
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 2, 12, 30),
    batch: null,
    ...extra,
  };
}

// Answers `list_history` with `history`, and records every command and its arguments.
function backend(
  history: History | ((args: Record<string, unknown>) => History),
  others: Record<string, (args: unknown) => unknown> = {},
) {
  const calls: [string, Record<string, unknown>][] = [];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    if (cmd === "list_history") {
      return typeof history === "function" ? history(a) : history;
    }
    return others[cmd]?.(args) ?? null;
  });
  return calls;
}

const histories = (calls: [string, unknown][]) =>
  calls.filter(([cmd]) => cmd === "list_history").map(([, args]) => args);

describe("the history", () => {
  it("lists every ended download, with its state, what was asked for and when", async () => {
    backend({
      items: [
        row(3, {
          state: "failed",
          error: { code: "network", message: "boom" },
        }),
        row(2, {
          request: {
            url: "https://example.test/v/2",
            mode: { kind: "audio", format: "mp3", bitrateKbps: 192 },
          },
          state: "cancelled",
        }),
        row(1, { title: null }),
      ],
      more: false,
    });
    render(<HistoryView />);
    const list = await screen.findByRole("list", { name: "3 downloads" });
    const items = [...list.querySelectorAll("li")];
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain("Title 3");
    expect(items[0].textContent).toContain("Failed · Video · MP4 best quality");
    expect(items[1].textContent).toContain("Cancelled · Audio · MP3");
    // A row from before titles were stored shows its link.
    expect(items[2].textContent).toContain("https://example.test/v/1");
    expect(items[2].textContent).toContain("Finished");
    // The date is written in the language of the app.
    expect(items[2].textContent).toMatch(/Oct 2, 2026/);
  });

  it("asks for everything at first, and again when a filter changes", async () => {
    const calls = backend({ items: [row(1)], more: false });
    render(<HistoryView />);
    await screen.findByRole("list");
    expect(histories(calls)).toEqual([{ search: "", state: null, kind: null }]);
    fireEvent.change(screen.getByLabelText("State"), {
      target: { value: "failed" },
    });
    fireEvent.change(screen.getByLabelText("Type"), {
      target: { value: "audio" },
    });
    await waitFor(() =>
      expect(histories(calls)[histories(calls).length - 1]).toEqual({
        search: "",
        state: "failed",
        kind: "audio",
      }),
    );
  });

  it("waits for a pause in the typing before it searches", async () => {
    vi.useFakeTimers();
    const calls = backend({ items: [row(1)], more: false });
    render(<HistoryView />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const box = screen.getByLabelText("Search by title or link");
    for (const text of ["z", "zo", "zoo"]) {
      fireEvent.change(box, { target: { value: text } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
    }
    // Three keystrokes 100 ms apart: still only the first question.
    expect(histories(calls)).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(histories(calls)).toEqual([
      { search: "", state: null, kind: null },
      { search: "zoo", state: null, kind: null },
    ]);
  });

  it("keeps only the answer to the latest question", async () => {
    let first: (history: History) => void = () => {};
    let asked = 0;
    mockIPC((cmd) => {
      if (cmd !== "list_history") return null;
      asked++;
      return asked === 1
        ? new Promise<History>((resolve) => {
            first = resolve;
          })
        : { items: [row(2, { title: "Newer" })], more: false };
    });
    render(<HistoryView />);
    fireEvent.change(screen.getByLabelText("State"), {
      target: { value: "failed" },
    });
    await screen.findByText("Newer");
    // The first question answers late: it must not replace the newer list.
    await act(async () =>
      first({ items: [row(1, { title: "Stale" })], more: false }),
    );
    expect(screen.queryByText("Stale")).toBeNull();
    expect(screen.getByText("Newer")).toBeTruthy();
  });

  it("says so when there is nothing yet, and when nothing matches", async () => {
    backend({ items: [], more: false });
    render(<HistoryView />);
    await screen.findByText("No finished, failed or cancelled downloads yet.");
    fireEvent.change(screen.getByLabelText("State"), {
      target: { value: "failed" },
    });
    await screen.findByText("No download matches the search.");
  });

  it("says when the list was cut", async () => {
    backend({ items: [row(1), row(2)], more: true });
    render(<HistoryView />);
    await screen.findByText(
      "Showing the 2 most recent. Narrow the search to see others.",
    );
  });

  it("says when the history cannot be read, also for an answer that is not a list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockIPC(() => {
      throw { code: "unknown", message: "database" };
    });
    const first = render(<HistoryView />);
    await screen.findByText("The history could not be read.");
    first.unmount();
    mockIPC(() => "not a history");
    render(<HistoryView />);
    await screen.findByText("The history could not be read.");
  });

  it("reads in Spanish", async () => {
    updateSettings({ language: "es" });
    backend({
      items: [
        row(1, { state: "failed", error: { code: "network", message: "x" } }),
      ],
      more: false,
    });
    render(<HistoryView />);
    await screen.findByText(/Fallida · Vídeo · MP4 máxima calidad/);
    expect(screen.getByLabelText("Buscar por título o enlace")).toBeTruthy();
  });

  it("downloads an entry again with the same request and its title", async () => {
    const download = row(5, { thumbnail: "https://example.test/t.jpg" });
    const calls = backend(
      { items: [download], more: false },
      { enqueue_download: () => 77 },
    );
    render(<HistoryView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Download again" }),
    );
    await screen.findByText("Added to the queue");
    expect(calls.find(([cmd]) => cmd === "enqueue_download")?.[1]).toEqual({
      request: download.request,
      info: { title: "Title 5", thumbnail: "https://example.test/t.jpg" },
    });
  });

  it("says why an entry could not be queued again", async () => {
    backend(
      { items: [row(5)], more: false },
      {
        enqueue_download: () => {
          throw { code: "alreadyQueued", message: "x is already in the queue" };
        },
      },
    );
    render(<HistoryView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Download again" }),
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This download is already in the queue.",
    );
  });

  it("shows a finished file in its folder; others have no such button", async () => {
    const calls = backend({
      items: [
        row(1),
        row(2, { state: "failed", error: { code: "network", message: "x" } }),
      ],
      more: false,
    });
    render(<HistoryView />);
    const reveal = await screen.findAllByRole("button", {
      name: "Open folder",
    });
    expect(reveal).toHaveLength(1);
    fireEvent.click(reveal[0]);
    await waitFor(() =>
      expect(calls.find(([cmd]) => cmd === "reveal_download")?.[1]).toEqual({
        id: 1,
      }),
    );
  });

  it("deletes the history only on the second press, and not after the time to think is over", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let cleared = 0;
    const calls = backend(
      { items: [row(1), row(2)], more: false },
      { clear_history: () => ++cleared },
    );
    render(<HistoryView />);
    const first = await screen.findByRole("button", { name: "Delete history" });
    fireEvent.click(first);
    // Asked, not done.
    expect(cleared).toBe(0);
    expect(
      screen.getByRole("button", { name: "Sure? Press again" }),
    ).toBeTruthy();
    // Left alone, it goes back.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(screen.getByRole("button", { name: "Delete history" })).toBeTruthy();
    expect(cleared).toBe(0);
    // Two presses in a row: deleted, and the list shows nothing (and no button to press).
    fireEvent.click(screen.getByRole("button", { name: "Delete history" }));
    fireEvent.click(screen.getByRole("button", { name: "Sure? Press again" }));
    await waitFor(() => expect(cleared).toBe(1));
    await waitFor(() => expect(screen.queryByText("Title 1")).toBeNull());
    expect(screen.queryByText("Title 2")).toBeNull();
    expect(
      screen.getByText("No finished, failed or cancelled downloads yet."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete history" })).toBeNull();
    expect(calls.filter(([cmd]) => cmd === "clear_history")).toHaveLength(1);
  });

  it("says when the history could not be deleted", async () => {
    backend(
      { items: [row(1)], more: false },
      {
        clear_history: () => {
          throw { code: "unknown", message: "database: locked" };
        },
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<HistoryView />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete history" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Sure? Press again" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The history could not be deleted.",
    );
  });

  it("offers no deletion when there is nothing to delete", async () => {
    backend({ items: [], more: false });
    render(<HistoryView />);
    await screen.findByText("No finished, failed or cancelled downloads yet.");
    expect(screen.queryByRole("button", { name: "Delete history" })).toBeNull();
  });

  it("says when the file is gone", async () => {
    backend(
      { items: [row(1)], more: false },
      {
        reveal_download: () => {
          throw { code: "unavailable", message: "gone" };
        },
      },
    );
    render(<HistoryView />);
    fireEvent.click(await screen.findByRole("button", { name: "Open folder" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "The file is no longer on the disk.",
    );
  });
});
