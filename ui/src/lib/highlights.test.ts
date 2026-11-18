import { describe, expect, it } from "vitest";
import { hitTest, locateAnchor } from "./highlights";

describe("locateAnchor", () => {
  it("uses prefix/suffix to pick the right repeat of a quote", () => {
    const text = "dante is up. dante is down.";
    expect(locateAnchor(text, { quote: "dante", prefix: "up. ", suffix: " is down" })).toEqual({
      index: 13,
      length: 5,
    });
  });

  it("falls back to the bare quote when the context drifted", () => {
    expect(locateAnchor("abc nvcc def", { quote: "nvcc", prefix: "zzz" })).toEqual({ index: 4, length: 4 });
  });

  it("returns null when the quote is gone", () => {
    expect(locateAnchor("abc", { quote: "xyz" })).toBeNull();
  });
});

describe("hitTest", () => {
  const rect = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
  const entries = [
    { id: "a", rects: [rect(0, 0, 10, 10)] },
    // A comment that wraps across two lines has two client rects.
    { id: "b", rects: [rect(50, 0, 100, 10), rect(0, 20, 30, 30)] },
  ];

  it("maps a point on the second line of a wrapped highlight to its comment", () => {
    const hit = hitTest(entries, 15, 25);
    expect(hit?.entry.id).toBe("b");
    expect(hit?.rect).toEqual(rect(0, 20, 30, 30));
  });

  it("returns null for a point outside every highlight", () => {
    expect(hitTest(entries, 40, 5)).toBeNull();
  });
});
