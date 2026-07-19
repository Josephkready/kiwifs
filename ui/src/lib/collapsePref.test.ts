import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCollapsePref, writeCollapsePref } from "./collapsePref";

describe("collapsePref", () => {
  beforeEach(() => {
    // These tests run in the node environment — no localStorage unless stubbed.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, val: string) => {
        store.set(key, val);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to collapsed when the section is not open by default", () => {
    expect(readCollapsePref("properties", false)).toBe(true);
  });

  it("defaults to expanded when the section is open by default", () => {
    expect(readCollapsePref("backlinks", true)).toBe(false);
  });

  it("lets a stored value win over the default", () => {
    writeCollapsePref("properties", false);
    expect(readCollapsePref("properties", false)).toBe(false);

    writeCollapsePref("backlinks", true);
    expect(readCollapsePref("backlinks", true)).toBe(true);
  });

  it("namespaces keys under kiwifs-", () => {
    writeCollapsePref("properties", true);
    expect(localStorage.getItem("kiwifs-properties")).toBe("1");
  });

  it("keeps sections independent", () => {
    writeCollapsePref("properties", false);
    expect(readCollapsePref("comments", false)).toBe(true);
  });

  it("falls back to the default when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });

    expect(readCollapsePref("properties", false)).toBe(true);
    expect(() => writeCollapsePref("properties", true)).not.toThrow();
  });
});
