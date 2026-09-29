import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression test for a long unbroken URL (e.g. in a note's "Rollback" section)
// overflowing the right edge of the article column on narrow/tablet viewports
// (caught by vdebug at the ipad-pro-11 viewport). Prose text must wrap; tables
// and code blocks must keep scrolling horizontally by design.
const cssPath = fileURLToPath(new URL("./index.css", import.meta.url));
const css = readFileSync(cssPath, "utf-8");

function ruleBodyFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`selector not found in index.css: ${selector}`);
  return match[1];
}

describe("kiwi-prose long-URL wrapping", () => {
  it.each([".kiwi-prose p", ".kiwi-prose a", ".kiwi-prose li", ".kiwi-prose blockquote", ".kiwi-prose dd"])(
    "%s allows breaking a long unbroken run of text (overflow-wrap: anywhere)",
    (selector) => {
      expect(ruleBodyFor(selector)).toMatch(/overflow-wrap:\s*anywhere/);
    },
  );

  it.each([".kiwi-prose code", ".kiwi-prose pre", ".kiwi-prose pre code"])(
    "%s is left alone so code keeps scrolling horizontally by design",
    (selector) => {
      expect(ruleBodyFor(selector)).not.toMatch(/overflow-wrap/);
    },
  );

  it("table/table-wrapper cells are left alone so wide tables keep scrolling horizontally by design", () => {
    for (const selector of [".kiwi-prose th,\n.kiwi-prose td", ".kiwi-table-wrapper th,\n.kiwi-table-wrapper td"]) {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\n/g, "\\s*\\n\\s*");
      const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
      expect(match).not.toBeNull();
      expect(match![1]).not.toMatch(/overflow-wrap/);
    }
  });
});
