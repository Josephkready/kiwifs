import { describe, expect, it } from "vitest";
import {
  computeSearchDialogMaxHeight,
  computeSearchListMaxHeight,
  getVisualViewportHeight,
  isCoarsePointer,
} from "./viewportKeyboard";

describe("getVisualViewportHeight", () => {
  it("prefers visualViewport.height when present", () => {
    expect(getVisualViewportHeight({ innerHeight: 844, visualViewport: { height: 508 } })).toBe(508);
  });

  it("falls back to innerHeight when visualViewport is unavailable", () => {
    expect(getVisualViewportHeight({ innerHeight: 844, visualViewport: null })).toBe(844);
    expect(getVisualViewportHeight({ innerHeight: 844 })).toBe(844);
  });
});

describe("isCoarsePointer", () => {
  it("reflects matchMedia(pointer: coarse)", () => {
    const coarse = { innerHeight: 0, matchMedia: () => ({ matches: true }) };
    const fine = { innerHeight: 0, matchMedia: () => ({ matches: false }) };
    expect(isCoarsePointer(coarse)).toBe(true);
    expect(isCoarsePointer(fine)).toBe(false);
  });

  it("defaults to false when matchMedia is unavailable (e.g. SSR/tests)", () => {
    expect(isCoarsePointer({ innerHeight: 0 })).toBe(false);
  });
});

describe("computeSearchListMaxHeight", () => {
  it("returns the desktop cap unchanged on non-touch devices", () => {
    const h = computeSearchListMaxHeight({
      viewportHeight: 1000,
      chromeAboveList: 400,
      chromeBelowList: 100,
      isCoarse: false,
    });
    expect(h).toBe(400);
  });

  it("iPhone 13 Pro: keyboard up (vvh 508) still leaves the last result reachable", () => {
    // Matches the bug-report measurements: 390x844 viewport, keyboard
    // shrinks visualViewport.height to 508. chromeAboveList/Below are the
    // measured heights of the search-input row + filter-chip row (above)
    // and the hint footer, which is hidden on touch (0).
    const listMaxHeight = computeSearchListMaxHeight({
      viewportHeight: 508,
      chromeAboveList: 96,
      chromeBelowList: 0,
      isCoarse: true,
    });
    const dialogMaxHeight = computeSearchDialogMaxHeight({ viewportHeight: 508, isCoarse: true });
    expect(dialogMaxHeight).toBeDefined();
    // The dialog is anchored to the top of the visual viewport (not the
    // layout viewport), so topInset(16) + chromeAboveList + listMaxHeight
    // must fit within the keyboard-shrunk visual viewport.
    const listBottom = 16 + 96 + listMaxHeight;
    expect(listBottom).toBeLessThanOrEqual(508);
  });

  it("iPad Pro 11: keyboard up (vvh 834) leaves headroom, never below the desktop cap floor", () => {
    const listMaxHeight = computeSearchListMaxHeight({
      viewportHeight: 834,
      chromeAboveList: 96,
      chromeBelowList: 0,
      isCoarse: true,
    });
    const iPhoneListMaxHeight = computeSearchListMaxHeight({
      viewportHeight: 508,
      chromeAboveList: 96,
      chromeBelowList: 0,
      isCoarse: true,
    });
    expect(listMaxHeight).toBeGreaterThan(iPhoneListMaxHeight); // more headroom than the iPhone case
    const listBottom = 16 + 96 + listMaxHeight;
    expect(listBottom).toBeLessThanOrEqual(834);
  });

  it("never collapses the list below the floor even with huge chrome", () => {
    const h = computeSearchListMaxHeight({
      viewportHeight: 300,
      chromeAboveList: 280,
      chromeBelowList: 50,
      isCoarse: true,
      minListHeight: 80,
    });
    expect(h).toBe(80);
  });
});

describe("computeSearchDialogMaxHeight", () => {
  it("returns undefined on non-touch devices (desktop CSS untouched)", () => {
    expect(computeSearchDialogMaxHeight({ viewportHeight: 1080, isCoarse: false })).toBeUndefined();
  });

  it("anchors within the shrunk visual viewport on touch devices", () => {
    const h = computeSearchDialogMaxHeight({ viewportHeight: 508, isCoarse: true, topInset: 16 });
    expect(h).toBe(508 - 32);
  });

  it("never collapses below the floor", () => {
    const h = computeSearchDialogMaxHeight({
      viewportHeight: 100,
      isCoarse: true,
      topInset: 16,
      minDialogHeight: 160,
    });
    expect(h).toBe(160);
  });
});
