import { Eraser } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { BatchGroup } from "./BatchGroup";
import { ConnectedRow } from "./ConnectedRow";
import { hasEnded } from "./downloadsState";
import {
  clearEnded,
  type DownloadActions,
  useDownloadsStore,
} from "./downloadsStore";

// The downloads, newest first, where the entries of a playlist queued together are one row (a
// `BatchGroup`). `rows` are the keys `useDownloadList` makes: "s<id>" for a download on
// its own, "b<batch>" for a group. The list's name says how many downloads there are in all (a
// plural, for screen readers). Above it, "Clear the list" (when something has ended) hides what is
// finished, failed or cancelled: they are many after a few playlists.
export function DownloadList(props: {
  rows: string[];
  count: number;
  actions: DownloadActions;
}) {
  const t = useT();
  // A number, so a progress update re-renders this only when the count changes.
  const ended = useDownloadsStore(
    (store) => Object.values(store.downloads).filter(hasEnded).length,
  );
  return (
    <div className="flex flex-col gap-2">
      {ended > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="w-fit self-end"
          title={t("downloads.clearHint")}
          onClick={clearEnded}
        >
          <Eraser aria-hidden />
          {t("downloads.clear", { count: ended })}
        </Button>
      )}
      <ul
        aria-label={t("downloads.list", { count: props.count })}
        className="flex flex-col gap-2"
      >
        {props.rows.map((row) => {
          const id = Number(row.slice(1));
          return row.startsWith("b") ? (
            <BatchGroup key={row} batchId={id} actions={props.actions} />
          ) : (
            <ConnectedRow key={row} id={id} actions={props.actions} />
          );
        })}
      </ul>
    </div>
  );
}
