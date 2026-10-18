import { useCallback, useEffect, useRef, useState } from "react";
import {
  asAppError,
  type ErrorCode,
  fetchMetadata,
  fetchPlaylist,
  type Metadata,
  type Playlist,
  readClipboardText,
} from "@/lib/ipc";
import { type LinkProblem, parseLink } from "./link";

// Anything the preview can show as an error: a backend code, or a problem found before asking
// it (a pasted text that is not a link).
export type PreviewProblem = ErrorCode | LinkProblem;

export type PreviewState =
  | { status: "idle" }
  | { status: "loading"; url: string }
  | { status: "ready"; metadata: Metadata }
  // The link is a playlist or channel: its entries, to pick from.
  | { status: "playlist"; playlist: Playlist }
  // `message` is the backend's technical detail, when there is one (not for a pasted text that
  // is not a link).
  | { status: "error"; problem: PreviewProblem; message?: string };

// True when the user is typing somewhere: Ctrl+V there pastes into that field instead.
function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'input, textarea, [contenteditable]:not([contenteditable="false"])',
    ) !== null
  );
}

// The link preview's state (local, not in the Zustand store). A link comes from the
// "Paste link" button (`pasteFromClipboard`, through the clipboard plugin) or from Ctrl+V anywhere outside a text field (the
// document's `paste` event, which needs no clipboard permission). Analysing takes 2-4 s and
// cannot be cancelled in Rust, so a newer link simply wins: every request takes a number and
// only the latest one may change the state.
export function useLinkPreview() {
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const latest = useRef(0);

  const show = useCallback((text: string) => {
    const request = ++latest.current;
    const link = parseLink(text);
    if (!link.ok) {
      setState({ status: "error", problem: link.problem });
      return;
    }
    setState({ status: "loading", url: link.url });
    const fail = (error: unknown) => {
      if (request !== latest.current) return;
      const { code, message } = asAppError(error);
      setState({ status: "error", problem: code, message });
    };
    fetchMetadata(link.url).then(
      (metadata) => {
        if (request === latest.current) setState({ status: "ready", metadata });
      },
      (error) => {
        if (asAppError(error).code !== "playlist") return fail(error);
        // A playlist or channel, not a video: list its entries (still "loading" meanwhile).
        if (request !== latest.current) return;
        fetchPlaylist(link.url).then((playlist) => {
          if (request === latest.current)
            setState({ status: "playlist", playlist });
        }, fail);
      },
    );
  }, []);

  const pasteFromClipboard = useCallback(async () => {
    let text: string;
    try {
      text = await readClipboardText();
    } catch {
      // The plugin rejects when there is no text (an empty clipboard, an image): the same
      // message as pasting an empty text with Ctrl+V.
      latest.current++;
      setState({ status: "error", problem: "clipboardEmpty" });
      return;
    }
    show(text);
  }, [show]);

  const dismiss = useCallback(() => {
    latest.current++;
    setState({ status: "idle" });
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (isEditable(event.target)) return;
      event.preventDefault();
      show(event.clipboardData?.getData("text") ?? "");
    };
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [show]);

  return { state, pasteFromClipboard, dismiss };
}
