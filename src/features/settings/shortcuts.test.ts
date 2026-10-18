import { isTyping, shortcutFor, withShortcut } from "./shortcuts";

const key = (
  init: KeyboardEventInit & { key: string },
  target?: HTMLElement,
) => {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (target) Object.defineProperty(event, "target", { value: target });
  return event;
};

describe("shortcutFor", () => {
  it("Ctrl+, is the settings and Ctrl+H the history, with Cmd as well", () => {
    expect(shortcutFor(key({ key: ",", ctrlKey: true }))).toBe("settings");
    expect(shortcutFor(key({ key: ",", metaKey: true }))).toBe("settings");
    expect(shortcutFor(key({ key: "h", ctrlKey: true }))).toBe("history");
    expect(shortcutFor(key({ key: "H", ctrlKey: true }))).toBe("history");
    expect(shortcutFor(key({ key: "h", metaKey: true }))).toBe("history");
  });

  it("the plain letter, other modifiers and other keys are nothing", () => {
    expect(shortcutFor(key({ key: "h" }))).toBeNull();
    expect(shortcutFor(key({ key: ",", shiftKey: true }))).toBe(null);
    // Ctrl+Alt is how some keyboards type characters: not ours.
    expect(
      shortcutFor(key({ key: "h", ctrlKey: true, altKey: true })),
    ).toBeNull();
    expect(shortcutFor(key({ key: "v", ctrlKey: true }))).toBeNull();
    expect(shortcutFor(key({ key: "Enter" }))).toBeNull();
  });

  it("Escape closes, unless something else took it or a field is being typed in", () => {
    expect(shortcutFor(key({ key: "Escape" }))).toBe("close");
    // The settings panel dismisses itself on Escape and prevents the default: it is not ours then.
    const taken = key({ key: "Escape" });
    taken.preventDefault();
    expect(shortcutFor(taken)).toBeNull();
    for (const tag of ["input", "textarea", "select"]) {
      expect(
        shortcutFor(key({ key: "Escape" }, document.createElement(tag))),
      ).toBeNull();
    }
    // Ctrl+H still works from inside a field: it types nothing.
    expect(
      shortcutFor(
        key({ key: "h", ctrlKey: true }, document.createElement("input")),
      ),
    ).toBe("history");
  });
});

describe("isTyping", () => {
  it("is true for fields and editable elements only", () => {
    expect(isTyping(document.createElement("input"))).toBe(true);
    const editable = document.createElement("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    expect(isTyping(editable)).toBe(true);
    expect(isTyping(document.createElement("button"))).toBe(false);
    expect(isTyping(null)).toBe(false);
    expect(isTyping(window)).toBe(false);
  });
});

describe("withShortcut", () => {
  it("adds the key to a tooltip, with Ctrl in jsdom", () => {
    expect(withShortcut("History", "H")).toBe("History (Ctrl+H)");
  });
});
