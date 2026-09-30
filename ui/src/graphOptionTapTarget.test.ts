import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression test: the knowledge-graph toolbar's three option checkboxes
// ("Size by PageRank", "Color by community", "Show links") are enabled
// controls. vdebug's small-tap-target check measures the `<input>` element's
// own layout box (not the enclosing <label>), and `accent-primary h-3 w-3`
// rendered a real 12x12px box — under the 24x24 WCAG 2.2 touch-target
// minimum on iphone-13-pro / ipad-pro-11. Padding-based hit-area tricks don't
// work here: browsers ignore `padding` on native `<input type="checkbox">`
// layout, so the fix sizes the checkbox itself to `h-6 w-6` (24x24px, the
// same height as the sibling Select/Button controls in this toolbar). The
// label also gets a `min-h-6` floor so its own clickable area matches.
const graphPath = fileURLToPath(new URL("./components/KiwiGraph.tsx", import.meta.url));
const source = readFileSync(graphPath, "utf-8");

const optionLabels = [
  { input: "sizeByPageRank", text: "Size by PageRank" },
  { input: "colorByCommunity", text: "Color by community" },
  { input: "showLinks", text: "Show links" },
];

function findOption(inputVar: string, text: string): { labelClass: string; inputClass: string } {
  const re = new RegExp(
    `<label className="([^"]*)">\\s*<input\\s+type="checkbox"\\s+checked={${inputVar}}[\\s\\S]*?className="([^"]*)"\\s*/>\\s*${text}`,
  );
  const match = source.match(re);
  expect(match, `option "${text}" not found in KiwiGraph.tsx`).not.toBeNull();
  return { labelClass: match![1], inputClass: match![2] };
}

describe("knowledge graph option checkbox tap targets", () => {
  for (const { input, text } of optionLabels) {
    it(`"${text}" checkbox's own box is >=24x24px (h-6 w-6)`, () => {
      const { inputClass } = findOption(input, text);
      expect(inputClass).toMatch(/(^|\s)h-6(\s|$)/);
      expect(inputClass).toMatch(/(^|\s)w-6(\s|$)/);
      // The old 12px box (below WCAG's 24x24 minimum) must be gone.
      expect(inputClass).not.toMatch(/(^|\s)h-3(\s|$)/);
      expect(inputClass).not.toMatch(/(^|\s)w-3(\s|$)/);
    });

    it(`"${text}" label has a >=24px min-height floor`, () => {
      const { labelClass } = findOption(input, text);
      expect(labelClass).toMatch(/(^|\s)min-h-6(\s|$)/);
    });
  }
});
