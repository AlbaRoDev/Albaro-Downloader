import { Check, CircleAlert, Download, Info, Plus } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { type Key, useLanguage, useT } from "@/i18n";
import {
  type AudioFormat,
  asAppError,
  type Container,
  type ErrorCode,
  enqueueDownload,
  type Metadata,
  type NameTemplate,
} from "@/lib/ipc";
import { outputActions, useDownloadsStore } from "./downloadsStore";
import { problemKey } from "./LinkPreview";
import {
  AUDIO_FORMATS,
  analyseFormats,
  bitrateOptions,
  buildRequest,
  type Choice,
  CONTAINERS,
  effectiveBitrate,
  effectiveHeight,
  effectiveKind,
  languageName,
  MORE_LANGUAGES,
  type SourceInfo,
  warnings,
} from "./options";

const CONFIRMATION_MS = 3000;

// A native <select>: nothing to install, keyboard and screen readers for free, and no <style>
// element (Radix's Select inserts one, which the CSP blocks). The label sits above it.
export function Field(props: {
  label: string;
  value: string;
  options: { value: string; text: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-muted-foreground text-xs">
        {props.label}
      </label>
      <select
        id={id}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.target.value)}
        className="h-8 max-w-full rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.text}
          </option>
        ))}
      </select>
    </div>
  );
}

// The subtitle languages the source offers, to embed in the video: a box for each, none
// ticked at first. A language with only automatic captions says so. Native checkboxes, like the
// rest of the card; a long list (some sites have dozens) scrolls instead of growing the card.
function SubtitlePicker(props: {
  info: SourceInfo;
  ticked: string[];
  onChange: (ticked: string[]) => void;
  // Given on a playlist, whose languages are only guessed: shows a "+" to add any other one.
  onAdd?: (code: string) => void;
}) {
  const t = useT();
  const appLanguage = useLanguage();
  const { info, ticked } = props;
  const toggle = (code: string, on: boolean) =>
    props.onChange(
      on ? [...ticked, code] : ticked.filter((other) => other !== code),
    );
  return (
    <fieldset className="flex min-w-0 flex-col gap-1">
      <legend className="mb-1 text-muted-foreground text-xs">
        {t("options.subtitles")}
      </legend>
      {info.subtitles.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("options.subtitlesNone")}
        </p>
      ) : (
        <div className="flex max-h-28 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
          {info.subtitles.map((language) => (
            <label
              key={language.code}
              className="flex cursor-pointer items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={ticked.includes(language.code)}
                onChange={(e) => toggle(language.code, e.target.checked)}
              />
              {languageName(language, appLanguage)}
              {!language.manual && language.auto && (
                <span className="text-muted-foreground">
                  ({t("options.subtitleAuto")})
                </span>
              )}
            </label>
          ))}
        </div>
      )}
      {props.onAdd && (
        <MoreLanguages
          offered={info.subtitles.map((l) => l.code)}
          onAdd={props.onAdd}
        />
      )}
      {info.subtitlesGuessed && (
        <p className="text-muted-foreground text-xs">
          {t("options.subtitlesGuess")}
        </p>
      )}
    </fieldset>
  );
}

// The "+" of a playlist's subtitles: opens a scrollable list of other languages, named in
// the app's language, and picking one adds it to the card, ticked. A plain list of buttons, no
// popover: it stays inside the card and needs no extra permission or style.
function MoreLanguages(props: {
  offered: string[];
  onAdd: (code: string) => void;
}) {
  const t = useT();
  const appLanguage = useLanguage();
  const [open, setOpen] = useState(false);
  const rest = useMemo(
    () =>
      MORE_LANGUAGES.filter((code) => !props.offered.includes(code))
        .map((code) => ({
          code,
          name: languageName(
            { code, name: null, manual: false, auto: true },
            appLanguage,
          ),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, appLanguage)),
    [props.offered, appLanguage],
  );
  if (rest.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Plus aria-hidden />
        {t("options.addLanguage")}
      </Button>
      {open && (
        <ul
          aria-label={t("options.moreLanguages")}
          className="flex max-h-40 flex-col overflow-y-auto rounded-lg border"
        >
          {rest.map(({ code, name }) => (
            <li key={code}>
              <button
                type="button"
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                onClick={() => {
                  props.onAdd(code);
                  setOpen(false);
                }}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const containerKey = (c: Container): Key => `container.${c}`;
const audioKey = (f: AudioFormat): Key => `audio.${f}`;
const NAME_TEMPLATES: NameTemplate[] = ["title", "titleId", "channelTitle"];

const kindItem =
  "px-3 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground data-[state=on]:hover:bg-primary/90";

// Under the preview card of a video: the options for what its formats offer, and the button that
// queues it.
export function DownloadOptions(props: {
  metadata: Metadata;
  choice: Choice;
  onChange: (choice: Choice) => void;
}) {
  const t = useT();
  const { metadata } = props;
  const info = useMemo(
    () => analyseFormats(metadata.formats, metadata.subtitleLanguages),
    [metadata.formats, metadata.subtitleLanguages],
  );
  return (
    <OptionsPanel
      info={info}
      choice={props.choice}
      onChange={props.onChange}
      // A live download never ends, so the button stays off with the reason.
      disabled={metadata.isLive === true}
      note={metadata.isLive === true ? t("download.live") : undefined}
      onDownload={async () => {
        await enqueueDownload(
          buildRequest(metadata.webpageUrl, props.choice, info),
          { title: metadata.title, thumbnail: metadata.thumbnail },
        );
        return t("download.queued");
      }}
    />
  );
}

// Video/Audio, what to choose for each, what to know about it and the Download button. Shared by
// a video and a playlist, which differ in `info` (what the source offers) and in what
// the button does: `onDownload` queues and resolves with the text to confirm, or rejects. Both
// modes keep their choices in `choice` (the caller's state), so switching modes loses nothing.
export function OptionsPanel(props: {
  info: SourceInfo;
  choice: Choice;
  onChange: (choice: Choice) => void;
  onDownload: () => Promise<string>;
  // The button is off (a live stream, nothing selected); `note` says why, if it needs saying.
  disabled?: boolean;
  note?: string;
  // A playlist can add languages its entries were not analysed for (the "+" in the subtitles).
  onAddLanguage?: (code: string) => void;
}) {
  const t = useT();
  const { info, choice, onChange } = props;
  const kind = effectiveKind(choice, info);
  const set = (patch: Partial<Choice>) => onChange({ ...choice, ...patch });
  const kindId = useId();
  // The saved file name: the same for every download until changed, and not part of
  // the card's `choice`, because the backend keeps it.
  const nameTemplate = useDownloadsStore((store) => store.nameTemplate);
  const nameProblem = useDownloadsStore((store) => store.nameProblem);

  // After clicking: "queued" for a moment, or the error. The button waits meanwhile, so a
  // double click cannot queue the same download twice.
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { ok: string } | { error: ErrorCode } | null
  >(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const download = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult({ ok: await props.onDownload() });
      timer.current = window.setTimeout(() => {
        setResult(null);
        setBusy(false);
      }, CONFIRMATION_MS);
    } catch (error) {
      setResult({ error: asAppError(error).code });
      setBusy(false);
    }
  };

  const bitrates = bitrateOptions(choice.audioFormat);
  const notes = warnings(choice, info);

  return (
    <div className="flex flex-col gap-3 border-t pt-3">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="flex flex-col gap-1">
          <span id={kindId} className="text-muted-foreground text-xs">
            {t("options.kind")}
          </span>
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            aria-labelledby={kindId}
            value={kind}
            // Clicking the selected one again would clear it: keep the current one.
            onValueChange={(value) =>
              value && set({ kind: value as Choice["kind"] })
            }
          >
            <ToggleGroupItem
              value="video"
              disabled={!info.hasVideo}
              className={kindItem}
            >
              {t("options.video")}
            </ToggleGroupItem>
            <ToggleGroupItem value="audio" className={kindItem}>
              {t("options.audio")}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {kind === "video" ? (
          <>
            <Field
              label={t("options.height")}
              value={String(effectiveHeight(choice, info) ?? "")}
              disabled={info.heights.length === 0}
              options={[
                { value: "", text: t("options.heightMax") },
                ...info.heights.map((h) => ({
                  value: String(h),
                  text: `${h}p`,
                })),
              ]}
              onChange={(v) => set({ maxHeight: v === "" ? null : Number(v) })}
            />
            <Field
              label={t("options.container")}
              value={choice.container}
              options={CONTAINERS.map((c) => ({
                value: c,
                text: t(containerKey(c)),
              }))}
              onChange={(v) => set({ container: v as Container })}
            />
          </>
        ) : (
          <>
            <Field
              label={t("options.audioFormat")}
              value={choice.audioFormat}
              options={AUDIO_FORMATS.map((f) => ({
                value: f,
                text: t(audioKey(f)),
              }))}
              onChange={(v) => set({ audioFormat: v as AudioFormat })}
            />
            {bitrates.length > 0 && (
              <Field
                label={t("options.bitrate")}
                value={String(effectiveBitrate(choice))}
                options={bitrates.map((b) => ({
                  value: String(b),
                  text: t("options.kbps", { kbps: b }),
                }))}
                onChange={(v) => set({ bitrateKbps: Number(v) })}
              />
            )}
          </>
        )}
        <Field
          label={t("options.name")}
          value={nameTemplate}
          options={NAME_TEMPLATES.map((n) => ({
            value: n,
            text: t(`name.${n}`),
          }))}
          onChange={(v) => void outputActions.changeName(v as NameTemplate)}
        />
      </div>
      {nameProblem !== null && (
        <p role="alert" className="flex items-center gap-1.5 text-sm">
          <CircleAlert className="size-4 text-destructive" aria-hidden />
          {t(problemKey(nameProblem))}
        </p>
      )}
      {kind === "video" && (
        <SubtitlePicker
          info={info}
          ticked={choice.subtitles}
          onChange={(subtitles) => set({ subtitles })}
          onAdd={props.onAddLanguage}
        />
      )}
      {!info.hasVideo && (
        <p className="text-muted-foreground text-sm">{t("options.noVideo")}</p>
      )}
      {notes.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {notes.map((note) => (
            <li
              key={note}
              className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-sm"
            >
              <Info
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              {t(`warn.${note}`)}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || props.disabled}
          aria-busy={busy}
          onClick={() => void download()}
        >
          <Download />
          {t("download.button")}
        </Button>
        {props.note && (
          <span className="text-muted-foreground text-sm">{props.note}</span>
        )}
        {result !== null && "ok" in result && (
          <span role="status" className="flex items-center gap-1.5 text-sm">
            <Check className="size-4 text-primary" aria-hidden />
            {result.ok}
          </span>
        )}
        {result !== null && "error" in result && (
          <span role="alert" className="flex items-center gap-1.5 text-sm">
            <CircleAlert className="size-4 text-destructive" aria-hidden />
            {t(problemKey(result.error))}
          </span>
        )}
      </div>
    </div>
  );
}
