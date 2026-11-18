import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { CheckCircle, Circle, Plus, Trash2 } from "lucide-react";
import { api, type Comment, type CommentAnchor } from "@kw/lib/api";
import {
  anchorFromSelection,
  hitTest,
  rangesForAnchors,
} from "@kw/lib/highlights";
import { Button } from "@kw/components/ui/button";
import { Card } from "@kw/components/ui/card";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@kw/components/ui/popover";

import { Textarea } from "@kw/components/ui/textarea";

type Props = {
  path: string;
  containerRef: React.RefObject<HTMLElement | null>;
  // Changes whenever the rendered markdown is replaced so we can re-apply
  // highlight ranges on top of the fresh DOM.
  renderKey: unknown;
  refreshKey?: number;
};

// Name of the CSS highlight; styled by ::highlight(kiwi-comment) in index.css.
const HIGHLIGHT_NAME = "kiwi-comment";

type PopoverState =
  | { mode: "closed" }
  | { mode: "add"; anchor: CommentAnchor; rect: DOMRect }
  | { mode: "view"; id: string; rect: DOMRect };

// Virtual-element factory for Radix Popover anchored at an arbitrary viewport
// rect. PopoverAnchor accepts `virtualRef` shape via Slot, but the simplest
// portable approach is to render an absolute-positioned empty div as the anchor.
function rectAnchorStyle(rect: DOMRect): React.CSSProperties {
  return {
    position: "fixed",
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    pointerEvents: "none",
  };
}

export function KiwiComments({ path, containerRef, renderKey, refreshKey }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [popover, setPopover] = useState<PopoverState>({ mode: "closed" });
  const [draftBody, setDraftBody] = useState("");
  const [selectionBtn, setSelectionBtn] = useState<{ rect: DOMRect } | null>(
    null,
  );
  const draftRef = useRef<HTMLTextAreaElement>(null);

  // Fetch comments for this page. Re-fetches when an SSE event arrives
  // (refreshKey bump) so externally-added comments show up live.
  useEffect(() => {
    let cancelled = false;
    api
      .listComments(path)
      .then((r) => {
        if (!cancelled) setComments(r.comments);
      })
      .catch(() => {
        if (!cancelled) setComments([]);
      });
    return () => {
      cancelled = true;
    };
  }, [path, refreshKey]);

  const openView = useCallback((id: string, rect: DOMRect) => {
    setPopover({ mode: "view", id, rect });
    setSelectionBtn(null);
  }, []);

  // Comment id -> live Range over the prose. Rebuilt whenever the comments
  // or the rendered markdown change.
  const rangesRef = useRef<{ id: string; range: Range }[]>([]);

  // Paint comment anchors with the CSS Custom Highlight API. Nothing is
  // inserted into the prose DOM, so React can re-render it freely (see
  // rangeForAnchor). A MutationObserver re-resolves the ranges whenever
  // React replaces nodes for reasons other than renderKey (theme, async
  // code blocks, wikilink resolution).
  useLayoutEffect(() => {
    const root = containerRef.current as HTMLElement | null;
    if (!root) return;
    const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
    const apply = () => {
      const entries: { id: string; range: Range }[] = [];
      const ranges = rangesForAnchors(root, comments.map((c) => c.anchor));
      comments.forEach((c, i) => {
        const range = ranges[i];
        if (range) entries.push({ id: c.id, range });
      });
      rangesRef.current = entries;
      if (registry && typeof Highlight !== "undefined") {
        registry.set(HIGHLIGHT_NAME, new Highlight(...entries.map((e) => e.range)));
      }
    };
    apply();
    let frame = 0;
    const observer = new MutationObserver(() => {
      // Drop ranges from before this mutation so click/hover never use them.
      rangesRef.current = [];
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    });
    observer.observe(root, { childList: true, characterData: true, subtree: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      rangesRef.current = [];
      registry?.delete(HIGHLIGHT_NAME);
    };
  }, [comments, containerRef, renderKey]);

  // Clicking highlighted text opens that comment; hovering it shows a
  // pointer. Both hit-test the ranges' client rects.
  useEffect(() => {
    const root = containerRef.current as HTMLElement | null;
    if (!root) return;
    const hitAt = (x: number, y: number) =>
      hitTest(
        rangesRef.current.map((e) => ({ id: e.id, rects: e.range.getClientRects() })),
        x,
        y,
      );
    const onClick = (e: MouseEvent) => {
      if (window.getSelection()?.isCollapsed === false) return;
      const hit = hitAt(e.clientX, e.clientY);
      if (!hit) return;
      const r = hit.rect;
      openView(hit.entry.id, new DOMRect(r.left, r.top, r.right - r.left, r.bottom - r.top));
    };
    let hoverFrame = 0;
    let pending: MouseEvent | null = null;
    let hovering = false;
    const onMove = (e: MouseEvent) => {
      pending = e;
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        const ev = pending;
        pending = null;
        if (!ev) return;
        const hit = hitAt(ev.clientX, ev.clientY) !== null;
        if (hit !== hovering) {
          hovering = hit;
          root.classList.toggle("kiwi-comment-hover", hit);
        }
      });
    };
    root.addEventListener("click", onClick);
    root.addEventListener("mousemove", onMove);
    return () => {
      root.removeEventListener("click", onClick);
      root.removeEventListener("mousemove", onMove);
      cancelAnimationFrame(hoverFrame);
      root.classList.remove("kiwi-comment-hover");
    };
  }, [containerRef, openView]);

  // Float an "Add comment" button near any non-empty selection inside the
  // prose container.
  useEffect(() => {
    const root = containerRef.current as HTMLElement | null;
    if (!root) return;
    const handler = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setSelectionBtn(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        setSelectionBtn(null);
        return;
      }
      if (!sel.toString().trim()) {
        setSelectionBtn(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      setSelectionBtn({ rect });
    };
    document.addEventListener("selectionchange", handler);
    return () => document.removeEventListener("selectionchange", handler);
  }, [containerRef]);

  // Focus the textarea whenever the add popover opens.
  useEffect(() => {
    if (popover.mode === "add") {
      setTimeout(() => draftRef.current?.focus(), 0);
    }
  }, [popover.mode]);

  function startAdd() {
    const root = containerRef.current as HTMLElement | null;
    if (!root) return;
    const anchor = anchorFromSelection(root);
    if (!anchor) return;
    const sel = window.getSelection();
    const rect =
      sel && sel.rangeCount
        ? sel.getRangeAt(0).getBoundingClientRect()
        : root.getBoundingClientRect();
    setPopover({ mode: "add", anchor, rect });
    setDraftBody("");
    setSelectionBtn(null);
    window.getSelection()?.removeAllRanges();
  }

  async function submit() {
    if (popover.mode !== "add") return;
    const body = draftBody.trim();
    if (!body) return;
    try {
      const created = await api.addComment(path, popover.anchor, body);
      setComments((xs) => [...xs, created]);
      setPopover({ mode: "closed" });
      setDraftBody("");
    } catch (err) {
      // Keep the popover open on error so the user can retry.
      console.error("add comment failed", err);
    }
  }

  async function toggleResolve(id: string) {
    const c = comments.find((x) => x.id === id);
    if (!c) return;
    try {
      const updated = await api.resolveComment(path, id, !c.resolved);
      setComments((xs) => xs.map((x) => (x.id === id ? updated : x)));
    } catch (err) {
      console.error("resolve comment failed", err);
    }
  }

  async function remove(id: string) {
    try {
      await api.deleteComment(path, id);
      setComments((xs) => xs.filter((c) => c.id !== id));
      setPopover({ mode: "closed" });
    } catch (err) {
      console.error("delete comment failed", err);
    }
  }

  const activeView =
    popover.mode === "view"
      ? comments.find((c) => c.id === popover.id)
      : undefined;

  return (
    <>
      {/* Floating "Add comment" affordance near the live selection */}
      {selectionBtn && popover.mode === "closed" ? (
        <div
          className="fixed z-50"
          style={{
            left: Math.max(
              8,
              selectionBtn.rect.left + selectionBtn.rect.width / 2 - 60,
            ),
            top: Math.max(8, selectionBtn.rect.top - 36),
          }}
        >
          <Button
            size="sm"
            className="h-7 px-2.5 text-xs shadow-md"
            onMouseDown={(e) => e.preventDefault()}
            onClick={startAdd}
          >
            <Plus className="h-3.5 w-3.5" /> Comment
          </Button>
        </div>
      ) : null}

      {/* Add popover, anchored at the selection rect */}
      {popover.mode === "add" ? (
        <Popover
          open
          onOpenChange={(o) => {
            if (!o) setPopover({ mode: "closed" });
          }}
        >
          <PopoverAnchor asChild>
            <div style={rectAnchorStyle(popover.rect)} />
          </PopoverAnchor>
          <PopoverContent
            side="bottom"
            align="center"
            className="w-[calc(100vw-2rem)] sm:w-80"
            onOpenAutoFocus={(e) => e.preventDefault()}
          >
            <div className="mb-2 text-xs text-muted-foreground">
              Commenting on:{" "}
              <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                {truncate(popover.anchor.quote, 80)}
              </span>
            </div>
            <Textarea
              ref={draftRef}
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              placeholder="Add a comment…"
              rows={3}
              className="resize-none text-sm"
              onKeyDown={(e) => {
                if (e.key === "Escape") setPopover({ mode: "closed" });
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
              }}
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-foreground"
                onClick={() => setPopover({ mode: "closed" })}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={submit}
                disabled={!draftBody.trim()}
              >
                Save
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}

      {/* View existing comment, anchored at the highlight rect */}
      {popover.mode === "view" && activeView ? (
        <Popover
          open
          onOpenChange={(o) => {
            if (!o) setPopover({ mode: "closed" });
          }}
        >
          <PopoverAnchor asChild>
            <div style={rectAnchorStyle(popover.rect)} />
          </PopoverAnchor>
          <PopoverContent side="bottom" align="center" className="w-80">
            <div className="mb-1 text-xs text-muted-foreground flex items-center gap-1.5">
              <span>{activeView.author} · {formatDate(activeView.createdAt)}</span>
              {activeView.resolved && (
                <span className="text-green-700 dark:text-green-400 flex items-center gap-0.5">
                  <CheckCircle className="h-3 w-3" /> Resolved
                </span>
              )}
            </div>
            <div className="whitespace-pre-wrap text-sm">{activeView.body}</div>
            <div className="mt-3 flex items-center justify-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => toggleResolve(activeView.id)}
              >
                {activeView.resolved ? (
                  <><Circle className="h-3.5 w-3.5" /> Unresolve</>
                ) : (
                  <><CheckCircle className="h-3.5 w-3.5" /> Resolve</>
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => remove(activeView.id)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      ) : null}

      {/* Footer list — always visible so comments are discoverable. */}
      <CommentsList
        comments={comments}
        onFocus={(c) => {
          const entry = rangesRef.current.find((e) => e.id === c.id);
          if (entry) {
            entry.range.startContainer.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
            const r = entry.range.getBoundingClientRect();
            openView(c.id, new DOMRect(r.left, r.top, r.width, r.height));
          }
        }}
        onDelete={remove}
        onToggleResolve={toggleResolve}
      />
    </>
  );
}

function CommentsList({
  comments,
  onFocus,
  onDelete,
  onToggleResolve,
}: {
  comments: Comment[];
  onFocus: (c: Comment) => void;
  onDelete: (id: string) => void;
  onToggleResolve: (id: string) => void;
}) {
  if (comments.length === 0) {
    return (
      <div className="text-sm text-muted-foreground">
        Select text in the page to add an inline comment.
      </div>
    );
  }
  return (
    <div className="text-sm">
      <ul className="space-y-3">
        {comments.map((c) => (
          <li key={c.id}>
            <Card className={"p-3" + (c.resolved ? " opacity-60" : "")}>
              <div className="flex items-start gap-2 min-w-0">
                <button
                  type="button"
                  onClick={() => onFocus(c)}
                  className="flex-1 min-w-0 text-left"
                >
                  <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1.5 flex-wrap">
                    <span>{c.author} · {formatDate(c.createdAt)}</span>
                    {c.resolved && (
                      <span className="text-green-700 dark:text-green-400 flex items-center gap-0.5">
                        <CheckCircle className="h-3 w-3" /> Resolved
                      </span>
                    )}
                  </div>
                  <div className="text-xs italic text-muted-foreground mb-1.5">
                    "{truncate(c.anchor.quote, 120)}"
                  </div>
                  <div className={"whitespace-pre-wrap" + (c.resolved ? " line-through" : "")}>{c.body}</div>
                </button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onToggleResolve(c.id)}
                  title={c.resolved ? "Unresolve" : "Resolve"}
                  className="h-7 w-7 text-muted-foreground"
                >
                  {c.resolved ? <Circle className="h-3.5 w-3.5" /> : <CheckCircle className="h-3.5 w-3.5" />}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onDelete(c.id)}
                  title="Delete"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
