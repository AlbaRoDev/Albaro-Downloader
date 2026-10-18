import { Link } from "lucide-react";
import { useT } from "@/i18n";

// What the download list shows while it has nothing in it.
export function EmptyState() {
  const t = useT();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
      <div className="rounded-full bg-primary/10 p-4 text-primary">
        <Link className="size-8" aria-hidden />
      </div>
      <p className="font-display text-lg">{t("downloads.empty")}</p>
    </div>
  );
}
