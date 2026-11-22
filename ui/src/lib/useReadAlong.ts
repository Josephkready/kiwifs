import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { ReadAlongSession, type SessionState } from "./readAlongSession";
import { createSpeechHighlighter, type SpeechHighlighter } from "./speechHighlight";
import { chunkSpeech, extractSpeech } from "./speechText";

export const MAX_CHUNK_CHARS = 1000;

export type ReadAlong = {
  session: ReadAlongSession | null;
  state: SessionState | null;
  /** Nothing speakable on the page. */
  empty: boolean;
  start: () => void;
  stop: () => void;
};

/** Owns one read-along session for the prose in `proseRef`; torn down when `resetKey` changes. */
export function useReadAlong(proseRef: RefObject<HTMLElement | null>, endpoint: string, resetKey: string): ReadAlong {
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
    const chunks = chunkSpeech(doc, MAX_CHUNK_CHARS);
    if (chunks.length === 0) {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    const s = new ReadAlongSession({ endpoint, chunks });
    const h = createSpeechHighlighter({ root, doc, source: s });
    const unsub = s.subscribe(() => setState(s.getState()));
    live.current = { s, h, unsub };
    setSession(s);
    setState(s.getState());
    s.start();
  }, [proseRef, endpoint, stop]);

  useEffect(() => () => stop(), [resetKey, stop]);
  useEffect(() => {
    setEmpty(false);
  }, [resetKey]);

  return { session, state, empty, start, stop };
}
