import { useRef, useState, type KeyboardEvent } from "react";
import { Bug, Menu } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@kw/lib/cn";
import { Button } from "./ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import type { BugReportController } from "./BugReportButton";

export interface OverflowItem {
  id: string;
  label: string;
  Icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  active?: boolean;
}

/**
 * Mobile header actions behind one button. "Report a bug" is always the last
 * item and opens the same dialog as the desktop button; focus returns to this
 * button when that dialog closes.
 */
export function HeaderOverflowMenu({ items, bug }: { items: OverflowItem[]; bug: BugReportController }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const handoff = useRef(false);

  const select = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? []);
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const move = (n: number) => {
      e.preventDefault();
      els[(n + els.length) % els.length].focus();
    };
    if (e.key === "ArrowDown") move(i + 1);
    else if (e.key === "ArrowUp") move(i < 0 ? els.length - 1 : i - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(els.length - 1);
  };

  const itemClass =
    "flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent focus:bg-accent focus:outline-none disabled:opacity-50";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <Menu className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-56 p-1"
        role="menu"
        aria-label="More actions"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          listRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
        }}
        onCloseAutoFocus={(e) => {
          // The bug dialog places focus itself and returns it to the hamburger on close.
          if (handoff.current) {
            e.preventDefault();
            handoff.current = false;
          }
        }}
        onKeyDown={onKeyDown}
      >
        <div ref={listRef}>
          {items.map(({ id, label, Icon, onSelect, disabled, active }) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              disabled={disabled}
              className={cn(itemClass, active && "bg-accent")}
              onClick={() => select(onSelect)}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span>{label}</span>
            </button>
          ))}
          {bug.available && (
            <button
              type="button"
              role="menuitem"
              data-feature="header.bug"
              aria-haspopup="dialog"
              className={itemClass}
              onPointerDown={bug.captureSelection}
              onClick={() =>
                select(() => {
                  handoff.current = true;
                  bug.openDialog(triggerRef);
                })
              }
            >
              <Bug className="h-4 w-4 shrink-0" />
              <span>Report a bug</span>
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
