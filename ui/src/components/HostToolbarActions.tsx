import { useEffect, useState } from "react";
import * as LucideIcons from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@kw/lib/cn";
import { Button } from "./ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "./ui/tooltip";
import {
  dispatchToolbarAction,
  getToolbarActions,
  KIWI_TOOLBAR_STATE_EVENT,
  type KiwiToolbarActionState,
  type ToolbarStateEvent,
} from "../lib/hostConfig";

export function resolveLucideIcon(name: string): LucideIcon {
  const icons = LucideIcons as unknown as Record<string, LucideIcon | undefined>;
  return icons[name] ?? LucideIcons.CircleHelp;
}

function HostToolbarButton({
  action,
  state,
}: {
  action: { id: string; icon: string; label: string; disabled?: boolean };
  state?: KiwiToolbarActionState;
}) {
  const Icon = resolveLucideIcon(action.icon);
  const disabled = action.disabled || state?.disabled;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "h-8 w-8",
            state?.active && "bg-accent text-accent-foreground",
          )}
          aria-label={action.label}
          aria-pressed={state?.active || undefined}
          disabled={disabled}
          onClick={() => dispatchToolbarAction(action.id)}
        >
          <Icon className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{action.label}</TooltipContent>
    </Tooltip>
  );
}

export interface HostToolbarItem {
  id: string;
  label: string;
  Icon: LucideIcon;
  disabled: boolean;
  active: boolean;
  onSelect: () => void;
}

/** Host toolbar actions as plain data, for surfaces that render them as menu items. */
export function useHostToolbarItems(): HostToolbarItem[] {
  const actions = getToolbarActions();
  const [states, setStates] = useState<Record<string, KiwiToolbarActionState>>({});
  useEffect(() => {
    const onState = (event: Event) => {
      const detail = (event as ToolbarStateEvent).detail;
      if (detail && typeof detail === "object") setStates(detail);
    };
    window.addEventListener(KIWI_TOOLBAR_STATE_EVENT, onState);
    return () => window.removeEventListener(KIWI_TOOLBAR_STATE_EVENT, onState);
  }, []);
  return actions.map((a) => ({
    id: a.id,
    label: a.label,
    Icon: resolveLucideIcon(a.icon),
    disabled: Boolean(a.disabled || states[a.id]?.disabled),
    active: Boolean(states[a.id]?.active),
    onSelect: () => dispatchToolbarAction(a.id),
  }));
}

/** Renders host-configured header toolbar icons (same chrome as built-in tools). */
export function HostToolbarActions() {
  const actions = getToolbarActions();
  const [states, setStates] = useState<Record<string, KiwiToolbarActionState>>({});

  useEffect(() => {
    const onState = (event: Event) => {
      const detail = (event as ToolbarStateEvent).detail;
      if (detail && typeof detail === "object") {
        setStates(detail);
      }
    };
    window.addEventListener(KIWI_TOOLBAR_STATE_EVENT, onState);
    return () => window.removeEventListener(KIWI_TOOLBAR_STATE_EVENT, onState);
  }, []);

  if (actions.length === 0) return null;

  return (
    <>
      {actions.map((action) => (
        <HostToolbarButton
          key={action.id}
          action={action}
          state={states[action.id]}
        />
      ))}
    </>
  );
}
