import {
  findChecksum,
  licenceProblem,
  pickFfmpegAsset,
} from "./fetch-sidecars.mjs";

const HASH = "a".repeat(64);

describe("findChecksum", () => {
  it("finds a hash by name in a checksum list", () => {
    const list = `${"b".repeat(64)}  other.zip\n${HASH}  yt-dlp.exe\n`;
    expect(findChecksum(list, "yt-dlp.exe")).toBe(HASH);
  });

  it("reads certutil output with an uppercase hash (Deno)", () => {
    const certutil = `\r\nAlgorithm : SHA256\r\nHash : ${HASH.toUpperCase()}\r\n`;
    expect(findChecksum(certutil, "deno.zip")).toBe(HASH);
  });

  it("throws when the name is not listed", () => {
    const list = `${HASH}  a.zip\n${"b".repeat(64)}  b.zip\n`;
    expect(() => findChecksum(list, "c.zip")).toThrow();
  });
});

describe("pickFfmpegAsset", () => {
  const names = [
    "SHA256SUMS",
    "ffmpeg-n9.0.1-albaro3-win64.zip",
    "ffmpeg-n9.0.2-albaro1-win64.zip",
    "ffmpeg-n9.0.2-albaro2-win64.zip",
    "ffmpeg-n9.0.2-albaro2-linux64.tar.xz",
    "ffmpeg-n8.1.0-albaro9-win64.zip",
  ];

  it("picks the platform's newest version, then its highest revision", () => {
    expect(pickFfmpegAsset(names, "win64")).toBe(
      "ffmpeg-n9.0.2-albaro2-win64.zip",
    );
    expect(pickFfmpegAsset(names, "linux64")).toBe(
      "ffmpeg-n9.0.2-albaro2-linux64.tar.xz",
    );
  });

  it("compares numbers, not text (10 is newer than 9)", () => {
    const list = [
      "ffmpeg-n9.0.2-albaro9-win64.zip",
      "ffmpeg-n9.0.2-albaro10-win64.zip",
      "ffmpeg-n10.0.0-albaro1-win64.zip",
    ];
    expect(pickFfmpegAsset(list, "win64")).toBe(
      "ffmpeg-n10.0.0-albaro1-win64.zip",
    );
  });

  it("throws when the platform has no build, and ignores anyone else's builds", () => {
    expect(() => pickFfmpegAsset(names, "winarm64")).toThrow();
    expect(() =>
      pickFfmpegAsset(["ffmpeg-n9.0-latest-win64-lgpl-9.0.zip"], "win64"),
    ).toThrow();
  });
});

describe("licenceProblem", () => {
  const ours =
    "ffmpeg version 9.0.2\nconfiguration: --prefix=/x --enable-static --disable-shared --disable-autodetect --enable-zlib --enable-libmp3lame --enable-libopus --enable-schannel --extra-cflags=-I/x";

  it("accepts the build we make", () => {
    expect(licenceProblem(ours)).toBeNull();
  });

  it("refuses GPL, nonfree and version3 code", () => {
    for (const flag of ["gpl", "nonfree", "version3"]) {
      expect(licenceProblem(`${ours} --enable-${flag}`)).toMatch(/GPL/);
    }
  });

  it("refuses the BtbN build: chromaprint pulls in FFTW (GPL) without --enable-gpl", () => {
    // The real start of the configuration line of BtbN's "lgpl" build (n9.0.2-22-g46d8f462ee-20261005).
    const btbn =
      "configuration: --prefix=/ffbuild/prefix --enable-version3 --disable-debug --enable-zlib --enable-chromaprint --enable-libdav1d";
    expect(licenceProblem(btbn)).toBeTruthy();
    expect(licenceProblem(`${ours} --enable-chromaprint`)).toMatch(
      /chromaprint/,
    );
  });

  it("refuses a library we did not choose", () => {
    expect(licenceProblem(`${ours} --enable-libx264`)).toMatch(/libx264/);
  });
});
