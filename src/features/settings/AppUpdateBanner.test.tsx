import { emit } from "@tauri-apps/api/event";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  act,
  configure,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  resetDownloadsStore,
  useDownloadsStore,
} from "@/features/downloads/downloadsStore";
import type { Download } from "@/lib/ipc";
import { AppUpdateBanner } from "./AppUpdateBanner";
import { loadSettings, updateSettings } from "./settings";

// The first test of the file loads the Tauri event plugin and took 6.9 s on a loaded CI runner,
// past the default 5 s: this file gets more time, for the test and for each wait.
vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
  resetDownloadsStore();
});

afterEach(() => {
  clearMocks();
});

// `known` is what `get_app_update` answers; `install` is what `install_app_update` does.
function setup(known: string | null, install: () => unknown = () => null) {
  const calls: string[] = [];
  mockIPC(
    (cmd) => {
      calls.push(cmd);
      if (cmd === "get_app_update") return known ? { version: known } : null;
      if (cmd === "install_app_update") return install();
      return null;
    },
    { shouldMockEvents: true },
  );
  render(<AppUpdateBanner />);
  return calls;
}

const installButton = () =>
  screen.findByRole("button", { name: /install|installing/i });

describe("AppUpdateBanner", () => {
  it("shows nothing when there is no update", async () => {
    setup(null);
    await act(async () => {});
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers the update it finds at start, and installs only on the button", async () => {
    const calls = setup("0.2.0");
    expect(await screen.findByText(/0\.2\.0/)).toBeTruthy();
    expect(calls).not.toContain("install_app_update");
    fireEvent.click(await installButton());
    expect(calls).toContain("install_app_update");
  });

  it("shows an update announced later by the event", async () => {
    setup(null);
    await act(async () => {});
    await act(async () => {
      await emit("app-update-available", { version: "0.3.0" });
    });
    expect(await screen.findByText(/0\.3\.0/)).toBeTruthy();
  });

  it("waits while a download runs, and 'Later' hides it", async () => {
    setup("0.2.0");
    await screen.findByText(/0\.2\.0/);
    act(() =>
      useDownloadsStore.getState().dispatch({
        type: "loaded",
        downloads: [{ id: 1, state: "active" } as Download],
      }),
    );
    const button = await installButton();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/finish or cancel/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says so when the installation fails, and lets the user retry", async () => {
    setup("0.2.0", () => {
      throw { code: "unknown", message: "update failed: bad signature" };
    });
    fireEvent.click(await installButton());
    expect(await screen.findByText(/could not be installed/i)).toBeTruthy();
    expect(((await installButton()) as HTMLButtonElement).disabled).toBe(false);
  });
});
