// Extract the text a read-along session should speak from the rendered prose,
// plus a spoken-index -> DOM text position map so highlights can be painted
// without ever mutating the React-owned DOM.
//
// Spoken text is what we POST to the speech service; `char_offset` values it
// returns index into exactly that string (per chunk), so every char in the
// spoken string has a map entry: a real DOM position, or "inserted" (-1) for
// characters we added (block separators).

/** Elements whose subtree is never spoken. */
const SKIP_SELECTOR = [
  "pre", "code", "table", "img", "svg", "canvas", "video", "audio", "iframe",
  "script", "style", "noscript", "button", "input", "select", "textarea",
  ".katex", ".katex-display", ".math", "mjx-container",
  "[data-footnote-ref]", "[aria-hidden='true']", ".sr-only", "[hidden]",
  ".kiwi-table-wrapper", ".kiwi-media", ".kiwi-figure img",
  ".kiwi-chart", ".kiwi-app", ".kiwi-query", ".kiwi-diff", ".kiwi-kanban",
  ".kiwi-playground", ".kiwi-progress", ".kiwi-color",
  ".kiwi-frontmatter", ".kiwi-metadata", ".kiwi-edges", ".kiwi-backlinks-section",
].join(",");

const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "UL", "OL", "DL", "DT", "DD",
  "BLOCKQUOTE", "DIV", "SECTION", "ARTICLE", "ASIDE", "HEADER", "FOOTER",
  "FIGURE", "FIGCAPTION", "HR", "BR", "DETAILS", "SUMMARY", "TR", "TD", "TH",
]);

export type SpeechDoc = {
  /** The spoken string (inserted separators included). */
  text: string;
  /** Distinct text nodes referenced by the map. */
  nodes: Text[];
  /** Per spoken char: index into `nodes`, or -1 when the char was inserted. */
  nodeIdx: Int32Array;
  /** Per spoken char: offset inside that text node (valid when nodeIdx >= 0). */
  local: Int32Array;
  /** Spoken index where each non-empty block begins. */
  blockStarts: number[];
};

const WS = /\s/;
const TERMINAL = /[.!?:;…]["')\]”’]*$/;

export function extractSpeech(root: HTMLElement): SpeechDoc {
  const parts: string[] = [];
  const nodeIdx: number[] = [];
  const local: number[] = [];
  const nodes: Text[] = [];
  const blockStarts: number[] = [];
  let length = 0;
  let blockHasContent = false;
  let lastWasSpace = false;

  const push = (ch: string, ni: number, lo: number) => {
    parts.push(ch);
    nodeIdx.push(ni);
    local.push(lo);
    length++;
  };
  const pop = () => {
    parts.pop();
    nodeIdx.pop();
    local.pop();
    length--;
  };

  const endBlock = () => {
    if (!blockHasContent) return;
    if (lastWasSpace) pop();
    const tail = parts.slice(-4).join("");
    // A heading/list item without closing punctuation gets a sentence break so
    // it does not run into the next block.
    if (!TERMINAL.test(tail)) push(".", -1, 0);
    push(" ", -1, 0);
    blockHasContent = false;
    lastWasSpace = false;
  };

  const emitText = (t: Text) => {
    let ni = -1;
    const data = t.data;
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (WS.test(ch)) {
        if (!blockHasContent || lastWasSpace) continue;
        if (ni < 0) ni = nodes.push(t) - 1;
        push(" ", ni, i);
        lastWasSpace = true;
      } else {
        if (!blockHasContent) {
          blockStarts.push(length);
          blockHasContent = true;
        }
        if (ni < 0) ni = nodes.push(t) - 1;
        push(ch, ni, i);
        lastWasSpace = false;
      }
    }
  };

  const walk = (el: Node) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        emitText(n as Text);
      } else if (n.nodeType === 1) {
        const e = n as Element;
        if (e.matches(SKIP_SELECTOR)) {
          // Skipped content still separates the text around it.
          if (BLOCK_TAGS.has(e.tagName)) endBlock();
          continue;
        }
        const block = BLOCK_TAGS.has(e.tagName);
        if (block) endBlock();
        walk(e);
        if (block) endBlock();
      }
    }
  };
  walk(root);
  endBlock();

  return {
    text: parts.join(""),
    nodes,
    nodeIdx: Int32Array.from(nodeIdx),
    local: Int32Array.from(local),
    blockStarts,
  };
}

/**
 * Range covering spoken chars [start, end). Inserted chars are skipped at the
 * edges; returns null when no char in the span has a DOM position or the DOM
 * node is gone. Read-only.
 */
export function rangeForSpoken(doc: SpeechDoc, start: number, end: number): Range | null {
  const lim = Math.min(end, doc.text.length);
  let a = Math.max(0, start);
  while (a < lim && doc.nodeIdx[a] < 0) a++;
  let b = lim - 1;
  while (b >= a && doc.nodeIdx[b] < 0) b--;
  if (a >= lim || b < a) return null;
  const sn = doc.nodes[doc.nodeIdx[a]];
  const en = doc.nodes[doc.nodeIdx[b]];
  if (!sn.isConnected || !en.isConnected) return null;
  try {
    const range = document.createRange();
    range.setStart(sn, doc.local[a]);
    range.setEnd(en, doc.local[b] + 1);
    return range;
  } catch {
    return null;
  }
}

const nodeSpanCache = new WeakMap<SpeechDoc, Map<Text, number[]>>();

function spansByNode(doc: SpeechDoc): Map<Text, number[]> {
  let m = nodeSpanCache.get(doc);
  if (!m) {
    m = new Map<Text, number[]>();
    for (let i = 0; i < doc.nodeIdx.length; i++) {
      const ni = doc.nodeIdx[i];
      if (ni < 0) continue;
      const node = doc.nodes[ni];
      let arr = m.get(node);
      if (!arr) {
        arr = [];
        m.set(node, arr);
      }
      arr.push(i);
    }
    nodeSpanCache.set(doc, m);
  }
  return m;
}

/** Nearest spoken index at/after a DOM (text node, offset), or null. */
export function spokenIndexFor(doc: SpeechDoc, node: Node, offset: number): number | null {
  const idxs = spansByNode(doc).get(node as Text);
  if (!idxs || idxs.length === 0) return null;
  let lo = 0;
  let hi = idxs.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (doc.local[idxs[mid]] >= offset) {
      found = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return found >= 0 ? idxs[found] : idxs[idxs.length - 1];
}

export type SpeechChunk = { index: number; text: string; base: number };

/**
 * Split the spoken text into chunks of at most `maxChars`, cutting at block
 * boundaries; a single oversize block is cut at sentence, then word, then (as a
 * last resort) arbitrary boundaries. Each chunk's `base` is the spoken index of
 * its first char, so `char_offset + base` addresses the full spoken string.
 */
export function chunkSpeech(doc: SpeechDoc, maxChars = 1000, firstChars = 0): SpeechChunk[] {
  const text = doc.text;
  type Unit = { start: number; end: number };
  const units: Unit[] = [];
  const starts = doc.blockStarts;
  const chunks: SpeechChunk[] = [];
  // Short first chunk: the paid engine buffers a whole chunk before returning, so a
  // small head chunk gets audio playing quickly; the rest is chunked as usual (chunk 2
  // is a normal chunk, requested in parallel with chunk 1 by the session's prefetch).
  let from = 0;
  if (firstChars > 0 && starts.length > 0) {
    const cut = firstChunkEnd(text, starts, firstChars);
    if (cut > 0) {
      chunks.push({ index: 0, text: text.slice(starts[0], cut), base: starts[0] });
      from = cut;
      while (from < text.length && WS.test(text[from])) from++;
    }
  }
  for (let b = 0; b < starts.length; b++) {
    const e = b + 1 < starts.length ? starts[b + 1] : text.length;
    if (e <= from) continue;
    const s = Math.max(starts[b], from);
    for (const piece of splitOversize(text, s, e, maxChars)) units.push(piece);
  }

  let cs = -1;
  let ce = -1;
  const flush = () => {
    if (cs < 0) return;
    const t = text.slice(cs, ce).trimEnd();
    if (t) chunks.push({ index: chunks.length, text: t, base: cs });
    cs = -1;
  };
  for (const u of units) {
    const trimmedEnd = u.start + text.slice(u.start, u.end).trimEnd().length;
    if (cs >= 0 && trimmedEnd - cs > maxChars) flush();
    if (cs < 0) cs = u.start;
    ce = u.end;
  }
  flush();
  return chunks;
}

/**
 * End (exclusive, trimmed) of the short first chunk, or 0 when the text is already
 * short enough to be one chunk. Prefers the sentence/block end in [target*0.4,
 * target*1.5] closest to `target` (defaults: 80..300 for 200); otherwise the last
 * word boundary at or before `target` (or the next one if the first word is longer).
 */
function firstChunkEnd(text: string, starts: number[], target: number): number {
  const origin = starts[0];
  const lo = origin + Math.round(target * 0.4);
  const hi = origin + Math.round(target * 1.5);
  const goal = origin + target;
  let total = text.length;
  while (total > origin && WS.test(text[total - 1])) total--;
  if (total - origin <= hi) return 0;
  const cands: number[] = [];
  const re = /[.!?]["')\]”’]*(?=\s)/g;
  re.lastIndex = origin;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && m.index + m[0].length <= hi) cands.push(m.index + m[0].length);
  for (const bs of starts) {
    if (bs <= origin) continue;
    let end = bs;
    while (end > origin && WS.test(text[end - 1])) end--;
    if (end <= hi) cands.push(end);
  }
  let best = 0;
  for (const c of cands) {
    if (c >= lo && c <= hi && (best === 0 || Math.abs(c - goal) < Math.abs(best - goal))) best = c;
  }
  if (best > 0) return best;
  let i = goal;
  while (i > origin && !WS.test(text[i])) i--;
  if (i <= origin) {
    i = goal;
    while (i < total && !WS.test(text[i])) i++;
    if (i >= total) return 0;
  }
  while (i > origin && WS.test(text[i - 1])) i--;
  return i;
}

function splitOversize(text: string, s: number, e: number, max: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let pos = s;
  let te = e;
  while (te > pos && WS.test(text[te - 1])) te--;
  while (pos < e) {
    if (te - pos <= max) {
      out.push({ start: pos, end: e });
      break;
    }
    const window = text.slice(pos, pos + max + 1);
    let cut = 0;
    const sentence = /[.!?]["')\]”’]*\s/g;
    let m: RegExpExecArray | null;
    while ((m = sentence.exec(window))) {
      if (m.index + m[0].length <= max + 1) cut = m.index + m[0].length;
    }
    if (cut <= 0) {
      const sp = window.lastIndexOf(" ");
      cut = sp > 0 ? sp + 1 : max;
    }
    out.push({ start: pos, end: pos + cut });
    pos += cut;
    while (pos < e && WS.test(text[pos])) pos++;
  }
  return out;
}
