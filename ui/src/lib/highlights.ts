// DOM utilities for locating and wrapping anchored text ranges in rendered
// markdown. Anchors are {quote, prefix, suffix} — the same TextQuote
// selector pattern used by W3C Web Annotations. The prefix/suffix
// disambiguate when the same quote appears multiple times on a page.

import type { CommentAnchor } from "./api";

export type AnchorLocation = { index: number; length: number };

// Find an anchor in a plain-text string. Tries exact context match first,
// then falls back to the raw quote. Returns null when the quote is absent.
export function locateAnchor(text: string, a: CommentAnchor): AnchorLocation | null {
  if (!a.quote) return null;
  const prefix = a.prefix || "";
  const suffix = a.suffix || "";

  if (prefix || suffix) {
    const full = prefix + a.quote + suffix;
    const hit = text.indexOf(full);
    if (hit >= 0) return { index: hit + prefix.length, length: a.quote.length };
  }
  // Fall back to plain quote match. Not perfect when the same quote recurs,
  // but better than silently dropping the comment.
  const hit = text.indexOf(a.quote);
  if (hit < 0) return null;
  return { index: hit, length: a.quote.length };
}

// Build the concatenated textContent of a container plus a parallel list of
// (node, offset) mappings so a flat-string index can be resolved back to a
// DOM Range.
function collectText(root: HTMLElement): { text: string; nodes: Text[]; offsets: number[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const offsets: number[] = [];
  let text = "";
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    nodes.push(t);
    offsets.push(text.length);
    text += t.data;
  }
  return { text, nodes, offsets };
}

// Map a flat-string index to (node, localOffset). Binary search on offsets.
function positionFor(
  index: number,
  nodes: Text[],
  offsets: number[]
): { node: Text; local: number } | null {
  if (nodes.length === 0) return null;
  let lo = 0,
    hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  const base = offsets[lo];
  const node = nodes[lo];
  const local = index - base;
  if (local < 0 || local > node.data.length) return null;
  return { node, local };
}

// Resolve an anchor to a DOM Range over the rendered markdown. This never
// touches the DOM: the prose subtree is owned by React, and splitting or
// wrapping its text nodes made the next re-render throw "Failed to execute
// 'insertBefore' on 'Node'" (the error boundary then hid the whole page).
// Callers paint the range with the CSS Custom Highlight API instead.
export function rangeForAnchor(root: HTMLElement, anchor: CommentAnchor): Range | null {
  return rangesForAnchors(root, [anchor])[0];
}

// Resolve many anchors against one text snapshot of `root`, so the TreeWalker
// runs once instead of once per anchor. Read-only: never touches the DOM.
export function rangesForAnchors(root: HTMLElement, anchors: CommentAnchor[]): (Range | null)[] {
  const { text, nodes, offsets } = collectText(root);
  return anchors.map((anchor) => {
    const loc = locateAnchor(text, anchor);
    if (!loc) return null;
    const start = positionFor(loc.index, nodes, offsets);
    const end = positionFor(loc.index + loc.length, nodes, offsets);
    if (!start || !end) return null;
    const range = document.createRange();
    try {
      range.setStart(start.node, start.local);
      range.setEnd(end.node, end.local);
    } catch {
      return null;
    }
    return range;
  });
}

type RectLike = { left: number; right: number; top: number; bottom: number };

// Return the id of the first entry with a rect containing (x, y). Used to
// turn a click on painted highlight text back into a comment id, since a
// CSS highlight has no element to attach a listener to.
export function hitTest<T extends { id: string; rects: ArrayLike<RectLike> }>(
  entries: readonly T[],
  x: number,
  y: number
): { entry: T; rect: RectLike } | null {
  for (const entry of entries) {
    for (let i = 0; i < entry.rects.length; i++) {
      const r = entry.rects[i];
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return { entry, rect: r };
      }
    }
  }
  return null;
}

// Capture an anchor from the current window selection, constrained to
// `root`. Returns null if the selection is empty, collapsed, or outside.
export function anchorFromSelection(
  root: HTMLElement,
  ctxChars = 24
): CommentAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return null;

  const quote = sel.toString();
  if (!quote.trim()) return null;

  const { text, nodes, offsets } = collectText(root);

  // Walk nodes once to find the range's start/end offsets in `text`.
  let startOffset = -1;
  let endOffset = -1;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node === range.startContainer) startOffset = offsets[i] + range.startOffset;
    if (node === range.endContainer) endOffset = offsets[i] + range.endOffset;
  }
  if (startOffset < 0 || endOffset < 0) {
    // Selection endpoints land on element nodes rather than text — fall
    // back to a simple quote lookup so the anchor is still usable.
    const hit = text.indexOf(quote);
    if (hit < 0) return { quote };
    startOffset = hit;
    endOffset = hit + quote.length;
  }

  const prefix = text.slice(Math.max(0, startOffset - ctxChars), startOffset);
  const suffix = text.slice(endOffset, Math.min(text.length, endOffset + ctxChars));

  return { quote, prefix, suffix, offset: startOffset };
}
