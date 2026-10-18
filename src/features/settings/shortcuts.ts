// The keyboard shortcuts, as plain functions so they can be tested without a page.
// Pasting a link with Ctrl+V is older and lives in `useLinkPreview`.

// What a key press asks for, if anything.
export type Shortcut = "settings" | "history" | "close";

// Ctrl on Windows and Linux, Cmd on macOS.
export const isMac = () =>
  typeof navigator !== "undefined" && /mac/i.test(navigator.userAgent);
export const modKey = () => (isMac() ? "⌘" : "Ctrl");

// A field where typing is what a key means, so the shortcuts keep out of its way.
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
  );
}

// Ctrl+, opens the settings and Ctrl+H the history (or goes back from it), like most apps. Escape
// closes what is open, but not when something else already took it (`defaultPrevented`: the
// settings panel closes itself on Escape and says so that way) nor while typing in a field.
export function shortcutFor(event: KeyboardEvent): Shortcut | null {
  const mod = (event.ctrlKey || event.metaKey) && !event.altKey;
  if (mod && event.key === ",") return "settings";
  if (mod && event.key.toLowerCase() === "h") return "history";
  if (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !isTyping(event.target)
  ) {
    return "close";
  }
  return null;
}

// The hint in a button's tooltip: "History (Ctrl+H)".
export const withShortcut = (label: string, key: string) =>
  `${label} (${modKey()}+${key})`;
