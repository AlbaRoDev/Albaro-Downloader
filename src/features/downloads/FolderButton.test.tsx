import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { loadSettings, updateSettings } from "@/features/settings/settings";
import type { OutputSettings } from "@/lib/ipc";
import { resetDownloadsStore, useDownloadsStore } from "./downloadsStore";
import {
  FolderButton,
  FolderProblem,
  FolderTooDeep,
  folderName,
} from "./FolderButton";

const LONG =
  "C:\\Users\\Ana\\Vídeos ñ\\Una carpeta con un nombre de lo más largo y descriptivo";

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
  resetDownloadsStore();
});

afterEach(() => {
  clearMocks();
});

const known = (outputDir: string) =>
  act(() => useDownloadsStore.setState({ outputDir }));
const button = () => screen.getByRole("button", { name: /folder/i });

// `pick_output_dir` answers with `next()`; `release` lets a pending one finish.
function picker(next: () => OutputSettings | Promise<OutputSettings>) {
  const calls: string[] = [];
  mockIPC((cmd) => {
    calls.push(cmd);
    return cmd === "pick_output_dir" ? next() : null;
  });
  return calls;
}

describe("folderName", () => {
  it("is the last part of the path, with either separator", () => {
    expect(folderName("C:\\Users\\Ana\\Vídeos")).toBe("Vídeos");
    expect(folderName("/home/ana/Vídeos ñ/")).toBe("Vídeos ñ");
    expect(folderName("D:\\Descargas\\AlbaRo Downloader")).toBe(
      "AlbaRo Downloader",
    );
  });

  it("is the whole path for a root, which has no last part", () => {
    expect(folderName("C:\\")).toBe("C:\\");
    expect(folderName("D:")).toBe("D:");
    expect(folderName("/")).toBe("/");
  });
});

describe("the folder button", () => {
  it("shows the folder's name, the full path in its tooltip and accessible name", () => {
    known(LONG);
    render(<FolderButton />);
    expect(button().textContent).toBe(
      "Una carpeta con un nombre de lo más largo y descriptivo",
    );
    expect(button().getAttribute("title")).toBe(LONG);
    expect(button().getAttribute("aria-label")).toBe(
      `Destination folder: ${LONG}. Click to change it.`,
    );
  });

  it("reads in Spanish", () => {
    updateSettings({ language: "es" });
    known("C:\\Descargas\\AlbaRo Downloader");
    render(<FolderButton />);
    expect(
      screen.getByRole("button", {
        name: "Carpeta de destino: C:\\Descargas\\AlbaRo Downloader. Pulsa para cambiarla.",
      }),
    ).toBeTruthy();
  });

  it("is what gives way: it shrinks (to ~96 px) and cuts the name, never wider than 16 rem", () => {
    known(LONG);
    render(<FolderButton />);
    const classes = button().className;
    expect(classes).toContain("min-w-24");
    expect(classes).toContain("max-w-64");
    // `shrink` replaces the button's own `shrink-0`.
    expect(classes.split(" ")).toContain("shrink");
    expect(classes.split(" ")).not.toContain("shrink-0");
    const name = button().querySelector("span");
    expect(name?.className).toContain("truncate");
    expect(name?.className).toContain("min-w-0");
  });

  it("waits, disabled, until the saved folder is known", () => {
    render(<FolderButton />);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    expect(button().textContent).toBe("Folder");
  });

  it("a click opens the picker and shows the folder that comes back", async () => {
    known("C:\\Descargas");
    const calls = picker(() => ({
      outputDir: "D:\\Vídeos ñ",
      nameTemplate: "titleId",
      folderTooDeep: false,
    }));
    render(<FolderButton />);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(calls).toEqual(["pick_output_dir"]);
    expect(button().textContent).toBe("Vídeos ñ");
    expect(button().getAttribute("title")).toBe("D:\\Vídeos ñ");
  });

  it("cancelling the picker changes nothing", async () => {
    known("C:\\Descargas");
    picker(() => ({
      outputDir: "C:\\Descargas",
      nameTemplate: "titleId",
      folderTooDeep: false,
    }));
    render(<FolderButton />);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("Descargas");
    expect(useDownloadsStore.getState().folderProblem).toBeNull();
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it("while the picker is open it is busy and cannot open a second one", async () => {
    known("C:\\Descargas");
    let close: (settings: OutputSettings) => void = () => {};
    const calls = picker(
      () =>
        new Promise<OutputSettings>((resolve) => {
          close = resolve;
        }),
    );
    render(<FolderButton />);
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    expect(button().getAttribute("aria-label")).toBe("Choosing a folder…");
    fireEvent.click(button());
    expect(calls).toEqual(["pick_output_dir"]);
    await act(async () => {
      close({
        outputDir: "E:\\Otra",
        nameTemplate: "titleId",
        folderTooDeep: false,
      });
    });
    expect(button().textContent).toBe("Otra");
    expect(button().getAttribute("aria-busy")).toBe("false");
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });

  it("a folder that cannot be used keeps the old one and says so, until closed", async () => {
    known("C:\\Descargas");
    picker(() =>
      Promise.reject({ code: "folderUnavailable", message: "C:\\x: denied" }),
    );
    render(
      <>
        <FolderButton />
        <FolderProblem />
      </>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().textContent).toBe("Descargas");
    expect(screen.getByRole("alert").textContent).toBe(
      "The destination folder cannot be used. Pick another one.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the next pick clears the message", async () => {
    known("C:\\Descargas");
    let fail = true;
    picker(() =>
      fail
        ? Promise.reject({ code: "folderUnavailable", message: "denied" })
        : {
            outputDir: "C:\\Descargas",
            nameTemplate: "titleId",
            folderTooDeep: false,
          },
    );
    render(
      <>
        <FolderButton />
        <FolderProblem />
      </>,
    );
    await act(async () => {
      fireEvent.click(button());
    });
    expect(screen.getByRole("alert")).toBeTruthy();
    fail = false;
    await act(async () => {
      fireEvent.click(button());
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the warning for a folder that is too deep", () => {
  it("shows nothing for a folder that is fine", () => {
    render(<FolderTooDeep />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("warns, in both languages, as long as the saved folder is that deep", () => {
    act(() => useDownloadsStore.setState({ folderTooDeep: true }));
    render(<FolderTooDeep />);
    expect(screen.getByRole("status").textContent).toMatch(
      /This folder is very deep/,
    );
    act(() => updateSettings({ language: "es" }));
    expect(screen.getByRole("status").textContent).toMatch(
      /Esta carpeta es muy profunda/,
    );
    act(() => useDownloadsStore.setState({ folderTooDeep: false }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("picking a folder moves the warning with it", async () => {
    known("C:\\x");
    let deep = true;
    picker(() => ({
      outputDir: "D:\\Other",
      nameTemplate: "titleId",
      folderTooDeep: deep,
    }));
    render(
      <>
        <FolderButton />
        <FolderTooDeep />
      </>,
    );
    await act(async () => {
      fireEvent.click(button());
    });
    expect(screen.getByRole("status")).toBeTruthy();
    deep = false;
    await act(async () => {
      fireEvent.click(button());
    });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
