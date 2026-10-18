import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useDownloadsStore } from "@/features/downloads/downloadsStore";
import { ErrorDetail } from "@/features/downloads/ErrorDetail";
import { useT } from "@/i18n";
import {
  asAppError,
  getAppUpdate,
  installAppUpdate,
  onAppUpdateAvailable,
} from "@/lib/ipc";

// "A new version is available" under the top bar. Rust looks for it in the background
// and only tells; nothing is downloaded until the button is pressed. Installing closes the app,
// so the button waits until no download is running or queued (Rust refuses too). "Later" hides
// it until the next start; the next check, hours later, shows it again.
export function AppUpdateBanner() {
  const t = useT();
  const [version, setVersion] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const busy = useDownloadsStore((store) =>
    Object.values(store.downloads).some(
      (entry) =>
        entry.download.state === "pending" || entry.download.state === "active",
    ),
  );

  useEffect(() => {
    let alive = true;
    // The event may have been sent before the page was listening: ask too.
    getAppUpdate().then(
      (update) => alive && update && setVersion(update.version),
      console.error,
    );
    const unlisten = onAppUpdateAvailable(
      (update) => alive && setVersion(update.version),
    );
    return () => {
      alive = false;
      unlisten.then((off) => off()).catch(console.error);
    };
  }, []);

  if (version === null || hidden) return null;

  const install = () => {
    setInstalling(true);
    setFailure(null);
    // On success the app restarts and this never settles.
    installAppUpdate().catch((error) => {
      setInstalling(false);
      setFailure(asAppError(error).message);
    });
  };

  return (
    <div role="status" className="border-b bg-muted px-4 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Download className="size-4 shrink-0 text-primary" aria-hidden />
        <p className="min-w-0 flex-1">
          {t("update.available", { version })}
          {busy && ` ${t("update.busy")}`}
        </p>
        <Button size="sm" disabled={busy || installing} onClick={install}>
          {installing ? t("update.installing") : t("update.install")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={installing}
          onClick={() => setHidden(true)}
        >
          {t("update.later")}
        </Button>
      </div>
      {failure !== null && (
        <div className="mt-1 flex flex-col gap-1">
          <p className="text-destructive">{t("update.failed")}</p>
          <ErrorDetail code="update" message={failure} />
        </div>
      )}
    </div>
  );
}
