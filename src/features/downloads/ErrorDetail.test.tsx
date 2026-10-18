import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { loadSettings, updateSettings } from "@/features/settings/settings";
import { ErrorDetail } from "./ErrorDetail";

const MESSAGE =
  "ERROR: unable to write data: [Errno 28] No space left on device: 'C:\\Vídeos ñ\\a.part'";

let written: unknown[];
let failWrite: boolean;

beforeEach(() => {
  localStorage.clear();
  loadSettings();
  updateSettings({ language: "en" });
  written = [];
  failWrite = false;
  mockIPC((cmd, args) => {
    if (cmd !== "plugin:clipboard-manager|write_text") return null;
    written.push(args);
    return failWrite ? Promise.reject("clipboard unavailable") : null;
  });
});

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const toggle = () =>
  screen.getByRole("button", {
    name: /^(view|hide) detail$|^(ver|ocultar) detalle$/i,
  });

describe("ErrorDetail", () => {
  it("is closed by default: the message is in the page but hidden", () => {
    render(<ErrorDetail code="noSpace" message={MESSAGE} />);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(toggle().textContent).toBe("View detail");
    // `hidden`: not shown, and not in the accessibility tree either, but in the page, so that
    // `aria-controls` points at something.
    expect(screen.queryByRole("button", { name: "Copy detail" })).toBeNull();
    const panel = document.getElementById(
      toggle().getAttribute("aria-controls") ?? "",
    );
    expect(panel?.hidden).toBe(true);
    expect(panel?.textContent).toContain(MESSAGE);
  });

  it("opens and closes with the toggle, which is a native, focusable button", () => {
    render(<ErrorDetail code="noSpace" message={MESSAGE} />);
    // A real <button type="button">: Tab reaches it, Enter and Space press it.
    expect(toggle().tagName).toBe("BUTTON");
    expect(toggle().getAttribute("type")).toBe("button");
    toggle().focus();
    expect(document.activeElement).toBe(toggle());

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(toggle().textContent).toBe("Hide detail");
    expect(screen.getByText(MESSAGE)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy detail" })).toBeTruthy();
    const panel = document.getElementById(
      toggle().getAttribute("aria-controls") ?? "",
    );
    expect(panel?.hidden).toBe(false);

    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(panel?.hidden).toBe(true);
    expect(screen.queryByRole("button", { name: "Copy detail" })).toBeNull();
  });

  it("shows the message selectable and unable to widen its row", () => {
    render(<ErrorDetail code="noSpace" message={MESSAGE} />);
    fireEvent.click(toggle());
    const text = screen.getByText(MESSAGE);
    expect(text.tagName).toBe("PRE");
    for (const cls of [
      "font-mono",
      "select-text",
      "max-h-32",
      "overflow-auto",
      "whitespace-pre-wrap",
      "[overflow-wrap:anywhere]",
    ]) {
      expect(text.className).toContain(cls);
    }
  });

  it("copies `<code>: <message>` and says Copied for 2 s", async () => {
    vi.useFakeTimers();
    render(<ErrorDetail code="noSpace" message={MESSAGE} />);
    fireEvent.click(toggle());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy detail" }));
    });
    expect(written).toEqual([{ text: `noSpace: ${MESSAGE}` }]);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1999);
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button", { name: "Copy detail" })).toBeTruthy();
  });

  it("copies the detail without the user's name or the tokens in addresses, and shows it whole", async () => {
    const raw =
      "ERROR: cannot write C:\\Users\\Ana María\\Vídeos\\a.part; GET https://cdn.test/v.mp4?sig=SECRET failed";
    render(<ErrorDetail code="unknown" message={raw} />);
    fireEvent.click(toggle());
    // What the user reads is the real message.
    expect(document.querySelector("pre")?.textContent).toBe(raw);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy detail" }));
    });
    const copied = (written[0] as { text: string }).text;
    expect(copied).toBe(
      "unknown: ERROR: cannot write C:\\Users\\<user>\\Vídeos\\a.part; GET https://cdn.test/v.mp4?<removed> failed",
    );
    expect(copied).not.toContain("Ana");
    expect(copied).not.toContain("SECRET");
  });

  it("a second copy restarts the 2 s", async () => {
    vi.useFakeTimers();
    render(<ErrorDetail code="unknown" message="boom" />);
    fireEvent.click(toggle());
    const copy = async () =>
      act(async () => {
        fireEvent.click(screen.getByRole("button", { name: /Cop/ }));
      });
    await copy();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    await copy();
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByRole("button", { name: "Copy detail" })).toBeTruthy();
    expect(written).toHaveLength(2);
  });

  it("if the clipboard refuses, it does not say Copied", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    failWrite = true;
    render(<ErrorDetail code="unknown" message="boom" />);
    fireEvent.click(toggle());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy detail" }));
    });
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    expect(error).toHaveBeenCalled();
  });

  it("with no message there is nothing to offer", () => {
    for (const message of ["", "   \n"]) {
      const { container, unmount } = render(
        <ErrorDetail code="unknown" message={message} />,
      );
      expect(container.innerHTML).toBe("");
      unmount();
    }
  });

  it("reads in Spanish", async () => {
    updateSettings({ language: "es" });
    render(<ErrorDetail code="noSpace" message={MESSAGE} />);
    expect(toggle().textContent).toBe("Ver detalle");
    fireEvent.click(toggle());
    expect(toggle().textContent).toBe("Ocultar detalle");
    expect(screen.getByRole("button", { name: "Copiar detalle" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copiar detalle" }));
    });
    expect(screen.getByRole("button", { name: "Copiado" })).toBeTruthy();
  });

  it("each instance keeps its own open state", () => {
    render(
      <>
        <ErrorDetail code="unknown" message="first" />
        <ErrorDetail code="unknown" message="second" />
      </>,
    );
    const [one, two] = screen.getAllByRole("button", { name: "View detail" });
    fireEvent.click(one);
    expect(one.getAttribute("aria-expanded")).toBe("true");
    expect(two.getAttribute("aria-expanded")).toBe("false");
  });
});
