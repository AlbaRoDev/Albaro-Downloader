import { CircleAlert, ImageOff, Settings, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { type Key, useT } from "@/i18n";
import { ERROR_CODES, type ErrorCode, type Metadata } from "@/lib/ipc";
import { settingsActions } from "./downloadsStore";
import { ErrorDetail } from "./ErrorDetail";
import { errorAction } from "./errorAction";
import { formatDuration } from "./link";
import type { PreviewProblem, PreviewState } from "./useLinkPreview";

// The pasted text can also be rejected before any command runs (`PreviewProblem` has those
// problems too), and those have no action.
const isErrorCode = (problem: string): problem is ErrorCode =>
  (ERROR_CODES as readonly string[]).includes(problem);

// The text for each problem: one plain line. What a failed download offers on top of it (the
// technical detail, another folder) is in ErrorDetail and errorAction.
export const problemKey = (problem: PreviewProblem): Key => `error.${problem}`;

// The preview area: a skeleton while loading, the card, or the error. Idle shows nothing (the
// caller shows the empty state instead).
export function LinkPreview(props: {
  // A playlist has its own card (PlaylistPicker).
  state: Exclude<PreviewState, { status: "playlist" }>;
  onDismiss: () => void;
  // Shown inside the card once the link is read: the download options.
  options?: ReactNode;
}) {
  const t = useT();
  const { state } = props;
  if (state.status === "idle") return null;
  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
      >
        <CircleAlert className="size-5 shrink-0 text-destructive" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="break-words">{t(problemKey(state.problem))}</p>
          {/* A login: the settings turn on the browser cookies. */}
          {isErrorCode(state.problem) &&
            errorAction(state.problem) === "settings" && (
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => settingsActions.setOpen(true)}
              >
                <Settings aria-hidden />
                {t("row.openSettings")}
              </Button>
            )}
          <ErrorDetail code={state.problem} message={state.message ?? ""} />
        </div>
        <DismissButton label={t("error.close")} onClick={props.onDismiss} />
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <div
        aria-busy="true"
        className="flex gap-4 rounded-lg border p-3"
        data-testid="preview-skeleton"
      >
        <span className="sr-only" role="status">
          {t("preview.loading")}
        </span>
        <div className="aspect-video w-40 shrink-0 animate-pulse rounded-md bg-muted sm:w-48" />
        <div className="flex flex-1 flex-col gap-2 py-1">
          <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
        </div>
      </div>
    );
  }
  return (
    <PreviewCard
      metadata={state.metadata}
      onDismiss={props.onDismiss}
      options={props.options}
    />
  );
}

function PreviewCard(props: {
  metadata: Metadata;
  onDismiss: () => void;
  options?: ReactNode;
}) {
  const t = useT();
  const { metadata: m } = props;
  const duration = m.isLive
    ? t("preview.live")
    : m.duration === null
      ? null
      : formatDuration(m.duration);
  const details = [m.channel, m.extractor].filter(Boolean).join(" · ");
  return (
    <article className="flex flex-col gap-3 rounded-lg border p-3">
      <div className="flex gap-4">
        <Thumbnail src={m.thumbnail} duration={duration} />
        <div className="flex min-w-0 flex-1 flex-col gap-1 py-1">
          <h2
            className="font-display line-clamp-2 font-medium [overflow-wrap:anywhere]"
            title={m.title}
          >
            {m.title}
          </h2>
          <p className="truncate text-muted-foreground text-sm">{details}</p>
        </div>
        <DismissButton label={t("preview.dismiss")} onClick={props.onDismiss} />
      </div>
      {props.options}
    </article>
  );
}

// 16:9 box reserved before the image arrives, so nothing jumps. No thumbnail, or one that
// fails to load (offline, a dead link, blocked by the CSP), shows a placeholder icon.
function Thumbnail(props: { src: string | null; duration: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-video w-40 shrink-0 overflow-hidden rounded-md bg-muted sm:w-48">
      {props.src && !failed ? (
        <img
          src={props.src}
          alt=""
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div
          className="flex size-full items-center justify-center text-muted-foreground"
          data-testid="thumbnail-placeholder"
        >
          <ImageOff className="size-6" aria-hidden />
        </div>
      )}
      {props.duration && (
        <span className="absolute right-1 bottom-1 rounded bg-black/75 px-1.5 py-0.5 font-medium text-white text-xs tabular-nums">
          {props.duration}
        </span>
      )}
    </div>
  );
}

export function DismissButton(props: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="shrink-0 self-start"
      aria-label={props.label}
      title={props.label}
      onClick={props.onClick}
    >
      <X />
    </Button>
  );
}
