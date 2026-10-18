import { ERROR_CODES, type ErrorCode } from "@/lib/ipc";
import { type ErrorAction, errorAction } from "./errorAction";

// A `Record` over every code: adding one to `ERROR_CODES` stops this file compiling until the
// new code is listed here, which is the moment to decide what its row offers.
const expected: Record<ErrorCode, ErrorAction> = {
  noSpace: "otherFolder",
  folderUnavailable: "otherFolder",
  network: "none",
  extractorBroken: "none",
  unavailable: "none",
  ffmpeg: "none",
  jsRuntimeMissing: "none",
  cancelled: "none",
  invalidUrl: "none",
  loginRequired: "settings",
  cookiesUnavailable: "settings",
  unsupportedUrl: "none",
  alreadyQueued: "none",
  playlist: "none",
  unknown: "none",
};

describe("errorAction", () => {
  it.each(ERROR_CODES)("%s", (code) => {
    expect(errorAction(code)).toBe(expected[code]);
  });

  it("only a full disk or an unusable folder offers another folder", () => {
    const elsewhere = ERROR_CODES.filter(
      (code) => errorAction(code) === "otherFolder",
    );
    expect(elsewhere).toEqual(["noSpace", "folderUnavailable"]);
  });

  it("only a login or unreadable cookies lead to the settings", () => {
    const settings = ERROR_CODES.filter(
      (code) => errorAction(code) === "settings",
    );
    expect(settings).toEqual(["loginRequired", "cookiesUnavailable"]);
  });

  it("the table lists exactly the codes there are", () => {
    expect(Object.keys(expected).sort()).toEqual([...ERROR_CODES].sort());
  });
});
