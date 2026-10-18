import {
  CircleAlert,
  FolderOpen,
  LoaderCircle,
  TriangleAlert,
  X,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { outputActions, useDownloadsStore } from "./downloadsStore";
import { problemKey } from "./LinkPreview";

// The last part of a path, for the button: `C:\Users\Ana\Vídeos` and `/home/ana/Vídeos` both give
// "Vídeos". A drive or filesystem root has no last part: it is shown whole.
export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ||
    (parts.length === 1 && !/^[A-Za-z]:$/.test(parts[0]))
    ? parts[parts.length - 1]
    : path;
}

// The destination folder in the top bar: its name, and a click opens the system's
// folder picker (opened from Rust; the page never sees a path it could choose). It is the part of
// the bar that gives way when space runs out: it shrinks, cut with an ellipsis, down to ~96 px,
// while the paste button, the summary and the settings keep their size. The full path is in the
// tooltip and the accessible name.
export function FolderButton() {
  const t = useT();
  const outputDir = useDownloadsStore((store) => store.outputDir);
  const [picking, setPicking] = useState(false);
  const pick = async () => {
    setPicking(true);
    try {
      await outputActions.pickFolder();
    } finally {
      setPicking(false);
    }
  };
  const name = outputDir === null ? t("folder.label") : folderName(outputDir);
  const label = picking
    ? t("folder.picking")
    : outputDir === null
      ? t("folder.label")
      : t("folder.button", { path: outputDir });
  return (
    <Button
      variant="outline"
      size="lg"
      // `shrink` undoes the button's own `shrink-0`; `min-w-24` is the floor, `max-w-64` keeps a
      // long name from taking the whole bar.
      className="min-w-24 max-w-64 shrink justify-start"
      aria-label={label}
      title={outputDir ?? undefined}
      aria-busy={picking}
      // Only one picker at a time, and none before the folder is known.
      disabled={picking || outputDir === null}
      onClick={() => void pick()}
    >
      {picking ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
      <span className="min-w-0 truncate">{name}</span>
    </Button>
  );
}

// A folder so deep that titles will not fit in a path: the downloads may fail or get
// very short names. Shown whenever the saved folder is like that, not only after picking it.
export function FolderTooDeep() {
  const t = useT();
  const tooDeep = useDownloadsStore((store) => store.folderTooDeep);
  if (!tooDeep) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b bg-muted px-4 py-2 text-sm"
    >
      <TriangleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
      <p className="min-w-0 flex-1">{t("folder.tooDeep")}</p>
    </div>
  );
}

// Why the last folder could not be used, under the top bar until closed or until the next pick.
export function FolderProblem() {
  const t = useT();
  const code = useDownloadsStore((store) => store.folderProblem);
  if (code === null) return null;
  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b bg-muted px-4 py-2 text-sm"
    >
      <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
      <p className="min-w-0 flex-1">{t(problemKey(code))}</p>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("error.close")}
        title={t("error.close")}
        onClick={outputActions.dismissFolderProblem}
      >
        <X />
      </Button>
    </div>
  );
}
