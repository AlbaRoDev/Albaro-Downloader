import { fireEvent, render, screen } from "@testing-library/react";
import { loadSettings, updateSettings } from "@/features/settings/settings";
import { translate } from "@/i18n";
import en from "@/i18n/en.json";
import es from "@/i18n/es.json";
import { ERROR_CODES, type Metadata } from "@/lib/ipc";
import { resetDownloadsStore, useDownloadsStore } from "./downloadsStore";
import { LinkPreview, problemKey } from "./LinkPreview";
import type { PreviewProblem } from "./useLinkPreview";

const metadata: Metadata = {
  id: "x",
  title: "Me at the zoo",
  channel: "jawed",
  duration: 19,
  thumbnail: "https://i.test/x.jpg",
  webpageUrl: "https://www.youtube.com/watch?v=x",
  extractor: "youtube",
  isLive: false,
  formats: [],
  subtitleLanguages: [],
};

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
});

const show = (m: Partial<Metadata>, onDismiss = () => {}) =>
  render(
    <LinkPreview
      state={{ status: "ready", metadata: { ...metadata, ...m } }}
      onDismiss={onDismiss}
    />,
  );

it("every problem has its own text in Spanish and English", () => {
  const problems: PreviewProblem[] = [
    ...ERROR_CODES,
    "clipboardEmpty",
    "tooLong",
    "notLink",
  ];
  for (const language of ["es", "en"] as const) {
    const texts = problems.map((p) => translate(language, problemKey(p)));
    for (const text of texts) expect(text).toMatch(/\w/);
    // No two problems share a text.
    expect(new Set(texts).size).toBe(problems.length);
  }
  // And no error text is left untranslated.
  for (const key of Object.keys(es).filter((k) => k.startsWith("error."))) {
    expect(es[key as keyof typeof es], key).not.toBe(
      en[key as keyof typeof en],
    );
  }
});

it("shows title, channel, site and duration, and can be dismissed", () => {
  const onDismiss = vi.fn();
  show({}, onDismiss);
  expect(screen.getByRole("heading", { name: "Me at the zoo" })).toBeTruthy();
  expect(screen.getByText("jawed · youtube")).toBeTruthy();
  expect(screen.getByText("0:19")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("says Live instead of a duration, in the current language", () => {
  updateSettings({ language: "es" });
  show({ isLive: true, duration: null });
  expect(screen.getByText("En directo")).toBeTruthy();
});

it("shows a placeholder when there is no thumbnail or it fails to load", () => {
  const { container, unmount } = show({});
  const img = container.querySelector("img") as HTMLImageElement;
  expect(img.getAttribute("src")).toBe("https://i.test/x.jpg");
  expect(screen.queryByTestId("thumbnail-placeholder")).toBeNull();
  fireEvent.error(img);
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByTestId("thumbnail-placeholder")).toBeTruthy();
  unmount();
  show({ thumbnail: null });
  expect(screen.getByTestId("thumbnail-placeholder")).toBeTruthy();
});

// jsdom does no layout, so this checks the classes that keep a long title and a long duration
// inside the card; the real overflow was checked in the browser at 760 px.
it("a long title is clamped to two lines and wraps anywhere; the text column can shrink", () => {
  show({ title: "W".repeat(500), duration: 90061, channel: "C".repeat(300) });
  const title = screen.getByRole("heading");
  expect(title.className).toMatch(/line-clamp-2/);
  expect(title.className).toMatch(/overflow-wrap:anywhere/);
  expect(title.parentElement?.className).toMatch(/min-w-0/);
  expect(screen.getByText(/^C+ · youtube$/).className).toMatch(/truncate/);
  expect(screen.getByText("25:01:01")).toBeTruthy();
});

it("shows an error as an alert that can be closed", () => {
  const onDismiss = vi.fn();
  render(
    <LinkPreview
      state={{ status: "error", problem: "unsupportedUrl" }}
      onDismiss={onDismiss}
    />,
  );
  expect(screen.getByRole("alert").textContent).toBe(
    "This site isn't supported.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onDismiss).toHaveBeenCalledOnce();
});

it("shows a busy skeleton while loading", () => {
  render(
    <LinkPreview
      state={{ status: "loading", url: "https://a.test" }}
      onDismiss={() => {}}
    />,
  );
  expect(screen.getByTestId("preview-skeleton").getAttribute("aria-busy")).toBe(
    "true",
  );
  expect(screen.getByRole("status").textContent).toBe("Reading the link…");
});

it("an error with a technical message offers it behind View detail, with a copy button", () => {
  render(
    <LinkPreview
      state={{
        status: "error",
        problem: "unavailable",
        message: "ERROR: [youtube] xxxxxxxxxxx: Video unavailable",
      }}
      onDismiss={() => {}}
    />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "The content isn't available",
  );
  fireEvent.click(screen.getByRole("button", { name: "View detail" }));
  expect(screen.getByText(/Video unavailable/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Copy detail" })).toBeTruthy();
});

it("a problem found before asking the backend has no detail to view", () => {
  render(
    <LinkPreview
      state={{ status: "error", problem: "notLink" }}
      onDismiss={() => {}}
    />,
  );
  expect(screen.queryByText("View detail")).toBeNull();
});

describe("an error the settings can fix", () => {
  afterEach(resetDownloadsStore);
  const error = (problem: PreviewProblem) =>
    render(
      <LinkPreview state={{ status: "error", problem }} onDismiss={() => {}} />,
    );

  it.each(["loginRequired", "cookiesUnavailable"] as const)(
    "%s has a button that opens the settings",
    (problem) => {
      error(problem);
      expect(useDownloadsStore.getState().settingsOpen).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
      expect(useDownloadsStore.getState().settingsOpen).toBe(true);
    },
  );

  it("is in Spanish too", () => {
    updateSettings({ language: "es" });
    error("loginRequired");
    expect(screen.getByRole("button", { name: "Abrir ajustes" })).toBeTruthy();
  });

  it.each(["unsupportedUrl", "network", "clipboardEmpty", "notLink"] as const)(
    "%s has none",
    (problem) => {
      error(problem);
      expect(
        screen.queryByRole("button", { name: "Open settings" }),
      ).toBeNull();
    },
  );
});
