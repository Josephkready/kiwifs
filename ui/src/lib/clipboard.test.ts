import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("copyTextToClipboard", () => {
  it("copies the exact Markdown source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const markdown = "---\ntitle: Exact source\ntags: [mind]\n---\n\n# Exact source\n\n[[linked-note]]\n";

    await expect(copyTextToClipboard(markdown)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(markdown);
  });

  it("returns false when clipboard access is unavailable", async () => {
    vi.stubGlobal("navigator", {});

    await expect(copyTextToClipboard("# Note\n")).resolves.toBe(false);
  });

  it("returns false when the browser rejects clipboard access", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });

    await expect(copyTextToClipboard("# Note\n")).resolves.toBe(false);
  });
});
