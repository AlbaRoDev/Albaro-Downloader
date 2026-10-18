import {
  type Mode,
  PALETTE_VARIABLES,
  paletteFor,
  SEASON_COLOURS,
} from "./palette";
import { SEASONS } from "./seasons";

// OKLCH -> linear sRGB (Björn Ottosson's matrices), clipped to the gamut, then WCAG relative
// luminance. The browser maps out-of-gamut colours more gently than clipping, which can only
// move a colour towards grey: close enough for a check with a margin.
function luminance(css: string): number {
  const m = css.match(/^oklch\(([\d.]+) ([\d.]+) ([\d.]+)(?: \/ [\d.]+)?\)$/);
  if (!m) throw new Error(`not an oklch colour: ${css}`);
  const [l, c, hDeg] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ].map((v) => Math.min(1, Math.max(0, v)));
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The destructive red is shared by both styles (index.css), so it is checked against each palette.
const DESTRUCTIVE: Record<Mode, string> = {
  light: "oklch(0.55 0.22 27)",
  dark: "oklch(0.7 0.19 22)",
};

// WCAG AA wants 4.5 for text and 3 for large text and interface parts; a little margin on top.
const TEXT = 4.6;
const PART = 3.1;

const cases = SEASONS.flatMap((season) =>
  (["light", "dark"] as const).map((mode) => [season, mode] as const),
);

describe.each(cases)("%s, %s", (season, mode) => {
  const p = paletteFor(season, mode);
  const destructive = DESTRUCTIVE[mode];

  it("keeps text readable on every surface", () => {
    expect(contrast(p["--foreground"], p["--background"])).toBeGreaterThan(7);
    expect(contrast(p["--popover-foreground"], p["--popover"])).toBeGreaterThan(
      TEXT,
    );
    expect(
      contrast(p["--secondary-foreground"], p["--secondary"]),
    ).toBeGreaterThan(TEXT);
    expect(contrast(p["--accent-foreground"], p["--accent"])).toBeGreaterThan(
      TEXT,
    );
    expect(
      contrast(p["--muted-foreground"], p["--background"]),
    ).toBeGreaterThan(TEXT);
    expect(contrast(p["--muted-foreground"], p["--muted"])).toBeGreaterThan(
      TEXT,
    );
    expect(contrast(p["--muted-foreground"], p["--popover"])).toBeGreaterThan(
      TEXT,
    );
  });

  it("keeps the text on the accent readable, and the accent visible on the page", () => {
    expect(contrast(p["--primary-foreground"], p["--primary"])).toBeGreaterThan(
      TEXT,
    );
    expect(contrast(p["--primary"], p["--background"])).toBeGreaterThan(PART);
    expect(contrast(p["--ring"], p["--background"])).toBeGreaterThan(PART);
  });

  it("keeps error text readable on the page and on a card", () => {
    expect(contrast(destructive, p["--background"])).toBeGreaterThan(TEXT);
    expect(contrast(destructive, p["--popover"])).toBeGreaterThan(TEXT);
  });
});

describe("paletteFor", () => {
  it("sets the same variables for every season and mode", () => {
    for (const [season, mode] of cases) {
      expect(Object.keys(paletteFor(season, mode)).sort()).toEqual(
        [...PALETTE_VARIABLES].sort(),
      );
    }
  });

  it("only produces colours the converter reads (so the check above cannot be skipped)", () => {
    for (const [season, mode] of cases) {
      for (const [name, value] of Object.entries(paletteFor(season, mode))) {
        // The strip is a gradient of the season's colours: decorative, checked below.
        if (name === "--season-strip") continue;
        expect(value).toMatch(/^oklch\(/);
        expect(Number.isFinite(luminance(value))).toBe(true);
      }
    }
  });

  it("gives each season its own accent, and light and dark their own surfaces", () => {
    const accents = SEASONS.map((s) => paletteFor(s, "light")["--primary"]);
    expect(new Set(accents).size).toBe(SEASONS.length);
    for (const season of SEASONS) {
      expect(paletteFor(season, "light")["--background"]).not.toBe(
        paletteFor(season, "dark")["--background"],
      );
    }
  });

  it("has a season table with a sane hue and chroma for each season", () => {
    for (const season of SEASONS) {
      const { hue, chroma, tint, tintChroma } = SEASON_COLOURS[season];
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
      expect(tint).toBeLessThan(360);
      expect(chroma).toBeLessThan(0.25);
      expect(tintChroma).toBeLessThan(0.04);
    }
  });
});

describe("the contrast helper", () => {
  it("knows black on white is 21 and a colour on itself is 1", () => {
    expect(contrast("oklch(0 0 0)", "oklch(1 0 0)")).toBeCloseTo(21, 0);
    expect(contrast("oklch(0.5 0.1 40)", "oklch(0.5 0.1 40)")).toBeCloseTo(
      1,
      5,
    );
  });
});

// The shortest way round the colour wheel between two hues.
const hueGap = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
};

describe("no two seasons look alike", () => {
  const pairs = SEASONS.flatMap((a, i) =>
    SEASONS.slice(i + 1).map((b) => [a, b] as const),
  );

  it.each(pairs)(
    "%s and %s differ in their accent or their surfaces",
    (a, b) => {
      const x = SEASON_COLOURS[a];
      const y = SEASON_COLOURS[b];
      // A clearly different accent hue, or surfaces tinted another way (a lavender page is not a
      // cream one, whatever the accent).
      const accent = hueGap(x.hue, y.hue);
      const surface = hueGap(x.tint, y.tint);
      expect(
        accent >= 30 || surface >= 60,
        `accent ${accent} deg, surfaces ${surface} deg`,
      ).toBe(true);
    },
  );

  it("the strip of every season has its own colours, in its own order", () => {
    const strips = SEASONS.map((s) => paletteFor(s, "light")["--season-strip"]);
    expect(new Set(strips).size).toBe(SEASONS.length);
    for (const season of SEASONS) {
      const { strip } = SEASON_COLOURS[season];
      expect(strip.length).toBeGreaterThanOrEqual(2);
      const value = paletteFor(season, "light")["--season-strip"];
      expect(value.startsWith("linear-gradient(90deg, oklch(")).toBe(true);
      expect(value.match(/oklch\(/g)).toHaveLength(strip.length);
      // Light and dark share it.
      expect(paletteFor(season, "dark")["--season-strip"]).toBe(value);
    }
  });

  it("Halloween is orange, purple and green, and Christmas red and green", () => {
    expect(SEASON_COLOURS.halloween.strip).toEqual([50, 305, 140]);
    expect(SEASON_COLOURS.halloween.hue).toBe(50); // orange accent
    expect(hueGap(SEASON_COLOURS.halloween.tint, 305)).toBeLessThan(15); // purple surfaces
    expect(SEASON_COLOURS.christmas.strip.slice(0, 2)).toEqual([25, 150]);
    expect(SEASON_COLOURS.spring.hue).not.toBe(SEASON_COLOURS.christmas.hue);
  });
});
