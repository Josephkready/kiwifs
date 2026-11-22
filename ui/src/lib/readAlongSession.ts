// Read-along playback session: synthesizes chunks on demand through the
// same-origin speech service, plays them back-to-back through ONE audio
// element, and exposes a virtual global timeline across all chunks.
//
// Service contract (apl-speech): POST {endpoint}/synthesize {text} -> 200
// {id, words?, ...} inline, or 202 {job_id, status_url} -> poll
// GET {endpoint}/synthesize/jobs/{job_id} -> {status, result}. A job's
// `result` carries NO words (only inline responses do), so words are fetched
// from {endpoint}/media/{id}/words.json when absent. Only `text` (plus an optional
// configured `mode`) is ever sent: engine and voice belong to the service.

import type { SpeechChunk } from "./speechText";

export type SpeechWord = {
  word: string;
  start: number;
  end: number;
  char_offset: number | null;
};

export const SPEEDS = [1, 1.25, 1.5, 1.75, 2] as const;

export type ChunkStatus = "idle" | "loading" | "ready" | "error" | "skipped";
export type Phase = "idle" | "buffering" | "playing" | "paused" | "ended" | "stopped";

export type ChunkInfo = { status: ChunkStatus; duration: number; error?: string };

export type SessionState = {
  phase: Phase;
  chunks: ChunkInfo[];
  current: number;
  /** Global time (s) on the virtual timeline. */
  time: number;
  /** Estimated total duration (s); exact once every chunk is ready. */
  duration: number;
  speed: number;
  /** Chunks ready / loading, for "Generating N of M". */
  ready: number;
  loading: boolean;
  total: number;
  /** Set when the chunk the user is waiting on failed. */
  error: { chunk: number; message: string } | null;
};

// ── Virtual timeline (pure) ────────────────────────────────────────────────

export function chunkStarts(durations: number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const d of durations) {
    out.push(acc);
    acc += d;
  }
  return out;
}

export function globalToLocal(durations: number[], t: number): { chunk: number; local: number } {
  if (durations.length === 0) return { chunk: 0, local: 0 };
  const total = durations.reduce((a, b) => a + b, 0);
  const g = Math.min(Math.max(0, t), total);
  let acc = 0;
  for (let i = 0; i < durations.length; i++) {
    const d = durations[i];
    if (g < acc + d || (i === durations.length - 1)) {
      return { chunk: i, local: Math.min(Math.max(0, g - acc), d) };
    }
    acc += d;
  }
  return { chunk: durations.length - 1, local: 0 };
}

export function localToGlobal(durations: number[], chunk: number, local: number): number {
  let acc = 0;
  for (let i = 0; i < chunk && i < durations.length; i++) acc += durations[i];
  return acc + local;
}

/** Index of the last word with start <= t that has a placed char_offset; -1 if none. */
export function activeWordIndex(words: SpeechWord[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  while (found >= 0 && words[found].char_offset == null) found--;
  return found;
}

// ── Session ────────────────────────────────────────────────────────────────

/** Max concurrent /synthesize requests (the paid engine's concurrency). */
const MAX_IN_FLIGHT = 2;

export type SessionOptions = {
  endpoint: string;
  /** Optional service mode ("default" | "fast"); omitted from the POST when empty. */
  mode?: string;
  chunks: SpeechChunk[];
  fetchImpl?: typeof fetch;
  audio?: HTMLAudioElement;
  prefetch?: number;
  pollMs?: number;
  pollTimeoutMs?: number;
  retries?: number;
};

type Internal = {
  status: ChunkStatus;
  id?: string;
  words?: SpeechWord[];
  duration: number;
  error?: string;
  attempts: number;
  abort?: AbortController;
};

// 0.1 s of silence; played inside the click so autoplay policies unlock the element.
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

const abortable = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });

export class ReadAlongSession {
  private warnedMeta = false;
  private opts: Required<Omit<SessionOptions, "audio" | "fetchImpl">> & { fetchImpl: typeof fetch };
  private audio: HTMLAudioElement;
  private ctrl = new AbortController();
  private cs: Internal[];
  private listeners = new Set<() => void>();
  private cur = 0;
  private wantPlay = false;
  private phase: Phase = "idle";
  private speed = 1;
  private loadedChunk = -1;
  private pendingSeek: number | null = null;
  private stopped = false;
  private state: SessionState;

  constructor(options: SessionOptions) {
    this.opts = {
      endpoint: options.endpoint.replace(/\/+$/, ""),
      mode: (options.mode ?? "").trim(),
      chunks: options.chunks,
      prefetch: options.prefetch ?? 1,
      pollMs: options.pollMs ?? 500,
      pollTimeoutMs: options.pollTimeoutMs ?? 10 * 60_000,
      retries: options.retries ?? 1,
      fetchImpl: options.fetchImpl ?? ((...a) => fetch(...a)),
    };
    this.audio = options.audio ?? new Audio();
    this.cs = options.chunks.map(() => ({ status: "idle", duration: 0, attempts: 0 }));
    this.state = this.compute();
    this.audio.addEventListener("ended", this.onEnded);
    this.audio.addEventListener("loadedmetadata", this.onMeta);
    this.audio.addEventListener("timeupdate", this.onTimeUpdate);
    this.audio.addEventListener("pause", this.onAudioPause);
    this.audio.addEventListener("playing", this.onAudioPlaying);
  }

  // ── public ──

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  getState(): SessionState {
    return this.state;
  }
  getChunkBase(i: number): number {
    return this.opts.chunks[i]?.base ?? 0;
  }
  getChunkText(i: number): string {
    return this.opts.chunks[i]?.text ?? "";
  }
  getWords(i: number): SpeechWord[] | undefined {
    return this.cs[i]?.words;
  }
  /** Where the audio is right now, or null if no chunk audio is loaded. */
  getPlayhead(): { chunk: number; local: number } | null {
    if (this.loadedChunk !== this.cur || this.loadedChunk < 0) return null;
    return { chunk: this.cur, local: this.audio.currentTime || 0 };
  }

  /** Must be called from a user gesture (click). */
  start(): void {
    if (this.stopped) return;
    this.wantPlay = true;
    // Unlock audio playback inside the gesture; real audio replaces it later.
    try {
      this.audio.src = SILENT_WAV;
      this.loadedChunk = -1;
      void this.audio.play()?.catch(() => {});
    } catch {
      /* jsdom / old browsers */
    }
    this.syncAudio();
  }

  play(): void {
    if (this.stopped) return;
    if (this.phase === "ended") {
      this.cur = 0;
      this.pendingSeek = 0;
      this.loadedChunk = -1;
    }
    this.wantPlay = true;
    this.syncAudio();
  }

  pause(): void {
    this.wantPlay = false;
    this.audio.pause();
    this.setPhase(this.stopped ? "stopped" : "paused");
  }

  toggle(): void {
    if (this.wantPlay) this.pause();
    else this.play();
  }

  /** Seek to a global time on the virtual timeline. */
  seek(t: number): void {
    if (this.stopped) return;
    const { chunk, local } = globalToLocal(this.durations(), t);
    this.seekChunk(chunk, local);
  }

  seekChunk(chunk: number, local: number): void {
    if (this.stopped || chunk < 0 || chunk >= this.cs.length) return;
    this.cur = chunk;
    this.pendingSeek = local;
    if (this.loadedChunk === chunk && this.cs[chunk].status === "ready") {
      this.audio.currentTime = local;
      this.pendingSeek = null;
    }
    this.syncAudio();
  }

  skip(delta: number): void {
    this.seek(this.state.time + delta);
  }

  /** Seek to the word covering a spoken-text index (from a click in the prose). */
  seekToSpoken(index: number): boolean {
    for (let i = 0; i < this.opts.chunks.length; i++) {
      const c = this.opts.chunks[i];
      if (index < c.base || index >= c.base + c.text.length) continue;
      const words = this.cs[i].words;
      if (!words) {
        this.seekChunk(i, 0);
        return true;
      }
      let target = 0;
      for (const w of words) {
        if (w.char_offset == null) continue;
        if (c.base + w.char_offset <= index) target = w.start;
        else break;
      }
      this.seekChunk(i, target + 0.001);
      return true;
    }
    return false;
  }

  setSpeed(s: number): void {
    this.speed = s;
    this.audio.playbackRate = s;
    this.emit();
  }

  retry(i: number): void {
    const c = this.cs[i];
    if (!c || c.status !== "error") return;
    c.status = "idle";
    c.attempts = 0;
    c.error = undefined;
    this.syncAudio();
  }

  skipChunk(i: number): void {
    const c = this.cs[i];
    if (!c || (c.status !== "error" && c.status !== "idle" && c.status !== "loading")) return;
    c.abort?.abort();
    c.abort = undefined;
    c.status = "skipped";
    c.duration = 0;
    c.error = undefined;
    this.syncAudio();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.wantPlay = false;
    this.ctrl.abort();
    this.audio.pause();
    this.audio.removeEventListener("ended", this.onEnded);
    this.audio.removeEventListener("loadedmetadata", this.onMeta);
    this.audio.removeEventListener("timeupdate", this.onTimeUpdate);
    this.audio.removeEventListener("pause", this.onAudioPause);
    this.audio.removeEventListener("playing", this.onAudioPlaying);
    this.audio.removeAttribute("src");
    this.loadedChunk = -1;
    for (const c of this.cs) if (c.status === "loading") c.status = "idle";
    this.phase = "stopped";
    this.emit();
  }

  // ── internals ──

  private durCache: number[] | null = null;
  private durKey: string[] = [];
  private durKeyDur: number[] = [];

  /** Cached until some chunk's status or duration changes (checked without allocating). */
  private durations(): number[] {
    const n = this.cs.length;
    let same = this.durCache !== null && this.durKey.length === n;
    for (let i = 0; same && i < n; i++) {
      if (this.durKey[i] !== this.cs[i].status || this.durKeyDur[i] !== this.cs[i].duration) same = false;
    }
    if (same) return this.durCache as number[];
    this.durKey = this.cs.map((c) => c.status);
    this.durKeyDur = this.cs.map((c) => c.duration);
    this.durCache = this.computeDurations();
    return this.durCache;
  }

  private computeDurations(): number[] {
    const known = this.cs.filter((c) => c.status === "ready" && c.duration > 0);
    let chars = 0;
    let secs = 0;
    this.cs.forEach((c, i) => {
      if (c.status === "ready" && c.duration > 0) {
        chars += this.opts.chunks[i].text.length;
        secs += c.duration;
      }
    });
    const cps = known.length && secs > 0 ? chars / secs : 15;
    return this.cs.map((c, i) =>
      c.status === "skipped" ? 0 : c.status === "ready" && c.duration > 0 ? c.duration : this.opts.chunks[i].text.length / cps,
    );
  }

  private compute(): SessionState {
    const durations = this.durations();
    const ph = this.getPlayhead();
    const local = ph ? Math.min(ph.local, durations[this.cur] ?? ph.local) : this.pendingSeek ?? 0;
    const cur = this.cs[this.cur];
    return {
      phase: this.phase,
      chunks: this.cs.map((c) => ({ status: c.status, duration: c.duration, error: c.error })),
      current: this.cur,
      time: localToGlobal(durations, this.cur, local),
      duration: durations.reduce((a, b) => a + b, 0),
      speed: this.speed,
      ready: this.cs.filter((c) => c.status === "ready").length,
      loading: this.cs.some((c) => c.status === "loading"),
      total: this.cs.length,
      error: cur?.status === "error" ? { chunk: this.cur, message: cur.error ?? "error" } : null,
    };
  }

  private emit = () => {
    this.state = this.compute();
    for (const l of [...this.listeners]) l();
  };

  private setPhase(p: Phase) {
    this.phase = p;
    this.emit();
  }

  private lastTick = 0;
  private onTimeUpdate = () => {
    const now = Date.now();
    if (now - this.lastTick < 250) return;
    this.lastTick = now;
    this.emit();
  };

  private onEnded = () => {
    if (this.loadedChunk !== this.cur) return;
    this.cur += 1;
    this.pendingSeek = 0;
    this.loadedChunk = -1;
    if (this.cur >= this.cs.length) {
      this.cur = this.cs.length - 1;
      this.wantPlay = false;
      this.setPhase("ended");
      return;
    }
    this.syncAudio();
  };

  private onMeta = () => {
    if (this.loadedChunk < 0) return;
    const d = this.audio.duration;
    if (Number.isFinite(d) && d > 0) this.cs[this.loadedChunk].duration = d;
    if (this.pendingSeek != null) {
      this.audio.currentTime = this.pendingSeek;
      this.pendingSeek = null;
    }
    this.emit();
  };

  private onAudioPause = () => {
    // Ignore pauses we cause (chunk handover, stop); a user-agent pause
    // (headset button, OS media key) flips intent.
    if (this.audio.ended || this.stopped || this.loadedChunk !== this.cur) return;
    if (this.wantPlay && this.phase === "playing") {
      this.wantPlay = false;
      this.setPhase("paused");
    }
  };
  private onAudioPlaying = () => {
    if (this.loadedChunk === this.cur && this.wantPlay) this.setPhase("playing");
  };

  /** Reconcile audio/phase with (cur, wantPlay) and top up prefetch. */
  private syncAudio(): void {
    if (this.stopped) return;
    // Skipped chunks are silent: hop over them.
    while (this.cs[this.cur]?.status === "skipped") {
      if (this.cur + 1 >= this.cs.length) {
        this.wantPlay = false;
        this.setPhase("ended");
        return;
      }
      this.cur += 1;
      this.pendingSeek = 0;
      this.loadedChunk = -1;
    }
    this.prefetch();
    const c = this.cs[this.cur];
    if (!c) return;
    if (c.status !== "ready") {
      this.audio.pause();
      this.loadedChunk = -1;
      this.setPhase(this.wantPlay || this.phase === "idle" ? "buffering" : "paused");
      return;
    }
    if (this.loadedChunk !== this.cur) {
      this.audio.src = `${this.opts.endpoint}/media/${c.id}/audio.mp3`;
      this.loadedChunk = this.cur;
      this.audio.playbackRate = this.speed;
    } else if (this.pendingSeek != null) {
      this.audio.currentTime = this.pendingSeek;
      this.pendingSeek = null;
    }
    if (this.wantPlay) {
      void this.audio.play()?.catch(() => {
        if (this.stopped) return;
        this.wantPlay = false;
        this.setPhase("paused");
      });
      this.setPhase("playing");
    } else {
      this.setPhase("paused");
    }
  }

  /**
   * Keep the current chunk plus `prefetch` (default 1) ahead loading, never more than
   * MAX_IN_FLIGHT requests at once (the paid engine allows 2 concurrent). Loads left
   * over from before a seek, outside the window, are aborted to free a slot.
   */
  private prefetch(): void {
    const end = Math.min(this.cs.length - 1, this.cur + this.opts.prefetch);
    for (let i = 0; i < this.cs.length; i++) {
      const c = this.cs[i];
      if ((i < this.cur || i > end) && c.status === "loading") {
        c.abort?.abort();
        c.abort = undefined;
        c.status = "idle";
        c.attempts = 0;
      }
    }
    let inFlight = this.runs.size;
    for (let i = this.cur; i <= end && inFlight < MAX_IN_FLIGHT; i++) {
      if (this.cs[i].status === "idle") {
        inFlight++;
        void this.load(i);
      }
    }
  }

  /** Runs whose fetch has not yet settled, including aborted ones still counted against the cap. */
  private runs = new Set<AbortController>();

  private async load(i: number): Promise<void> {
    const chunkCtrl = new AbortController();
    const onSessionAbort = () => chunkCtrl.abort();
    this.ctrl.signal.addEventListener("abort", onSessionAbort, { once: true });
    this.runs.add(chunkCtrl);
    try {
      await this.runLoad(i, chunkCtrl);
    } finally {
      this.ctrl.signal.removeEventListener("abort", onSessionAbort);
      this.runs.delete(chunkCtrl);
      // An aborted run freed its slot only now; pump any queued chunk.
      if (chunkCtrl.signal.aborted && !this.stopped) this.syncAudio();
    }
  }

  private async runLoad(i: number, chunkCtrl: AbortController): Promise<void> {
    const c = this.cs[i];
    c.status = "loading";
    this.emit();
    c.abort = chunkCtrl;
    const signal = chunkCtrl.signal;
    for (;;) {
      c.attempts += 1;
      try {
        const res = await this.synthesize(this.opts.chunks[i].text, signal);
        if (this.stopped || signal.aborted || c.abort !== chunkCtrl || c.status !== "loading") return;
        c.id = res.id;
        c.words = res.words;
        const last = res.words[res.words.length - 1];
        c.duration = last ? last.end : 0;
        c.status = "ready";
        break;
      } catch (e) {
        if (this.stopped || signal.aborted || c.abort !== chunkCtrl || c.status !== "loading") return;
        if (c.attempts <= this.opts.retries) {
          try {
            await abortable(250 * c.attempts, signal);
          } catch {
            return;
          }
          continue;
        }
        c.status = "error";
        c.error = e instanceof Error ? e.message : String(e);
        break;
      }
    }
    if (i === this.cur || c.status === "ready") this.syncAudio();
    else this.emit();
  }

  private async json(url: string, init: RequestInit): Promise<{ status: number; body: any }> {
    const r = await this.opts.fetchImpl(url, init);
    if (!r.ok && r.status !== 202) throw new Error(`speech service ${r.status}`);
    return { status: r.status, body: await r.json() };
  }

  private async synthesize(text: string, signal: AbortSignal): Promise<{ id: string; words: SpeechWord[] }> {
    const ep = this.opts.endpoint;
    // Only text (+ optional mode): engine/voice are the service's decision.
    const first = await this.json(`${ep}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(this.opts.mode ? { text, mode: this.opts.mode } : { text }),
      signal,
    });
    let item = first.body;
    let envelope = first.body;
    if (first.status === 202) {
      const jobUrl = this.jobUrl(item);
      const deadline = Date.now() + this.opts.pollTimeoutMs;
      for (;;) {
        await abortable(this.opts.pollMs, signal);
        const { body } = await this.json(jobUrl, { signal });
        if (body.status === "complete") {
          envelope = body;
          item = body.result ?? {};
          break;
        }
        if (body.status === "error") throw new Error(String(body.error ?? "synthesis failed"));
        if (Date.now() > deadline) throw new Error("speech job timed out");
      }
    }
    if (!item || typeof item.id !== "string") throw new Error("speech service returned no item id");
    let words: SpeechWord[] | undefined = Array.isArray(item.words) ? item.words : undefined;
    if (!words) {
      const w = await this.json(`${ep}/media/${item.id}/words.json`, { signal });
      words = Array.isArray(w.body) ? w.body : w.body?.words;
    }
    // apl reports mode/fallback_reason at the TOP level of an inline response (a 202
    // job's result does not carry them); meta is a harmless fallback.
    this.noteMeta(first.body, item, envelope, item?.meta, envelope?.meta);
    if (!words) {
      console.warn(`read-along: no word timings for item ${item.id}; highlight disabled`);
    }
    return { id: item.id, words: words ?? [] };
  }

  /** Log a service fallback indicator (fallback_reason / mode) once per session. */
  private noteMeta(...sources: any[]): void {
    if (this.warnedMeta) return;
    const src = sources.find((m) => m && typeof m === "object" && m.fallback_reason);
    if (!src) return;
    this.warnedMeta = true;
    console.warn(`read-along: speech service fell back (mode=${src.mode ?? "?"}): ${src.fallback_reason}`);
  }

  /** status_url is an upstream path (/synthesize/jobs/<id>): re-root it under the endpoint. */
  private jobUrl(pending: any): string {
    const ep = this.opts.endpoint;
    const su = typeof pending?.status_url === "string" ? pending.status_url : "";
    if (su) {
      let path = su;
      if (/^[a-z]+:\/\//i.test(su)) {
        try {
          path = new URL(su).pathname;
        } catch {
          /* keep as is */
        }
      }
      return `${ep}${path.startsWith("/") ? "" : "/"}${path}`;
    }
    return `${ep}/synthesize/jobs/${pending?.job_id}`;
  }
}
