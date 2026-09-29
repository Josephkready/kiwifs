/** Ellipsize `label` to fit `maxWidth`, using `measure` (e.g. a canvas
 * `ctx.measureText(s).width`) to size candidate substrings. Returns the
 * label unchanged if it already fits. */
export function truncateLabel(
  label: string,
  maxWidth: number,
  measure: (s: string) => number,
): string {
  if (maxWidth <= 0 || measure(label) <= maxWidth) return label;

  const ellipsis = "…";
  if (measure(ellipsis) > maxWidth) return ellipsis;

  let lo = 0;
  let hi = label.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(label.slice(0, mid) + ellipsis) <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo === 0 ? ellipsis : label.slice(0, lo) + ellipsis;
}
