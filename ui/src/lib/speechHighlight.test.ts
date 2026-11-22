// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSpeechHighlighter, SPEECH_HIGHLIGHT_NAME, type HighlightSource, type SpeechHighlighter } from "./speechHighlight";
import { extractSpeech, type SpeechDoc } from "./speechText";

// Word timing is out of scope here: treat the playhead's local value as the word index.
vi.mock("./readAlongSession", () => ({
  activeWordIndex: (_words: unknown, t: number) => t,
}));

let queue: Map<number, FrameRequestCallback>;
let nextId: number;
let registry: Map<string, { range: Range }>;
let root: HTMLElement;
let doc: SpeechDoc;
let hl: SpeechHighlighter | null;
let playhead: { chunk: number; local: number } | null;
let seekSpy = vi.fn(() => true);
let source: HighlightSource;

const words = [
  { word: "Hello", char_offset: 0 },
  { word: "world", char_offset: 6 },
] as any;

function flushFrame() {
  const cbs = [...queue.values()];
  queue.clear();
  for (const cb of cbs) cb(performance.now());
}

function start(): SpeechHighlighter {
  hl = createSpeechHighlighter({ root, doc, source, autoScroll: false });
  return hl;
}

function clickAt(node: Node, offset: number) {
  (document as any).caretRangeFromPoint = vi.fn(() => ({ startContainer: node, startOffset: offset }));
  root.querySelector("p")!.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }));
}

beforeEach(() => {
  queue = new Map();
  nextId = 1;
  registry = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const id = nextId++;
    queue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue.delete(id);
  });
  vi.stubGlobal("CSS", { highlights: registry });
  vi.stubGlobal("Highlight", class {
    range: Range;
    constructor(r: Range) {
      this.range = r;
    }
  });
  root = document.createElement("div");
  root.className = "kiwi-prose";
  root.innerHTML = "<p>Hello world. Second sentence here.</p>";
  document.body.appendChild(root);
  doc = extractSpeech(root);
  playhead = { chunk: 0, local: 0 };
  seekSpy = vi.fn(() => true);
  source = {
    getPlayhead: () => playhead,
    getWords: () => words,
    getChunkBase: () => 0,
    seekToSpoken: seekSpy,
  };
  hl = null;
});

afterEach(() => {
  hl?.destroy();
  hl = null;
  root.remove();
  vi.unstubAllGlobals();
  delete (document as any).caretRangeFromPoint;
});

describe("createSpeechHighlighter", () => {
  it("paints one Range per word index and skips repaints for the same index", () => {
    start();
    const set = vi.spyOn(registry, "set");
    flushFrame();
    expect(set).toHaveBeenCalledTimes(1);
    expect((registry.get(SPEECH_HIGHLIGHT_NAME) as any).range.toString()).toBe("Hello");

    flushFrame();
    flushFrame();
    expect(set).toHaveBeenCalledTimes(1);

    playhead = { chunk: 0, local: 1 };
    flushFrame();
    expect(set).toHaveBeenCalledTimes(2);
    expect((registry.get(SPEECH_HIGHLIGHT_NAME) as any).range.toString()).toBe("world");
  });

  it("clears the highlight and stops painting when the prose text changes", async () => {
    const h = start();
    flushFrame();
    expect(registry.has(SPEECH_HIGHLIGHT_NAME)).toBe(true);

    root.querySelector("p")!.firstChild!.textContent = "Completely different text.";
    await new Promise((r) => setTimeout(r, 0));
    flushFrame();

    expect(h.isActive()).toBe(false);
    expect(registry.has(SPEECH_HIGHLIGHT_NAME)).toBe(false);

    const set = vi.spyOn(registry, "set");
    playhead = { chunk: 0, local: 1 };
    flushFrame();
    expect(set).not.toHaveBeenCalled();
  });

  it("seeks to the spoken index of a clicked text position", () => {
    start();
    const text = root.querySelector("p")!.firstChild as Text;
    clickAt(text, 6);
    expect(seekSpy).toHaveBeenCalledWith(doc.text.indexOf("world"));
  });

  it("destroy() cancels the loop, removes click handling, and clears the highlight", () => {
    const h = start();
    flushFrame();
    expect(registry.has(SPEECH_HIGHLIGHT_NAME)).toBe(true);

    const cancelSpy = vi.fn((id: number) => {
      queue.delete(id);
    });
    vi.stubGlobal("cancelAnimationFrame", cancelSpy);
    h.destroy();
    expect(cancelSpy).toHaveBeenCalled();
    expect(registry.has(SPEECH_HIGHLIGHT_NAME)).toBe(false);

    clickAt(root.querySelector("p")!.firstChild as Text, 6);
    expect(seekSpy).not.toHaveBeenCalled();

    const set = vi.spyOn(registry, "set");
    playhead = { chunk: 0, local: 1 };
    flushFrame();
    expect(set).not.toHaveBeenCalled();
  });
});
