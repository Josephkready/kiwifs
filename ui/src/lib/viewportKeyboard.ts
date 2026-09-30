/**
 * Helpers for keeping fixed/centered overlays (the search dialog, in
 * particular) inside the *visual* viewport while an on-screen keyboard is
 * up. On iOS/Android, focusing a text input shrinks
 * `window.visualViewport.height` but leaves `window.innerHeight` (the
 * layout viewport) unchanged, so a dialog sized/centered against the
 * layout viewport ends up partly or fully hidden behind the keyboard.
 *
 * These are pure functions so the geometry can be unit-tested without a
 * real browser; the React hooks in `hooks/useVisualViewportHeight.ts` and
 * `hooks/useCoarsePointer.ts` are the thin, untestable wiring around them.
 */

/** Minimal shape of `window` these helpers need — lets tests pass a fake. */
export type ViewportLike = {
  innerHeight: number;
  visualViewport?: { height: number } | null;
  matchMedia?: (query: string) => { matches: boolean };
};

/** The visual viewport's height, falling back to the layout viewport. */
export function getVisualViewportHeight(win: ViewportLike): number {
  return win.visualViewport?.height ?? win.innerHeight;
}

/** Whether the primary pointer is coarse (touch) rather than fine (mouse/trackpad). */
export function isCoarsePointer(win: ViewportLike): boolean {
  return win.matchMedia?.("(pointer: coarse)").matches ?? false;
}

export type SearchListHeightParams = {
  /** Current `visualViewport.height` (or layout height as a fallback). */
  viewportHeight: number;
  /** Measured height (px) of everything in the dialog above the results list. */
  chromeAboveList: number;
  /** Measured height (px) of everything in the dialog below the results list. */
  chromeBelowList: number;
  /** Whether the primary pointer is coarse (touch). */
  isCoarse: boolean;
  /** Floor so the list never collapses to nothing. Default 80px. */
  minListHeight?: number;
  /** Cap used on non-touch devices, matching the dialog's original static max-height. */
  desktopMaxHeight?: number;
  /** Gap kept between the dialog and the top/bottom of the visual viewport
   * — must match the inset used by `computeSearchDialogMaxHeight` so the
   * list's bottom lines up with the dialog's own bottom edge. */
  topInset?: number;
};

/**
 * The results list's max-height. On touch devices this shrinks to fit
 * whatever visual-viewport space remains inside the (top-anchored,
 * height-capped) dialog once the search input row and any filter
 * chips/footer above/below the list are accounted for — so the last
 * result can always be scrolled into view above the keyboard. On
 * non-touch devices it returns the original fixed desktop cap unchanged.
 */
export function computeSearchListMaxHeight(params: SearchListHeightParams): number {
  const {
    viewportHeight,
    chromeAboveList,
    chromeBelowList,
    isCoarse,
    minListHeight = 80,
    desktopMaxHeight = 400,
    topInset = 16,
  } = params;
  if (!isCoarse) return desktopMaxHeight;
  const dialogHeight = Math.max(0, viewportHeight - topInset * 2);
  const available = dialogHeight - chromeAboveList - chromeBelowList;
  return Math.max(minListHeight, available);
}

export type SearchDialogHeightParams = {
  /** Current `visualViewport.height` (or layout height as a fallback). */
  viewportHeight: number;
  /** Whether the primary pointer is coarse (touch). */
  isCoarse: boolean;
  /** Gap kept between the dialog and the top/bottom of the visual viewport. */
  topInset?: number;
  /** Floor so the dialog never collapses to nothing. Default 160px. */
  minDialogHeight?: number;
};

/**
 * The dialog's own max-height. `undefined` on non-touch devices means
 * "don't override the desktop CSS at all". On touch devices it's anchored
 * near the top of the visual viewport (not the layout viewport), so it
 * never overlaps the keyboard.
 */
export function computeSearchDialogMaxHeight(
  params: SearchDialogHeightParams,
): number | undefined {
  const { viewportHeight, isCoarse, topInset = 16, minDialogHeight = 160 } = params;
  if (!isCoarse) return undefined;
  return Math.max(minDialogHeight, viewportHeight - topInset * 2);
}
