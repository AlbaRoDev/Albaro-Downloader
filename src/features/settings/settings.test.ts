import { PALETTE_VARIABLES, paletteFor } from "./palette";
import { seasonFor } from "./seasons";
import {
  AUDIO_FORMAT_KEY,
  getSettings,
  LANGUAGE_KEY,
  loadSettings,
  STYLE_KEY,
  THEME_KEY,
  updateSettings,
} from "./settings";
import { applyAppearance, applyTheme, PALETTE_KEY, watchTheme } from "./theme";

// A controllable `prefers-color-scheme: dark` (jsdom has no matchMedia).
function mockSystemTheme(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) =>
      listeners.add(listener),
  };
  window.matchMedia = vi.fn(() => query) as unknown as typeof matchMedia;
  return (next: boolean) => {
    query.matches = next;
    for (const listener of listeners) listener();
  };
}

const DEFAULTS = {
  language: "system",
  theme: "system",
  style: "themed",
  audioFormat: "best",
};

const isDarkNow = () => document.documentElement.classList.contains("dark");

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  document.documentElement.className = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("settings", () => {
  it("default to the system's language and theme", () => {
    expect(getSettings()).toEqual(DEFAULTS);
  });

  it("are saved and read back", () => {
    updateSettings({ language: "en" });
    updateSettings({ theme: "dark" });
    expect(localStorage.getItem(LANGUAGE_KEY)).toBe("en");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(loadSettings()).toEqual({
      ...DEFAULTS,
      language: "en",
      theme: "dark",
    });
  });

  it("keep the card's default audio format", () => {
    updateSettings({ audioFormat: "flac" });
    expect(localStorage.getItem(AUDIO_FORMAT_KEY)).toBe("flac");
    expect(loadSettings()).toEqual({ ...DEFAULTS, audioFormat: "flac" });
  });

  it("drop an audio format that does not exist when reading", () => {
    localStorage.setItem(AUDIO_FORMAT_KEY, "ogg");
    expect(loadSettings().audioFormat).toBe("best");
  });

  it("keep the style, the themed one by default", () => {
    expect(getSettings().style).toBe("themed");
    updateSettings({ style: "sober" });
    expect(localStorage.getItem(STYLE_KEY)).toBe("sober");
    expect(loadSettings()).toMatchObject({ style: "sober" });
  });

  it("ignore a style that does not exist", () => {
    localStorage.setItem(STYLE_KEY, "neon");
    expect(loadSettings()).toMatchObject({ style: "themed" });
  });

  it("ignore an unknown stored value", () => {
    localStorage.setItem(THEME_KEY, "purple");
    expect(loadSettings().theme).toBe("system");
  });

  it("work on the defaults when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadSettings()).toEqual(DEFAULTS);
    updateSettings({ theme: "dark" });
    expect(getSettings().theme).toBe("dark");
  });
});

describe("theme", () => {
  it("light and dark ignore the system", () => {
    mockSystemTheme(true);
    applyTheme("light");
    expect(isDarkNow()).toBe(false);
    mockSystemTheme(false);
    applyTheme("dark");
    expect(isDarkNow()).toBe(true);
  });

  it("system follows prefers-color-scheme, also when it changes", () => {
    const setSystemDark = mockSystemTheme(false);
    watchTheme();
    expect(isDarkNow()).toBe(false);
    setSystemDark(true);
    expect(isDarkNow()).toBe(true);

    // A fixed choice wins over the system until "system" is picked again.
    updateSettings({ theme: "light" });
    expect(isDarkNow()).toBe(false);
    setSystemDark(true);
    expect(isDarkNow()).toBe(false);
    updateSettings({ theme: "system" });
    expect(isDarkNow()).toBe(true);
  });
});

describe("the look", () => {
  const root = document.documentElement;
  const settings = (change: Partial<ReturnType<typeof getSettings>>) => ({
    ...getSettings(),
    ...change,
  });
  const MAY = new Date(2026, 4, 10); // spring
  const OCT = new Date(2026, 9, 15); // autumn

  beforeEach(() => {
    mockSystemTheme(false);
    root.removeAttribute("style");
    root.removeAttribute("data-style");
    root.removeAttribute("data-season");
  });

  it("the themed style puts the season's colours, its name and the style on <html>", () => {
    applyAppearance(settings({ style: "themed", theme: "light" }), OCT);
    expect(root.dataset.style).toBe("themed");
    expect(root.dataset.season).toBe("autumn");
    for (const [name, value] of Object.entries(paletteFor("autumn", "light"))) {
      expect(root.style.getPropertyValue(name)).toBe(value);
    }
    expect(isDarkNow()).toBe(false);
  });

  it("dark mode takes the dark palette of the same season", () => {
    applyAppearance(settings({ style: "themed", theme: "dark" }), OCT);
    expect(isDarkNow()).toBe(true);
    expect(root.style.getPropertyValue("--background")).toBe(
      paletteFor("autumn", "dark")["--background"],
    );
  });

  it("the season is always the one for the date", () => {
    applyAppearance(settings({ style: "themed", theme: "light" }), MAY);
    expect(root.dataset.season).toBe("spring");
    applyAppearance(settings({ style: "themed", theme: "light" }), OCT);
    expect(root.dataset.season).toBe("autumn");
    expect(root.style.getPropertyValue("--primary")).toBe(
      paletteFor("autumn", "light")["--primary"],
    );
  });

  it("the sober style takes all of it off again, and forgets it", () => {
    applyAppearance(settings({ style: "themed", theme: "light" }), OCT);
    expect(localStorage.getItem(PALETTE_KEY)).not.toBeNull();
    applyAppearance(settings({ style: "sober", theme: "light" }), OCT);
    expect(root.dataset.style).toBeUndefined();
    expect(root.dataset.season).toBeUndefined();
    for (const name of PALETTE_VARIABLES) {
      expect(root.style.getPropertyValue(name), name).toBe("");
    }
    expect(localStorage.getItem(PALETTE_KEY)).toBeNull();
  });

  it("saves both palettes and the season for the page to paint with before it loads", () => {
    applyAppearance(settings({ style: "themed", theme: "dark" }), MAY);
    expect(JSON.parse(localStorage.getItem(PALETTE_KEY) as string)).toEqual({
      season: "spring",
      light: paletteFor("spring", "light"),
      dark: paletteFor("spring", "dark"),
    });
  });

  it("works when localStorage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() =>
      applyAppearance(settings({ style: "themed", theme: "light" }), OCT),
    ).not.toThrow();
    expect(root.dataset.season).toBe("autumn");
  });

  it("follows the settings and the system once watched", () => {
    const setSystemDark = mockSystemTheme(false);
    updateSettings({ theme: "system", style: "themed" });
    watchTheme();
    expect(root.dataset.season).toBe(seasonFor(new Date()));
    const light = root.style.getPropertyValue("--background");
    setSystemDark(true);
    expect(root.style.getPropertyValue("--background")).not.toBe(light);
    updateSettings({ style: "sober" });
    expect(root.dataset.style).toBeUndefined();
  });
});
