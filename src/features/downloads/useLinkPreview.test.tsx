import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, renderHook } from "@testing-library/react";
import type { Metadata, Playlist } from "@/lib/ipc";
import { useLinkPreview } from "./useLinkPreview";

const metadata = (url: string): Metadata => ({
  id: url,
  title: `Title of ${url}`,
  channel: null,
  duration: 10,
  thumbnail: null,
  webpageUrl: url,
  extractor: "test",
  isLive: false,
  formats: [],
  subtitleLanguages: [],
});

const playlist: Playlist = {
  title: "A list",
  channel: null,
  truncated: false,
  entries: [
    {
      url: "https://a.test/1",
      title: "One",
      duration: 5,
      thumbnail: null,
      channel: null,
      unavailable: null,
    },
  ],
};

// A URL with "playlist" makes fetch_metadata reject with `playlist` (then fetch_playlist
// answers, or fails with "listfail" in the URL).
// fetch_metadata answers after `delays[url]` ms (default 100): with `fail` in the URL it
// rejects like Rust (an AppError), with `garbage` it rejects with a plain string like Tauri.
// The clipboard plugin's read_text gives `clipboard()`.
let calls: string[];
function mockBackend(
  delays: Record<string, number> = {},
  clipboard: () => Promise<string> = async () => "",
) {
  calls = [];
  mockIPC((cmd, args) => {
    if (cmd === "plugin:clipboard-manager|read_text") return clipboard();
    const url = (args as { url: string }).url;
    calls.push(`${cmd} ${url}`);
    return new Promise((resolve, reject) =>
      setTimeout(() => {
        if (cmd === "fetch_playlist") {
          if (url.includes("listfail")) {
            reject({ code: "network", message: "offline" });
          } else {
            resolve(playlist);
          }
        } else if (url.includes("playlist")) {
          reject({ code: "playlist", message: "a playlist" });
        } else if (url.includes("fail")) {
          reject({ code: "unavailable", message: "gone" });
        } else if (url.includes("garbage")) {
          reject("invalid args `url` for command `fetch_metadata`");
        } else {
          resolve(metadata(url));
        }
      }, delays[url] ?? 100),
    );
  });
}

// jsdom has no ClipboardEvent with data: a plain `paste` event carrying `clipboardData`.
function paste(target: EventTarget, text: string) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: () => text },
  });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

it("goes idle → loading → ready", async () => {
  mockBackend();
  const { result } = renderHook(() => useLinkPreview());
  expect(result.current.state).toEqual({ status: "idle" });
  paste(document.body, " HTTPS://a.test/1 ");
  expect(result.current.state).toEqual({
    status: "loading",
    url: "https://a.test/1",
  });
  await advance(100);
  expect(result.current.state).toEqual({
    status: "ready",
    metadata: metadata("https://a.test/1"),
  });
  act(() => result.current.dismiss());
  expect(result.current.state).toEqual({ status: "idle" });
});

it("ignores a result that arrives after a newer link", async () => {
  // The first answers last: its result must not replace the second's.
  mockBackend({ "https://a.test/slow": 3000, "https://a.test/fast": 500 });
  const { result } = renderHook(() => useLinkPreview());
  paste(document.body, "https://a.test/slow");
  await advance(200);
  paste(document.body, "https://a.test/fast");
  await advance(500);
  expect(result.current.state).toMatchObject({
    status: "ready",
    metadata: { webpageUrl: "https://a.test/fast" },
  });
  await advance(3000);
  expect(result.current.state).toMatchObject({
    metadata: { webpageUrl: "https://a.test/fast" },
  });
  expect(calls).toEqual([
    "fetch_metadata https://a.test/slow",
    "fetch_metadata https://a.test/fast",
  ]);
});

it("a stale failure and a dismissed load change nothing either", async () => {
  mockBackend({ "https://a.test/fail": 1000 });
  const { result } = renderHook(() => useLinkPreview());
  paste(document.body, "https://a.test/fail");
  act(() => result.current.dismiss());
  await advance(1000);
  expect(result.current.state).toEqual({ status: "idle" });
});

it("shows the error code, and anything unstructured as unknown", async () => {
  mockBackend();
  const { result } = renderHook(() => useLinkPreview());
  paste(document.body, "https://a.test/fail");
  await advance(100);
  expect(result.current.state).toEqual({
    status: "error",
    problem: "unavailable",
    message: "gone",
  });
  paste(document.body, "https://a.test/garbage");
  await advance(100);
  // Tauri's own refusal is a plain text: `unknown`, with that text as the technical detail.
  expect(result.current.state).toEqual({
    status: "error",
    problem: "unknown",
    message: "invalid args `url` for command `fetch_metadata`",
  });
});

describe("a playlist or channel link", () => {
  it("is listed after fetch_metadata says so, staying 'loading' meanwhile", async () => {
    mockBackend();
    const { result } = renderHook(() => useLinkPreview());
    paste(document.body, "https://a.test/playlist?list=1");
    await advance(100);
    expect(result.current.state).toMatchObject({ status: "loading" });
    await advance(100);
    expect(result.current.state).toEqual({ status: "playlist", playlist });
    expect(calls).toEqual([
      "fetch_metadata https://a.test/playlist?list=1",
      "fetch_playlist https://a.test/playlist?list=1",
    ]);
  });

  it("shows the listing's error", async () => {
    mockBackend();
    const { result } = renderHook(() => useLinkPreview());
    paste(document.body, "https://a.test/playlist-listfail");
    await advance(200);
    expect(result.current.state).toEqual({
      status: "error",
      problem: "network",
      message: "offline",
    });
  });

  it("a newer link or dismissing wins over a listing in flight", async () => {
    mockBackend({ "https://a.test/video": 150 });
    const { result } = renderHook(() => useLinkPreview());
    paste(document.body, "https://a.test/playlist");
    await advance(100); // metadata answered "playlist"; the listing is running
    paste(document.body, "https://a.test/video");
    await advance(100); // the old listing finishes now: ignored
    expect(result.current.state).toMatchObject({ status: "loading" });
    await advance(100);
    expect(result.current.state).toMatchObject({ status: "ready" });
    paste(document.body, "https://a.test/playlist");
    await advance(100);
    act(() => result.current.dismiss());
    await advance(100);
    expect(result.current.state).toEqual({ status: "idle" });
  });
});

it("rejects an invalid text without asking the backend", () => {
  mockBackend();
  const { result } = renderHook(() => useLinkPreview());
  paste(document.body, "--version");
  expect(result.current.state).toEqual({ status: "error", problem: "notLink" });
  paste(document.body, "");
  expect(result.current.state).toEqual({
    status: "error",
    problem: "clipboardEmpty",
  });
  expect(calls).toEqual([]);
});

describe("the Paste link button", () => {
  it("reads a valid link from the clipboard", async () => {
    mockBackend({}, async () => "https://a.test/1");
    const { result } = renderHook(() => useLinkPreview());
    await act(() => result.current.pasteFromClipboard());
    expect(result.current.state).toEqual({
      status: "loading",
      url: "https://a.test/1",
    });
  });

  it("reports an invalid text", async () => {
    mockBackend({}, async () => "a long sentence with spaces, not a link");
    const { result } = renderHook(() => useLinkPreview());
    await act(() => result.current.pasteFromClipboard());
    expect(result.current.state).toEqual({
      status: "error",
      problem: "notLink",
    });
  });

  it("reports a clipboard with no text, or that cannot be read", async () => {
    // What the plugin does with an empty clipboard or an image: reject with a string.
    mockBackend({}, () =>
      Promise.reject("The clipboard contents were not available"),
    );
    const { result } = renderHook(() => useLinkPreview());
    await act(() => result.current.pasteFromClipboard());
    expect(result.current.state).toEqual({
      status: "error",
      problem: "clipboardEmpty",
    });
  });
});

describe("Ctrl+V", () => {
  it("does nothing while a text field has the focus", () => {
    mockBackend();
    const { result } = renderHook(() => useLinkPreview());
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inside = document.createElement("span");
    editable.append(inside);
    document.body.append(input, textarea, editable);
    for (const target of [input, textarea, inside]) {
      const event = paste(target, "https://a.test/1");
      // Left alone: the field gets its paste.
      expect(event.defaultPrevented).toBe(false);
    }
    expect(result.current.state).toEqual({ status: "idle" });
    expect(calls).toEqual([]);
  });

  it("stops listening when unmounted", () => {
    mockBackend();
    const { unmount } = renderHook(() => useLinkPreview());
    unmount();
    paste(document.body, "https://a.test/1");
    expect(calls).toEqual([]);
  });
});
