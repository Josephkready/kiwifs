import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FrontmatterProperties } from "./KiwiPage";

const PROPERTIES = [
  { key: "status", value: "active", kind: "text" as const },
  { key: "created", value: "2026-07-19", kind: "date" as const },
];

function stubStorage(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, val: string) => {
      store.set(key, val);
    },
  });
}

describe("FrontmatterProperties", () => {
  beforeEach(() => stubStorage());
  afterEach(() => vi.unstubAllGlobals());

  it("starts collapsed with no stored preference", () => {
    const html = renderToStaticMarkup(<FrontmatterProperties properties={PROPERTIES} />);

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Properties");
    expect(html).toContain("(2)"); // count shown only while collapsed
    expect(html).not.toContain("status");
  });

  it("starts expanded when the stored preference says so", () => {
    stubStorage({ "kiwifs-properties": "0" });

    const html = renderToStaticMarkup(<FrontmatterProperties properties={PROPERTIES} />);

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("status");
    expect(html).toContain("active");
    expect(html).not.toContain("(2)");
  });

  it("stays collapsed when the stored preference says so", () => {
    stubStorage({ "kiwifs-properties": "1" });

    const html = renderToStaticMarkup(<FrontmatterProperties properties={PROPERTIES} />);

    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("status");
  });
});
