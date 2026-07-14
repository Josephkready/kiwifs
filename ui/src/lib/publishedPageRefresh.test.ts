import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { schedulePublishedPagesRefresh } from "./publishedPageRefresh";

describe("schedulePublishedPagesRefresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits until after the successful tree load", () => {
    const refresh = vi.fn();
    const cleanup = schedulePublishedPagesRefresh({ loading: false, hasTree: true }, refresh);

    vi.advanceTimersByTime(1_499);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledOnce();
    cleanup?.();
  });

  it("cancels a pending refresh when the effect is replaced", () => {
    const refresh = vi.fn();
    const cleanup = schedulePublishedPagesRefresh({ loading: false, hasTree: true }, refresh);

    cleanup?.();
    vi.runAllTimers();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes immediately after a failed tree load", () => {
    const refresh = vi.fn();
    schedulePublishedPagesRefresh({ loading: false, hasTree: false }, refresh);

    vi.runAllTimers();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("does not schedule while the tree is loading", () => {
    const refresh = vi.fn();
    expect(schedulePublishedPagesRefresh({ loading: true, hasTree: false }, refresh)).toBeUndefined();

    vi.runAllTimers();
    expect(refresh).not.toHaveBeenCalled();
  });
});
