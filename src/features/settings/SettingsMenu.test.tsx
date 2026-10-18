import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  resetDownloadsStore,
  settingsActions,
  useDownloadsStore,
} from "@/features/downloads/downloadsStore";
import type { DownloadSettings } from "@/lib/ipc";
import { SettingsMenu } from "./SettingsMenu";
import { loadSettings, updateSettings } from "./settings";

const defaults: DownloadSettings = {
  maxConcurrent: 3,
  limitRateKbps: null,
  cookiesBrowser: null,
  cookiesFile: null,
  notifications: true,
};

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
});

afterEach(() => {
  clearMocks();
  resetDownloadsStore();
});

const load = (settings: DownloadSettings | null) =>
  act(() => useDownloadsStore.setState({ settings }));
const open = () =>
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
const select = (name: string) =>
  screen.getByRole("combobox", { name }) as HTMLSelectElement;
const optionTexts = (name: string) =>
  [...select(name).options].map((o) => o.textContent);

// Records the commands the panel sends.
function backend() {
  const calls: [string, unknown][] = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    return null;
  });
  return calls;
}

describe("the downloads' settings", () => {
  it("are disabled until the backend has answered", () => {
    render(<SettingsMenu />);
    open();
    for (const name of [
      "Simultaneous downloads",
      "Speed limit",
      "Browser cookies",
    ]) {
      expect(select(name).disabled).toBe(true);
    }
  });

  it("show what is in force", () => {
    render(<SettingsMenu />);
    load({
      ...defaults,
      maxConcurrent: 4,
      limitRateKbps: 2048,
      cookiesBrowser: "edge",
    });
    open();
    expect(select("Simultaneous downloads").value).toBe("4");
    expect(select("Speed limit").value).toBe("2048");
    expect(select("Browser cookies").value).toBe("edge");
    expect(select("Speed limit").disabled).toBe(false);
  });

  it("offer the usual choices, cookies off and no limit by default", () => {
    render(<SettingsMenu />);
    load(defaults);
    open();
    expect(select("Speed limit").value).toBe("");
    expect(select("Browser cookies").value).toBe("");
    expect(optionTexts("Speed limit").slice(0, 4)).toEqual([
      "No limit",
      "512 KB/s",
      "1 MB/s",
      "2 MB/s",
    ]);
    expect(optionTexts("Browser cookies")).toEqual([
      "Don't use",
      "Chrome",
      "Edge",
      "Firefox",
      "Brave",
      "Opera",
      "Vivaldi",
      "Chromium",
      "cookies.txt file…",
    ]);
    expect(optionTexts("Simultaneous downloads")).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "8",
      "10",
    ]);
  });

  it("add a saved value that is not in the list, so the panel never lies", () => {
    render(<SettingsMenu />);
    load({ ...defaults, maxConcurrent: 7, limitRateKbps: 3000 });
    open();
    expect(select("Speed limit").value).toBe("3000");
    expect(optionTexts("Speed limit")).toContain("3000 KB/s");
    expect(select("Simultaneous downloads").value).toBe("7");
    expect(optionTexts("Simultaneous downloads")).toContain("7");
  });

  it("offer Safari only where it exists, or when it is the saved one", () => {
    render(<SettingsMenu />);
    load(defaults);
    open();
    expect(optionTexts("Browser cookies")).not.toContain("Safari");
    act(() => settingsActions.setOpen(true));
    load({ ...defaults, cookiesBrowser: "safari" });
    expect(optionTexts("Browser cookies")).toContain("Safari");
  });

  it("send each change to its command", async () => {
    const calls = backend();
    render(<SettingsMenu />);
    load(defaults);
    open();
    await act(async () => {
      fireEvent.change(select("Simultaneous downloads"), {
        target: { value: "5" },
      });
      fireEvent.change(select("Speed limit"), { target: { value: "5120" } });
      fireEvent.change(select("Browser cookies"), {
        target: { value: "firefox" },
      });
    });
    expect(calls).toEqual([
      ["set_max_concurrent", { max: 5 }],
      ["set_limit_rate", { kbps: 5120 }],
      ["set_cookies_browser", { browser: "firefox" }],
    ]);
    expect(select("Speed limit").value).toBe("5120");
    await act(async () => {
      fireEvent.change(select("Speed limit"), { target: { value: "" } });
      fireEvent.change(select("Browser cookies"), { target: { value: "" } });
    });
    expect(calls.slice(3)).toEqual([
      ["set_limit_rate", { kbps: null }],
      ["set_cookies_browser", { browser: null }],
    ]);
  });

  it("explain the limit and the cookies", () => {
    render(<SettingsMenu />);
    load(defaults);
    open();
    expect(
      screen.getByText("Shared among the downloads that can run at once."),
    ).toBeTruthy();
    expect(
      screen.getByText(/Only for content that asks you to sign in/),
    ).toBeTruthy();
  });

  it("say why a change was refused, with the error's own text", () => {
    render(<SettingsMenu />);
    load(defaults);
    open();
    act(() => useDownloadsStore.setState({ settingsProblem: "unknown" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "Something unexpected went wrong.",
    );
  });

  it("are in Spanish too", () => {
    updateSettings({ language: "es" });
    render(<SettingsMenu />);
    load(defaults);
    fireEvent.click(screen.getByRole("button", { name: "Ajustes" }));
    expect(screen.getByText("Descargas")).toBeTruthy();
    expect(select("Descargas a la vez")).toBeTruthy();
    expect(optionTexts("Límite de velocidad")[0]).toBe("Sin límite");
    expect(optionTexts("Cookies del navegador")[0]).toBe("No usar");
  });
});

describe("the panel's open state", () => {
  it("opens when a row asks for it, and the gear still works", () => {
    render(<SettingsMenu />);
    expect(screen.queryByText("Downloads")).toBeNull();
    act(() => settingsActions.setOpen(true));
    expect(screen.getByText("Downloads")).toBeTruthy();
    // Closing it from outside (Escape) is also the store's business.
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    expect(useDownloadsStore.getState().settingsOpen).toBe(false);
  });
});

describe("a cookies.txt file in the settings", () => {
  const file = "C:\\Users\\Ana\\Exported\\cookies-youtube.txt";
  const withFile = { ...defaults, cookiesFile: file };

  it("is an option of the cookies list, and choosing it opens the picker", async () => {
    const calls = backend();
    render(<SettingsMenu />);
    load(defaults);
    open();
    await act(async () => {
      fireEvent.change(select("Browser cookies"), {
        target: { value: "file" },
      });
    });
    expect(calls).toEqual([["pick_cookies_file", {}]]);
  });

  it("shows the file's name, with its full path as the tooltip, and a button to choose another", async () => {
    const calls = backend();
    render(<SettingsMenu />);
    load(withFile);
    open();
    expect(select("Browser cookies").value).toBe("file");
    const name = screen.getByText("cookies-youtube.txt");
    expect(name.getAttribute("title")).toBe(file);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Choose another" }));
    });
    expect(calls).toEqual([["pick_cookies_file", {}]]);
  });

  it("shows neither the name nor the button while no file is chosen", () => {
    render(<SettingsMenu />);
    load({ ...defaults, cookiesBrowser: "firefox" });
    open();
    expect(select("Browser cookies").value).toBe("firefox");
    expect(screen.queryByRole("button", { name: "Choose another" })).toBeNull();
  });

  it("choosing a browser, or none, from the list sends that command", async () => {
    const calls = backend();
    render(<SettingsMenu />);
    load(withFile);
    open();
    await act(async () => {
      fireEvent.change(select("Browser cookies"), { target: { value: "" } });
    });
    expect(calls).toEqual([["set_cookies_browser", { browser: null }]]);
    // The file is gone from the panel at once.
    expect(select("Browser cookies").value).toBe("");
    expect(screen.queryByText("cookies-youtube.txt")).toBeNull();
  });

  it("explains that the app uses a copy, in both languages", () => {
    render(<SettingsMenu />);
    load(defaults);
    open();
    expect(
      screen.getByText(/the app uses a copy and never touches your file/),
    ).toBeTruthy();
  });

  it("is in Spanish too", () => {
    updateSettings({ language: "es" });
    render(<SettingsMenu />);
    load(withFile);
    fireEvent.click(screen.getByRole("button", { name: "Ajustes" }));
    expect(optionTexts("Cookies del navegador")).toContain(
      "Fichero cookies.txt…",
    );
    expect(screen.getByRole("button", { name: "Elegir otro" })).toBeTruthy();
    expect(
      screen.getByText(/la app usa una copia y no toca tu fichero/),
    ).toBeTruthy();
  });
});

describe("the notification setting", () => {
  const box = () =>
    screen.getByRole("checkbox", {
      name: /Notify when downloads finish/,
    }) as HTMLInputElement;

  it("is on by default, disabled until the backend answers, and shows what is saved", () => {
    render(<SettingsMenu />);
    open();
    expect(box().disabled).toBe(true);
    load({ ...defaults, notifications: false });
    expect(box().disabled).toBe(false);
    expect(box().checked).toBe(false);
    load(defaults);
    expect(box().checked).toBe(true);
  });

  it("ticking it sends the command with the new value", async () => {
    const calls = backend();
    render(<SettingsMenu />);
    load(defaults);
    open();
    await act(async () => {
      fireEvent.click(box());
    });
    expect(calls).toEqual([["set_notifications", { on: false }]]);
    expect(box().checked).toBe(false);
  });

  it("is in Spanish too", () => {
    updateSettings({ language: "es" });
    render(<SettingsMenu />);
    load(defaults);
    fireEvent.click(screen.getByRole("button", { name: "Ajustes" }));
    expect(
      screen.getByRole("checkbox", { name: /Avisar cuando terminen/ }),
    ).toBeTruthy();
  });
});

describe("the defaults of the card", () => {
  const audioSelect = () => select("Audio format");

  it("show the saved audio format and offer all six", () => {
    updateSettings({ audioFormat: "opus" });
    render(<SettingsMenu />);
    open();
    expect(audioSelect().value).toBe("opus");
    expect(optionTexts("Audio format")).toEqual([
      "Best quality (no re-encoding)",
      "MP3",
      "M4A (AAC)",
      "Opus",
      "FLAC",
      "WAV",
    ]);
  });

  it("a new audio format is saved and is the card's choice at once", () => {
    render(<SettingsMenu />);
    open();
    fireEvent.change(audioSelect(), { target: { value: "flac" } });
    expect(localStorage.getItem("albaro.audioFormat")).toBe("flac");
    expect(useDownloadsStore.getState().choice.audioFormat).toBe("flac");
    // Nothing else in the card moved.
    expect(useDownloadsStore.getState().choice.kind).toBe("video");
  });

  it("has no field for subtitle languages: those are picked on the card", () => {
    render(<SettingsMenu />);
    open();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("is in Spanish too", () => {
    updateSettings({ language: "es" });
    render(<SettingsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Ajustes" }));
    expect(select("Formato de audio")).toBeTruthy();
  });
});

describe("the style", () => {
  const style = (name: string) => screen.getByRole("radio", { name });

  it("offers sober and themed, themed being the default, and has no season picker", () => {
    render(<SettingsMenu />);
    open();
    expect(style("Themed").getAttribute("data-state")).toBe("on");
    expect(style("Sober").getAttribute("data-state")).toBe("off");
    expect(screen.queryByRole("combobox", { name: "Season" })).toBeNull();
  });

  it("choosing the sober style is saved and hides the hint about the season", () => {
    render(<SettingsMenu />);
    open();
    expect(screen.getByText(/changes with the season/)).toBeTruthy();
    fireEvent.click(style("Sober"));
    expect(localStorage.getItem("albaro.style")).toBe("sober");
    expect(screen.queryByText(/changes with the season/)).toBeNull();
  });

  it("is in Spanish too", () => {
    updateSettings({ language: "es" });
    render(<SettingsMenu />);
    fireEvent.click(screen.getByRole("button", { name: "Ajustes" }));
    expect(screen.getByRole("radio", { name: "Temático" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Sobrio" })).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Temporada" })).toBeNull();
  });
});
