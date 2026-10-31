// Pure helpers for the link preview.

const MAX_LENGTH = 2048;

// Why a pasted text is not a link we accept.
export type LinkProblem =
  | "clipboardEmpty"
  | "tooLong"
  | "notLink"
  // An imported file with no link in it.
  | "noLinks";

export type ParsedLink =
  | { ok: true; url: string }
  | { ok: false; problem: LinkProblem };

// Accepts one http(s) URL. Trims the ends; rejects an empty text, one longer than 2048
// characters, one with spaces or line breaks inside (a sentence, not a link) and anything
// without an http:// or https:// scheme (`file://`, `javascript:`, `--version`...). No scheme
// is added to a bare "example.com". The scheme is checked in any case but sent in lowercase,
// because the backend only accepts that (ytdlp::check_url), and it checks again anyway.
export function parseLink(text: string): ParsedLink {
  const url = text.trim();
  if (!url) return { ok: false, problem: "clipboardEmpty" };
  if (url.length > MAX_LENGTH) return { ok: false, problem: "tooLong" };
  const scheme = /^https?:\/\//i.exec(url);
  if (/\s/.test(url) || !scheme) return { ok: false, problem: "notLink" };
  return {
    ok: true,
    url: scheme[0].toLowerCase() + url.slice(scheme[0].length),
  };
}

// Most links taken from one file, like the most entries of a playlist.
export const MAX_IMPORTED_LINKS = 5000;

// The distinct http(s) links in a text, in order. Works on a CSV (any column, quoted or not), a
// TSV or a plain list alike, because it looks for links, not for columns: a link ends at a space,
// comma, semicolon or quote. Each one goes through `parseLink`. `truncated`: there were more than
// MAX_IMPORTED_LINKS.
export function extractLinks(text: string): {
  urls: string[];
  truncated: boolean;
} {
  const found = text.match(/https?:\/\/[^\s,;"'<>]+/gi) ?? [];
  const urls = new Set<string>();
  for (const raw of found) {
    const link = parseLink(raw);
    if (link.ok) urls.add(link.url);
  }
  return {
    urls: [...urls].slice(0, MAX_IMPORTED_LINKS),
    truncated: urls.size > MAX_IMPORTED_LINKS,
  };
}

// 19 → "0:19", 3600 → "1:00:00". yt-dlp gives some sites' durations with decimals.
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
