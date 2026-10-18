import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { useT } from "@/i18n";
import { setTaskbarProgress } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { globalProgress, taskbarState, wholePercent } from "./downloadsState";
import { useDownloadsStore } from "./downloadsStore";

// How many downloads are running and how far along they are as a whole number (null: none has
// a number yet). A new object only when one of the two changes: progress updates that do not
// change the whole percentage do not render whoever reads this.
export function useGlobalProgress() {
  return useDownloadsStore(
    useShallow((store) => {
      const global = globalProgress(store.downloads);
      return { active: global.active, percent: wholePercent(global.percent) };
    }),
  );
}

// Keeps the taskbar icon in step with the global progress. It calls the backend only when what
// the icon shows would change (the status or the whole percentage), not on every event.
export function useTaskbarProgress() {
  const global = useGlobalProgress();
  const state = taskbarState({
    active: global.active,
    percent: global.percent,
  });
  const key =
    state.status === "normal" ? `normal:${state.progress}` : state.status;
  // The icon starts with nothing, so "none" needs no call until something else was shown.
  const shown = useRef("none");
  // `state` is derived from `key`, which is the dependency that matters.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (shown.current === key) return;
    shown.current = key;
    setTaskbarProgress(state).catch((error) =>
      console.error("taskbar progress:", error),
    );
  }, [key]);
}

// The top bar's summary of the running downloads: a line of text and a 2 px bar along the
// header's bottom edge, in the accent colour. Nothing while no download is running. The empty
// element it always renders takes the room left between the folder button and the settings,
// which stay put. While something runs it keeps a minimum of 9 rem, so it is the folder button
// that gives way; the text is cut if even that is short, and never widens the bar.
export function GlobalProgress() {
  const t = useT();
  const { active, percent } = useGlobalProgress();
  const running = active > 0;
  const count = t("global.active", { count: active });
  const text =
    percent === null
      ? count
      : t("global.withPercent", { active: count, percent });
  return (
    <div
      className={cn(
        "flex flex-1 items-center gap-2",
        running ? "min-w-36" : "min-w-0",
      )}
    >
      {running && (
        <>
          <p
            className="min-w-0 truncate text-muted-foreground text-sm"
            title={text}
          >
            {text}
          </p>
          <div
            role="progressbar"
            aria-label={text}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5"
          >
            <div
              className={`h-full bg-primary ${percent === null ? "w-full animate-pulse opacity-50" : ""}`}
              style={percent === null ? undefined : { width: `${percent}%` }}
            />
          </div>
        </>
      )}
    </div>
  );
}
