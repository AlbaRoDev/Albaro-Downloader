import { buildManifest, releaseNotes } from "./release-manifest.mjs";

const files = [
  {
    name: "AlbaRo-Downloader_1.2.3_x64-setup.exe",
    signature: "sigwin\n",
    sha256: "a".repeat(64),
  },
  {
    name: "AlbaRo-Downloader_1.2.3_amd64.AppImage",
    signature: "sigapp",
    sha256: "b".repeat(64),
  },
  {
    name: "AlbaRo-Downloader_1.2.3_amd64.deb",
    signature: "sigdeb",
    sha256: "c".repeat(64),
  },
];
const base = {
  tag: "v1.2.3",
  repo: "o/r",
  files,
  notes: "n",
  date: new Date(0),
};

describe("buildManifest", () => {
  it("maps each installer to its updater key, with the release download URL", () => {
    const m = buildManifest(base);
    expect(m.version).toBe("1.2.3");
    expect(m.pub_date).toBe("1970-01-01T00:00:00.000Z");
    expect(m.platforms["windows-x86_64"]).toEqual({
      signature: "sigwin",
      url: "https://github.com/o/r/releases/download/v1.2.3/AlbaRo-Downloader_1.2.3_x64-setup.exe",
    });
    expect(Object.keys(m.platforms).sort()).toEqual([
      "linux-x86_64",
      "linux-x86_64-deb",
      "windows-x86_64",
    ]);
  });

  it("refuses a missing installer, a missing signature and a bad tag", () => {
    expect(() => buildManifest({ ...base, files: files.slice(0, 2) })).toThrow(
      /deb/,
    );
    expect(() =>
      buildManifest({
        ...base,
        files: [{ ...files[0], signature: "" }, ...files.slice(1)],
      }),
    ).toThrow(/no signature/);
    expect(() => buildManifest({ ...base, tag: "1.2.3" })).toThrow(/tag/);
    expect(() => buildManifest({ ...base, tag: "v1.2" })).toThrow(/tag/);
  });
});

describe("releaseNotes", () => {
  it("lists every hash with its file name", () => {
    const text = releaseNotes("v1.2.3", files);
    for (const f of files) expect(text).toContain(`${f.sha256}  ${f.name}`);
    expect(text).toContain("SmartScreen");
  });
});
