import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { loadSettings, updateSettings } from "@/features/settings/settings";
import {
  type Download,
  ERROR_CODES,
  type ErrorCode,
  type Progress,
} from "@/lib/ipc";
import { DownloadRow } from "./DownloadRow";
import type { Entry } from "./downloadsState";
import type { DownloadActions, Notice } from "./downloadsStore";
import { download, progress } from "./testData";

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
});

afterEach(() => {
  vi.useRealTimers();
});

const entry = (
  patch: Partial<Download>,
  extra: Partial<Entry> = {},
  p: Progress | null = null,
): Entry => ({
  download: download(7, patch),
  progress: p,
  progressAt: p ? 10 : 0,
  activeAt: 5,
  files: p?.filename ? [p.filename] : [],
  bytes: {},
  retry: null,
  ...extra,
});

const actions = (): DownloadActions => ({
  pause: vi.fn(),
  resume: vi.fn(),
  cancel: vi.fn(),
  retry: vi.fn(),
  retryElsewhere: vi.fn(),
  reveal: vi.fn(),
  dismiss: vi.fn(),
  openSettings: vi.fn(),
});

const show = (e: Entry, a = actions(), notice?: Notice) => {
  render(
    <ul>
      <DownloadRow entry={e} actions={a} notice={notice} />
    </ul>,
  );
  return a;
};

// The names of the row's action buttons, in order (the "View detail" toggle has no label of its
// own, it has text).
const buttons = () =>
  screen
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label"))
    .filter((name) => name !== null);
const bar = () => screen.getByRole("progressbar");

describe("each state shows its text and its buttons", () => {
  it("pending: queued, can only be cancelled", () => {
    show(entry({ state: "pending" }));
    expect(screen.getByText("Queued")).toBeTruthy();
    expect(buttons()).toEqual(["Cancel"]);
  });

  it("pending after a network error: which retry is next", () => {
    show(
      entry({ state: "pending" }, { retry: { attempt: 2, maxAttempts: 5 } }),
    );
    expect(screen.getByText("Retrying (2 of 5)")).toBeTruthy();
    expect(buttons()).toEqual(["Cancel"]);
  });

  it("active with nothing yet: starting; pause and cancel", () => {
    show(entry({ state: "active" }));
    expect(screen.getByText("Starting…")).toBeTruthy();
    expect(buttons()).toEqual(["Pause", "Cancel"]);
    // No number to show: the bar has no value.
    expect(bar().getAttribute("aria-valuenow")).toBeNull();
  });

  it("active: percentage, speed and time left; the bar follows", () => {
    show(
      entry(
        { state: "active" },
        {},
        progress({
          downloadedBytes: 40,
          totalBytes: 100,
          speed: 3 * 1024 * 1024,
          eta: 65,
        }),
      ),
    );
    expect(screen.getByText("40 % · 3.0 MB/s · 1:05 left")).toBeTruthy();
    expect(bar().getAttribute("aria-valuenow")).toBe("40");
    expect(buttons()).toEqual(["Pause", "Cancel"]);
  });

  it("active: no speed or time yet leaves them out", () => {
    show(entry({ state: "active" }, {}, progress({ speed: null, eta: null })));
    expect(screen.getByText("50 %")).toBeTruthy();
  });

  it("the second file of a video is Part 2, with its own bar", () => {
    const second = progress({ filename: "a.f2.webm", downloadedBytes: 10 });
    show(
      entry({ state: "active" }, { files: ["a.f1.mp4", "a.f2.webm"] }, second),
    );
    expect(screen.getByText(/^Part 2 · 10 %/)).toBeTruthy();
    expect(bar().getAttribute("aria-valuenow")).toBe("10");
  });

  it("an update from a previous run is not shown as current, but the bar keeps it", () => {
    show(
      entry(
        { state: "active" },
        { activeAt: 50, progressAt: 10 },
        progress({ downloadedBytes: 60 }),
      ),
    );
    expect(screen.getByText("Starting…")).toBeTruthy();
    expect(bar().getAttribute("aria-valuenow")).toBe("60");
  });

  it("paused: the bar stays where it was; resume and cancel", () => {
    show(entry({ state: "paused" }, {}, progress({ downloadedBytes: 30 })));
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(bar().getAttribute("aria-valuenow")).toBe("30");
    expect(buttons()).toEqual(["Resume", "Cancel"]);
  });

  it("finished: open folder and remove", () => {
    show(entry({ state: "finished" }));
    expect(screen.getByText("Finished")).toBeTruthy();
    expect(bar().getAttribute("aria-valuenow")).toBe("100");
    expect(buttons()).toEqual(["Open folder", "Remove from list"]);
  });

  it("failed: the error's text, retry and remove", () => {
    show(
      entry({
        state: "failed",
        error: { code: "unavailable", message: "ERROR: raw detail" },
      }),
    );
    expect(screen.getByText(/The content isn.t available/)).toBeTruthy();
    expect(buttons()).toEqual(["Retry", "Remove from list"]);
    // The raw message is behind "View detail", not in the row's text.
    const toggle = screen.getByRole("button", { name: "View detail" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByText("ERROR: raw detail")).toBeTruthy();
  });

  it("failed with an unknown code falls back to the generic text", () => {
    show(entry({ state: "failed", error: null }));
    expect(screen.getByText("Something unexpected went wrong.")).toBeTruthy();
  });

  it("cancelled: only remove", () => {
    show(entry({ state: "cancelled" }));
    expect(screen.getByText("Cancelled")).toBeTruthy();
    expect(buttons()).toEqual(["Remove from list"]);
  });
});

describe("the row's content", () => {
  it("shows the title, or the URL for an old row without one", () => {
    show(entry({ title: "Me at the zoo" }));
    expect(screen.getByText("Me at the zoo")).toBeTruthy();
  });

  it("falls back to the URL", () => {
    show(entry({ title: null }));
    expect(screen.getByText("https://example.test/7")).toBeTruthy();
  });

  it("a missing or broken thumbnail shows the placeholder", () => {
    const { unmount } = render(
      <ul>
        <DownloadRow entry={entry({})} actions={actions()} />
      </ul>,
    );
    expect(screen.getByTestId("row-thumbnail-placeholder")).toBeTruthy();
    unmount();
    const { container } = render(
      <ul>
        <DownloadRow
          entry={entry({ thumbnail: "https://i.test/x.jpg" })}
          actions={actions()}
        />
      </ul>,
    );
    const img = container.querySelector("img") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("https://i.test/x.jpg");
    fireEvent.error(img);
    expect(screen.getByTestId("row-thumbnail-placeholder")).toBeTruthy();
  });

  it("long titles cannot widen the row: the column shrinks and the text breaks anywhere", () => {
    show(entry({ title: "https://example.test/".concat("x".repeat(300)) }));
    const title = screen.getByText(/xxxx/);
    expect(title.className).toContain("line-clamp-2");
    expect(title.className).toContain("[overflow-wrap:anywhere]");
    expect(title.parentElement?.className).toContain("min-w-0");
  });

  it("shows the notice of a failed action", () => {
    show(entry({ state: "finished" }), actions(), {
      code: "revealFailed",
      message: "",
    });
    expect(screen.getByRole("alert").textContent).toBe(
      "The file is no longer on the disk.",
    );
    // Nothing technical to show for this one.
    expect(screen.queryByText("View detail")).toBeNull();
  });

  it("a refused action's notice has its code's text and the technical detail", () => {
    show(entry({ state: "active" }), actions(), {
      code: "unknown",
      message: "download 7 cannot go from active to pending",
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Something unexpected went wrong.");
    fireEvent.click(screen.getByRole("button", { name: "View detail" }));
    expect(screen.getByText(/cannot go from active to pending/)).toBeTruthy();
  });

  it("reads in Spanish", () => {
    updateSettings({ language: "es" });
    show(entry({ state: "paused" }));
    expect(screen.getByText("En pausa")).toBeTruthy();
    expect(buttons()).toEqual(["Reanudar", "Cancelar"]);
  });

  it("every button has a tooltip equal to its name", () => {
    show(entry({ state: "active" }));
    for (const b of screen.getAllByRole("button")) {
      expect(b.getAttribute("title")).toBe(b.getAttribute("aria-label"));
    }
  });
});

describe("the buttons call the actions with the row's id", () => {
  const cases: [Download["state"], string, keyof DownloadActions][] = [
    ["active", "Pause", "pause"],
    ["active", "Cancel", "cancel"],
    ["paused", "Resume", "resume"],
    ["failed", "Retry", "retry"],
    ["finished", "Open folder", "reveal"],
    ["finished", "Remove from list", "dismiss"],
  ];
  it.each(cases)("%s: %s", (state, name, action) => {
    const a = show(entry({ state }));
    fireEvent.click(screen.getByRole("button", { name }));
    expect(a[action]).toHaveBeenCalledExactlyOnceWith(7);
  });
});

describe("failed rows by error code", () => {
  const failedWith = (code: ErrorCode, message = "ERROR: raw detail") =>
    entry({ state: "failed", error: { code, message } });
  const others = ERROR_CODES.filter(
    (code) =>
      code !== "noSpace" &&
      code !== "folderUnavailable" &&
      code !== "loginRequired" &&
      code !== "cookiesUnavailable",
  );

  it.each(["noSpace", "folderUnavailable"] as const)(
    "%s offers to pick another folder and retry, between Retry and Remove",
    (code) => {
      show(failedWith(code));
      expect(buttons()).toEqual([
        "Retry",
        "Pick another folder and retry",
        "Remove from list",
      ]);
      const extra = screen.getByRole("button", {
        name: "Pick another folder and retry",
      });
      expect(extra.getAttribute("title")).toBe("Pick another folder and retry");
    },
  );

  it.each(others)("%s offers nothing new", (code) => {
    show(failedWith(code));
    expect(buttons()).toEqual(["Retry", "Remove from list"]);
  });

  it("the extra button calls its own action with the row's id", () => {
    const a = show(failedWith("noSpace"));
    fireEvent.click(
      screen.getByRole("button", { name: "Pick another folder and retry" }),
    );
    expect(a.retryElsewhere).toHaveBeenCalledExactlyOnceWith(7);
    expect(a.retry).not.toHaveBeenCalled();
  });

  it("its icon is not the one of Open folder", () => {
    show(failedWith("noSpace"));
    const icon = screen
      .getByRole("button", { name: "Pick another folder and retry" })
      .querySelector("svg");
    expect(icon?.getAttribute("class")).toContain("lucide-folder-sync");
    expect(icon?.getAttribute("class")).not.toContain("lucide-folder-open");
  });

  it("in Spanish: the buttons and the new texts", () => {
    updateSettings({ language: "es" });
    show(failedWith("noSpace"));
    expect(buttons()).toEqual([
      "Reintentar",
      "Elegir otra carpeta y reintentar",
      "Quitar de la lista",
    ]);
    expect(
      screen.getByText(/No queda espacio en el disco de destino/),
    ).toBeTruthy();
    expect(screen.getByText("Ver detalle")).toBeTruthy();
  });

  it.each(["loginRequired", "cookiesUnavailable"] as const)(
    "%s offers to open the settings, between Retry and Remove",
    (code) => {
      const a = show(failedWith(code));
      expect(buttons()).toEqual(["Retry", "Open settings", "Remove from list"]);
      fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
      expect(a.openSettings).toHaveBeenCalledExactlyOnceWith();
      expect(a.retry).not.toHaveBeenCalled();
    },
  );

  it("its icon is the gear, not a folder", () => {
    show(failedWith("loginRequired"));
    const icon = screen
      .getByRole("button", { name: "Open settings" })
      .querySelector("svg");
    expect(icon?.getAttribute("class")).toContain("lucide-settings");
  });

  it("loginRequired and cookiesUnavailable explain what to do, in both languages", () => {
    show(failedWith("loginRequired"));
    expect(
      screen.getByText(
        "This content requires signing in. You can use your browser's cookies in the settings and try again.",
      ),
    ).toBeTruthy();
    cleanup();
    show(failedWith("cookiesUnavailable"));
    expect(
      screen.getByText(
        "The cookies could not be read. If it is a browser: close it completely (also in the background); recent Chrome, Edge and Brave encrypt their cookies in a way yt-dlp cannot always decrypt on Windows, so try Firefox or a cookies.txt file. If it is a file: check that it is still there and that it is a cookies.txt.",
      ),
    ).toBeTruthy();
    cleanup();
    updateSettings({ language: "es" });
    show(failedWith("loginRequired"));
    expect(
      screen.getByText(
        "Este contenido pide iniciar sesión. Puedes usar las cookies de tu navegador en los ajustes y reintentar.",
      ),
    ).toBeTruthy();
    expect(buttons()).toEqual([
      "Reintentar",
      "Abrir ajustes",
      "Quitar de la lista",
    ]);
    cleanup();
    show(failedWith("cookiesUnavailable"));
    expect(
      screen.getByText(
        "No se han podido leer las cookies. Si es un navegador: ciérralo del todo (también en segundo plano); Chrome, Edge y Brave recientes cifran sus cookies de un modo que yt-dlp no siempre puede descifrar en Windows, así que prueba con Firefox o con un fichero cookies.txt. Si es un fichero: comprueba que sigue ahí y que es un cookies.txt.",
      ),
    ).toBeTruthy();
  });

  it("an error with no message has no detail to view", () => {
    show(failedWith("unknown", ""));
    expect(screen.queryByText("View detail")).toBeNull();
  });
});

describe("Processing…", () => {
  const finished = progress({ status: "finished", downloadedBytes: 100 });

  it("shows after 800 ms with nothing newer, not before", () => {
    vi.useFakeTimers();
    show(entry({ state: "active" }, {}, finished));
    expect(screen.queryByText("Processing…")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(799);
    });
    expect(screen.queryByText("Processing…")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Processing…")).toBeTruthy();
    // The bar pulses: there is nothing to measure.
    expect(bar().getAttribute("aria-valuenow")).toBeNull();
  });

  it("a newer update restarts the wait (video done, audio starting)", () => {
    vi.useFakeTimers();
    const e = entry({ state: "active" }, {}, finished);
    const { rerender } = render(
      <ul>
        <DownloadRow entry={e} actions={actions()} />
      </ul>,
    );
    act(() => {
      vi.advanceTimersByTime(500);
    });
    // The next file's first update arrives: no "Processing…" flicker.
    const next = {
      ...e,
      progress: progress({ filename: "a.f2.webm" }),
      files: ["a.f1.mp4", "a.f2.webm"],
      progressAt: 20,
    };
    rerender(
      <ul>
        <DownloadRow entry={next} actions={actions()} />
      </ul>,
    );
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText("Processing…")).toBeNull();
    expect(screen.getByText(/^Part 2/)).toBeTruthy();
  });

  it("goes away when the download ends", () => {
    vi.useFakeTimers();
    const e = entry({ state: "active" }, {}, finished);
    const { rerender } = render(
      <ul>
        <DownloadRow entry={e} actions={actions()} />
      </ul>,
    );
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByText("Processing…")).toBeTruthy();
    rerender(
      <ul>
        <DownloadRow
          entry={{ ...e, download: { ...e.download, state: "finished" } }}
          actions={actions()}
        />
      </ul>,
    );
    expect(screen.queryByText("Processing…")).toBeNull();
    expect(screen.getByText("Finished")).toBeTruthy();
  });

  it("never shows for a paused download, whatever its last update", () => {
    vi.useFakeTimers();
    show(entry({ state: "paused" }, {}, finished));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText("Processing…")).toBeNull();
  });
});
