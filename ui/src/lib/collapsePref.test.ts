import { beforeEach, describe, expect, it } from "vitest";
import { readCollapsePref, writeCollapsePref } from "./collapsePref";

/** Minimal localStorage stand-in — these tests run in the node environment. */
function stubStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("collapsePref", () => {
  beforeEach(() => {
    globalThis.localStorage = stubStorage();
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
    globalThis.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;

    expect(readCollapsePref("properties", false)).toBe(true);
    expect(() => writeCollapsePref("properties", true)).not.toThrow();
  });
});
