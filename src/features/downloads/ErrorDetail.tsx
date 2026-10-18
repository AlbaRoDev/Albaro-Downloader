import { Check, ChevronRight, Copy } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
import { writeClipboardText } from "@/lib/ipc";
import { redactDetail } from "@/lib/redact";

const COPIED_MS = 2000;

// "View detail" under an error's plain text: a toggle that opens the technical
// message, normally yt-dlp's stderr line, and a button that copies `<code>: <message>`. Shared by
// the failed row, the refused actions and the preview card. Closed by default, and its open state
// is its own (per row, not in the store). With no message there is nothing to show, so it is not
// there at all. The message is shown as it is: it may carry local paths (known limitation).
export function ErrorDetail(props: { code: string; message: string }) {
  const t = useT();
  const panel = useId();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (props.message.trim() === "") return null;

  const copy = () => {
    // Cleaned for pasting elsewhere (a bug report): no user name, no address tokens.
    writeClipboardText(`${props.code}: ${redactDetail(props.message)}`).then(
      () => {
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
      },
      (error) => console.error("copy detail:", error),
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
        className="inline-flex w-fit items-center gap-1 rounded text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronRight
          className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`}
          aria-hidden
        />
        {open ? t("detail.hide") : t("detail.show")}
      </button>
      {/* Always in the page (hidden when closed) so `aria-controls` points at something. */}
      <div id={panel} hidden={!open} className="flex min-w-0 flex-col gap-1">
        <pre className="max-h-32 select-text overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 font-mono text-xs [overflow-wrap:anywhere]">
          {props.message}
        </pre>
        <Button
          variant="outline"
          size="xs"
          className="w-fit"
          onClick={copy}
          title={t("detail.copyHint")}
          aria-live="polite"
        >
          {copied ? <Check /> : <Copy />}
          {copied ? t("detail.copied") : t("detail.copy")}
        </Button>
      </div>
    </div>
  );
}
