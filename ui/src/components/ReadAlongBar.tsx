import { useSyncExternalStore } from "react";
import { Pause, Play, RotateCcw, RotateCw, SkipForward, X } from "lucide-react";
import { Button } from "@kw/components/ui/button";
import { SPEEDS } from "@kw/lib/readAlongSession";
import type { ReadAlong } from "@kw/lib/useReadAlong";

export function formatClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Sticky bottom transport bar for an active read-along session. */
export function ReadAlongBar({ readAlong }: { readAlong: ReadAlong }) {
  const { session, state, stop } = readAlong;
  if (!session || !state) return null;
  return <ReadAlongBarInner session={session} stop={stop} />;
}

function ReadAlongBarInner({ session, stop }: { session: NonNullable<ReadAlong["session"]>; stop: () => void }) {
  // Subscribe to the session directly so clock ticks re-render only this bar.
  const state = useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.getState(),
  );

  const playing = state.phase === "playing";
  const nextSpeed = SPEEDS[(SPEEDS.indexOf(state.speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length];
  const status = state.error
    ? "Speech chunk failed"
    : state.loading
      ? `Generating ${Math.min(state.ready + 1, state.total)} of ${state.total}`
      : state.phase === "ended"
        ? "Finished"
        : `${formatClock(state.time)} / ${formatClock(state.duration)}`;

  return (
    <div
      role="region"
      aria-label="Read-along controls"
      data-testid="read-along-bar"
      className="sticky bottom-0 z-30 border-t border-border bg-background/95 backdrop-blur px-3 py-2 flex items-center gap-2"
    >
      <Button variant="ghost" size="icon" aria-label="Back 10 seconds" onClick={() => session.skip(-10)}>
        <RotateCcw className="h-4 w-4" />
      </Button>
      <Button variant="outline" size="icon" aria-label={playing ? "Pause" : "Play"} onClick={() => session.toggle()}>
        {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
      </Button>
      <Button variant="ghost" size="icon" aria-label="Forward 10 seconds" onClick={() => session.skip(10)}>
        <RotateCw className="h-4 w-4" />
      </Button>
      <input
        type="range"
        aria-label="Seek"
        className="flex-1 min-w-0 accent-primary"
        min={0}
        max={Math.max(1, Math.round(state.duration))}
        step={1}
        value={Math.round(state.time)}
        onChange={(e) => session.seek(Number(e.target.value))}
      />
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap" aria-live="polite">
        {status}
      </span>
      {state.error && (
        <>
          <Button variant="outline" size="sm" onClick={() => session.retry(state.error!.chunk)}>
            Retry
          </Button>
          <Button variant="ghost" size="sm" onClick={() => session.skipChunk(state.error!.chunk)}>
            <SkipForward className="h-3.5 w-3.5" /> Skip
          </Button>
        </>
      )}
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Speed ${state.speed}x, change to ${nextSpeed}x`}
        onClick={() => session.setSpeed(nextSpeed)}
        className="tabular-nums"
      >
        {state.speed}×
      </Button>
      <Button variant="ghost" size="icon" aria-label="Close read-along" onClick={stop}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
