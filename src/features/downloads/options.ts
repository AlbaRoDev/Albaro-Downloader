// What to download, decided from what the source offers. Pure functions: the
// codecs of `Metadata.formats` in, the choices, warnings and `DownloadRequest` out.
import type {
  AudioFormat,
  Container,
  DownloadRequest,
  Format,
  SubtitleLanguage,
} from "@/lib/ipc";

// The user's selections. Both modes keep theirs, so switching Video → Audio → Video loses
// nothing. `maxHeight` is only valid while the source has that height (see `buildRequest`).
export interface Choice {
  kind: "video" | "audio";
  maxHeight: number | null; // null: the maximum
  container: Container;
  audioFormat: AudioFormat;
  bitrateKbps: number;
  // The subtitle languages ticked, by code. Kept across links like the rest, so a
  // language the next video lacks stays ticked but is never asked for (`effectiveSubtitles`).
  subtitles: string[];
}

// "mp4" is the best resolution, whatever the codec (AV1 up to 4K on YouTube).
export const DEFAULT_CHOICE: Choice = {
  kind: "video",
  maxHeight: null,
  container: "mp4",
  audioFormat: "best",
  bitrateKbps: 192,
  subtitles: [],
};

// What the card starts with: the built-in choice with the user's default audio format.
export function choiceFrom(prefs: { audioFormat: AudioFormat }): Choice {
  return { ...DEFAULT_CHOICE, audioFormat: prefs.audioFormat };
}

// The languages the "+" of a playlist offers besides the usual eight: codes yt-dlp's
// sites use, named by `languageName` in the app's language. Not exhaustive; every code passes
// `is_language_code` in formats.rs.
export const MORE_LANGUAGES = [
  "af",
  "ar",
  "bg",
  "bn",
  "ca",
  "cs",
  "da",
  "el",
  "es-419",
  "et",
  "fa",
  "fi",
  "he",
  "hi",
  "hr",
  "hu",
  "id",
  "is",
  "ko",
  "lt",
  "lv",
  "ms",
  "nl",
  "no",
  "pl",
  "pt-BR",
  "pt-PT",
  "ro",
  "sk",
  "sl",
  "sr",
  "sv",
  "sw",
  "ta",
  "th",
  "tl",
  "tr",
  "uk",
  "ur",
  "vi",
  "zh-Hans",
  "zh-Hant",
];

export const CONTAINERS: Container[] = ["mp4", "mp4Compatible", "mkv", "webm"];
export const AUDIO_FORMATS: AudioFormat[] = [
  "best",
  "mp3",
  "m4a",
  "opus",
  "flac",
  "wav",
];

// Bitrates only make sense when re-encoding with loss. Opus is efficient at lower ones.
const BITRATES = {
  mp3: [128, 192, 256, 320],
  m4a: [128, 192, 256, 320],
  opus: [64, 96, 128, 192, 256],
} as const;

export function bitrateOptions(format: AudioFormat): readonly number[] {
  return format === "mp3" || format === "m4a" || format === "opus"
    ? BITRATES[format]
    : [];
}

// What the source has, as far as the formats say. A format that yt-dlp could not describe
// (codec null) counts for nothing here: it never makes anything impossible.
export interface SourceInfo {
  hasVideo: boolean;
  heights: number[]; // distinct, highest first
  av1Heights: number[];
  hasH264: boolean;
  webm: boolean; // false only when the codecs we know make a webm impossible
  // The subtitle languages it offers.
  subtitles: SubtitleLanguage[];
  // True when they are only the usual ones, not read from the source (a playlist's entries are
  // not analysed one by one): whichever a video lacks is skipped by yt-dlp.
  subtitlesGuessed?: boolean;
}

// yt-dlp says "none" for "this format has no video/audio" and null for "I do not know".
const isReal = (codec: string | null): codec is string =>
  codec !== null && codec !== "none" && codec !== "";

type VideoFamily = "h264" | "vp" | "av1" | "other";
type AudioFamily = "webm" | "other";

function videoFamily(codec: string): VideoFamily {
  const c = codec.toLowerCase();
  if (/^(avc|h264)/.test(c)) return "h264";
  if (/^vp0?[89]/.test(c)) return "vp";
  if (/^(av01|av1)/.test(c)) return "av1";
  return "other";
}

// Opus and Vorbis are what a webm can hold.
const audioFamily = (codec: string): AudioFamily =>
  /^(opus|vorbis)/i.test(codec) ? "webm" : "other";

export function analyseFormats(
  formats: Format[],
  subtitles: SubtitleLanguage[] = [],
): SourceInfo {
  const video = formats.filter((f) => isReal(f.vcodec));
  const audio = formats.filter((f) => isReal(f.acodec));
  const families = video.map((f) => videoFamily(f.vcodec as string));
  const heights = (list: Format[]) =>
    [...new Set(list.map((f) => f.height ?? 0).filter((h) => h > 0))].sort(
      (a, b) => b - a,
    );
  const noWebmVideo =
    families.length > 0 && !families.some((f) => f === "vp" || f === "av1");
  const noWebmAudio =
    audio.length > 0 &&
    !audio.some((f) => audioFamily(f.acodec as string) === "webm");
  return {
    // Nothing known at all: let the user try, yt-dlp will say.
    hasVideo: video.length > 0 || audio.length === 0,
    heights: heights(video),
    av1Heights: heights(
      video.filter((f) => videoFamily(f.vcodec as string) === "av1"),
    ),
    hasH264: families.includes("h264"),
    webm: !(noWebmVideo || noWebmAudio),
    subtitles,
  };
}

// The height `-S res:limit` ends up with: the highest one within the limit or, when every
// height is above it, the closest.
function topHeight(heights: number[], limit: number | null): number | null {
  if (heights.length === 0) return null;
  if (limit === null) return heights[0];
  return heights.find((h) => h <= limit) ?? heights[heights.length - 1];
}

// A video needs video in the source; an audio-only source (SoundCloud) can only be audio.
export function effectiveKind(choice: Choice, info: SourceInfo) {
  return info.hasVideo ? choice.kind : "audio";
}

// The ticked subtitle languages that the source offers, in the source's order: what is asked for.
export function effectiveSubtitles(
  choice: Choice,
  info: SourceInfo,
): SubtitleLanguage[] {
  return info.subtitles.filter((l) => choice.subtitles.includes(l.code));
}

// The name of a language for the screen, in the app's language: the browser knows most codes
// (`es`, `pt-BR`, `zh-Hans`), and a code it rejects (`en-orig`) falls back to the site's own name
// and, failing that, the code.
export function languageName(
  language: SubtitleLanguage,
  appLanguage: string,
): string {
  try {
    const name = new Intl.DisplayNames([appLanguage], {
      type: "language",
    }).of(language.code);
    // `of` echoes the code back when it knows nothing about it.
    if (name && name !== language.code) return name;
  } catch {
    // An invalid code: use the site's name.
  }
  return language.name ?? language.code;
}

// A webm is impossible from H.264/AAC, so it is saved as mkv (still no re-encoding).
export function effectiveContainer(
  choice: Choice,
  info: SourceInfo,
): Container {
  return choice.container === "webm" && !info.webm ? "mkv" : choice.container;
}

// Never a limit the source does not have.
export function effectiveHeight(choice: Choice, info: SourceInfo) {
  return choice.maxHeight !== null && info.heights.includes(choice.maxHeight)
    ? choice.maxHeight
    : null;
}

export function effectiveBitrate(choice: Choice): number | null {
  const options = bitrateOptions(choice.audioFormat);
  if (options.length === 0) return null;
  return options.includes(choice.bitrateKbps)
    ? choice.bitrateKbps
    : (options.find((b) => b >= 128) ?? options[0]);
}

export type Warning =
  | "av1"
  | "noH264"
  | "webmToMkv"
  | "lossy"
  | "noGain"
  | "wavNoCover";

export function warnings(choice: Choice, info: SourceInfo): Warning[] {
  if (effectiveKind(choice, info) === "audio") {
    switch (choice.audioFormat) {
      case "mp3":
      case "m4a":
      case "opus":
        return ["lossy"];
      case "flac":
        return ["noGain"];
      case "wav":
        return ["noGain", "wavNoCover"];
      default:
        return [];
    }
  }
  switch (choice.container) {
    case "mp4": {
      // AV1 wins a tie in height, so it matters only if it reaches the top one.
      const top = topHeight(info.heights, effectiveHeight(choice, info));
      return top !== null && info.av1Heights.includes(top) ? ["av1"] : [];
    }
    case "mp4Compatible":
      return info.hasH264 ? [] : ["noH264"];
    case "webm":
      return info.webm ? [] : ["webmToMkv"];
    default:
      return [];
  }
}

// The languages offered for a playlist, whose entries are not analysed.
const COMMON_SUBTITLES = ["es", "en", "fr", "de", "it", "pt", "ja", "ru"];

// A playlist's entries are not analysed one by one (that would cost seconds each), so the
// options are offered for a source that could be anything: the usual heights, no AV1 or H.264
// warnings. Whatever a video lacks, yt-dlp falls back (a lower height, mkv for a webm that
// cannot be), as it does for a single video.
export const PLAYLIST_SOURCE: SourceInfo = playlistSource([]);

// The same, with more languages offered too: the ones added with the "+" of the playlist card
//, which is how a language outside the usual eight can be asked for there.
export function playlistSource(extraLanguages: string[]): SourceInfo {
  const codes = [...new Set([...COMMON_SUBTITLES, ...extraLanguages])];
  return {
    hasVideo: true,
    heights: [2160, 1440, 1080, 720, 480, 360],
    av1Heights: [],
    hasH264: true,
    webm: true,
    subtitles: codes.map((code) => ({
      code,
      name: null,
      manual: false,
      auto: true,
    })),
    subtitlesGuessed: true,
  };
}

// The request for entry `index` (from 0) of a playlist with `count` entries. With `numbered`
// (in either mode) the file name starts with the entry's place in the list, so the
// files sort in the playlist's order; without it, the file keeps its plain name. `folder`, if
// given, is the subfolder for the file, also in either mode.
export function buildPlaylistRequest(
  url: string,
  choice: Choice,
  index: number,
  count: number,
  folder: string | null = null,
  numbered = true,
  source: SourceInfo = PLAYLIST_SOURCE,
): DownloadRequest {
  return {
    ...buildRequest(url, choice, source),
    ...(numbered && { playlist: { index: index + 1, count } }),
    ...(folder && { folder }),
  };
}

export function buildRequest(
  url: string,
  choice: Choice,
  info: SourceInfo,
): DownloadRequest {
  if (effectiveKind(choice, info) === "audio") {
    return {
      url,
      mode: {
        kind: "audio",
        format: choice.audioFormat,
        bitrateKbps: effectiveBitrate(choice),
      },
    };
  }
  // Only the ticked languages the source offers, and the automatic captions only when one of
  // them has no manual subtitles: a language with both is taken by hand.
  const subtitles = effectiveSubtitles(choice, info);
  return {
    url,
    mode: {
      kind: "video",
      maxHeight: effectiveHeight(choice, info),
      container: effectiveContainer(choice, info),
    },
    ...(subtitles.length > 0 && {
      subtitles: {
        langs: subtitles.map((l) => l.code),
        auto: subtitles.some((l) => !l.manual),
      },
    }),
  };
}
