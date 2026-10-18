import { redactDetail } from "./redact";

describe("redactDetail", () => {
  it("takes the user's name out of a Windows path, whatever the slashes and the name", () => {
    for (const [input, expected] of [
      ["C:\\Users\\Ana\\Videos\\a.part", "C:\\Users\\<user>\\Videos\\a.part"],
      ["C:/Users/Ana/Videos", "C:/Users/<user>/Videos"],
      ["d:\\users\\ana\\x", "d:\\users\\<user>\\x"],
      // Names with spaces and accents.
      [
        "C:\\Users\\Ana María Pérez\\AppData\\x.txt",
        "C:\\Users\\<user>\\AppData\\x.txt",
      ],
      ["\\\\?\\C:\\Users\\Ana\\a", "\\\\?\\C:\\Users\\<user>\\a"],
      [
        "[Errno 2] No such file: 'C:\\Users\\Ana\\x.txt'",
        "[Errno 2] No such file: 'C:\\Users\\<user>\\x.txt'",
      ],
    ]) {
      expect(redactDetail(input)).toBe(expected);
    }
  });

  it("takes it out of Linux and macOS paths", () => {
    expect(redactDetail("/home/ana/.local/share/x")).toBe(
      "/home/<user>/.local/share/x",
    );
    expect(redactDetail("cannot write /Users/ana/Movies/a.mp4: full")).toBe(
      "cannot write /Users/<user>/Movies/a.mp4: full",
    );
  });

  it("drops the query string and fragment of addresses, keeping where they point", () => {
    expect(
      redactDetail("GET https://a.test/v/1.mp4?sig=SECRET&exp=1#t=3 failed"),
    ).toBe("GET https://a.test/v/1.mp4?<removed> failed");
    expect(redactDetail("http://127.0.0.1:9/x?token=abc")).toBe(
      "http://127.0.0.1:9/x?<removed>",
    );
    expect(redactDetail("see https://a.test/page.")).toBe(
      "see https://a.test/page.",
    );
  });

  it("leaves ordinary text alone, and is idempotent", () => {
    const text =
      "ERROR: [youtube] abc: Video unavailable. This video is private (HTTP Error 403)";
    expect(redactDetail(text)).toBe(text);
    const dirty = "C:\\Users\\Ana\\x https://a.test/y?z=1";
    expect(redactDetail(redactDetail(dirty))).toBe(redactDetail(dirty));
    expect(redactDetail("")).toBe("");
  });
});
