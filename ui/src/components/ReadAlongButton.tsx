import { Loader2, Pause, Play, Volume2 } from "lucide-react";
import { Button } from "@kw/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@kw/components/ui/tooltip";
import { useUIConfigStore } from "@kw/lib/uiConfigStore";
import type { ReadAlong } from "@kw/lib/useReadAlong";

/** Header button that starts/pauses read-along. Renders nothing unless features.tts is on. */
export function ReadAlongButton({ readAlong }: { readAlong: ReadAlong }) {
  const enabled = useUIConfigStore((s) => s.features.tts);
  if (!enabled) return null;
  const { state, session, empty } = readAlong;

  const unavailable = !!state && state.ready === 0 && !state.loading && state.chunks[0]?.status === "error";
  const generating = !!state && state.phase === "buffering" && !unavailable;
  const playing = !!state && state.phase === "playing";

  let label = "Read aloud";
  let icon = <Volume2 className="h-3.5 w-3.5" />;
  if (empty) label = "Nothing to read on this page";
  else if (unavailable) label = "Speech service unavailable";
  else if (generating) {
    label = "Generating…";
    icon = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
  } else if (playing) {
    label = "Pause";
    icon = <Pause className="h-3.5 w-3.5" />;
  } else if (state) {
    label = "Resume";
    icon = <Play className="h-3.5 w-3.5" />;
  }

  const onClick = () => {
    if (!session || unavailable) return readAlong.start();
    session.toggle();
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          onClick={onClick}
          disabled={empty}
          aria-label={label}
          data-testid="read-along-button"
          className={unavailable ? "text-destructive" : undefined}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
