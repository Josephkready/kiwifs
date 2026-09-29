import { describe, expect, it } from "vitest";
import { truncateLabel } from "./graphLabel";

// Deterministic stand-in for ctx.measureText(s).width: fixed-width font.
const measure = (s: string) => s.length * 6;

describe("truncateLabel", () => {
  it("returns the label unchanged when it fits", () => {
    expect(truncateLabel("short", 100, measure)).toBe("short");
  });

  it("truncates with an ellipsis when it overflows", () => {
    const label = "a-very-long-node-title-that-does-not-fit-the-graph";
    const result = truncateLabel(label, 60, measure);
    expect(result.endsWith("…")).toBe(true);
    expect(measure(result)).toBeLessThanOrEqual(60);
    expect(result.length).toBeLessThan(label.length);
  });

  it("falls back to a bare ellipsis when even one char cannot fit", () => {
    expect(truncateLabel("hello", 5, measure)).toBe("…");
  });

  it("is a no-op for a non-positive max width", () => {
    expect(truncateLabel("hello", 0, measure)).toBe("hello");
  });
});
