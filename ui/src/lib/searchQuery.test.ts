import { describe, expect, it, vi } from "vitest";
import { executeSearch, parseFieldFilters } from "./searchQuery";

describe("parseFieldFilters", () => {
  it("maps tag syntax to exact array membership", () => {
    expect(parseFieldFilters("tag:ancestry")).toEqual({
      text: "",
      filters: [{ field: "$.tags[*]", op: "=", value: "ancestry" }],
    });
    expect(parseFieldFilters("tags:ancestry")).toEqual({
      text: "",
      filters: [{ field: "$.tags[*]", op: "=", value: "ancestry" }],
    });
  });

  it("ANDs tag membership with remaining full-text terms", () => {
    expect(parseFieldFilters("estate tag:ancestry status:published")).toEqual({
      text: "estate",
      filters: [
        { field: "$.tags[*]", op: "=", value: "ancestry" },
        { field: "$.status", op: "=", value: "published" },
      ],
    });
  });

  it("leaves malformed filters in the text query", () => {
    expect(parseFieldFilters("tag: 1tag:ancestry")).toEqual({
      text: "tag: 1tag:ancestry",
      filters: [],
    });
  });
});

describe("executeSearch", () => {
  function client() {
    return {
      meta: vi.fn().mockResolvedValue({
        count: 1,
        limit: 200,
        offset: 0,
        results: [{ path: "family.md", frontmatter: { tags: ["ancestry"] } }],
      }),
      search: vi.fn().mockResolvedValue({
        query: "estate",
        results: [
          { path: "family.md", score: 2, snippet: "family estate" },
          { path: "genetics.md", score: 3, snippet: "genetic ancestry" },
        ],
      }),
      semanticSearch: vi.fn().mockResolvedValue({
        query: "estate",
        topK: 15,
        offset: 0,
        results: [],
      }),
    };
  }

  it("sends exact tag metadata, strips it from text search, and intersects results", async () => {
    const api = client();

    const result = await executeSearch(api, "estate tag:ancestry");

    expect(api.meta).toHaveBeenCalledWith({
      where: [{ field: "$.tags[*]", op: "=", value: "ancestry" }],
      limit: 200,
    });
    expect(api.search).toHaveBeenCalledWith("estate", undefined);
    expect(api.semanticSearch).toHaveBeenCalledWith("estate", 15, 0, undefined);
    expect(result.results.map((hit) => hit.path)).toEqual(["family.md"]);
  });

  it("returns metadata-only hits without running text search", async () => {
    const api = client();

    const result = await executeSearch(api, "tag:ancestry");

    expect(api.search).not.toHaveBeenCalled();
    expect(api.semanticSearch).not.toHaveBeenCalled();
    expect(result.results).toEqual([{ path: "family.md" }]);
  });

  it("fails closed when metadata filtering fails", async () => {
    const api = client();
    api.meta.mockRejectedValue(new Error("metadata unavailable"));

    const result = await executeSearch(api, "estate tag:ancestry");

    expect(result.results).toEqual([]);
  });
});
