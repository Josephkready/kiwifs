type RefreshState = {
  loading: boolean;
  hasTree: boolean;
};

export function schedulePublishedPagesRefresh(
  state: RefreshState,
  refresh: () => void,
): (() => void) | undefined {
  if (state.loading) return undefined;
  const timer = globalThis.setTimeout(refresh, state.hasTree ? 1_500 : 0);
  return () => globalThis.clearTimeout(timer);
}
