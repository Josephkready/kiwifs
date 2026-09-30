import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression test: the search dialog's field-filter chip (e.g. `tags[*]=networking`)
// used bare `text-primary` on a `bg-primary/10` background. `--primary` is a lime
// hsl(65 80% 55%) in light mode, so lime-on-near-white measured ~1.3:1 contrast —
// far below WCAG AA's 4.5:1 for 12px text. AppSidebar.tsx and PublishButton.tsx
// already use the correct pattern for text sitting on this background:
// `text-primary-foreground` (near-black) in light mode, flipping to the lime
// `dark:text-primary` once the dark surface makes it readable again.
const searchPath = fileURLToPath(
  new URL("./components/KiwiSearch.tsx", import.meta.url),
);
const source = readFileSync(searchPath, "utf-8");

function fieldFilterChipClassName(): string {
  // The chip renders `{f.field.slice(2)}={f.value}` — match the <span> that
  // immediately precedes it.
  const match = source.match(
    /<span\s+key={i}\s+className="([^"]*)"\s*>\s*\{f\.field\.slice\(2\)\}/,
  );
  if (!match) throw new Error("field-filter chip <span> not found in KiwiSearch.tsx");
  return match[1];
}

describe("search dialog tag-filter chip contrast", () => {
  it("does not use bare light-mode text-primary on the bg-primary/10 chip", () => {
    const className = fieldFilterChipClassName();
    expect(className).toContain("bg-primary/10");
    // A bare `text-primary` (no dark: prefix immediately before it) is the
    // low-contrast bug; the fix always qualifies the lime variant with `dark:`.
    expect(className).not.toMatch(/(^|\s)text-primary(\s|$)/);
  });

  it("uses a readable foreground in light mode and the lime accent only in dark mode", () => {
    const className = fieldFilterChipClassName();
    expect(className).toMatch(/(^|\s)text-primary-foreground(\s|$)/);
    expect(className).toMatch(/(^|\s)dark:text-primary(\s|$)/);
  });
});
