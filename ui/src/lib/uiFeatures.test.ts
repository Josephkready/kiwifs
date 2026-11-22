import { describe, expect, it } from "vitest";
import {
  DEFAULT_UI_FEATURES,
  isViewRouteAllowed,
  resolveUIFeatures,
  viewFeatureFromPathname,
} from "./uiFeatures";

describe("uiFeatures", () => {
  it("defaults all features to enabled", () => {
    expect(resolveUIFeatures()).toEqual(DEFAULT_UI_FEATURES);
  });

  it("merges partial overrides", () => {
    expect(resolveUIFeatures({ kanban: false, graph: false }).kanban).toBe(false);
    expect(resolveUIFeatures({ kanban: false }).graph).toBe(true);
    expect(resolveUIFeatures({ edit: false, history: false, publish: false }).edit).toBe(false);
    expect(resolveUIFeatures({ edit: false }).publish).toBe(true);
  });

  it("maps view routes to feature keys", () => {
    expect(viewFeatureFromPathname("/view/kanban")).toBe("kanban");
    expect(viewFeatureFromPathname("/view/data")).toBe("data_sources");
    expect(viewFeatureFromPathname("/page/foo.md")).toBeNull();
  });

  it("blocks disabled view routes", () => {
    const features = resolveUIFeatures({ kanban: false });
    expect(isViewRouteAllowed("/view/kanban", features)).toBe(false);
    expect(isViewRouteAllowed("/view/graph", features)).toBe(true);
  });
});

describe("tts flag", () => {
  it("is off by default while every other flag is on", () => {
    expect(resolveUIFeatures({}).tts).toBe(false);
    expect(resolveUIFeatures(undefined).tts).toBe(false);
    for (const [k, v] of Object.entries(DEFAULT_UI_FEATURES)) if (k !== "tts") expect(v).toBe(true);
  });
  it("turns on only when the server enables it", () => {
    expect(resolveUIFeatures({ tts: true }).tts).toBe(true);
  });
});
