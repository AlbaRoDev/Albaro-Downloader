import { ArrowLeft, ClipboardPaste, History, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DownloadList } from "@/features/downloads/DownloadList";
import { DownloadOptions } from "@/features/downloads/DownloadOptions";
import {
  settingsActions,
  useDownloadsStore,
} from "@/features/downloads/downloadsStore";
import { EmptyState } from "@/features/downloads/EmptyState";
import {
  FolderButton,
  FolderProblem,
  FolderTooDeep,
} from "@/features/downloads/FolderButton";
import {
  GlobalProgress,
  useTaskbarProgress,
} from "@/features/downloads/GlobalProgress";
import { LinkPreview } from "@/features/downloads/LinkPreview";
import { PlaylistPicker } from "@/features/downloads/PlaylistPicker";
import { useDownloadList } from "@/features/downloads/useDownloadList";
import { useLinkPreview } from "@/features/downloads/useLinkPreview";
import { HistoryView } from "@/features/history/HistoryView";
import { AppUpdateBanner } from "@/features/settings/AppUpdateBanner";
import { SettingsMenu } from "@/features/settings/SettingsMenu";
import { shortcutFor, withShortcut } from "@/features/settings/shortcuts";
import { useLanguage, useT } from "@/i18n";
import { setUiLanguage } from "@/lib/ipc";

// One screen: the top bar, then the download list filling the rest. The native title bar shows
// the app's name, so the heading is for screen readers only.
export default function App() {
  const t = useT();
  // Rust writes the "queue is done" notification and the tray menu, so it needs the language.
  const language = useLanguage();
  useEffect(() => {
    setUiLanguage(language).catch(console.error);
  }, [language]);
  const preview = useLinkPreview();
  const list = useDownloadList();
  useTaskbarProgress();
  // In the store, not in the card, so the choice survives going from one link to the next.
  const choice = useDownloadsStore((store) => store.choice);
  const setChoice = useDownloadsStore((store) => store.setChoice);
  const loading = preview.state.status === "loading";
  // The history replaces the list while it is open; it reads afresh each time.
  const [showHistory, setShowHistory] = useState(false);
  // Keyboard shortcuts. Escape closes the history, or else dismisses the preview card.
  const previewOpen = preview.state.status !== "idle";
  const dismissPreview = preview.dismiss;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      switch (shortcutFor(event)) {
        case "settings":
          event.preventDefault();
          settingsActions.setOpen(true);
          break;
        case "history":
          event.preventDefault();
          setShowHistory((open) => !open);
          break;
        case "close":
          if (showHistory) setShowHistory(false);
          else if (previewOpen) dismissPreview();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showHistory, previewOpen, dismissPreview]);
  return (
    <div className="flex h-dvh flex-col">
      <div className="season-strip" aria-hidden />
      <h1 className="sr-only">AlbaRo Downloader</h1>
      <header className="relative flex items-center gap-3 border-b px-4 py-3">
        {/* Ctrl+V outside a text field does the same (useLinkPreview). It stays enabled while
            loading: a new link replaces the one being read. */}
        <Button
          size="lg"
          aria-busy={loading}
          onClick={preview.pasteFromClipboard}
        >
          {loading ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <ClipboardPaste />
          )}
          {t("toolbar.pasteLink")}
        </Button>
        {/* The destination folder is what gives way when the bar is short of room. */}
        <FolderButton />
        <GlobalProgress />
        <Button
          variant="ghost"
          size="icon-lg"
          aria-pressed={showHistory}
          aria-label={t(
            showHistory ? "toolbar.historyBack" : "toolbar.history",
          )}
          title={withShortcut(
            t(showHistory ? "toolbar.historyBack" : "toolbar.history"),
            "H",
          )}
          onClick={() => setShowHistory((open) => !open)}
        >
          {showHistory ? (
            <ArrowLeft className="size-5" />
          ) : (
            <History className="size-5" />
          )}
        </Button>
        <SettingsMenu />
      </header>
      <FolderProblem />
      <FolderTooDeep />
      <AppUpdateBanner />
      <main
        aria-label={t("downloads.label")}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        {showHistory ? (
          <HistoryView />
        ) : /* The preview card on top of the list; the empty state only when there is neither. */
        preview.state.status === "idle" && list.ids.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="flex flex-col gap-4 p-4">
            {preview.state.status === "playlist" ? (
              <PlaylistPicker
                playlist={preview.state.playlist}
                choice={choice}
                onChoose={setChoice}
                onDismiss={preview.dismiss}
              />
            ) : (
              preview.state.status !== "idle" && (
                <LinkPreview
                  state={preview.state}
                  onDismiss={preview.dismiss}
                  options={
                    preview.state.status === "ready" && (
                      <DownloadOptions
                        metadata={preview.state.metadata}
                        choice={choice}
                        onChange={setChoice}
                      />
                    )
                  }
                />
              )
            )}
            {list.ids.length > 0 && (
              <DownloadList
                rows={list.rows}
                count={list.ids.length}
                actions={list.actions}
              />
            )}
          </div>
        )}
      </main>
    </div>
  );
}
