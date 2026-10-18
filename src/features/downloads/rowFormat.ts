// Text for a download row's numbers. Pure: the language comes in as a parameter.
import type { Language } from "@/i18n";

const KB = 1024;
const MB = KB * 1024;

// Bytes per second as "512 KB/s" or "3.2 MB/s" ("3,2" in Spanish). Units are 1024-based, like
// the sizes a file manager shows. null when yt-dlp has no speed yet.
export function formatSpeed(
  bytesPerSecond: number | null,
  language: Language,
): string | null {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond)) return null;
  if (bytesPerSecond >= MB) {
    const value = new Intl.NumberFormat(language, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(bytesPerSecond / MB);
    return `${value} MB/s`;
  }
  return `${Math.round(bytesPerSecond / KB)} KB/s`;
}

// Seconds left as "m:ss" or "h:mm:ss"; null when unknown. Rounds up: "0:00" would say it is
// done while it is not.
export function formatEta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.ceil(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}
