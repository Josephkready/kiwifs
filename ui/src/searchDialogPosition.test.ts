import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression test: on touch devices the search dialog is anchored near the top
// (`.kiwi-search-dialog` inside `@media (pointer: coarse)`). Tailwind v4's
// translate-x-[-50%] / translate-y-[-50%] utilities write the standalone CSS
// `translate` property; an extra `transform: translateX(-50%)` composes with it,
// so the dialog rendered at x=-195 / y=-222 on a 390px phone (measured by vdebug).
const cssPath = fileURLToPath(new URL("./index.css", import.meta.url));
const css = readFileSync(cssPath, "utf-8");

function coarseSearchDialogRule(): string {
  const start = css.indexOf("@media (pointer: coarse)");
  expect(start).toBeGreaterThanOrEqual(0);
  const match = css.slice(start).match(/\.kiwi-search-dialog\s*\{([^}]*)\}/);
  if (!match) throw new Error(".kiwi-search-dialog rule not found in the coarse-pointer block");
  return match[1].replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("search dialog position on touch devices", () => {
  it("anchors the dialog to the top and keeps only the horizontal centring", () => {
    const body = coarseSearchDialogRule();
    expect(body).toMatch(/top:\s*16px/);
    expect(body).toMatch(/translate:\s*-50%\s+0\s*;/);
  });

  it("does not set transform, which would stack on Tailwind's translate", () => {
    expect(coarseSearchDialogRule()).not.toMatch(/(^|[^-])transform\s*:/);
  });
});
