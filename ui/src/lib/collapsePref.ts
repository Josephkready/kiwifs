/** localStorage-backed collapsed/expanded state for named UI sections. */

const PREFIX = "kiwifs-";

/**
 * Resolve whether a section starts collapsed. A stored value always wins;
 * otherwise fall back to the section's default open state.
 */
export function readCollapsePref(storageKey: string, defaultOpen: boolean): boolean {
  try {
    const stored = localStorage.getItem(PREFIX + storageKey);
    if (stored !== null) return stored === "1";
  } catch {
    /* ignore */
  }
  return !defaultOpen;
}

/** Persist a section's collapsed state. Failures (private mode, quota) are ignored. */
export function writeCollapsePref(storageKey: string, collapsed: boolean): void {
  try {
    localStorage.setItem(PREFIX + storageKey, collapsed ? "1" : "0");
  } catch {
    /* ignore */
  }
}
