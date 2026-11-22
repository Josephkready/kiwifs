// Paints the word being spoken with the CSS Custom Highlight API and keeps it
// in view. Nothing is ever inserted into the React-owned prose DOM (see
// speechText.ts for the spoken-index to DOM map). Follows aloud/spec/TIMING-SPEC.md: rAF loop, last word with
// start <= t, hold through gaps, touch the DOM only when the index changes,
// 38% anchor scrolling.

import { activeWordIndex, type SpeechWord } from "./readAlongSession";
import { extractSpeech, rangeForSpoken, spokenIndexFor, type SpeechDoc } from "./speechText";

export const SPEECH_HIGHLIGHT_NAME = "kiwi-speech";

export interface HighlightSource {
  getPlayhead(): { chunk: number; local: number } | null;
  getWords(chunk: number): SpeechWord[] | undefined;
  getChunkBase(chunk: number): number;
  seekToSpoken(index: number): boolean;
}

export type HighlighterOptions = {
  root: HTMLElement;
  doc: SpeechDoc;
  source: HighlightSource;
  autoScroll?: boolean;
};

export type SpeechHighlighter = {
  destroy(): void;
  /** False once the prose no longer matches the spoken text (audio keeps playing). */
  isActive(): boolean;
};

const easeInOutQuad = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

export function createSpeechHighlighter(opts: HighlighterOptions): SpeechHighlighter {
  const { root, source } = opts;
  let doc = opts.doc;
  let seenRaw = root.textContent ?? "";
  let active = true;
  let raf = 0;
  let mutRaf = 0;
  let lastKey = "";
  let lastSpan: { start: number; end: number } | null = null;
  let userScrolledAt = 0;
  let tween = 0;
  let tweenTarget = NaN;

  const registry = typeof CSS !== "undefined" ? CSS.highlights : undefined;
  const canPaint = !!registry && typeof Highlight !== "undefined";

  const paint = (start: number, end: number) => {
    const range = rangeForSpoken(doc, start, end);
    if (!range) return false;
    if (canPaint) {
      try {
        registry!.set(SPEECH_HIGHLIGHT_NAME, new Highlight(range));
      } catch (err) {
        console.warn("speech highlight paint failed", err);
        return false;
      }
    }
    if (opts.autoScroll !== false) ensureVisible(range);
    return true;
  };

  const ensureVisible = (range: Range) => {
    if (Date.now() - userScrolledAt < 4000) return;
    let rect: DOMRect;
    try {
      rect = range.getBoundingClientRect();
    } catch {
      return;
    }
    if (!rect || (rect.top === 0 && rect.bottom === 0 && rect.height === 0)) return;
    const sp = scrollParent(root);
    const viewTop = sp ? sp.getBoundingClientRect().top : 0;
    const viewHeight = sp ? sp.clientHeight : window.innerHeight;
    const scrollTop = sp ? sp.scrollTop : window.scrollY;
    const off = rect.top - viewTop;
    const anchor = 0.38 * viewHeight;
    if (!(off > anchor || off < 0)) return;
    const target = Math.max(0, scrollTop + off - anchor);
    // Single-flight tween: leave one already heading here alone.
    if (tween && Math.abs(target - tweenTarget) < 2) return;
    cancelAnimationFrame(tween);
    tweenTarget = target;
    const from = scrollTop;
    const t0 = performance.now();
    const dur = Math.min(350 * Math.max(1, Math.abs(target - from) / 28), 600);
    const set = (y: number) => (sp ? (sp.scrollTop = y) : window.scrollTo(0, y));
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      set(from + (target - from) * easeInOutQuad(p));
      if (p < 1) tween = requestAnimationFrame(step);
      else tween = 0;
    };
    tween = requestAnimationFrame(step);
  };

  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!active) return;
    try {
      const ph = source.getPlayhead();
      if (!ph) return;
      const words = source.getWords(ph.chunk);
      if (!words || words.length === 0) return;
      const idx = activeWordIndex(words, ph.local);
      if (idx < 0) return;
      const key = `${ph.chunk}:${idx}`;
      if (key === lastKey) return;
      const w = words[idx];
      const start = source.getChunkBase(ph.chunk) + (w.char_offset as number);
      // Unmappable word: keep the previous highlight and try again on the next index.
      lastKey = key;
      if (paint(start, start + w.word.length)) lastSpan = { start, end: start + w.word.length };
    } catch (err) {
      /* never let a bad word kill the loop */
      console.warn("speech highlight tick failed; continuing", err);
    }
  };

  const clear = () => {
    registry?.delete(SPEECH_HIGHLIGHT_NAME);
  };

  const observer = new MutationObserver(() => {
    if (!active) return;
    cancelAnimationFrame(mutRaf);
    mutRaf = requestAnimationFrame(() => {
      const raw = root.textContent ?? "";
      if (raw === seenRaw && doc.nodes.every((n) => n.isConnected)) return;
      seenRaw = raw;
      const next = extractSpeech(root);
      if (next.text !== doc.text) {
        // Content changed under us: stop highlighting, keep the audio.
        console.warn("speech highlight disabled: prose text changed", { chunk: lastKey });
        active = false;
        clear();
        return;
      }
      doc = next;
      if (lastSpan) {
        const r = rangeForSpoken(doc, lastSpan.start, lastSpan.end);
        if (r && canPaint) registry!.set(SPEECH_HIGHLIGHT_NAME, new Highlight(r));
      }
    });
  });
  observer.observe(root, { childList: true, characterData: true, subtree: true });

  const onClick = (e: MouseEvent) => {
    if (!active) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("a,button,input,textarea,select")) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    let node: Node | null = null;
    let offset = 0;
    const d = document as any;
    if (typeof d.caretPositionFromPoint === "function") {
      const p = d.caretPositionFromPoint(e.clientX, e.clientY);
      if (p) {
        node = p.offsetNode;
        offset = p.offset;
      }
    } else if (typeof d.caretRangeFromPoint === "function") {
      const r = d.caretRangeFromPoint(e.clientX, e.clientY);
      if (r) {
        node = r.startContainer;
        offset = r.startOffset;
      }
    }
    if (!node || !root.contains(node)) return;
    const idx = spokenIndexFor(doc, node, offset);
    if (idx != null) {
      lastKey = "";
      source.seekToSpoken(idx);
    }
  };
  const onUserScroll = () => {
    userScrolledAt = Date.now();
  };
  root.addEventListener("click", onClick);
  window.addEventListener("wheel", onUserScroll, { passive: true });
  window.addEventListener("touchmove", onUserScroll, { passive: true });

  raf = requestAnimationFrame(tick);

  return {
    isActive: () => active,
    destroy() {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(mutRaf);
      cancelAnimationFrame(tween);
      observer.disconnect();
      root.removeEventListener("click", onClick);
      window.removeEventListener("wheel", onUserScroll);
      window.removeEventListener("touchmove", onUserScroll);
      clear();
    },
  };
}
