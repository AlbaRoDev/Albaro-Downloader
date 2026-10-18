// How the app looks: light or dark (the `dark` class on <html>, which index.css keys every colour
// on) and, in the themed style, the season's palette as inline CSS variables on <html>
// plus `data-style` for the shapes and the display font. index.html replays the saved copy before
// the first paint.
import { PALETTE_VARIABLES, paletteFor } from "./palette";
import { type Season, seasonFor } from "./seasons";
import {
  getSettings,
  type Settings,
  subscribe,
  type ThemeChoice,
} from "./settings";

const DARK_QUERY = "(prefers-color-scheme: dark)";

// What index.html reads before the first paint: the season and both palettes (light and dark,
// because "system" can only be resolved there). Absent in the sober style.
export const PALETTE_KEY = "albaro.palette";

// `matchMedia` is missing in some test environments: no preference means light.
function systemIsDark(): boolean {
  return window.matchMedia?.(DARK_QUERY).matches ?? false;
}

export function isDark(theme: ThemeChoice): boolean {
  return theme === "dark" || (theme === "system" && systemIsDark());
}

export function applyTheme(theme: ThemeChoice) {
  document.documentElement.classList.toggle("dark", isDark(theme));
}

// The season the themed style shows: the one picked, or the one for `now`.
export function activeSeason(settings: Settings, now: Date): Season {
  return settings.season === "auto" ? seasonFor(now) : settings.season;
}

function remember(value: object | null) {
  try {
    if (value) localStorage.setItem(PALETTE_KEY, JSON.stringify(value));
    else localStorage.removeItem(PALETTE_KEY);
  } catch {
    // Not saved: the next start paints once with the defaults before this runs.
  }
}

// Puts the light or dark mode and the style on <html>. The sober style is index.css as it is;
// the themed one adds the palette on top of it and takes it off again when the style changes back.
export function applyAppearance(
  settings: Settings = getSettings(),
  now = new Date(),
) {
  const root = document.documentElement;
  const dark = isDark(settings.theme);
  root.classList.toggle("dark", dark);
  if (settings.style === "sober") {
    delete root.dataset.style;
    delete root.dataset.season;
    for (const name of PALETTE_VARIABLES) root.style.removeProperty(name);
    remember(null);
    return;
  }
  const season = activeSeason(settings, now);
  root.dataset.style = "themed";
  root.dataset.season = season;
  const light = paletteFor(season, "light");
  const night = paletteFor(season, "dark");
  for (const [name, value] of Object.entries(dark ? night : light)) {
    root.style.setProperty(name, value);
  }
  remember({ season, light, dark: night });
}

// Applies the look now and keeps it applied: when the user changes the theme, the style or the
// season, and when the system switches between light and dark (which only shows while the theme is
// "system"). Called once, before the first render. The date is read at start and on each change,
// not on a timer: a season that turns while the app is open shows at the next start.
export function watchTheme() {
  const apply = () => applyAppearance();
  apply();
  subscribe(apply);
  window.matchMedia?.(DARK_QUERY).addEventListener("change", apply);
}
