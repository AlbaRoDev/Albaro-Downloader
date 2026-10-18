import { formatEta, formatSpeed } from "./rowFormat";

describe("formatSpeed", () => {
  it("KB/s below a megabyte, MB/s with one decimal above", () => {
    expect(formatSpeed(512 * 1024, "en")).toBe("512 KB/s");
    expect(formatSpeed(0, "en")).toBe("0 KB/s");
    expect(formatSpeed(3.2 * 1024 * 1024, "en")).toBe("3.2 MB/s");
    expect(formatSpeed(1024 * 1024, "en")).toBe("1.0 MB/s");
    expect(formatSpeed(120 * 1024 * 1024, "en")).toBe("120.0 MB/s");
  });

  it("uses the language's decimal separator", () => {
    expect(formatSpeed(3.2 * 1024 * 1024, "es")).toBe("3,2 MB/s");
  });

  it("is null when yt-dlp has no speed", () => {
    expect(formatSpeed(null, "en")).toBeNull();
    expect(formatSpeed(Number.NaN, "en")).toBeNull();
  });
});

describe("formatEta", () => {
  it("m:ss and h:mm:ss", () => {
    expect(formatEta(5)).toBe("0:05");
    expect(formatEta(65)).toBe("1:05");
    expect(formatEta(3600)).toBe("1:00:00");
    expect(formatEta(3725)).toBe("1:02:05");
  });

  it("rounds up, so it never says 0:00 while it is still going", () => {
    expect(formatEta(0.04)).toBe("0:01");
    expect(formatEta(59.2)).toBe("1:00");
    expect(formatEta(0)).toBe("0:00");
  });

  it("is null when unknown or nonsense", () => {
    expect(formatEta(null)).toBeNull();
    expect(formatEta(-1)).toBeNull();
    expect(formatEta(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
