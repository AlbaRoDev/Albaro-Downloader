import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import App from "./App";
import {
  resetDownloadsStore,
  useDownloadsStore,
} from "./features/downloads/downloadsStore";
import { loadSettings, updateSettings } from "./features/settings/settings";

beforeEach(() => {
  localStorage.clear();
  loadSettings();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearMocks();
});

it("renders the layout: title, paste button, settings and empty list", () => {
  updateSettings({ language: "es" });
  render(<App />);
  expect(
    screen.getByRole("heading", { name: "AlbaRo Downloader" }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Pegar enlace" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(screen.getByRole("button", { name: "Ajustes" })).toBeTruthy();
  expect(screen.getByText("Pega un enlace para empezar")).toBeTruthy();
  expect(screen.getByRole("main", { name: "Descargas" })).toBeTruthy();
});

it("changing the language in the settings panel changes the text at once", () => {
  updateSettings({ language: "es" });
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Ajustes" }));
  fireEvent.click(screen.getByRole("radio", { name: "English" }));
  expect(screen.getByRole("button", { name: "Paste link" })).toBeTruthy();
  expect(screen.getByText("Paste a link to get started")).toBeTruthy();
  expect(localStorage.getItem("albaro.language")).toBe("en");
});

it("works on the defaults when localStorage throws", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("denied");
  });
  loadSettings();
  render(<App />);
  // jsdom's navigator.language is "en-US": "system" means English.
  expect(screen.getByRole("button", { name: "Paste link" })).toBeTruthy();
});

it("the paste button shows the link's preview in place of the empty list", async () => {
  updateSettings({ language: "en" });
  mockIPC((cmd, args) =>
    cmd === "plugin:clipboard-manager|read_text"
      ? "HTTPS://a.test/v"
      : {
          id: "x",
          title: `Preview of ${(args as { url: string }).url}`,
          channel: null,
          duration: 61,
          thumbnail: null,
          webpageUrl: "",
          extractor: "test",
          isLive: false,
          formats: [],
        },
  );
  render(<App />);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Paste link" }));
  });
  expect(
    screen.getByRole("heading", { name: "Preview of https://a.test/v" }),
  ).toBeTruthy();
  expect(screen.queryByText("Paste a link to get started")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.getByText("Paste a link to get started")).toBeTruthy();
});

describe("the download list", () => {
  const rows = [
    {
      id: 1,
      request: {
        url: "https://a.test/1",
        mode: { kind: "audio", format: "best", bitrateKbps: null },
      },
      title: "First one",
      thumbnail: null,
      state: "finished",
      error: null,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: 2,
      request: {
        url: "https://a.test/2",
        mode: { kind: "audio", format: "best", bitrateKbps: null },
      },
      title: null,
      thumbnail: null,
      state: "paused",
      error: null,
      createdAt: 2,
      updatedAt: 2,
    },
  ];

  it("shows the downloads the app already had when it opens, newest first, and no empty state", async () => {
    updateSettings({ language: "en" });
    mockIPC((cmd) => (cmd === "list_downloads" ? rows : null), {
      shouldMockEvents: true,
    });
    render(<App />);
    const list = await screen.findByRole("list", { name: "2 downloads" });
    const titles = [...list.querySelectorAll("li p:first-child")].map(
      (p) => p.textContent,
    );
    // The second has no title (queued before titles were stored): its URL stands in.
    expect(titles).toEqual(["https://a.test/2", "First one"]);
    expect(screen.queryByText("Paste a link to get started")).toBeNull();
  });

  it("removing a row hides it, and the empty state returns with the last one", async () => {
    updateSettings({ language: "en" });
    const left = [...rows];
    mockIPC(
      (cmd, args) => {
        if (cmd === "list_downloads") return left;
        if (cmd === "dismiss_download") {
          const id = (args as { id: number }).id;
          left.splice(
            left.findIndex((r) => r.id === id),
            1,
          );
        }
        return null;
      },
      { shouldMockEvents: true },
    );
    render(<App />);
    await screen.findByRole("list", { name: /downloads/ });
    // Only the finished one can be removed (the paused one is still work).
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Remove from list" }));
    });
    expect(screen.queryByText("First one")).toBeNull();
    expect(screen.getByRole("list", { name: "1 download" })).toBeTruthy();
  });
});

it("the history button swaps the list for the history and back", async () => {
  updateSettings({ language: "en" });
  resetDownloadsStore();
  mockIPC((cmd) =>
    cmd === "list_history" ? { items: [], more: false } : null,
  );
  render(<App />);
  expect(screen.queryByRole("region", { name: "History" })).toBeNull();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "History" }));
  });
  expect(screen.getByRole("region", { name: "History" })).toBeTruthy();
  // The paste button and the rest of the bar stay; the empty state is gone.
  expect(screen.getByRole("button", { name: "Paste link" })).toBeTruthy();
  expect(screen.queryByText("Paste a link to get started")).toBeNull();
  const back = screen.getByRole("button", { name: "Back to downloads" });
  expect(back.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(back);
  expect(screen.queryByRole("region", { name: "History" })).toBeNull();
  expect(screen.getByText("Paste a link to get started")).toBeTruthy();
});

it("tells the backend the language at start and when it changes", async () => {
  updateSettings({ language: "es" });
  const calls: [string, unknown][] = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    return null;
  });
  render(<App />);
  const sent = () =>
    calls.filter(([cmd]) => cmd === "set_ui_language").map(([, args]) => args);
  await act(async () => {});
  expect(sent()).toEqual([{ language: "es" }]);
  fireEvent.click(screen.getByRole("button", { name: "Ajustes" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("radio", { name: "English" }));
  });
  expect(sent()).toEqual([{ language: "es" }, { language: "en" }]);
});

describe("keyboard shortcuts", () => {
  const press = (init: KeyboardEventInit & { key: string }) =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        }),
      );
    });

  beforeEach(() => {
    updateSettings({ language: "en" });
    resetDownloadsStore();
    mockIPC((cmd) =>
      cmd === "list_history" ? { items: [], more: false } : null,
    );
  });

  it("Ctrl+H opens the history and Ctrl+H or Escape goes back", async () => {
    render(<App />);
    await press({ key: "h", ctrlKey: true });
    expect(screen.getByRole("region", { name: "History" })).toBeTruthy();
    await press({ key: "h", ctrlKey: true });
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
    await press({ key: "h", ctrlKey: true });
    expect(screen.getByRole("region", { name: "History" })).toBeTruthy();
    await press({ key: "Escape" });
    expect(screen.queryByRole("region", { name: "History" })).toBeNull();
  });

  it("Ctrl+, opens the settings panel", async () => {
    render(<App />);
    expect(useDownloadsStore.getState().settingsOpen).toBe(false);
    await press({ key: ",", ctrlKey: true });
    expect(useDownloadsStore.getState().settingsOpen).toBe(true);
    expect(screen.getByText("Keyboard shortcuts")).toBeTruthy();
  });

  it("Escape dismisses the preview card, and does nothing with nothing open", async () => {
    mockIPC((cmd, args) =>
      cmd === "fetch_metadata"
        ? {
            id: "x",
            title: `T ${(args as { url: string }).url}`,
            channel: null,
            duration: 5,
            thumbnail: null,
            webpageUrl: "",
            extractor: "t",
            isLive: false,
            formats: [],
          }
        : null,
    );
    render(<App />);
    await press({ key: "Escape" });
    // jsdom has no ClipboardEvent with data: a plain `paste` event carrying `clipboardData`.
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "https://a.test/v" },
    });
    await act(async () => {
      document.dispatchEvent(paste);
    });
    await screen.findByText(/T https:\/\/a.test\/v/);
    await press({ key: "Escape" });
    expect(screen.queryByText(/T https:\/\/a.test\/v/)).toBeNull();
  });

  it("the buttons say their shortcut in their tooltip", () => {
    render(<App />);
    expect(
      screen.getByRole("button", { name: "History" }).getAttribute("title"),
    ).toBe("History (Ctrl+H)");
    expect(
      screen.getByRole("button", { name: "Settings" }).getAttribute("title"),
    ).toBe("Settings (Ctrl+,)");
  });

  it("the settings panel lists them", async () => {
    render(<App />);
    await press({ key: ",", ctrlKey: true });
    const panel = screen.getByRole("dialog");
    for (const keys of ["Ctrl+V", "Ctrl+H", "Ctrl+,", "Esc"]) {
      expect(within(panel).getByText(keys)).toBeTruthy();
    }
  });
});
