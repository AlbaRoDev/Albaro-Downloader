import {
  extractLinks,
  formatDuration,
  MAX_IMPORTED_LINKS,
  parseLink,
} from "./link";

describe("parseLink", () => {
  it("accepts an http(s) link, trimmed, with its scheme in lowercase", () => {
    expect(parseLink("https://www.youtube.com/watch?v=jNQXAC9IVRw")).toEqual({
      ok: true,
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    });
    expect(parseLink("  \n http://example.com/a?b=C \t")).toEqual({
      ok: true,
      url: "http://example.com/a?b=C",
    });
    // Only the scheme changes: the rest may be case-sensitive.
    expect(parseLink("HTTPS://Example.com/AbC")).toEqual({
      ok: true,
      url: "https://Example.com/AbC",
    });
    expect(parseLink("HtTp://x.test/")).toEqual({
      ok: true,
      url: "http://x.test/",
    });
  });

  it("rejects what is not one http(s) link", () => {
    const problem = (text: string) => {
      const result = parseLink(text);
      return result.ok ? "ok" : result.problem;
    };
    expect(problem("")).toBe("clipboardEmpty");
    expect(problem("   \n\t ")).toBe("clipboardEmpty");
    expect(problem("file:///etc/passwd")).toBe("notLink");
    expect(problem("--version")).toBe("notLink");
    expect(problem("--exec=calc.exe")).toBe("notLink");
    expect(problem("javascript:alert(1)")).toBe("notLink");
    expect(problem("ftp://example.com/a")).toBe("notLink");
    // No scheme is guessed.
    expect(problem("example.com/video")).toBe("notLink");
    expect(problem("www.youtube.com/watch?v=x")).toBe("notLink");
    // A sentence, or two links.
    expect(problem("look at https://example.com")).toBe("notLink");
    expect(problem("https://a.test/1 https://a.test/2")).toBe("notLink");
    expect(problem("https://a.test/1\nhttps://a.test/2")).toBe("notLink");
    expect(problem("https://a.test/x\ty")).toBe("notLink");
  });

  it("allows 2048 characters, not 2049", () => {
    const prefix = "https://a.test/";
    const at = (length: number) => prefix + "x".repeat(length - prefix.length);
    expect(parseLink(at(2048)).ok).toBe(true);
    expect(parseLink(at(2049))).toEqual({ ok: false, problem: "tooLong" });
    // The limit applies after trimming.
    expect(parseLink(`  ${at(2048)}  `).ok).toBe(true);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [19, "0:19"],
    [59, "0:59"],
    [60, "1:00"],
    [61, "1:01"],
    [3599, "59:59"],
    [3600, "1:00:00"],
    [3661, "1:01:01"],
    [86399, "23:59:59"],
    [90061, "25:01:01"],
    [212.4, "3:32"],
    [59.6, "1:00"],
  ])("%s s is %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe("extractLinks", () => {
  it("finds the links of a CSV in any column, quoted or not, and drops repeats", () => {
    const csv = [
      "title,url,notes",
      'One,https://a.example/v?id=1,"see, later"',
      '"Two","https://b.example/v?id=2";x',
      "https://a.example/v?id=1,again",
      "ftp://c.example/x,not a link",
    ].join("\r\n");
    expect(extractLinks(csv)).toEqual({
      urls: ["https://a.example/v?id=1", "https://b.example/v?id=2"],
      truncated: false,
    });
  });

  it("finds nothing in a text without links", () => {
    expect(extractLinks("title,url\nOne,example.com").urls).toEqual([]);
  });

  it("stops at the maximum and says so", () => {
    const text = Array.from(
      { length: MAX_IMPORTED_LINKS + 1 },
      (_, i) => `https://a.example/${i}`,
    ).join("\n");
    const { urls, truncated } = extractLinks(text);
    expect(urls).toHaveLength(MAX_IMPORTED_LINKS);
    expect(truncated).toBe(true);
  });
});
