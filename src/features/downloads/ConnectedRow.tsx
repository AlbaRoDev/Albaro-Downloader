import { memo } from "react";
import { DownloadRow } from "./DownloadRow";
import { type DownloadActions, useDownloadsStore } from "./downloadsStore";

// One row, tied to the store by its id alone: the selectors return the entry and the notice
// themselves (the same objects until that row changes), so another download's progress does not
// render this one.
export const ConnectedRow = memo(function ConnectedRow(props: {
  id: number;
  actions: DownloadActions;
}) {
  const entry = useDownloadsStore((store) => store.downloads[props.id]);
  const notice = useDownloadsStore((store) => store.notices[props.id]);
  // Gone between the ids and this read (dismissed): nothing to show.
  if (!entry) return null;
  return <DownloadRow entry={entry} notice={notice} actions={props.actions} />;
});
