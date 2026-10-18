import type { Format, SubtitleLanguage } from "@/lib/ipc";
import live from "../../../tests/fixtures/metadata-live.json";
import reddit from "../../../tests/fixtures/metadata-reddit.json";
import soundcloud from "../../../tests/fixtures/metadata-soundcloud.json";
import youtube from "../../../tests/fixtures/metadata-youtube.json";
import {
  analyseFormats,
  bitrateOptions,
  buildPlaylistRequest,
  buildRequest,
  type Choice,
  choiceFrom,
  DEFAULT_CHOICE,
  effectiveBitrate,
  effectiveKind,
  effectiveSubtitles,
  languageName,
  MORE_LANGUAGES,
  PLAYLIST_SOURCE,
  playlistSource,
  warnings,
} from "./options";

// The captured yt-dlp output has snake_case fields and may lack some: the same reading as
// metadata.rs (missing = null).
type Raw = {
  vcodec?: string | null;
  acodec?: string | null;
  height?: number | null;
};
const fromFixture = (raw: { formats: unknown[] }) =>
  analyseFormats(
    (raw.formats as Raw[]).map(
      (f) =>
        ({
          vcodec: f.vcodec ?? null,
          acodec: f.acodec ?? null,
          height: f.height ?? null,
        }) as Format,
    ),
  );

// A hand-made format list: [vcodec, acodec, height].
const made = (...rows: [string | null, string | null, number | null][]) =>
  analyseFormats(
    rows.map(
      ([vcodec, acodec, height]) => ({ vcodec, acodec, height }) as Format,
    ),
  );

const URL = "https://example.com/v";
const choice = (patch: Partial<Choice>): Choice => ({
  ...DEFAULT_CHOICE,
  ...patch,
});

describe("analyseFormats with real metadata", () => {
  it("YouTube: video, H.264 and webm-capable codecs, heights highest first", () => {
    const info = fromFixture(youtube);
    expect(info).toMatchObject({ hasVideo: true, hasH264: true, webm: true });
    // The storyboards (vcodec "none", no acodec) are not video: no height of theirs.
    expect(info.heights).toEqual([240, 144]);
    expect(info.av1Heights).toEqual([240]);
  });

  it("Reddit: only H.264 + AAC, so no webm", () => {
    const info = fromFixture(reddit);
    expect(info).toMatchObject({ hasVideo: true, hasH264: true, webm: false });
    expect(info.heights[0]).toBe(640);
    expect(info.av1Heights).toEqual([]);
  });

  it("SoundCloud: audio only, so no video", () => {
    const info = fromFixture(soundcloud);
    expect(info.hasVideo).toBe(false);
    expect(info.heights).toEqual([]);
    expect(effectiveKind(choice({ kind: "video" }), info)).toBe("audio");
  });

  it("a live stream with H.264 only", () => {
    const info = fromFixture(live);
    expect(info).toMatchObject({ hasVideo: true, hasH264: true });
    expect(info.heights[0]).toBe(1080);
  });
});

describe("analyseFormats edge cases", () => {
  it("a source with no known heights has an empty list", () => {
    const info = made(["h264", "aac", null]);
    expect(info.hasVideo).toBe(true);
    expect(info.heights).toEqual([]);
  });

  it("unknown codecs (null) never make anything impossible", () => {
    const info = made([null, null, 720]);
    expect(info).toMatchObject({ hasVideo: true, webm: true, heights: [] });
  });

  it("a combined format counts for video and audio", () => {
    const info = made(["vp9", "opus", 480]);
    expect(info).toMatchObject({ hasVideo: true, webm: true, heights: [480] });
  });

  it("webm needs a webm audio codec too", () => {
    expect(made(["vp9", null, 720], [null, "mp4a.40.2", null]).webm).toBe(
      false,
    );
  });
});

describe("warnings", () => {
  const yt = fromFixture(youtube);
  const rd = fromFixture(reddit);

  it("warns about AV1 only when it is the top height in a max-quality mp4", () => {
    expect(warnings(choice({ container: "mp4" }), yt)).toEqual(["av1"]);
    // Limited to 144p, the top height is 144, where there is no AV1.
    expect(warnings(choice({ container: "mp4", maxHeight: 144 }), yt)).toEqual(
      [],
    );
    expect(warnings(choice({ container: "mp4" }), rd)).toEqual([]);
    expect(warnings(choice({ container: "mp4Compatible" }), yt)).toEqual([]);
    expect(warnings(choice({ container: "mkv" }), yt)).toEqual([]);
  });

  it("warns when compatible mp4 has no H.264 to use", () => {
    const vp9 = made(["vp9", "opus", 720]);
    expect(warnings(choice({ container: "mp4Compatible" }), vp9)).toEqual([
      "noH264",
    ]);
  });

  it("warns that webm becomes mkv for an H.264 source, not for a VP9 one", () => {
    expect(warnings(choice({ container: "webm" }), rd)).toEqual(["webmToMkv"]);
    expect(warnings(choice({ container: "webm" }), yt)).toEqual([]);
  });

  it("audio warnings", () => {
    const audio = (audioFormat: Choice["audioFormat"]) =>
      warnings(choice({ kind: "audio", audioFormat }), yt);
    expect(audio("best")).toEqual([]);
    for (const f of ["mp3", "m4a", "opus"] as const) {
      expect(audio(f)).toEqual(["lossy"]);
    }
    expect(audio("flac")).toEqual(["noGain"]);
    expect(audio("wav")).toEqual(["noGain", "wavNoCover"]);
  });

  it("no video warnings in an audio-only source", () => {
    const sc = fromFixture(soundcloud);
    expect(warnings(choice({ container: "webm" }), sc)).toEqual([]);
  });
});

describe("buildRequest", () => {
  const yt = fromFixture(youtube);
  const rd = fromFixture(reddit);

  it("default: video, no limit, max-quality mp4", () => {
    expect(buildRequest(URL, DEFAULT_CHOICE, yt)).toEqual({
      url: URL,
      mode: { kind: "video", maxHeight: null, container: "mp4" },
    });
  });

  it("keeps a height the source has and drops one it does not", () => {
    const mode = (maxHeight: number) =>
      buildRequest(URL, choice({ maxHeight }), yt).mode;
    expect(mode(144)).toMatchObject({ maxHeight: 144 });
    // 1080 was picked for another source, or is not in this one: never a made-up limit.
    expect(mode(1080)).toMatchObject({ maxHeight: null });
  });

  it("sends mkv instead of an impossible webm", () => {
    expect(
      buildRequest(URL, choice({ container: "webm" }), rd).mode,
    ).toMatchObject({ container: "mkv" });
    expect(
      buildRequest(URL, choice({ container: "webm" }), yt).mode,
    ).toMatchObject({ container: "webm" });
  });

  it("audio: best has no bitrate; lossy formats have one; flac and wav none", () => {
    const mode = (audioFormat: Choice["audioFormat"], bitrateKbps = 192) =>
      buildRequest(URL, choice({ kind: "audio", audioFormat, bitrateKbps }), yt)
        .mode;
    expect(mode("best")).toEqual({
      kind: "audio",
      format: "best",
      bitrateKbps: null,
    });
    expect(mode("mp3", 320)).toMatchObject({ format: "mp3", bitrateKbps: 320 });
    expect(mode("flac")).toMatchObject({ bitrateKbps: null });
    expect(mode("wav")).toMatchObject({ bitrateKbps: null });
  });

  it("a bitrate the format does not offer falls back to one it does", () => {
    // 320 is not an Opus bitrate.
    expect(
      effectiveBitrate(choice({ audioFormat: "opus", bitrateKbps: 320 })),
    ).toBe(128);
    expect(bitrateOptions("opus")).not.toContain(320);
    expect(bitrateOptions("flac")).toEqual([]);
  });

  it("an audio-only source is always requested as audio", () => {
    const sc = fromFixture(soundcloud);
    expect(buildRequest(URL, choice({ kind: "video" }), sc).mode.kind).toBe(
      "audio",
    );
  });

  it("switching Video → Audio → Video keeps both selections", () => {
    const start = choice({
      maxHeight: 144,
      container: "mkv",
      audioFormat: "mp3",
      bitrateKbps: 256,
    });
    const audio = { ...start, kind: "audio" as const };
    const back = { ...audio, kind: "video" as const };
    expect(buildRequest(URL, audio, yt).mode).toEqual({
      kind: "audio",
      format: "mp3",
      bitrateKbps: 256,
    });
    expect(buildRequest(URL, back, yt)).toEqual(buildRequest(URL, start, yt));
    expect(buildRequest(URL, back, yt).mode).toEqual({
      kind: "video",
      maxHeight: 144,
      container: "mkv",
    });
  });
});

describe("buildPlaylistRequest", () => {
  const url = "https://a.test/v";
  const audio: Choice = {
    ...DEFAULT_CHOICE,
    kind: "audio",
    audioFormat: "mp3",
  };

  it("numbers an audio entry from 1, with the playlist's size", () => {
    expect(buildPlaylistRequest(url, audio, 0, 24)).toEqual({
      url,
      mode: { kind: "audio", format: "mp3", bitrateKbps: 192 },
      playlist: { index: 1, count: 24 },
    });
    expect(buildPlaylistRequest(url, audio, 9, 24).playlist).toEqual({
      index: 10,
      count: 24,
    });
  });

  it("numbers a video too, and leaves it plain when numbering is off", () => {
    const choice: Choice = {
      ...DEFAULT_CHOICE,
      maxHeight: 720,
      container: "webm",
    };
    const mode = { kind: "video", maxHeight: 720, container: "webm" };
    expect(buildPlaylistRequest(url, choice, 3, 9)).toEqual({
      url,
      mode,
      playlist: { index: 4, count: 9 },
    });
    const plain = buildPlaylistRequest(url, choice, 3, 9, null, false);
    expect(plain).toEqual({ url, mode });
    expect("playlist" in plain).toBe(false);
    expect(
      "playlist" in buildPlaylistRequest(url, audio, 3, 9, null, false),
    ).toBe(false);
  });

  it("puts the folder in the request, for audio and for video, and never an empty one", () => {
    const video = buildPlaylistRequest(
      url,
      DEFAULT_CHOICE,
      0,
      5,
      "My list",
      false,
    );
    expect(video).toEqual({
      url,
      mode: { kind: "video", maxHeight: null, container: "mp4" },
      folder: "My list",
    });
    expect(buildPlaylistRequest(url, audio, 1, 5, "My list")).toMatchObject({
      playlist: { index: 2, count: 5 },
      folder: "My list",
    });
    for (const none of [null, ""]) {
      expect("folder" in buildPlaylistRequest(url, audio, 0, 5, none)).toBe(
        false,
      );
    }
  });

  it("offers any usual height and never a made-up limit", () => {
    expect(PLAYLIST_SOURCE.heights).toContain(1080);
    const request = buildPlaylistRequest(
      url,
      { ...DEFAULT_CHOICE, maxHeight: 999 },
      0,
      1,
    );
    expect(request.mode).toMatchObject({ maxHeight: null });
    // No codec warning for a source it knows nothing about.
    expect(warnings(DEFAULT_CHOICE, PLAYLIST_SOURCE)).toEqual([]);
    expect(
      warnings(
        { ...DEFAULT_CHOICE, container: "mp4Compatible" },
        PLAYLIST_SOURCE,
      ),
    ).toEqual([]);
  });
});

describe("subtitles", () => {
  const url = "https://a.test/v";
  const lang = (
    code: string,
    manual: boolean,
    auto: boolean,
    name: string | null = null,
  ): SubtitleLanguage => ({ code, name, manual, auto });
  const info = (subtitles: SubtitleLanguage[]) => ({
    ...analyseFormats([]),
    hasVideo: true,
    subtitles,
  });
  const choice = (...subtitles: string[]): Choice => ({
    ...DEFAULT_CHOICE,
    subtitles,
  });

  it("asks for nothing by default, and with nothing ticked", () => {
    const source = info([lang("en", true, true)]);
    expect(buildRequest(url, DEFAULT_CHOICE, source)).toEqual({
      url,
      mode: { kind: "video", maxHeight: null, container: "mp4" },
    });
    expect("subtitles" in buildRequest(url, choice(), source)).toBe(false);
  });

  it("asks only for the ticked languages the source offers", () => {
    const source = info([lang("en", true, false), lang("es", true, false)]);
    // `fr` was ticked for another video: never asked for here.
    expect(buildRequest(url, choice("es", "fr"), source).subtitles).toEqual({
      langs: ["es"],
      auto: false,
    });
    expect(effectiveSubtitles(choice("fr"), source)).toEqual([]);
    expect("subtitles" in buildRequest(url, choice("fr"), source)).toBe(false);
  });

  it("keeps the source's order, whatever order they were ticked in", () => {
    const source = info([lang("de", true, false), lang("en", true, false)]);
    expect(
      buildRequest(url, choice("en", "de"), source).subtitles?.langs,
    ).toEqual(["de", "en"]);
  });

  it("allows the automatic captions only when a ticked language has no manual ones", () => {
    const source = info([
      lang("en", true, true),
      lang("es", false, true),
      lang("fr", true, false),
    ]);
    // Both manual and automatic: yt-dlp takes the manual one, so no automatic needed.
    expect(buildRequest(url, choice("en", "fr"), source).subtitles?.auto).toBe(
      false,
    );
    expect(buildRequest(url, choice("en", "es"), source).subtitles?.auto).toBe(
      true,
    );
    expect(buildRequest(url, choice("es"), source).subtitles?.auto).toBe(true);
  });

  it("audio never carries subtitles, even ticked", () => {
    const source = info([lang("en", true, false)]);
    const audio: Choice = { ...choice("en"), kind: "audio" };
    expect("subtitles" in buildRequest(url, audio, source)).toBe(false);
    // An audio-only source can only be audio.
    const noVideo = { ...source, hasVideo: false };
    expect("subtitles" in buildRequest(url, choice("en"), noVideo)).toBe(false);
  });

  it("a playlist offers the usual languages, all with automatic captions allowed", () => {
    expect(PLAYLIST_SOURCE.subtitlesGuessed).toBe(true);
    expect(PLAYLIST_SOURCE.subtitles.map((l) => l.code)).toEqual([
      "es",
      "en",
      "fr",
      "de",
      "it",
      "pt",
      "ja",
      "ru",
    ]);
    expect(
      buildPlaylistRequest(url, choice("en", "ja"), 0, 3).subtitles,
    ).toEqual({ langs: ["en", "ja"], auto: true });
    expect("subtitles" in buildPlaylistRequest(url, choice(), 0, 3)).toBe(
      false,
    );
  });

  it("the languages added with the + are offered on a playlist too", () => {
    const source = playlistSource(["pt-BR", "es", "zh-Hans"]);
    // The usual eight first, then the extra ones; `es` is not repeated.
    expect(source.subtitles.map((l) => l.code)).toEqual([
      "es",
      "en",
      "fr",
      "de",
      "it",
      "pt",
      "ja",
      "ru",
      "pt-BR",
      "zh-Hans",
    ]);
    expect(source.subtitles.every((l) => l.auto && !l.manual)).toBe(true);
    expect(
      buildPlaylistRequest(url, choice("pt-BR"), 0, 3, null, true, source)
        .subtitles,
    ).toEqual({ langs: ["pt-BR"], auto: true });
    // Without the source, that language is not one the playlist offers: it is dropped.
    expect(
      "subtitles" in buildPlaylistRequest(url, choice("pt-BR"), 0, 3),
    ).toBe(false);
  });

  it("a real source gives its languages through analyseFormats", () => {
    const source = analyseFormats([], [lang("en", true, true)]);
    expect(source.subtitles).toEqual([lang("en", true, true)]);
    expect(source.subtitlesGuessed).toBeUndefined();
    expect(analyseFormats([]).subtitles).toEqual([]);
  });

  it("names a language in the app's language, then by the site's name, then by its code", () => {
    expect(languageName(lang("ja", true, false), "es")).toBe("japonés");
    expect(languageName(lang("ja", true, false), "en")).toBe("Japanese");
    expect(languageName(lang("pt-BR", true, false), "en")).toBe(
      "Brazilian Portuguese",
    );
    // The browser knows nothing about this one: the site's own name, or the code.
    expect(languageName(lang("xx", true, false, "Klingon"), "en")).toBe(
      "Klingon",
    );
    expect(languageName(lang("xx", true, false), "en")).toBe("xx");
    // A code the browser rejects outright (not a language tag) does not throw.
    expect(languageName(lang("not a code", true, false, "Odd"), "en")).toBe(
      "Odd",
    );
  });
});

describe("the card's defaults and the playlist's extra languages", () => {
  it("start from the built-in choice with the user's audio format", () => {
    expect(choiceFrom({ audioFormat: "best" })).toEqual(DEFAULT_CHOICE);
    expect(choiceFrom({ audioFormat: "flac" })).toEqual({
      ...DEFAULT_CHOICE,
      audioFormat: "flac",
    });
  });

  it('the languages the "+" offers are safe codes, not repeated, and not already offered', () => {
    const usual = PLAYLIST_SOURCE.subtitles.map((l) => l.code);
    expect(new Set(MORE_LANGUAGES).size).toBe(MORE_LANGUAGES.length);
    for (const code of MORE_LANGUAGES) {
      // The rule of `is_language_code` in formats.rs.
      expect(code, code).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]{0,23}$/);
      expect(code.toLowerCase()).not.toBe("all");
      expect(usual).not.toContain(code);
    }
  });

  it("every one of them has a name in the app's language", () => {
    for (const code of MORE_LANGUAGES) {
      const name = languageName(
        { code, name: null, manual: false, auto: true },
        "en",
      );
      expect(name, code).not.toBe(code);
    }
  });
});
