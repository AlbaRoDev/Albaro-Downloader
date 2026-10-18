// The user's interface preferences, kept in localStorage: language, theme, and the default audio
// format of the download card. They are for the page alone, which
// the backend never reads, and the theme has to be known before the first paint (index.html reads
// it), earlier than Rust could answer: so they stay here. The settings the backend
// uses (folder, name, limits, cookies) live in its database. localStorage may be missing or throw
// (storage disabled, a locked-down webview): then the app runs on the defaults and simply forgets
// the choice.
import { useSyncExternalStore } from "react";
import type { AudioFormat } from "@/lib/ipc";
import { AUDIO_FORMATS } from "../downloads/options";
import { SEASONS, type Season } from "./seasons";

export type LanguageChoice = "es" | "en" | "system";
export type ThemeChoice = "light" | "dark" | "system";
// The look: "sober" is the neutral one; "themed" is the author's website palette, which
// changes with the season. Independent of light or dark.
export type StyleChoice = "sober" | "themed";
export type SeasonChoice = "auto" | Season;

export interface Settings {
  language: LanguageChoice;
  theme: ThemeChoice;
  style: StyleChoice;
  // Which season the themed style shows: by the date, or one picked by hand.
  season: SeasonChoice;
  // What the card starts with (and what the setting changes at once).
  audioFormat: AudioFormat;
}

// index.html reads THEME_KEY too, to set the theme before the first paint.
export const LANGUAGE_KEY = "albaro.language";
export const THEME_KEY = "albaro.theme";
export const STYLE_KEY = "albaro.style";
export const SEASON_KEY = "albaro.season";
export const AUDIO_FORMAT_KEY = "albaro.audioFormat";

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function read<T extends string>(
  key: string,
  choices: readonly T[],
  fallback: T,
): T {
  const value = readRaw(key);
  return choices.find((c) => c === value) ?? fallback;
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not saved: the choice lasts until the app closes.
  }
}

let current: Settings;
const listeners = new Set<() => void>();

// Reads the stored choices (an unknown or missing value is the default). Runs on import; tests
// call it again after changing localStorage.
export function loadSettings(): Settings {
  current = {
    language: read(LANGUAGE_KEY, ["es", "en", "system"], "system"),
    theme: read(THEME_KEY, ["light", "dark", "system"], "system"),
    style: read<StyleChoice>(STYLE_KEY, ["sober", "themed"], "themed"),
    season: read<SeasonChoice>(SEASON_KEY, ["auto", ...SEASONS], "auto"),
    audioFormat: read(AUDIO_FORMAT_KEY, AUDIO_FORMATS, "best"),
  };
  return current;
}
loadSettings();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(change: Partial<Settings>) {
  current = { ...current, ...change };
  if (change.language) write(LANGUAGE_KEY, change.language);
  if (change.theme) write(THEME_KEY, change.theme);
  if (change.style) write(STYLE_KEY, change.style);
  if (change.season) write(SEASON_KEY, change.season);
  if (change.audioFormat) write(AUDIO_FORMAT_KEY, change.audioFormat);
  for (const listener of listeners) listener();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Re-renders the component when a setting changes.
export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings);
}
