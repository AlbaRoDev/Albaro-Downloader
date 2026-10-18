import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { loadSettings, updateSettings } from "@/features/settings/settings";
import type { DownloadRequest, Playlist, PlaylistEntry } from "@/lib/ipc";
import { type Choice, DEFAULT_CHOICE } from "./options";
import { PlaylistPicker } from "./PlaylistPicker";

const entry = (
  n: number,
  extra: Partial<PlaylistEntry> = {},
): PlaylistEntry => ({
  url: `https://a.test/${n}`,
  title: `Video ${n}`,
  duration: 60 * n,
  thumbnail: `https://i.test/${n}.jpg`,
  channel: "Chan",
  unavailable: null,
  ...extra,
});

const playlist = (entries: PlaylistEntry[]): Playlist => ({
  title: "My list",
  channel: "Owner",
  entries,
  truncated: false,
});

const show = (
  p: Playlist,
  onDismiss = () => {},
  choice: Choice = DEFAULT_CHOICE,
) =>
  render(
    <PlaylistPicker
      playlist={p}
      choice={choice}
      onChoose={() => {}}
      onDismiss={onDismiss}
    />,
  );

// The entries' boxes only, not the "own folder" one.
const boxes = () =>
  within(screen.getByRole("list", { name: "Videos in the list" })).getAllByRole(
    "checkbox",
  ) as HTMLInputElement[];

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
});

it("says when the list was cut and there is more", () => {
  show({ ...playlist([entry(1), entry(2)]), truncated: true });
  expect(
    screen.getByText(
      "Owner · 2 videos · there are more: only the first are shown",
    ),
  ).toBeTruthy();
});

it("shows hostile titles as plain text", () => {
  const hostile =
    '<img src=x onerror="window.__pwned=1"> <b>bold</b> \u202eevil';
  show(playlist([entry(1, { title: hostile })]));
  expect(screen.getByText(hostile)).toBeTruthy();
  expect(document.querySelector("img[src='x']")).toBeNull();
  expect(document.querySelector("b")).toBeNull();
  expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
});

it("shows the title, channel and count, and can be dismissed", () => {
  const onDismiss = vi.fn();
  show(playlist([entry(1), entry(2), entry(3)]), onDismiss);
  expect(screen.getByRole("heading", { name: "My list" })).toBeTruthy();
  expect(screen.getByText("Owner · 3 videos")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("lists every entry with its title, channel and duration, all ticked", () => {
  show(playlist([entry(1), entry(2)]));
  const list = screen.getByRole("list", { name: "Videos in the list" });
  expect(list.querySelectorAll("li")).toHaveLength(2);
  expect(screen.getByText("Video 2")).toBeTruthy();
  expect(screen.getByText("2:00")).toBeTruthy();
  expect(boxes().map((b) => b.checked)).toEqual([true, true]);
  expect(screen.getByText("2 of 2 selected")).toBeTruthy();
});

it("ticks and unticks one entry, and counts what is selected", () => {
  show(playlist([entry(1), entry(2), entry(3)]));
  fireEvent.click(screen.getByRole("checkbox", { name: /Video 2/ }));
  expect(boxes().map((b) => b.checked)).toEqual([true, false, true]);
  expect(screen.getByText("2 of 3 selected")).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /Video 2/ }));
  expect(screen.getByText("3 of 3 selected")).toBeTruthy();
});

it("select all / clear, each disabled when it would change nothing", () => {
  show(playlist([entry(1), entry(2)]));
  const all = screen.getByRole("button", { name: "Select all" });
  const none = screen.getByRole("button", { name: "Clear selection" });
  expect(all).toHaveProperty("disabled", true);
  fireEvent.click(none);
  expect(boxes().map((b) => b.checked)).toEqual([false, false]);
  expect(screen.getByText("0 of 2 selected")).toBeTruthy();
  expect(none).toHaveProperty("disabled", true);
  fireEvent.click(all);
  expect(boxes().map((b) => b.checked)).toEqual([true, true]);
});

it("the same video twice is two independent rows", () => {
  show(playlist([entry(1), entry(1)]));
  fireEvent.click(boxes()[0]);
  expect(boxes().map((b) => b.checked)).toEqual([false, true]);
});

it("an entry without title, duration or thumbnail still shows", () => {
  show(playlist([entry(1, { title: null, duration: null, thumbnail: null })]));
  expect(screen.getByText("Untitled video")).toBeTruthy();
  expect(screen.getByTestId("entry-placeholder")).toBeTruthy();
  expect(screen.queryByText("0:00")).toBeNull();
});

it("a thumbnail that fails to load becomes the placeholder", () => {
  const { container } = show(playlist([entry(1)]));
  fireEvent.error(container.querySelector("img") as HTMLImageElement);
  expect(screen.getByTestId("entry-placeholder")).toBeTruthy();
});

it("an empty playlist says so and offers nothing to select", () => {
  show(playlist([]));
  expect(screen.getByText("No videos were found in this list.")).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
});

it("speaks Spanish, with its plural", () => {
  updateSettings({ language: "es" });
  show(playlist([entry(1)]));
  expect(screen.getByText("Owner · 1 vídeo")).toBeTruthy();
  expect(screen.getByText("1 de 1 seleccionado")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Seleccionar todo" })).toBeTruthy();
});

it("keeps long titles from overflowing", () => {
  show(playlist([entry(1, { title: "x".repeat(300) })]));
  const title = screen.getByText("x".repeat(300));
  expect(title.className).toContain("line-clamp-2");
  expect(title.className).toContain("overflow-wrap:anywhere");
});

describe("the Download button", () => {
  const list = playlist([
    entry(1),
    entry(2, { title: null, thumbnail: null }),
    entry(3),
  ]);
  const audio: Choice = { ...DEFAULT_CHOICE, kind: "audio" };
  let sent: unknown[];
  function backend(answer: unknown = { queued: 2, skipped: 0 }) {
    sent = [];
    mockIPC((cmd, args) => {
      sent.push([cmd, args]);
      if (answer instanceof Error)
        throw { code: "folderUnavailable", message: "x" };
      return answer;
    });
  }
  afterEach(() => clearMocks());
  const click = () =>
    fireEvent.click(screen.getByRole("button", { name: "Download" }));

  it("queues the ticked entries in order, numbered when it is audio", async () => {
    backend({ queued: 2, skipped: 0 });
    show(list, undefined, audio);
    fireEvent.click(screen.getByRole("checkbox", { name: /Video 3/ }));
    click();
    expect(await screen.findByText("2 videos added to the queue")).toBeTruthy();
    const mode = { kind: "audio", format: "best", bitrateKbps: null };
    expect(sent).toEqual([
      [
        "enqueue_downloads",
        {
          // The playlist's name, for the group in the list.
          batchTitle: "My list",
          items: [
            {
              request: {
                url: "https://a.test/1",
                mode,
                playlist: { index: 1, count: 3 },
                // The playlist's title: "its own folder" starts ticked.
                folder: "My list",
              },
              info: { title: "Video 1", thumbnail: "https://i.test/1.jpg" },
            },
            {
              // The position is the entry's place in the list, not among the ticked ones.
              request: {
                url: "https://a.test/2",
                mode,
                playlist: { index: 2, count: 3 },
                folder: "My list",
              },
              info: { title: null, thumbnail: null },
            },
          ],
        },
      ],
    ]);
  });

  const sentRequests = () =>
    (sent[0] as [string, { items: { request: object }[] }])[1].items.map(
      (i) => i.request,
    );

  it("numbers a video by its place in the list, like audio", async () => {
    backend();
    show(list);
    click();
    await screen.findByRole("status");
    const requests = sentRequests();
    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual({
      url: "https://a.test/1",
      mode: { kind: "video", maxHeight: null, container: "mp4" },
      playlist: { index: 1, count: 3 },
      folder: "My list",
    });
  });

  it("numbers by default and sends plain names when that is unticked", async () => {
    backend();
    show(list, undefined, audio);
    const box = screen.getByRole("checkbox", {
      name: "Number the files in the list's order",
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    click();
    await screen.findByRole("status");
    const requests = sentRequests();
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => !("playlist" in r))).toBe(true);
    // The other option is independent: the folder is still sent.
    expect(requests.every((r) => "folder" in r)).toBe(true);
  });

  it("offers numbering even for a playlist without a title", () => {
    backend();
    show({ ...list, title: "  " });
    expect(
      screen.getByRole("checkbox", {
        name: "Number the files in the list's order",
      }),
    ).toBeTruthy();
  });

  it("saves in the playlist's folder unless that is unticked", async () => {
    backend();
    show(list);
    const box = screen.getByRole("checkbox", {
      name: "Save in its own folder",
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    click();
    await screen.findByRole("status");
    const items = (sent[0] as [string, { items: { request: object }[] }])[1]
      .items;
    expect(items.every((i) => !("folder" in i.request))).toBe(true);
  });

  it("offers no folder for a playlist without a title", async () => {
    backend();
    show({ ...list, title: "  " });
    expect(screen.queryByText("Save in its own folder")).toBeNull();
    click();
    await screen.findByRole("status");
    const items = (sent[0] as [string, { items: { request: object }[] }])[1]
      .items;
    expect(items.every((i) => !("folder" in i.request))).toBe(true);
  });

  it("says how many were already in the queue", async () => {
    backend({ queued: 1, skipped: 2 });
    show(list);
    click();
    expect(
      await screen.findByText(
        "1 video added to the queue. 2 were already in the queue",
      ),
    ).toBeTruthy();
  });

  it("is off with nothing ticked", () => {
    backend();
    show(list);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    const button = screen.getByRole("button", { name: "Download" });
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    expect(sent).toEqual([]);
  });

  it("shows the backend's error", async () => {
    backend(new Error("boom"));
    show(list);
    click();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("folder");
  });

  it("offers every height and format, with no warning about a source it knows nothing of", () => {
    show(list);
    expect(screen.getByRole("option", { name: "1080p" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "WebM" })).toBeTruthy();
    expect(screen.queryByText(/AV1/)).toBeNull();
  });
});

describe("private and deleted videos", () => {
  const gone = (n: number, why: "private" | "deleted") =>
    entry(n, {
      title: null,
      duration: null,
      thumbnail: null,
      channel: null,
      unavailable: why,
    });
  // 1 ok, 2 private, 3 ok, 4 deleted, 5 ok
  const mixed = playlist([
    entry(1),
    gone(2, "private"),
    entry(3),
    gone(4, "deleted"),
    entry(5),
  ]);

  it("lists them greyed out, named by what they are, with no box to tick", () => {
    show(mixed);
    expect(screen.getByText("Owner · 5 videos · 2 unavailable")).toBeTruthy();
    expect(screen.getByText("Private video")).toBeTruthy();
    expect(screen.getByText("Deleted video")).toBeTruthy();
    expect(boxes().map((b) => [b.checked, b.disabled])).toEqual([
      [true, false],
      [false, true],
      [true, false],
      [false, true],
      [true, false],
    ]);
    expect(screen.getAllByTestId("entry-placeholder")).toHaveLength(2);
  });

  it("counts and selects only the ones that can be downloaded", () => {
    show(mixed);
    expect(screen.getByText("3 of 3 selected")).toBeTruthy();
    // "Select all" is already everything there is to select.
    expect(screen.getByRole("button", { name: "Select all" })).toHaveProperty(
      "disabled",
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("0 of 3 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(boxes().map((b) => b.checked)).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
  });

  describe("when downloading", () => {
    afterEach(() => clearMocks());

    it("leaves them out, keeping every position and the playlist's size", async () => {
      const sent: unknown[] = [];
      mockIPC((cmd, args) => {
        sent.push([cmd, args]);
        return { queued: 3, skipped: 0 };
      });
      show(mixed, undefined, { ...DEFAULT_CHOICE, kind: "audio" });
      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      await screen.findByRole("status");
      const [, args] = sent[0] as [
        string,
        { items: { request: DownloadRequest }[] },
      ];
      expect(args.items.map((i) => i.request.url)).toEqual([
        "https://a.test/1",
        "https://a.test/3",
        "https://a.test/5",
      ]);
      // Numbered by place in the list: the gaps stay, so 1, 3 and 5.
      expect(args.items.map((i) => i.request.playlist)).toEqual([
        { index: 1, count: 5 },
        { index: 3, count: 5 },
        { index: 5, count: 5 },
      ]);
    });
  });

  it("offers nothing to download when none is available", () => {
    show(playlist([gone(1, "private"), gone(2, "deleted")]));
    expect(
      screen.getByText("None of the videos in this list can be downloaded."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Select all" })).toBeNull();
    // They are still listed, so it is clear why.
    expect(screen.getByText("Private video")).toBeTruthy();
  });

  it("is in Spanish too", () => {
    updateSettings({ language: "es" });
    show(mixed);
    expect(
      screen.getByText("Owner · 5 vídeos · 2 no disponibles"),
    ).toBeTruthy();
    expect(screen.getByText("Vídeo privado")).toBeTruthy();
    expect(screen.getByText("Vídeo borrado")).toBeTruthy();
  });
});

describe("subtitles in a playlist", () => {
  let sent: DownloadRequest[];
  beforeEach(() => {
    sent = [];
    mockIPC((cmd, args) => {
      if (cmd === "enqueue_downloads") {
        sent = (args as { items: { request: DownloadRequest }[] }).items.map(
          (i) => i.request,
        );
        return { queued: sent.length, skipped: 0 };
      }
      return null;
    });
  });
  afterEach(() => clearMocks());

  // The card's choice lives in the caller (the store): a stand-in that keeps it, so ticking works.
  function Stateful(props: { playlist: Playlist }) {
    const [choice, setChoice] = useState<Choice>(DEFAULT_CHOICE);
    return (
      <PlaylistPicker
        playlist={props.playlist}
        choice={choice}
        onChoose={setChoice}
        onDismiss={() => {}}
      />
    );
  }

  it("offers the usual languages and says they are only embedded where there are", () => {
    show(playlist([entry(1), entry(2)]));
    for (const name of [/Spanish/, /English/, /French/, /German/, /Japanese/]) {
      expect(screen.getByRole("checkbox", { name })).toBeTruthy();
    }
    expect(
      screen.getByText("Embedded in the videos of the list that have them."),
    ).toBeTruthy();
  });

  it("puts the ticked ones in every request, with the automatic captions allowed", async () => {
    render(<Stateful playlist={playlist([entry(1), entry(2)])} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Spanish/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /English/ }));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await screen.findByRole("status");
    expect(sent).toHaveLength(2);
    for (const request of sent) {
      expect(request.subtitles).toEqual({ langs: ["es", "en"], auto: true });
    }
  });

  it("a + adds any other language from a scrollable list, ticked, and it is sent", async () => {
    render(<Stateful playlist={playlist([entry(1)])} />);
    // Not among the usual eight until it is added.
    expect(screen.queryByRole("checkbox", { name: /Swedish/ })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Add another language" }),
    );
    const list = screen.getByRole("list", { name: "More languages" });
    // Named in the app's language, in order, with none of the eight already offered.
    const names = [...list.querySelectorAll("button")].map(
      (b) => b.textContent,
    );
    expect(names).toContain("Swedish");
    expect(names).toContain("Brazilian Portuguese");
    expect(names).not.toContain("Spanish");
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, "en")));
    fireEvent.click(within(list).getByRole("button", { name: "Swedish" }));
    // The list closes, the language shows as one more box, already ticked.
    expect(screen.queryByRole("list", { name: "More languages" })).toBeNull();
    const box = screen.getByRole("checkbox", {
      name: /Swedish/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await screen.findByRole("status");
    expect(sent[0].subtitles).toEqual({ langs: ["sv"], auto: true });
  });

  it("a language that was added is not offered again in the list", () => {
    render(<Stateful playlist={playlist([entry(1)])} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Add another language" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Swedish" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Add another language" }),
    );
    expect(screen.queryByRole("button", { name: "Swedish" })).toBeNull();
  });

  it("sends none by default, and none for audio", async () => {
    show(playlist([entry(1)]));
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await screen.findByRole("status");
    expect("subtitles" in sent[0]).toBe(false);
  });
});
