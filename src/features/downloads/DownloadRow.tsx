import {
  CircleX,
  FolderOpen,
  FolderSync,
  ImageOff,
  Pause,
  Play,
  RotateCcw,
  Settings,
  X,
} from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type Key, useLanguage, useT } from "@/i18n";
import { awaitingNext, type Entry, partOf, percentOf } from "./downloadsState";
import type { DownloadActions, Notice } from "./downloadsStore";
import { ErrorDetail } from "./ErrorDetail";
import { errorAction } from "./errorAction";
import { problemKey } from "./LinkPreview";
import { formatEta, formatSpeed } from "./rowFormat";

// After a file finishes with the download still running and nothing newer, how long before the
// row says "Processing…" (ffmpeg merging video and audio sends no progress for a second or two).
// Between two files the next update arrives well before this, so the text does not flicker.
const PROCESSING_DELAY_MS = 800;

// Whether to say "Processing…": the last file finished and no update has followed for
// PROCESSING_DELAY_MS. Any new update restarts the wait.
// Known limit: one timer per active row, restarted on each update; fine for a few downloads at once.
export function useProcessing(entry: Entry): boolean {
  const waiting = awaitingNext(entry);
  const [processing, setProcessing] = useState(false);
  // `progressAt` is a dependency on purpose: a new update (of any kind) restarts the wait.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    setProcessing(false);
    if (!waiting) return;
    const timer = setTimeout(() => setProcessing(true), PROCESSING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [waiting, entry.progressAt]);
  return waiting && processing;
}

// One download: a small thumbnail, its title, a thin bar with one line of detail, and the
// actions that make sense for its state. Everything is built to survive ~600 px: the middle
// column can shrink (`min-w-0`) and its text wraps or is cut, never widens the row.
// `memo`: an update to one download leaves the other rows' props as they were (the reducer
// keeps their entries), so only that row renders again.
export const DownloadRow = memo(function DownloadRow(props: {
  entry: Entry;
  notice?: Notice;
  actions: DownloadActions;
}) {
  const t = useT();
  const { entry, actions } = props;
  const { download } = entry;
  const { id, state } = download;
  const title = download.title ?? download.request.url;
  const processing = useProcessing(entry);
  const percent = entry.progress ? percentOf(entry.progress) : null;

  const button = (label: Key, icon: ReactNode, onClick: () => void) => (
    <Button
      key={label}
      variant="ghost"
      size="icon"
      className="size-8"
      aria-label={t(label)}
      title={t(label)}
      onClick={onClick}
    >
      {icon}
    </Button>
  );
  const cancel = button("row.cancel", <CircleX />, () => actions.cancel(id));
  const dismiss = button("row.dismiss", <X />, () => actions.dismiss(id));
  const buttons: Record<typeof state, ReactNode[]> = {
    pending: [cancel],
    active: [button("row.pause", <Pause />, () => actions.pause(id)), cancel],
    paused: [button("row.resume", <Play />, () => actions.resume(id)), cancel],
    failed: [
      button("row.retry", <RotateCcw />, () => actions.retry(id)),
      // Only for a full disk or an unusable folder; a different icon from "Open folder".
      ...(errorAction(download.error?.code ?? "unknown") === "otherFolder"
        ? [
            button("row.retryElsewhere", <FolderSync />, () =>
              actions.retryElsewhere(id),
            ),
          ]
        : []),
      // For a login or unreadable cookies: the settings are where they are turned on.
      ...(errorAction(download.error?.code ?? "unknown") === "settings"
        ? [
            button("row.openSettings", <Settings />, () =>
              actions.openSettings(),
            ),
          ]
        : []),
      dismiss,
    ],
    finished: [
      button("row.reveal", <FolderOpen />, () => actions.reveal(id)),
      dismiss,
    ],
    cancelled: [dismiss],
  };

  // The bar: the current file's progress while running or paused (frozen), full when finished.
  // No number to show (starting, merging, a size yt-dlp does not know) is a pulsing full bar.
  const shown =
    state === "finished"
      ? 100
      : state === "active" || state === "paused"
        ? percent
        : 0;
  const indeterminate =
    state === "active" && (shown === null || processing || !entry.progress);

  return (
    <li className="flex items-center gap-3 rounded-lg border p-2">
      <Thumbnail src={download.thumbnail} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p
          className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]"
          title={title}
        >
          {title}
        </p>
        <div
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={indeterminate ? undefined : Math.round(shown ?? 0)}
          className="h-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={`h-full rounded-full bg-primary ${indeterminate ? "w-full animate-pulse opacity-50" : ""}`}
            style={indeterminate ? undefined : { width: `${shown ?? 0}%` }}
          />
        </div>
        <Detail entry={entry} processing={processing} />
        {props.notice && (
          <div role="alert" className="flex flex-col gap-1">
            <p className="text-destructive text-xs">
              {t(
                props.notice.code === "revealFailed"
                  ? "row.revealFailed"
                  : problemKey(props.notice.code),
              )}
            </p>
            <ErrorDetail
              code={props.notice.code}
              message={props.notice.message}
            />
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center">{buttons[state]}</div>
    </li>
  );
});

// The line under the bar, by state.
function Detail(props: { entry: Entry; processing: boolean }) {
  const t = useT();
  const language = useLanguage();
  const { entry } = props;
  const { download, progress } = entry;
  const line = "text-muted-foreground text-xs";
  switch (download.state) {
    case "pending":
      return (
        <p className={line}>
          {entry.retry
            ? t("row.retrying", {
                attempt: entry.retry.attempt,
                max: entry.retry.maxAttempts,
              })
            : t("row.queued")}
        </p>
      );
    case "paused":
      return <p className={line}>{t("row.paused")}</p>;
    case "finished":
      return <p className={line}>{t("row.finished")}</p>;
    case "cancelled":
      return <p className={line}>{t("row.cancelled")}</p>;
    case "failed": {
      const error = download.error;
      const code = error?.code ?? "unknown";
      return (
        <>
          <p className="line-clamp-3 text-destructive text-xs [overflow-wrap:anywhere]">
            {t(problemKey(code))}
          </p>
          <ErrorDetail code={code} message={error?.message ?? ""} />
        </>
      );
    }
    case "active": {
      // An update from before the last start is a previous run's: the bar keeps it, the line
      // does not repeat its speed.
      const current = progress && entry.progressAt >= entry.activeAt;
      if (!current) return <p className={line}>{t("row.starting")}</p>;
      if (props.processing)
        return <p className={line}>{t("row.processing")}</p>;
      const percent = percentOf(progress);
      const part = partOf(entry);
      const eta = formatEta(progress.eta);
      const pieces = [
        part > 1 ? t("row.part", { n: part }) : null,
        percent === null
          ? null
          : t("row.percent", { percent: Math.round(percent) }),
        formatSpeed(progress.speed, language),
        eta === null ? null : t("row.eta", { time: eta }),
      ].filter(Boolean);
      return <p className={`${line} truncate`}>{pieces.join(" · ")}</p>;
    }
  }
}

// A 16:9 box of a fixed small size, so rows do not jump when the image arrives. Without a
// thumbnail (old rows) or when it fails to load, a placeholder icon.
export function Thumbnail(props: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="aspect-video w-20 shrink-0 overflow-hidden rounded-md bg-muted sm:w-24">
      {props.src && !failed ? (
        <img
          src={props.src}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div
          className="flex size-full items-center justify-center text-muted-foreground"
          data-testid="row-thumbnail-placeholder"
        >
          <ImageOff className="size-5" aria-hidden />
        </div>
      )}
    </div>
  );
}
