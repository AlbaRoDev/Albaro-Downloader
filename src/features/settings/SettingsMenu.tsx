import { Monitor, Moon, Settings, Sun } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Field } from "@/features/downloads/DownloadOptions";
import {
  settingsActions,
  useDownloadsStore,
} from "@/features/downloads/downloadsStore";
import { folderName } from "@/features/downloads/FolderButton";
import { AUDIO_FORMATS } from "@/features/downloads/options";
import { useT } from "@/i18n";
import { type AudioFormat, BROWSERS, type Browser } from "@/lib/ipc";
import { updateSettings, useSettings } from "./settings";
import { isMac, modKey, withShortcut } from "./shortcuts";

// The gear in the top bar: a small panel with the language and the theme, and the settings of
// the downloads. Changes apply at once. Escape or a click outside closes it
// (Radix's Popover). Open or closed lives in the downloads store, so a failed row can open it.
export function SettingsMenu() {
  const t = useT();
  const { language, theme } = useSettings();
  const open = useDownloadsStore((store) => store.settingsOpen);
  return (
    <Popover open={open} onOpenChange={settingsActions.setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-lg"
          aria-label={t("settings.open")}
          title={withShortcut(t("settings.open"), ",")}
        >
          <Settings className="size-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t("settings.open")}
        className="max-h-[80vh] w-80 gap-4 overflow-y-auto p-4"
      >
        <Choice
          label={t("settings.language")}
          value={language}
          onChange={(language) => updateSettings({ language })}
          options={[
            { value: "es", text: t("settings.spanish") },
            { value: "en", text: t("settings.english") },
            { value: "system", text: t("settings.system") },
          ]}
        />
        <Choice
          label={t("settings.theme")}
          value={theme}
          onChange={(theme) => updateSettings({ theme })}
          options={[
            { value: "light", text: t("settings.light"), icon: <Sun /> },
            { value: "dark", text: t("settings.dark"), icon: <Moon /> },
            { value: "system", text: t("settings.system"), icon: <Monitor /> },
          ]}
        />
        <Appearance />
        <Defaults />
        <DownloadSettings />
        <Shortcuts />
      </PopoverContent>
    </Popover>
  );
}

// The style (sober or themed; the themed one follows the season of the year by itself).
// Independent of the light/dark choice above.
function Appearance() {
  const t = useT();
  const { style } = useSettings();
  return (
    <div className="flex flex-col gap-3">
      <Choice
        label={t("settings.style")}
        value={style}
        onChange={(style) => updateSettings({ style })}
        options={[
          { value: "sober", text: t("settings.styleSober") },
          { value: "themed", text: t("settings.styleThemed") },
        ]}
      />
      {style === "themed" && (
        <p className="text-muted-foreground text-xs">
          {t("settings.styleHint")}
        </p>
      )}
    </div>
  );
}

// What the download card starts with: the audio format. Changing it also changes the
// card now, so the next link already shows it. (Subtitle languages are picked on the card.)
function Defaults() {
  const t = useT();
  const { audioFormat } = useSettings();
  const setChoice = useDownloadsStore((store) => store.setChoice);
  const choice = useDownloadsStore((store) => store.choice);
  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <span className="font-medium text-muted-foreground text-xs">
        {t("settings.defaults")}
      </span>
      <Field
        label={t("settings.audioDefault")}
        value={audioFormat}
        options={AUDIO_FORMATS.map((format) => ({
          value: format,
          text: t(`audio.${format}`),
        }))}
        onChange={(value) => {
          const format = value as AudioFormat;
          updateSettings({ audioFormat: format });
          setChoice({ ...choice, audioFormat: format });
        }}
      />
    </div>
  );
}

// The keyboard shortcuts there are, at the bottom of the panel.
function Shortcuts() {
  const t = useT();
  const mod = modKey();
  const rows: [string, string][] = [
    [`${mod}+V`, t("shortcuts.paste")],
    [`${mod}+H`, t("shortcuts.history")],
    [`${mod}+,`, t("shortcuts.settings")],
    ["Esc", t("shortcuts.close")],
  ];
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <span className="font-medium text-muted-foreground text-xs">
        {t("shortcuts.title")}
      </span>
      <ul className="flex flex-col gap-1 text-sm">
        {rows.map(([keys, what]) => (
          <li key={keys} className="flex items-center justify-between gap-3">
            <span>{what}</span>
            <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
              {keys}
            </kbd>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The value of the cookies list's "a cookies.txt file" entry: not a browser's name.
const FILE = "file";

const MAX_CONCURRENT_CHOICES = [1, 2, 3, 4, 5, 6, 8, 10];
// KB/s: what the backend stores. A saved value that is not here (a hand-edited database) is
// added to the list, so what the panel shows is always what is in force.
const LIMIT_CHOICES_KBPS = [512, 1024, 2048, 5120, 10240, 20480, 51200];
// Proper names, the same in every language.
const BROWSER_NAMES: Record<Browser, string> = {
  chrome: "Chrome",
  edge: "Edge",
  firefox: "Firefox",
  brave: "Brave",
  opera: "Opera",
  vivaldi: "Vivaldi",
  chromium: "Chromium",
  safari: "Safari",
};

const speedText = (kbps: number) =>
  kbps >= 1024 && kbps % 1024 === 0 ? `${kbps / 1024} MB/s` : `${kbps} KB/s`;

const sortedWith = (choices: number[], current: number | null) =>
  [...new Set(current === null ? choices : [...choices, current])].sort(
    (a, b) => a - b,
  );

// Safari only exists on macOS: offered there, or when it is already the saved one.

// How many downloads run at once, the speed limit, and the browser to take cookies from (off by
// default). Disabled until the backend has answered.
function DownloadSettings() {
  const t = useT();
  const settings = useDownloadsStore((store) => store.settings);
  const problem = useDownloadsStore((store) => store.settingsProblem);
  const disabled = settings === null;
  const concurrent = settings?.maxConcurrent ?? 3;
  const limit = settings?.limitRateKbps ?? null;
  const cookiesFile = settings?.cookiesFile ?? null;
  const browsers = BROWSERS.filter(
    (b) => b !== "safari" || isMac() || settings?.cookiesBrowser === "safari",
  );
  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <span className="font-medium text-muted-foreground text-xs">
        {t("settings.downloads")}
      </span>
      <Field
        label={t("settings.maxConcurrent")}
        value={String(concurrent)}
        disabled={disabled}
        options={sortedWith(MAX_CONCURRENT_CHOICES, concurrent).map((n) => ({
          value: String(n),
          text: String(n),
        }))}
        onChange={(value) => settingsActions.setMaxConcurrent(Number(value))}
      />
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={settings?.notifications ?? true}
          disabled={disabled}
          onChange={(e) => settingsActions.setNotifications(e.target.checked)}
        />
        <span className="flex flex-col">
          {t("settings.notifications")}
          <span className="text-muted-foreground text-xs">
            {t("settings.notificationsHint")}
          </span>
        </span>
      </label>
      <div className="flex flex-col gap-1">
        <Field
          label={t("settings.limitRate")}
          value={limit === null ? "" : String(limit)}
          disabled={disabled}
          options={[
            { value: "", text: t("settings.limitNone") },
            ...sortedWith(LIMIT_CHOICES_KBPS, limit).map((kbps) => ({
              value: String(kbps),
              text: speedText(kbps),
            })),
          ]}
          onChange={(value) =>
            settingsActions.setLimitRate(value === "" ? null : Number(value))
          }
        />
        <p className="text-muted-foreground text-xs">
          {t("settings.limitHint")}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Field
          label={t("settings.cookies")}
          value={cookiesFile ? FILE : (settings?.cookiesBrowser ?? "")}
          disabled={disabled}
          options={[
            { value: "", text: t("settings.cookiesNone") },
            ...browsers.map((b) => ({ value: b, text: BROWSER_NAMES[b] })),
            { value: FILE, text: t("settings.cookiesFile") },
          ]}
          onChange={(value) =>
            value === FILE
              ? void settingsActions.pickCookiesFile()
              : settingsActions.setCookiesBrowser(
                  value === "" ? null : (value as Browser),
                )
          }
        />
        {cookiesFile && (
          <div className="flex items-center gap-2">
            <span
              className="min-w-0 flex-1 truncate text-sm"
              title={cookiesFile}
            >
              {folderName(cookiesFile)}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void settingsActions.pickCookiesFile()}
            >
              {t("settings.cookiesFileChange")}
            </Button>
          </div>
        )}
        <p className="text-muted-foreground text-xs">
          {t("settings.cookiesHint")}
        </p>
      </div>
      {problem && (
        <p role="alert" className="text-destructive text-xs">
          {t(`error.${problem}`)}
        </p>
      )}
    </div>
  );
}

interface Option<T> {
  value: T;
  text: string;
  icon?: ReactNode;
}

// One labelled row of mutually exclusive buttons. Tab reaches the selected one; the arrow
// keys move between them (Radix's roving focus).
function Choice<T extends string>(props: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: Option<T>[];
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <span id={id} className="font-medium text-muted-foreground text-xs">
        {props.label}
      </span>
      <ToggleGroup
        type="single"
        variant="outline"
        spacing={0}
        aria-labelledby={id}
        value={props.value}
        // Clicking the selected option again would clear it: keep the current one.
        onValueChange={(value) => value && props.onChange(value as T)}
      >
        {props.options.map((option) => (
          <ToggleGroupItem
            key={option.value}
            value={option.value}
            className="px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90"
          >
            {option.icon}
            {option.text}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
