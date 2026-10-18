// UI text in Spanish and English, without a library: a few dozen strings need no more.
// es.json defines the keys (and so the `Key` type); en.json must have exactly the same ones
// (TypeScript catches a missing key, the test also an extra one).
//
// A value is a string with `{name}` placeholders, or, for a plural, an object with one string
// per plural form (`{ "one": "{count} file", "other": "{count} files" }`), picked by `count`.
import { useCallback } from "react";
import {
  getSettings,
  type LanguageChoice,
  subscribe,
  useSettings,
} from "@/features/settings/settings";
import en from "./en.json";
import es from "./es.json";

export type Language = "es" | "en";
export type Key = keyof typeof es;
export type Params = Record<string, string | number>;
type Entry = string | { one: string; other: string };

const messages: Record<Language, Record<Key, Entry>> = { es, en };

// "es", "es-MX"... are Spanish; anything else, English.
export function detectLanguage(browserLanguage: string): Language {
  return browserLanguage.toLowerCase().startsWith("es") ? "es" : "en";
}

export function resolveLanguage(choice: LanguageChoice): Language {
  return choice === "system" ? detectLanguage(navigator.language) : choice;
}

export function format(entry: Entry, language: Language, params: Params = {}) {
  const template =
    typeof entry === "string"
      ? entry
      : new Intl.PluralRules(language).select(Number(params.count)) === "one"
        ? entry.one
        : entry.other;
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}

export function translate(language: Language, key: Key, params?: Params) {
  return format(messages[language][key], language, params);
}

// `t(key, params)` in the current language; the component re-renders when it changes.
export function useT() {
  const language = resolveLanguage(useSettings().language);
  return useCallback(
    (key: Key, params?: Params) => translate(language, key, params),
    [language],
  );
}

// Keeps <html lang> on the current language (screen readers, hyphenation). Called once,
// before the first render.
export function watchLanguage() {
  const apply = () => {
    document.documentElement.lang = resolveLanguage(getSettings().language);
  };
  apply();
  subscribe(apply);
}

// The current language, for formatting that is not text from the files (numbers).
export function useLanguage(): Language {
  return resolveLanguage(useSettings().language);
}
