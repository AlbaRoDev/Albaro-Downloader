import { ChevronDown, ChevronRight } from "lucide-react";
import { useId, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "@/i18n";
import { batchSummary } from "./batchSummary";
import { ConnectedRow } from "./ConnectedRow";
import { type DownloadActions, useDownloadsStore } from "./downloadsStore";

// The entries of one playlist, queued together: a header with the playlist's name and
// one progress for all of them, which opens to show each download as a row. Closed at first: a
// playlist can have hundreds, and the header already says how far along they are and whether any
// failed. The header reads its members from the store, so it repaints with their progress while
// the rows inside, memoized, only repaint when their own download changes.
export function BatchGroup(props: {
  batchId: number;
  actions: DownloadActions;
}) {
  const t = useT();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const members = useDownloadsStore(
    useShallow((store) =>
      Object.values(store.downloads)
        .filter((e) => e.download.batch?.id === props.batchId)
        .sort((a, b) => b.download.id - a.download.id),
    ),
  );
  const summary = batchSummary(members);
  const title = members[0]?.download.batch?.title ?? t("batch.untitled");
  const parts = [
    t("batch.finished", {
      count: summary.finished,
      finished: summary.finished,
      total: summary.total,
    }),
    summary.failed > 0 && t("batch.failed", { count: summary.failed }),
  ]
    .filter(Boolean)
    .join(" · ");
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="rounded-lg border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-3 rounded-lg p-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Chevron
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate font-medium text-sm" title={title}>
            {title}
          </p>
          <div
            role="progressbar"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={summary.percent ?? 0}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${summary.percent ?? 0}%` }}
            />
          </div>
          <p className="text-muted-foreground text-xs">{parts}</p>
        </div>
        <span className="w-10 shrink-0 text-right text-sm tabular-nums">
          {summary.percent === null ? "" : `${summary.percent} %`}
        </span>
      </button>
      {open && (
        <ul
          id={listId}
          aria-label={t("downloads.list", { count: members.length })}
          className="flex flex-col gap-2 border-t p-2"
        >
          {members.map((e) => (
            <ConnectedRow
              key={e.download.id}
              id={e.download.id}
              actions={props.actions}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
