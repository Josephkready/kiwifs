import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bug, ImagePlus, X } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Textarea } from "./ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
  MAX_DESCRIPTION,
  descriptionValid,
  fetchConfig,
  fetchRecent,
  imagesFromClipboard,
  loadDraft,
  newUUID,
  pollStatus,
  safeIssueUrl,
  saveDraft,
  selectionSnippet,
  stageImages,
  statusLabel,
  submitReport,
  type BugContext,
  type PreviousReport,
  type StagedImage,
} from "../lib/bugReport";

interface Props {
  /** Called when the dialog opens; the result is the report's context snapshot. */
  getContext: () => BugContext;
  /** Current note path, used to scope the previous-reports list. */
  path: string | null;
}

const TOAST_MS = 3000;

export interface BugReportController {
  available: boolean;
  open: boolean;
  /** Opens the dialog; focus returns to `returnTo` when it closes (default: the previously focused element). */
  openDialog: (returnTo?: { current: HTMLElement | null } | null) => void;
  captureSelection: () => void;
  /** The dialog and toast. Render once, outside any menu that may unmount. */
  node: ReactNode;
}

export function useBugReport({ getContext, path }: Props): BugReportController {
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    fetchConfig().then((ok) => live && setAvailable(ok));
    return () => {
      live = false;
    };
  }, []);

  const [toast, setToast] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const flashToast = useCallback(() => {
    setToast(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(false), TOAST_MS);
  }, []);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const snapshot = useRef<BugContext>({});
  const selection = useRef("");
  const returnFocus = useRef<{ current: HTMLElement | null } | null>(null);
  const captureSelection = useCallback(() => {
    selection.current = selectionSnippet(window.getSelection());
  }, []);
  const getCtx = useRef(getContext);
  getCtx.current = getContext;
  const openDialog = useCallback((returnTo?: { current: HTMLElement | null } | null) => {
    snapshot.current = { ...getCtx.current(), selected_text: selection.current || selectionSnippet(window.getSelection()) };
    selection.current = "";
    returnFocus.current = returnTo ?? null;
    setOpen(true);
  }, []);

  const node = available ? (
    <>
      <BugReportDialog
        open={open}
        onClose={() => setOpen(false)}
        context={snapshot}
        path={path}
        onSaved={flashToast}
        returnFocus={returnFocus}
      />
      {toast && (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-[60] rounded-md border border-border bg-card px-3 py-2 text-sm shadow-lg"
        >
          Report saved
        </div>
      )}
    </>
  ) : null;

  return { available, open, openDialog, captureSelection, node };
}

export function BugReportTrigger({ bug }: { bug: BugReportController }) {
  if (!bug.available) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 sm:h-8 sm:w-8"
          title="Report a bug"
          aria-label="Report a bug"
          aria-haspopup="dialog"
          aria-expanded={bug.open}
          data-feature="header.bug"
          onPointerDown={bug.captureSelection}
          onClick={() => bug.openDialog()}
        >
          <Bug className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Report a bug</TooltipContent>
    </Tooltip>
  );
}

export function BugReportDialog({
  open,
  onClose,
  context,
  path,
  onSaved,
  returnFocus,
}: {
  open: boolean;
  onClose: () => void;
  context: { current: BugContext };
  path: string | null;
  onSaved: () => void;
  returnFocus?: { current: { current: HTMLElement | null } | null };
}) {
  const [text, setText] = useState(() => loadDraft());
  const [images, setImages] = useState<StagedImage[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [previous, setPrevious] = useState<PreviousReport[]>([]);
  const [showAll, setShowAll] = useState(false);
  const keyRef = useRef<string>("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const imagesRef = useRef<StagedImage[]>([]);
  imagesRef.current = images;

  const dropImages = useCallback(() => {
    imagesRef.current.forEach((i) => URL.revokeObjectURL(i.previewUrl));
    setImages([]);
    setNotes([]);
  }, []);

  // Reopening starts with no screenshots and a fresh idempotency key.
  useEffect(() => {
    if (!open) return;
    dropImages();
    setError("");
    setShowAll(false);
    keyRef.current = newUUID();
  }, [open, dropImages]);

  const loadPrevious = useCallback(
    () => fetchRecent({ path, limit: showAll ? 100 : 3 }).then(setPrevious),
    [path, showAll],
  );
  useEffect(() => {
    if (open) void loadPrevious();
  }, [open, loadPrevious]);

  // Bounded status polling for reports that are not final yet.
  const pendingIds = previous.filter((r) => r.sync_status !== "filed" && r.sync_status !== "failed").map((r) => r.id).join(",");
  useEffect(() => {
    if (!open || !pendingIds) return;
    const stops = pendingIds.split(",").map((id) =>
      pollStatus(Number(id), (s) =>
        setPrevious((prev) =>
          prev.map((r) => (r.id === Number(id) ? { ...r, sync_status: s.sync_status, issue_url: s.issue_url } : r)),
        ),
      ),
    );
    return () => stops.forEach((stop) => stop());
  }, [open, pendingIds]);

  const addFiles = async (files: File[]) => {
    if (!files.length) return;
    const res = await stageImages(imagesRef.current, files);
    setImages(res.staged);
    setNotes(res.errors);
  };

  const removeImage = (id: string) => {
    const gone = images.find((i) => i.id === id);
    if (gone) URL.revokeObjectURL(gone.previewUrl);
    setImages(images.filter((i) => i.id !== id));
    setNotes([]);
  };

  const valid = descriptionValid(text);

  const save = async (done: boolean) => {
    if (!valid || busy) return;
    setBusy(true);
    setError("");
    const key = keyRef.current || newUUID();
    const res = await submitReport({
      description: text,
      key,
      context: context.current,
      images: images.map((i) => i.blob),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setText("");
    dropImages();
    keyRef.current = newUUID();
    onSaved();
    void loadPrevious();
    if (done) onClose();
    else areaRef.current?.focus();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        showCloseButton={false}
        data-testid="bug-report-dialog"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          areaRef.current?.focus();
        }}
        onCloseAutoFocus={(e) => {
          const target = returnFocus?.current?.current;
          if (target) {
            e.preventDefault();
            target.focus();
          }
        }}
        onPaste={(e) => {
          const files = imagesFromClipboard(e.clipboardData);
          if (files.length) void addFiles(files);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/")));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void save(true);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Report a bug</DialogTitle>
          <DialogDescription className="sr-only">Describe what went wrong</DialogDescription>
        </DialogHeader>

        <Textarea
          ref={areaRef}
          value={text}
          maxLength={MAX_DESCRIPTION}
          rows={6}
          aria-label="What went wrong?"
          placeholder="What went wrong?"
          onChange={(e) => {
            setText(e.target.value);
            saveDraft(e.target.value);
          }}
        />

        <div className="flex flex-wrap items-center gap-2">
          {images.map((img, i) => (
            <div key={img.id} className="relative h-16 w-16 overflow-hidden rounded border border-border">
              <img src={img.previewUrl} alt={`Screenshot ${i + 1}`} className="h-full w-full object-cover" />
              <button
                type="button"
                aria-label={`Remove screenshot ${i + 1}`}
                className="absolute right-0 top-0 rounded-bl bg-background/80 p-0.5"
                onClick={() => removeImage(img.id)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
          <label className="inline-flex h-8 cursor-pointer items-center gap-1 rounded-md border border-input px-2 text-sm text-muted-foreground hover:bg-accent">
            <ImagePlus className="h-4 w-4" />
            <span>Add screenshot</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="sr-only"
              data-testid="bug-report-file"
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = "";
              }}
            />
          </label>
        </div>
        {notes.map((n) => (
          <p key={n} className="text-xs text-destructive" role="alert">
            {n}
          </p>
        ))}
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {previous.length > 0 && (
          <div className="text-sm">
            <ul className="space-y-1">
              {previous.map((r) => {
                const url = safeIssueUrl(r.issue_url);
                return (
                  <li key={r.id} className="flex items-baseline justify-between gap-2">
                    <span className="truncate">{r.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {url ? (
                        <a href={url} target="_blank" rel="noreferrer" className="underline">
                          View issue
                        </a>
                      ) : (
                        statusLabel(r.sync_status)
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            {!showAll && previous.length >= 3 && (
              <button type="button" className="mt-1 text-xs underline" onClick={() => setShowAll(true)}>
                Show all
              </button>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button type="button" variant="outline" disabled={!valid || busy} onClick={() => void save(false)}>
            Save and add
          </Button>
          <Button type="button" disabled={!valid || busy} onClick={() => void save(true)}>
            Save and done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
