import { describe, expect, it } from "vitest";
import { withoutColorTransitions } from "./kiwiTheme";

describe("withoutColorTransitions", () => {
  it("still runs the flip when there is no document (SSR/non-browser)", () => {
    // This suite runs in a document-less (node) environment, so this also
    // covers the fallback path withoutColorTransitions falls back to when
    // `document` is unavailable.
    expect(typeof document).toBe("undefined");
    let flipped = false;
    withoutColorTransitions(() => {
      flipped = true;
    });
    expect(flipped).toBe(true);
  });
});
