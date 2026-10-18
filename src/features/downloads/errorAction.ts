import type { ErrorCode } from "@/lib/ipc";

// What a failed download's row offers besides "Retry" and "Remove": nothing, to pick another
// folder and retry there, or to open the settings, where the cookies of a browser can
// be turned on.
export type ErrorAction = "none" | "otherFolder" | "settings";

// The action for each error code. An exhaustive switch with no default: adding a code to
// `ERROR_CODES` stops compiling here until someone decides what it offers. Another folder only
// helps when the disk is full or the folder cannot be used; `network` keeps its partial files in
// the old folder, and the rest would fail the same anywhere. (src-tauri/src/queue.rs checks the
// same two codes before it moves a download: change both together.) A login the site asks for
// is what browser cookies are for, and a browser whose cookies cannot be read is fixed by
// choosing another one: both lead to the settings.
export function errorAction(code: ErrorCode): ErrorAction {
  switch (code) {
    case "noSpace":
    case "folderUnavailable":
      return "otherFolder";
    case "loginRequired":
    case "cookiesUnavailable":
      return "settings";
    case "network":
    case "extractorBroken":
    case "unavailable":
    case "ffmpeg":
    case "jsRuntimeMissing":
    case "cancelled":
    case "invalidUrl":
    case "unsupportedUrl":
    case "alreadyQueued":
    case "playlist":
    case "unknown":
      return "none";
  }
}
