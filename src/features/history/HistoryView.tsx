import { FolderOpen, RotateCcw, Search, Trash2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/features/downloads/DownloadOptions";
import { Thumbnail } from "@/features/downloads/DownloadRow";
import { useDownloadsStore } from "@/features/downloads/downloadsStore";
import { ErrorDetail } from "@/features/downloads/ErrorDetail";
import { problemKey } from "@/features/downloads/LinkPreview";
import { type Key, type Language, useLanguage, useT } from "@/i18n";
import {
  asAppError,
  clearHistory,
  type Download,
  enqueueDownload,
  type History,
  listHistory,
  revealDownload,
} from "@/lib/ipc";

type StateFilter = "all" | "finished" | "failed" | "cancelled";
type KindFilter = "all" | "video" | "audio";

// A search box that waits for a pause in the typing before it reaches the backend.
const SEARCH_DELAY_MS = 250;

function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

type Answer =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; history: History };

// The history: every finished, failed or cancelled download, also those cleared from the
// list, newest first, with a search and two filters. The backend filters (the history can be long);
// this asks again whenever the search (after a pause) or a filter changes, and ignores an answer
// that a newer question has already replaced. Each row can be shown on disk or downloaded again.
export function HistoryView() {
  const t = useT();
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [state, setState] = useState<StateFilter>("all");
  const [kind, setKind] = useState<KindFilter>("all");
  const query = useDebounced(search);
  const [answer, setAnswer] = useState<Answer>({ status: "loading" });

  useEffect(() => {
    let current = true;
    listHistory(
      query,
      state === "all" ? null : state,
      kind === "all" ? null : kind,
    ).then(
      (history) => {
        // A test double may answer with anything: only a real answer counts.
        if (current && Array.isArray(history?.items)) {
          setAnswer({ status: "ready", history });
        } else if (current) {
          setAnswer({ status: "failed" });
        }
      },
      (error) => {
        console.error("history:", error);
        if (current) setAnswer({ status: "failed" });
      },
    );
    return () => {
      current = false;
    };
  }, [query, state, kind]);

  const filtering = query.trim() !== "" || state !== "all" || kind !== "all";
  return (
    <section
      aria-label={t("history.label")}
      className="flex flex-col gap-4 p-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-48 flex-1 flex-col gap-1">
          <label htmlFor={searchId} className="text-muted-foreground text-xs">
            {t("history.search")}
          </label>
          <div className="relative">
            <Search
              className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2 size-4 text-muted-foreground"
              aria-hidden
            />
            <input
              id={searchId}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-full rounded-lg border border-input bg-background pr-2 pl-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
          </div>
        </div>
        <Field
          label={t("history.state")}
          value={state}
          onChange={(value) => setState(value as StateFilter)}
          options={[
            { value: "all", text: t("history.all") },
            { value: "finished", text: t("history.finished") },
            { value: "failed", text: t("history.failed") },
            { value: "cancelled", text: t("history.cancelled") },
          ]}
        />
        <Field
          label={t("history.kind")}
          value={kind}
          onChange={(value) => setKind(value as KindFilter)}
          options={[
            { value: "all", text: t("history.all") },
            { value: "video", text: t("options.video") },
            { value: "audio", text: t("options.audio") },
          ]}
        />
      </div>
      <Results answer={answer} filtering={filtering} />
      {answer.status === "ready" &&
        (answer.history.items.length > 0 || filtering) && (
          // Everything that had ended is gone, whatever the search and the filters were.
          <ClearHistory
            onCleared={() =>
              setAnswer({
                status: "ready",
                history: { items: [], more: false },
              })
            }
          />
        )}
    </section>
  );
}

// "Delete the history": two presses, the second within a few seconds, because it cannot
// be undone. It removes the rows (and what was kept of them on disk), not the downloaded files.
const CONFIRM_MS = 4000;

function ClearHistory(props: { onCleared: () => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);

  const clear = () => {
    setConfirming(false);
    clearHistory().then(
      () => {
        setFailed(false);
        // The list shows the ended ones that were not cleared from it: they are gone too.
        useDownloadsStore.getState().dispatch({ type: "dismissedEnded" });
        props.onCleared();
      },
      (error) => {
        console.error("clear history:", error);
        setFailed(true);
      },
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-3 border-t pt-3">
      <Button
        variant={confirming ? "destructive" : "outline"}
        size="sm"
        onClick={confirming ? clear : () => setConfirming(true)}
        title={t("history.clearHint")}
      >
        <Trash2 aria-hidden />
        {confirming ? t("history.clearConfirm") : t("history.clear")}
      </Button>
      {failed && (
        <p role="alert" className="text-destructive text-sm">
          {t("history.clearFailed")}
        </p>
      )}
    </div>
  );
}

function Results(props: { answer: Answer; filtering: boolean }) {
  const t = useT();
  const { answer } = props;
  if (answer.status === "loading") return null;
  if (answer.status === "failed") {
    return (
      <p role="alert" className="text-destructive text-sm">
        {t("history.loadFailed")}
      </p>
    );
  }
  const { items, more } = answer.history;
  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t(props.filtering ? "history.noMatches" : "history.empty")}
      </p>
    );
  }
  return (
    <>
      <ul
        aria-label={t("downloads.list", { count: items.length })}
        className="flex flex-col gap-2"
      >
        {items.map((download) => (
          <HistoryRow key={download.id} download={download} />
        ))}
      </ul>
      {more && (
        <p className="text-muted-foreground text-xs">
          {t("history.more", { count: items.length })}
        </p>
      )}
    </>
  );
}

const STATE_KEY = {
  finished: "history.stateFinished",
  failed: "history.stateFailed",
  cancelled: "history.stateCancelled",
} as const;

// "Vídeo · MP4 máxima calidad" / "Audio · MP3": what was asked for.
function kindText(download: Download, t: (key: Key) => string): string {
  const { mode } = download.request;
  return mode.kind === "video"
    ? `${t("options.video")} · ${t(`container.${mode.container ?? "mp4"}`)}`
    : `${t("options.audio")} · ${t(`audio.${mode.format}`)}`;
}

function when(ms: number, language: Language): string {
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(ms);
}

// One ended download. A finished one can be shown in its folder; any of them can be queued again
// with the same request (the queue refuses it only while an identical one is still waiting).
function HistoryRow(props: { download: Download }) {
  const t = useT();
  const language = useLanguage();
  const { download } = props;
  const title = download.title ?? download.request.url;
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const ended = download.state as keyof typeof STATE_KEY;

  const again = () => {
    setNote(null);
    enqueueDownload(download.request, {
      title: download.title,
      thumbnail: download.thumbnail,
    }).then(
      () => setNote({ text: t("history.queued"), bad: false }),
      (error) =>
        setNote({ text: t(problemKey(asAppError(error).code)), bad: true }),
    );
  };
  const reveal = () => {
    setNote(null);
    revealDownload(download.id).catch(() =>
      setNote({ text: t("row.revealFailed"), bad: true }),
    );
  };

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
        <p className="truncate text-muted-foreground text-xs">
          {[
            t(STATE_KEY[ended]),
            kindText(download, t),
            when(download.updatedAt, language),
          ].join(" · ")}
        </p>
        {download.state === "failed" && download.error && (
          <>
            <p className="line-clamp-3 text-destructive text-xs [overflow-wrap:anywhere]">
              {t(problemKey(download.error.code))}
            </p>
            <ErrorDetail
              code={download.error.code}
              message={download.error.message}
            />
          </>
        )}
        {note && (
          <p
            role={note.bad ? "alert" : "status"}
            className={`text-xs ${note.bad ? "text-destructive" : "text-muted-foreground"}`}
          >
            {note.text}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        {download.state === "finished" && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t("row.reveal")}
            title={t("row.reveal")}
            onClick={reveal}
          >
            <FolderOpen />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          aria-label={t("history.again")}
          title={t("history.again")}
          onClick={again}
        >
          <RotateCcw />
        </Button>
      </div>
    </li>
  );
}
