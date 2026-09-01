import { describe, expect, it } from "vitest";
import {
  COMMENT_EVENTS,
  PAGE_REFRESH_EVENTS,
  classifySSEEvent,
} from "./sseEvents";

describe("sseEvents", () => {
  it("classifies content/tree mutations as page refreshes", () => {
    expect(classifySSEEvent("write")).toBe("page");
    expect(classifySSEEvent("delete")).toBe("page");
    expect(classifySSEEvent("bulk")).toBe("page");
  });

  it("classifies comment events as comment-only refreshes", () => {
    expect(classifySSEEvent("comment.add")).toBe("comment");
    expect(classifySSEEvent("comment.delete")).toBe("comment");
    expect(classifySSEEvent("comment.resolve")).toBe("comment");
  });

  it("treats unknown events as other (ignored, never a page reload)", () => {
    expect(classifySSEEvent("heartbeat")).toBe("other");
    expect(classifySSEEvent("")).toBe("other");
  });

  // The whole point of the split: a comment must NEVER trigger a page-wide
  // refresh. If someone later adds a comment event to PAGE_REFRESH_EVENTS (or
  // renames one so it collides), posting a comment reloads the note again.
  it("keeps comment events out of the page-refresh set", () => {
    for (const name of COMMENT_EVENTS) {
      expect(PAGE_REFRESH_EVENTS as readonly string[]).not.toContain(name);
      expect(classifySSEEvent(name)).toBe("comment");
    }
  });

  it("has no overlap between the two sets", () => {
    const page = new Set<string>(PAGE_REFRESH_EVENTS);
    const overlap = COMMENT_EVENTS.filter((n) => page.has(n));
    expect(overlap).toEqual([]);
  });
});
