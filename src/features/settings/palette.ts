// The colours of the themed style: warm cream surfaces with brown text in light, deep
// brown in dark, and an accent that changes with the season. Each season is the accent (hue and
// chroma), the tint of the surfaces and the hues of a thin gradient strip; `paletteFor` turns that
// into the CSS variables of index.css. Lightness is fixed per mode, so the text on every surface
// keeps its contrast whatever the hue: `palette.test.ts` checks all 9 seasons in both modes against
// WCAG AA, and that no two seasons look alike, so a retuned season fails there and not in front of
// the user.
//
// Written as plain strings because they end up as inline CSS variables on <html> (set through
// CSSOM, which the app's CSP allows); `index.html` replays the saved copy before the first paint.
import type { Season } from "./seasons";

interface SeasonColours {
  /** Accent hue, in OKLCH degrees. */
  hue: number;
  /** Accent chroma: how vivid it is. */
  chroma: number;
  /** Hue of the surfaces (background, cards, text). */
  tint: number;
  /** How much of that hue the surfaces carry: a little (cream) or hardly any (cool white). */
  tintChroma: number;
  /** The hues of the strip along the top of the window, left to right: the season's colours, as
   *  the website's gradients have them. Decorative, so they are as vivid as they can be. */
  strip: number[];
}

// The website's palette, season by season, reduced to what a utility app needs. The accent colours
// the buttons and bars, the tint the surfaces, and the strip carries the rest of the season's
// colours (Halloween is orange, purple and green: orange on purple surfaces, with all three in the
// strip).
export const SEASON_COLOURS: Record<Season, SeasonColours> = {
  // Fresh green on warm cream; the strip is the flowers (red, yellow, green, blue).
  spring: {
    hue: 150,
    chroma: 0.13,
    tint: 100,
    tintChroma: 0.022,
    strip: [25, 95, 150, 250],
  },
  // Royal blue on sunny cream, going to green.
  summer: {
    hue: 260,
    chroma: 0.17,
    tint: 95,
    tintChroma: 0.02,
    strip: [260, 215, 150],
  },
  // Sun and beach: teal on sand. A gold accent is too dark to look like gold at the lightness
  // the contrast needs (it turns mustard brown), and teal keeps its colour there; the strip has
  // the gold.
  summerSun: {
    hue: 200,
    chroma: 0.1,
    tint: 85,
    tintChroma: 0.026,
    strip: [200, 85, 50],
  },
  // Dawn orange on cream, into brown.
  autumn: {
    hue: 45,
    chroma: 0.18,
    tint: 70,
    tintChroma: 0.024,
    strip: [85, 50, 35],
  },
  // Ice: a cold cyan-blue on cool white.
  winter: {
    hue: 220,
    chroma: 0.09,
    tint: 240,
    tintChroma: 0.014,
    strip: [215, 235, 255],
  },
  // Red on pale-green surfaces (deep green in dark), with red, green and gold in the strip.
  christmas: {
    hue: 25,
    chroma: 0.19,
    tint: 150,
    tintChroma: 0.028,
    strip: [25, 150, 90],
  },
  // Orange on purple surfaces (deep purple in dark): orange, purple and green.
  halloween: {
    hue: 50,
    chroma: 0.17,
    tint: 305,
    tintChroma: 0.03,
    strip: [50, 305, 140],
  },
  // Lilac on pale yellow, into gold.
  easter: {
    hue: 295,
    chroma: 0.13,
    tint: 95,
    tintChroma: 0.022,
    strip: [295, 320, 90],
  },
  // Pink.
  anniversary: {
    hue: 350,
    chroma: 0.16,
    tint: 20,
    tintChroma: 0.018,
    strip: [350, 330, 10],
  },
};

export type Mode = "light" | "dark";

// The variables of index.css that the themed style replaces (name -> value). Every other variable
// (the destructive red, the radius) is shared with the sober style.
export function paletteFor(season: Season, mode: Mode): Record<string, string> {
  const { hue, chroma, tint, tintChroma: tc, strip } = SEASON_COLOURS[season];
  const o = (l: number, c: number, h: number, alpha?: number) =>
    `oklch(${l} ${c} ${h}${alpha === undefined ? "" : ` / ${alpha}`})`;

  // The same in both modes: bright colours read on cream and on deep brown alike.
  const stops = strip.map((h) => o(0.72, 0.16, h)).join(", ");
  const stripVar = { "--season-strip": `linear-gradient(90deg, ${stops})` };

  if (mode === "light") {
    return {
      ...stripVar,
      "--background": o(0.975, tc, tint),
      "--foreground": o(0.3, 0.035, tint),
      "--popover": o(0.99, tc / 2, tint),
      "--popover-foreground": o(0.3, 0.035, tint),
      "--primary": o(0.52, chroma, hue),
      "--primary-foreground": o(0.99, 0.01, tint),
      "--secondary": o(0.94, tc * 1.4, tint),
      "--secondary-foreground": o(0.3, 0.035, tint),
      "--muted": o(0.94, tc * 1.4, tint),
      "--muted-foreground": o(0.44, 0.03, tint),
      "--accent": o(0.94, tc * 1.4, tint),
      "--accent-foreground": o(0.3, 0.035, tint),
      "--border": o(0.87, tc * 1.6, tint),
      "--input": o(0.87, tc * 1.6, tint),
      "--ring": o(0.52, chroma, hue),
    };
  }
  return {
    ...stripVar,
    "--background": o(0.2, tc * 1.2, tint),
    "--foreground": o(0.93, 0.035, tint),
    "--popover": o(0.25, tc * 1.2, tint),
    "--popover-foreground": o(0.93, 0.035, tint),
    "--primary": o(0.77, chroma * 0.85, hue),
    "--primary-foreground": o(0.2, 0.03, hue),
    "--secondary": o(0.28, tc * 1.2, tint),
    "--secondary-foreground": o(0.93, 0.035, tint),
    "--muted": o(0.28, tc * 1.2, tint),
    "--muted-foreground": o(0.76, 0.03, tint),
    "--accent": o(0.28, tc * 1.2, tint),
    "--accent-foreground": o(0.93, 0.035, tint),
    "--border": o(1, 0, 0, 0.12),
    "--input": o(1, 0, 0, 0.16),
    "--ring": o(0.77, chroma * 0.85, hue),
  };
}

// The variable names `paletteFor` sets, to take them off again when the style goes back to sober.
export const PALETTE_VARIABLES = Object.keys(paletteFor("autumn", "light"));
