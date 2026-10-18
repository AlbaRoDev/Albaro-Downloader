import html from "../../../index.html?raw";
import { paletteFor } from "./palette";
import { PALETTE_KEY } from "./theme";

// The inline script of index.html runs before the first paint. It is plain page code, outside
// the bundle, so this runs it the way the page does: its text, against the test's document.
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
const root = document.documentElement;

function runPrepaint(systemDark = false) {
  window.matchMedia = (() => ({
    matches: systemDark,
  })) as unknown as typeof matchMedia;
  new Function(script)();
}

beforeEach(() => {
  localStorage.clear();
  root.className = "";
  root.removeAttribute("style");
  root.removeAttribute("data-style");
  root.removeAttribute("data-season");
});

describe("the script before the first paint (index.html)", () => {
  it("is found", () => {
    expect(script).toContain("albaro.palette");
    expect(script).toContain("albaro.theme");
  });

  it("uses the same storage key as theme.ts", () => {
    expect(script).toContain(`"${PALETTE_KEY}"`);
  });

  it("puts back the saved light palette, the season and the themed style", () => {
    localStorage.setItem("albaro.theme", "light");
    localStorage.setItem(
      PALETTE_KEY,
      JSON.stringify({
        season: "winter",
        light: paletteFor("winter", "light"),
        dark: paletteFor("winter", "dark"),
      }),
    );
    runPrepaint(true);
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.dataset.style).toBe("themed");
    expect(root.dataset.season).toBe("winter");
    for (const [name, value] of Object.entries(paletteFor("winter", "light"))) {
      expect(root.style.getPropertyValue(name), name).toBe(value);
    }
  });

  it("takes the dark palette when the theme is dark, or system and the system is dark", () => {
    const saved = JSON.stringify({
      season: "autumn",
      light: paletteFor("autumn", "light"),
      dark: paletteFor("autumn", "dark"),
    });
    for (const [theme, systemDark] of [
      ["dark", false],
      ["system", true],
    ] as const) {
      root.className = "";
      root.removeAttribute("style");
      localStorage.setItem("albaro.theme", theme);
      localStorage.setItem(PALETTE_KEY, saved);
      runPrepaint(systemDark);
      expect(root.classList.contains("dark"), `${theme}/${systemDark}`).toBe(
        true,
      );
      expect(root.style.getPropertyValue("--background")).toBe(
        paletteFor("autumn", "dark")["--background"],
      );
    }
  });

  it("does nothing to the colours without a saved palette (the sober style, or a first start)", () => {
    runPrepaint(false);
    expect(root.dataset.style).toBeUndefined();
    expect(root.style.length).toBe(0);
  });

  it("survives a damaged palette, and leaves no globals behind that the browser would keep", () => {
    localStorage.setItem(PALETTE_KEY, "{not json");
    expect(() => runPrepaint(false)).not.toThrow();
    expect(root.style.length).toBe(0);
    // `name` at the top level of a script is `window.name`, which survives page loads.
    expect(window.name).toBe("");
  });
});
