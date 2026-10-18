import { ImageOff } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { enqueueDownloads, type Playlist, type PlaylistEntry } from "@/lib/ipc";
import { OptionsPanel } from "./DownloadOptions";
import { DismissButton } from "./LinkPreview";
import { formatDuration } from "./link";
import { buildPlaylistRequest, type Choice, playlistSource } from "./options";

// The card for a playlist or channel link: its title, the entries with a checkbox each
// (all ticked at first) and "select all / none". Below, the download options and the button that
// queues the ticked entries. A private or deleted entry is listed, greyed out and
// never ticked: the rest downloads as usual. Not virtualized: a few hundred
// plain rows are fine.
export function PlaylistPicker(props: {
  playlist: Playlist;
  // The card's choice, kept by the caller as for a single video.
  choice: Choice;
  onChoose: (choice: Choice) => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const { playlist, choice } = props;
  // `total` is the size of the playlist, which numbers the files; `pickable` are the positions
  // that can be ticked.
  const total = playlist.entries.length;
  const pickable = useMemo(
    () => playlist.entries.flatMap((e, i) => (e.unavailable ? [] : [i])),
    [playlist.entries],
  );
  const unavailableCount = total - pickable.length;
  // The usual subtitle languages plus the ones added with the "+".
  const [extraLanguages, setExtraLanguages] = useState<string[]>([]);
  const source = useMemo(
    () => playlistSource(extraLanguages),
    [extraLanguages],
  );
  const addLanguage = (code: string) => {
    setExtraLanguages((previous) => [...new Set([...previous, code])]);
    props.onChoose({
      ...choice,
      subtitles: [...new Set([...choice.subtitles, code])],
    });
  };
  // Positions, not URLs: a playlist can hold the same video twice.
  const [selected, setSelected] = useState(() => new Set(pickable));
  // Its own subfolder, named after the playlist. Off for a playlist without a title.
  const folder = playlist.title?.trim() || null;
  const [ownFolder, setOwnFolder] = useState(true);
  // The file names start with the entry's place in the list. On, like its sibling:
  // an unneeded prefix costs nothing, a missing one loses the order.
  const [numbered, setNumbered] = useState(true);
  const toggle = useCallback((index: number) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (!next.delete(index)) next.add(index);
      return next;
    });
  }, []);
  // Queues the ticked entries in the playlist's order. Resolves with the text to show.
  const download = async () => {
    const items = playlist.entries.flatMap((entry, index) =>
      selected.has(index)
        ? [
            {
              request: buildPlaylistRequest(
                entry.url,
                choice,
                index,
                total,
                ownFolder ? folder : null,
                numbered,
                source,
              ),
              info: { title: entry.title, thumbnail: entry.thumbnail },
            },
          ]
        : [],
    );
    const { queued, skipped } = await enqueueDownloads(items, playlist.title);
    return [
      queued > 0 && t("playlist.queued", { count: queued }),
      skipped > 0 && t("playlist.skipped", { count: skipped }),
    ]
      .filter(Boolean)
      .join(". ");
  };
  const details = [
    playlist.channel,
    t("playlist.count", { count: total }),
    unavailableCount > 0 &&
      t("playlist.unavailableCount", { count: unavailableCount }),
    playlist.truncated && t("playlist.truncated"),
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <article className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1 py-1">
          <h2
            className="font-display line-clamp-2 font-medium [overflow-wrap:anywhere]"
            title={playlist.title ?? undefined}
          >
            {playlist.title}
          </h2>
          <p className="truncate text-muted-foreground text-sm">{details}</p>
        </div>
        <DismissButton label={t("preview.dismiss")} onClick={props.onDismiss} />
      </div>
      {total === 0 ? (
        <p className="text-muted-foreground text-sm">{t("playlist.empty")}</p>
      ) : (
        <>
          {pickable.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={selected.size === pickable.length}
                onClick={() => setSelected(new Set(pickable))}
              >
                {t("playlist.selectAll")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={selected.size === 0}
                onClick={() => setSelected(new Set())}
              >
                {t("playlist.selectNone")}
              </Button>
              <p
                className="text-muted-foreground text-sm tabular-nums"
                aria-live="polite"
              >
                {t("playlist.selected", {
                  count: selected.size,
                  selected: selected.size,
                  total: pickable.length,
                })}
              </p>
            </div>
          )}
          <ul
            aria-label={t("playlist.entries")}
            className="max-h-96 divide-y overflow-y-auto rounded-md border"
          >
            {playlist.entries.map((entry, index) => (
              <EntryRow
                // biome-ignore lint/suspicious/noArrayIndexKey: the list never reorders, and the same video can appear twice
                key={index}
                index={index}
                entry={entry}
                checked={selected.has(index)}
                onToggle={toggle}
              />
            ))}
          </ul>
          {pickable.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("playlist.noneAvailable")}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {folder && (
                  <CheckOption
                    label={t("playlist.ownFolder")}
                    checked={ownFolder}
                    onChange={setOwnFolder}
                  />
                )}
                <CheckOption
                  label={t("playlist.numbered")}
                  checked={numbered}
                  onChange={setNumbered}
                />
              </div>
              <OptionsPanel
                info={source}
                choice={choice}
                onChange={props.onChoose}
                onDownload={download}
                onAddLanguage={addLanguage}
                disabled={selected.size === 0}
              />
            </>
          )}
        </>
      )}
    </article>
  );
}

function CheckOption(props: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 accent-primary"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      {props.label}
    </label>
  );
}

// `memo` + a stable `onToggle`: ticking one box repaints that row, not all of them.
const EntryRow = memo(function EntryRow(props: {
  index: number;
  entry: PlaylistEntry;
  checked: boolean;
  onToggle: (index: number) => void;
}) {
  const t = useT();
  const { entry } = props;
  // A private or deleted video has no title to show: say what it is instead, and give no box.
  const off = entry.unavailable !== null;
  const title = entry.unavailable
    ? t(`playlist.${entry.unavailable}`)
    : (entry.title ?? t("playlist.untitled"));
  return (
    <li>
      <label
        className={
          off
            ? "flex items-center gap-3 p-2 opacity-60"
            : "flex cursor-pointer items-center gap-3 p-2 hover:bg-accent"
        }
      >
        <input
          type="checkbox"
          className="size-4 shrink-0 accent-primary"
          checked={props.checked}
          disabled={off}
          onChange={() => props.onToggle(props.index)}
        />
        <EntryThumbnail src={entry.thumbnail} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span
            className="line-clamp-2 text-sm [overflow-wrap:anywhere]"
            title={title}
          >
            {title}
          </span>
          {entry.channel && (
            <span className="truncate text-muted-foreground text-xs">
              {entry.channel}
            </span>
          )}
        </span>
        {entry.duration !== null && (
          <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
            {formatDuration(entry.duration)}
          </span>
        )}
      </label>
    </li>
  );
});

// Small 16:9 box; the placeholder icon covers a missing thumbnail and one that fails to load.
function EntryThumbnail(props: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="aspect-video w-20 shrink-0 overflow-hidden rounded bg-muted">
      {props.src && !failed ? (
        <img
          src={props.src}
          alt=""
          loading="lazy"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div
          className="flex size-full items-center justify-center text-muted-foreground"
          data-testid="entry-placeholder"
        >
          <ImageOff className="size-4" aria-hidden />
        </div>
      )}
    </div>
  );
}
