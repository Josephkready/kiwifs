import { describe, expect, it, vi } from "vitest";
import {
  ReadAlongSession,
  activeWordIndex,
  chunkStarts,
  globalToLocal,
  localToGlobal,
  type SpeechWord,
} from "./readAlongSession";

describe("virtual timeline", () => {
  const d = [10, 5, 20];
  it("computes chunk starts", () => expect(chunkStarts(d)).toEqual([0, 10, 15]));
  it("maps global to chunk/local across 3 chunks", () => {
    expect(globalToLocal(d, 0)).toEqual({ chunk: 0, local: 0 });
    expect(globalToLocal(d, 12)).toEqual({ chunk: 1, local: 2 });
    expect(globalToLocal(d, 15)).toEqual({ chunk: 2, local: 0 });
    expect(globalToLocal(d, 999)).toEqual({ chunk: 2, local: 20 });
    expect(globalToLocal(d, -5)).toEqual({ chunk: 0, local: 0 });
  });
  it("round-trips, including a backward seek", () => {
    const fwd = globalToLocal(d, 30);
    expect(localToGlobal(d, fwd.chunk, fwd.local)).toBe(30);
    const back = globalToLocal(d, 4);
    expect(back).toEqual({ chunk: 0, local: 4 });
    expect(localToGlobal(d, back.chunk, back.local)).toBe(4);
  });
});

describe("activeWordIndex", () => {
  const w = (start: number, off: number | null): SpeechWord => ({ word: "w", start, end: start + 0.2, char_offset: off });
  const words = [w(1, 0), w(2, 2), w(3, null), w(4, 6)];
  it("is none before the first word", () => expect(activeWordIndex(words, 0.5)).toBe(-1));
  it("holds the last word through gaps", () => {
    expect(activeWordIndex(words, 1.5)).toBe(0);
    expect(activeWordIndex(words, 2.9)).toBe(1);
  });
  it("skips null char_offset words, keeping the previous one", () => expect(activeWordIndex(words, 3.5)).toBe(1));
  it("holds the final word past the end", () => expect(activeWordIndex(words, 99)).toBe(3));
});

// ── session with mocked fetch ──

class FakeAudio extends EventTarget {
  src = "";
  currentTime = 0;
  duration = NaN;
  playbackRate = 1;
  paused = true;
  ended = false;
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(a: string) {
    if (a === "src") this.src = "";
  }
}

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response);

const words = (n: number): SpeechWord[] =>
  Array.from({ length: n }, (_, i) => ({ word: "ab", start: i, end: i + 0.9, char_offset: i * 3 }));

const chunks = [
  { index: 0, text: "ab ab ab", base: 0 },
  { index: 1, text: "ab ab ab", base: 9 },
];

const settle = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(cond()).toBe(true);
};

function make(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  const audio = new FakeAudio();
  const s = new ReadAlongSession({
    endpoint: "/api/speech/",
    chunks,
    fetchImpl,
    audio: audio as unknown as HTMLAudioElement,
    pollMs: 1,
    ...extra,
  });
  return { s, audio };
}

describe("ReadAlongSession", () => {
  it("sends only text, follows 202 -> poll -> complete, and fetches words for job results", async () => {
    const calls: { url: string; body?: string }[] = [];
    const f = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string });
      if (url.endsWith("/synthesize")) return json(202, { status: "pending", job_id: "j1", status_url: "/synthesize/jobs/j1" });
      if (url.endsWith("/jobs/j1")) {
        const n = calls.filter((c) => c.url.endsWith("/jobs/j1")).length;
        return json(200, n < 2 ? { status: "pending", done: 0, total: 1 } : { status: "complete", done: 1, total: 1, result: { id: "item1" } });
      }
      if (url.endsWith("/words.json")) return json(200, words(3));
      return json(404, {});
    }) as unknown as typeof fetch;
    const { s, audio } = make(f);
    s.start();
    await settle(() => s.getState().chunks[0].status === "ready");
    expect(JSON.parse(calls[0].body!)).toEqual({ text: "ab ab ab" });
    expect(calls.some((c) => c.url === "/api/speech/synthesize/jobs/j1")).toBe(true);
    expect(s.getWords(0)).toHaveLength(3);
    expect(audio.src).toBe("/api/speech/media/item1/audio.mp3");
    expect(s.getState().phase).toBe("playing");
    expect(s.getState().duration).toBeGreaterThan(0);
    s.stop();
  });

  it("includes mode in the POST body only when configured", async () => {
    const run = async (extra: Record<string, unknown>) => {
      const bodies: string[] = [];
      const f = ((_url: string, init?: RequestInit) => {
        if (init?.method === "POST") bodies.push(init.body as string);
        return json(200, { id: "x", words: words(3) });
      }) as unknown as typeof fetch;
      const { s } = make(f, { prefetch: 0, ...extra });
      s.start();
      await settle(() => bodies.length > 0);
      s.stop();
      return JSON.parse(bodies[0]);
    };
    expect(await run({ mode: "fast" })).toEqual({ text: "ab ab ab", mode: "fast" });
    expect(await run({ mode: "" })).toEqual({ text: "ab ab ab" });
    expect(await run({})).toEqual({ text: "ab ab ab" });
  });

  it("warns once per session when the service reports a fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = (() => json(200, { id: "x", words: words(3), meta: { mode: "default", fallback_reason: "cartesia down" } })) as unknown as typeof fetch;
    const { s } = make(f);
    s.start();
    await settle(() => s.getState().chunks.every((c) => c.status === "ready"));
    const calls = warn.mock.calls.filter((c) => String(c[0]).includes("fell back"));
    expect(calls).toHaveLength(1);
    warn.mockRestore();
    s.stop();
  });

  it("retries once, then reports a per-chunk error that Skip resolves", async () => {
    let attempts0 = 0;
    const f = ((url: string, init?: RequestInit) => {
      const text = JSON.parse((init?.body as string) ?? "{}").text;
      if (url.endsWith("/synthesize") && chunks[0].text === text && init?.method === "POST") {
        // chunk 0 and chunk 1 share text in this fixture; fail the first two calls only
        attempts0++;
        if (attempts0 <= 2) return json(500, {});
        return json(200, { id: "ok", words: words(3) });
      }
      return json(404, {});
    }) as unknown as typeof fetch;
    const { s } = make(f, { prefetch: 0 });
    s.start();
    await settle(() => s.getState().chunks[0].status === "error");
    expect(attempts0).toBe(2); // first try + one retry
    expect(s.getState().error?.chunk).toBe(0);
    expect(s.getState().phase).toBe("buffering");
    s.skipChunk(0);
    expect(s.getState().chunks[0].status).toBe("skipped");
    expect(s.getState().current).toBe(1);
    await settle(() => s.getState().chunks[1].status === "ready");
    expect(s.getState().error).toBeNull();
    s.stop();
  });

  it("aborts in-flight work on stop and ends in a stopped state", async () => {
    let signal: AbortSignal | undefined;
    const f = ((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) => {
        signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const { s, audio } = make(f);
    s.start();
    await settle(() => s.getState().chunks[0].status === "loading");
    s.stop();
    expect(signal?.aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    const st = s.getState();
    expect(st.phase).toBe("stopped");
    expect(st.chunks.every((c) => c.status !== "error" && c.status !== "ready")).toBe(true);
    expect(audio.src).toBe("");
  });

  it("hands over to the next chunk when audio ends and seeks across chunks", async () => {
    const f = ((_url: string, init?: RequestInit) => {
      if (init?.method === "POST") return json(200, { id: `id${Math.random().toString(36).slice(2)}`, words: words(3) });
      return json(404, {});
    }) as unknown as typeof fetch;
    const { s, audio } = make(f);
    s.start();
    await settle(() => s.getState().ready === 2);
    const first = audio.src;
    audio.dispatchEvent(new Event("ended"));
    expect(s.getState().current).toBe(1);
    expect(audio.src).not.toBe(first);
    s.seek(0.5); // backward seek into chunk 0
    expect(s.getState().current).toBe(0);
    expect(audio.src).toBe(first);
    s.stop();
  });
});
