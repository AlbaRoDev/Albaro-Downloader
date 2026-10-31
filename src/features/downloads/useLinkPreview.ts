import { useCallback, useEffect, useRef, useState } from "react";
import {
  asAppError,
  type ErrorCode,
  fetchMetadata,
  fetchPlaylist,
  type Metadata,
  type Playlist,
  pickLinksFile,
  readClipboardText,
} from "@/lib/ipc";
import { extractLinks, type LinkProblem, parseLink } from "./link";

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
// ponytail: one yt-dlp run per link (2-4 s), so only the first DETAILS_LIMIT of a file get a
// title and thumbnail, DETAILS_PARALLEL at a time. The rest keep their link as title. Raise the
// limit (or read the rest as the list scrolls) if that falls short.
const DETAILS_LIMIT = 50;
const DETAILS_PARALLEL = 3;

export function useLinkPreview() {
  const [state, setState] = useState<PreviewState>({ status: "idle" });
  const latest = useRef(0);

  // Reads each link's metadata and puts it in its entry of the playlist on screen. A link that
  // fails (or is itself a playlist) stays as it is. Stops when a newer request replaces this one.
  const fillDetails = useCallback((request: number, urls: string[]) => {
    let next = 0;
    const worker = async () => {
      while (next < urls.length && request === latest.current) {
        const index = next++;
        let metadata: Metadata;
        try {
          metadata = await fetchMetadata(urls[index]);
        } catch {
          continue;
        }
        if (request !== latest.current) return;
        setState((previous) => {
          if (previous.status !== "playlist") return previous;
          const { title, thumbnail, duration, channel } = metadata;
          const entries = previous.playlist.entries.map((entry, i) =>
            i === index
              ? { ...entry, title, thumbnail, duration, channel }
              : entry,
          );
          return {
            status: "playlist",
            playlist: { ...previous.playlist, entries },
          };
        });
      }
    };
    for (let i = 0; i < DETAILS_PARALLEL; i++) void worker();
  }, []);

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

  // A CSV or text file with links, shown as a playlist: the same picker, options and queueing.
  // Cancelling the dialog changes nothing. The titles start as the links themselves; the first
  // ones are then read in the background (`fillDetails`) to get title and thumbnail.
  const importFile = useCallback(async () => {
    let file: Awaited<ReturnType<typeof pickLinksFile>>;
    try {
      file = await pickLinksFile();
    } catch (error) {
      latest.current++;
      const { code, message } = asAppError(error);
      setState({ status: "error", problem: code, message });
      return;
    }
    if (!file) return;
    const request = ++latest.current;
    const { urls, truncated } = extractLinks(file.text);
    if (urls.length === 0) {
      setState({ status: "error", problem: "noLinks" });
      return;
    }
    setState({
      status: "playlist",
      playlist: {
        title: file.name,
        channel: null,
        entries: urls.map((url) => ({
          url,
          title: url,
          unavailable: null,
          duration: null,
          thumbnail: null,
          channel: null,
        })),
        truncated,
      },
    });
    fillDetails(request, urls.slice(0, DETAILS_LIMIT));
  }, [fillDetails]);

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

  return { state, pasteFromClipboard, importFile, dismiss };
}
