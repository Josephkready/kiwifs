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

/** Nearest spoken index at/after a DOM (text node, offset), or null. */
export function spokenIndexFor(doc: SpeechDoc, node: Node, offset: number): number | null {
  const ni = doc.nodes.indexOf(node as Text);
  if (ni < 0) return null;
  let best: number | null = null;
  for (let i = 0; i < doc.nodeIdx.length; i++) {
    if (doc.nodeIdx[i] !== ni) continue;
    best = i;
    if (doc.local[i] >= offset) return i;
  }
  return best;
}

export type SpeechChunk = { index: number; text: string; base: number };

/**
 * Split the spoken text into chunks of at most `maxChars`, cutting at block
 * boundaries; a single oversize block is cut at sentence, then word, then (as a
 * last resort) arbitrary boundaries. Each chunk's `base` is the spoken index of
 * its first char, so `char_offset + base` addresses the full spoken string.
 */
export function chunkSpeech(doc: SpeechDoc, maxChars = 1000): SpeechChunk[] {
  const text = doc.text;
  type Unit = { start: number; end: number };
  const units: Unit[] = [];
  const starts = doc.blockStarts;
  for (let b = 0; b < starts.length; b++) {
    const s = starts[b];
    const e = b + 1 < starts.length ? starts[b + 1] : text.length;
    for (const piece of splitOversize(text, s, e, maxChars)) units.push(piece);
  }

  const chunks: SpeechChunk[] = [];
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

function splitOversize(text: string, s: number, e: number, max: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let pos = s;
  while (pos < e) {
    const trimmedLen = text.slice(pos, e).trimEnd().length;
    if (trimmedLen <= max) {
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
