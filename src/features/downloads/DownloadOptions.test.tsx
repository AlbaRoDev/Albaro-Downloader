import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { loadSettings, updateSettings } from "@/features/settings/settings";
import type { DownloadRequest, Format, Metadata } from "@/lib/ipc";
import { DownloadOptions } from "./DownloadOptions";
import { resetDownloadsStore, useDownloadsStore } from "./downloadsStore";
import { type Choice, DEFAULT_CHOICE } from "./options";

const fmt = (
  vcodec: string | null,
  acodec: string | null,
  height: number | null,
) => ({ vcodec, acodec, height }) as Format;

const sources = {
  youtube: [
    fmt("none", "opus", null),
    fmt("avc1.64002A", "none", 1080),
    fmt("vp09.00.40.08", "none", 1080),
    fmt("av01.0.12M.08", "none", 2160),
    fmt("avc1.4D401F", "none", 720),
  ],
  reddit: [fmt("none", "mp4a.40.2", null), fmt("avc1.4d401f", "none", 480)],
  soundcloud: [fmt("none", "mp3", null), fmt("none", "mp4a.40.2", null)],
};

const metadata = (formats: Format[], patch: Partial<Metadata> = {}) =>
  ({
    id: "x",
    title: "T",
    channel: null,
    duration: 19,
    thumbnail: null,
    webpageUrl: "https://example.test/v",
    extractor: "test",
    isLive: false,
    formats,
    ...patch,
  }) as Metadata;

// Keeps the choice in state, like App does.
function Harness(props: { metadata: Metadata; initial?: Partial<Choice> }) {
  const [choice, setChoice] = useState({
    ...DEFAULT_CHOICE,
    ...props.initial,
  });
  return (
    <DownloadOptions
      metadata={props.metadata}
      choice={choice}
      onChange={setChoice}
    />
  );
}

let requests: DownloadRequest[];
let infos: unknown[];
let outcome: "ok" | "fail";

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
  resetDownloadsStore();
  requests = [];
  infos = [];
  outcome = "ok";
  mockIPC((cmd, args) => {
    if (cmd !== "enqueue_download") return null;
    requests.push((args as { request: DownloadRequest }).request);
    infos.push((args as { info?: unknown }).info);
    if (outcome === "fail") {
      return Promise.reject({
        code: "unknown",
        message: "already in the queue",
      });
    }
    return 1;
  });
});

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
});

const select = (label: string) =>
  screen.getByLabelText(label) as HTMLSelectElement;
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};
const radio = (name: string) => screen.getByRole("radio", { name });

it("video by default: heights from the source, and the four containers", () => {
  render(<Harness metadata={metadata(sources.youtube)} />);
  expect(radio("Video").getAttribute("aria-checked")).toBe("true");
  const heights = [...select("Maximum resolution").options].map((o) => o.text);
  expect(heights).toEqual(["Maximum", "2160p", "1080p", "720p"]);
  const containers = [...select("Format").options].map((o) => o.text);
  expect(containers).toEqual([
    "MP4 best quality",
    "MP4 compatible",
    "MKV",
    "WebM",
  ]);
  // The best-quality mp4 is AV1 here.
  expect(screen.getByText(/uses AV1/)).toBeTruthy();
});

it("downloads with the chosen options and confirms briefly", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<Harness metadata={metadata(sources.youtube)} />);
  fireEvent.change(select("Maximum resolution"), { target: { value: "1080" } });
  fireEvent.change(select("Format"), { target: { value: "mp4Compatible" } });
  await click("Download");
  // The preview's title and thumbnail go along, for the list.
  expect(infos).toEqual([{ title: "T", thumbnail: null }]);
  expect(requests).toEqual([
    {
      url: "https://example.test/v",
      mode: { kind: "video", maxHeight: 1080, container: "mp4Compatible" },
    },
  ]);
  expect(screen.getByRole("status").textContent).toContain(
    "Added to the queue",
  );
  // The button waits while the confirmation shows: no double click.
  expect(
    (screen.getByRole("button", { name: "Download" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await act(async () => {
    vi.advanceTimersByTime(3100);
  });
  expect(screen.queryByRole("status")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Download" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("a rejected download shows its error and can be tried again", async () => {
  outcome = "fail";
  render(<Harness metadata={metadata(sources.youtube)} />);
  await click("Download");
  expect(screen.getByRole("alert").textContent).toContain("unexpected");
  expect(
    (screen.getByRole("button", { name: "Download" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});

it("switching to Audio and back keeps each mode's choices", () => {
  render(<Harness metadata={metadata(sources.youtube)} />);
  fireEvent.change(select("Maximum resolution"), { target: { value: "720" } });
  fireEvent.change(select("Format"), { target: { value: "mkv" } });
  fireEvent.click(radio("Audio"));
  expect(select("Format").value).toBe("best");
  fireEvent.change(select("Format"), { target: { value: "mp3" } });
  fireEvent.change(select("Quality"), { target: { value: "256" } });
  fireEvent.click(radio("Video"));
  expect(select("Maximum resolution").value).toBe("720");
  expect(select("Format").value).toBe("mkv");
  fireEvent.click(radio("Audio"));
  expect(select("Format").value).toBe("mp3");
  expect(select("Quality").value).toBe("256");
});

it("audio: bitrate only for lossy formats, with the warnings", () => {
  render(
    <Harness
      metadata={metadata(sources.youtube)}
      initial={{ kind: "audio" }}
    />,
  );
  expect(screen.queryByLabelText("Quality")).toBeNull();
  expect(screen.queryByText(/loses quality/)).toBeNull();
  fireEvent.change(select("Format"), { target: { value: "mp3" } });
  expect(select("Quality")).toBeTruthy();
  expect(screen.getByText(/loses quality/)).toBeTruthy();
  fireEvent.change(select("Format"), { target: { value: "flac" } });
  expect(screen.queryByLabelText("Quality")).toBeNull();
  expect(screen.getByText(/do not improve/)).toBeTruthy();
  fireEvent.change(select("Format"), { target: { value: "wav" } });
  expect(screen.getByText(/cannot hold cover art/)).toBeTruthy();
});

it("an H.264-only source: WebM warns it will be MKV, and MKV is what is requested", async () => {
  render(
    <Harness
      metadata={metadata(sources.reddit)}
      initial={{ container: "webm" }}
    />,
  );
  expect(screen.getByText(/saved as MKV/)).toBeTruthy();
  await click("Download");
  expect(requests[0].mode).toMatchObject({ container: "mkv" });
});

it("an audio-only source: video is disabled, with the reason, and audio is requested", async () => {
  render(<Harness metadata={metadata(sources.soundcloud)} />);
  expect((radio("Video") as HTMLInputElement).disabled).toBe(true);
  expect(radio("Audio").getAttribute("aria-checked")).toBe("true");
  expect(screen.getByText("This source has audio only.")).toBeTruthy();
  await click("Download");
  expect(requests[0].mode).toEqual({
    kind: "audio",
    format: "best",
    bitrateKbps: null,
  });
});

it("a source without known heights: the limit stays on Maximum, disabled", () => {
  render(
    <Harness metadata={metadata([fmt("avc1.4d401f", "mp4a.40.2", null)])} />,
  );
  expect(select("Maximum resolution").disabled).toBe(true);
  expect(select("Maximum resolution").value).toBe("");
});

it("a live stream cannot be downloaded yet", () => {
  render(<Harness metadata={metadata(sources.youtube, { isLive: true })} />);
  expect(
    (screen.getByRole("button", { name: "Download" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByText(/Live streams/)).toBeTruthy();
});

it("a height picked for another source is not sent, nor shown", async () => {
  render(
    <Harness
      metadata={metadata(sources.reddit)}
      initial={{ maxHeight: 2160 }}
    />,
  );
  expect(select("Maximum resolution").value).toBe("");
  await click("Download");
  expect(requests[0].mode).toMatchObject({ maxHeight: null });
});

describe("the file name", () => {
  let nameCalls: unknown[];
  let nameOutcome: "ok" | "fail";

  // Like the beforeEach backend, plus the new command.
  beforeEach(() => {
    resetDownloadsStore();
    nameCalls = [];
    nameOutcome = "ok";
    mockIPC((cmd, args) => {
      if (cmd === "set_name_template") {
        nameCalls.push(args);
        return nameOutcome === "fail"
          ? Promise.reject({ code: "unknown", message: "database is locked" })
          : null;
      }
      if (cmd === "enqueue_download") {
        requests.push((args as { request: DownloadRequest }).request);
        return outcome === "fail"
          ? Promise.reject({ code: "folderUnavailable", message: "denied" })
          : 1;
      }
      return null;
    });
  });

  const names = () => [...select("File name").options].map((o) => o.text);

  it("offers the three names, on the saved one", () => {
    useDownloadsStore.setState({ nameTemplate: "channelTitle" });
    render(<Harness metadata={metadata(sources.youtube)} />);
    expect(names()).toEqual(["Title", "Title [id]", "Channel - Title"]);
    expect(select("File name").value).toBe("channelTitle");
  });

  it("starts on Title [id], the default", () => {
    render(<Harness metadata={metadata(sources.youtube)} />);
    expect(select("File name").value).toBe("titleId");
  });

  it("is there in audio mode too, with the same value", () => {
    render(<Harness metadata={metadata(sources.soundcloud)} />);
    expect(select("File name").value).toBe("titleId");
  });

  it("saves the change at once, and the next card shows it", async () => {
    const { unmount } = render(
      <Harness metadata={metadata(sources.youtube)} />,
    );
    await act(async () => {
      fireEvent.change(select("File name"), { target: { value: "title" } });
    });
    expect(nameCalls).toEqual([{ template: "title" }]);
    expect(select("File name").value).toBe("title");
    unmount();
    render(<Harness metadata={metadata(sources.reddit)} />);
    expect(select("File name").value).toBe("title");
  });

  it("goes back to the old name, and says why, when saving fails", async () => {
    nameOutcome = "fail";
    render(<Harness metadata={metadata(sources.youtube)} />);
    await act(async () => {
      fireEvent.change(select("File name"), {
        target: { value: "channelTitle" },
      });
    });
    expect(select("File name").value).toBe("titleId");
    expect(screen.getByRole("alert").textContent).toContain("unexpected");
    // Trying again clears the message.
    nameOutcome = "ok";
    await act(async () => {
      fireEvent.change(select("File name"), { target: { value: "title" } });
    });
    expect(select("File name").value).toBe("title");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an unusable folder when queueing is said in the card, in both languages", async () => {
    outcome = "fail";
    render(<Harness metadata={metadata(sources.youtube)} />);
    await click("Download");
    expect(screen.getByRole("alert").textContent).toBe(
      "The destination folder cannot be used. Pick another one.",
    );
    // The button is ready for another try once the folder is fixed.
    expect(
      (screen.getByRole("button", { name: "Download" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    act(() => updateSettings({ language: "es" }));
    expect(screen.getByRole("alert").textContent).toBe(
      "No se puede usar la carpeta de destino. Elige otra.",
    );
  });
});

describe("subtitles", () => {
  const languages = [
    { code: "en", name: "English", manual: true, auto: true },
    { code: "es", name: "Spanish", manual: false, auto: true },
    { code: "ja", name: "Japanese", manual: false, auto: true },
  ];
  const withSubs = () =>
    metadata(sources.youtube, { subtitleLanguages: languages });
  const box = (name: string | RegExp) =>
    screen.getByRole("checkbox", { name }) as HTMLInputElement;

  it("lists the languages, none ticked, and says which are only automatic", () => {
    render(<Harness metadata={withSubs()} />);
    expect(screen.getByText("Subtitles")).toBeTruthy();
    expect(box("English").checked).toBe(false);
    expect(box(/Spanish.*automatic/).checked).toBe(false);
    expect(box(/Japanese.*automatic/).checked).toBe(false);
    // English has them by hand: nothing to flag; the other two say so.
    expect(screen.getAllByText("(automatic)")).toHaveLength(2);
    expect(box("English").parentElement?.textContent).not.toContain(
      "automatic",
    );
  });

  it("says so when the video has none", () => {
    render(<Harness metadata={metadata(sources.youtube)} />);
    expect(screen.getByText("This video has no subtitles.")).toBeTruthy();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("is in Spanish, with the languages named in Spanish", () => {
    updateSettings({ language: "es" });
    render(<Harness metadata={withSubs()} />);
    expect(screen.getByText("Subtítulos")).toBeTruthy();
    expect(box(/japonés.*automáticos/)).toBeTruthy();
    expect(box("inglés")).toBeTruthy();
  });

  it("sends the ticked languages with Download, and the automatic flag when needed", async () => {
    render(<Harness metadata={withSubs()} />);
    fireEvent.click(box("English"));
    await click("Download");
    expect(requests[0].subtitles).toEqual({ langs: ["en"], auto: false });
  });

  it("ticking an automatic-only language turns the automatic captions on", async () => {
    render(<Harness metadata={withSubs()} />);
    fireEvent.click(box("English"));
    fireEvent.click(box(/Spanish/));
    expect(box(/Spanish/).checked).toBe(true);
    await click("Download");
    expect(requests[0].subtitles).toEqual({ langs: ["en", "es"], auto: true });
  });

  it("unticking removes it, and nothing ticked sends no subtitles at all", async () => {
    render(<Harness metadata={withSubs()} />);
    fireEvent.click(box("English"));
    fireEvent.click(box("English"));
    expect(box("English").checked).toBe(false);
    await click("Download");
    expect("subtitles" in requests[0]).toBe(false);
  });

  it("only for video: audio hides them and sends none", async () => {
    render(
      <Harness
        metadata={withSubs()}
        initial={{ kind: "audio", subtitles: ["en"] }}
      />,
    );
    expect(screen.queryByText("Subtitles")).toBeNull();
    await click("Download");
    expect("subtitles" in requests[0]).toBe(false);
  });

  it("a language ticked for another video stays ticked but is not asked for here", async () => {
    render(
      <Harness metadata={withSubs()} initial={{ subtitles: ["fr", "ja"] }} />,
    );
    expect(box(/Japanese/).checked).toBe(true);
    await click("Download");
    expect(requests[0].subtitles).toEqual({ langs: ["ja"], auto: true });
  });
});
