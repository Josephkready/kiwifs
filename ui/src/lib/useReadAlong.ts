import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ReadAlongSession, type SessionState } from "./readAlongSession";
import { createSpeechHighlighter, type SpeechHighlighter } from "./speechHighlight";
import { chunkSpeech, extractSpeech } from "./speechText";

export const MAX_CHUNK_CHARS = 1000;
/** First chunk is short so playback starts after one small synth, not a ~1000-char one. */
export const FIRST_CHUNK_CHARS = 200;

export type ReadAlong = {
  session: ReadAlongSession | null;
  state: SessionState | null;
  /** Nothing speakable on the page. */
  empty: boolean;
  start: () => void;
  stop: () => void;
};

/** True when two states differ only in the fast-changing clock fields (time/duration). */
function sameCoarse(a: SessionState | null, b: SessionState): boolean {
  if (!a) return false;
  return (
    a.phase === b.phase &&
    a.current === b.current &&
    a.speed === b.speed &&
    a.ready === b.ready &&
    a.loading === b.loading &&
    a.total === b.total &&
    a.error?.chunk === b.error?.chunk &&
    a.error?.message === b.error?.message &&
    a.chunks.length === b.chunks.length &&
    a.chunks.every((c, i) => c.status === b.chunks[i].status)
  );
}

/** Owns one read-along session for the prose in `proseRef`; torn down when `resetKey` changes. */
export function useReadAlong(proseRef: RefObject<HTMLElement | null>, endpoint: string, mode: string, resetKey: string): ReadAlong {
  const [session, setSession] = useState<ReadAlongSession | null>(null);
  const [state, setState] = useState<SessionState | null>(null);
  const [empty, setEmpty] = useState(false);
  const live = useRef<{ s: ReadAlongSession; h: SpeechHighlighter; unsub: () => void } | null>(null);

  const stop = useCallback(() => {
    const l = live.current;
    if (!l) return;
    live.current = null;
    l.unsub();
    l.h.destroy();
    l.s.stop();
    setSession(null);
    setState(null);
  }, []);

  const start = useCallback(() => {
    const root = proseRef.current;
    if (!root) return;
    stop();
    const doc = extractSpeech(root);
    const chunks = chunkSpeech(doc, MAX_CHUNK_CHARS, FIRST_CHUNK_CHARS);
    if (chunks.length === 0) {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    const s = new ReadAlongSession({ endpoint, mode, chunks });
    const h = createSpeechHighlighter({ root, doc, source: s });
    // Clock ticks (time/duration) are consumed by ReadAlongBar via the session
    // directly, so they must not re-render the host page.
    const unsub = s.subscribe(() => {
      const next = s.getState();
      setState((prev) => (sameCoarse(prev, next) ? prev : next));
    });
    live.current = { s, h, unsub };
    setSession(s);
    setState(s.getState());
    s.start();
  }, [proseRef, endpoint, mode, stop]);

  useEffect(() => () => stop(), [resetKey, stop]);
  useEffect(() => {
    setEmpty(false);
  }, [resetKey]);

  return { session, state, empty, start, stop };
}
