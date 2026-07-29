import { describe, expect, it } from "vitest";
import { parseFieldFilters } from "./searchQuery";

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
