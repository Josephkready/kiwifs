import { describe, expect, it, vi } from "vitest";
import {
  DRAFT_KEY,
  MAX_IMAGE_BYTES,
  compressImage,
  fitWithin,
  imagesFromClipboard,
  newUUID,
  pollStatus,
  safeIssueUrl,
  stageImages,
  statusLabel,
  submitReport,
  type ImageIO,
} from "./bugReport";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newUUID", () => {
  it("falls back to getRandomValues when randomUUID throws (plain http)", () => {
    const c = {
      randomUUID: () => {
        throw new TypeError("insecure context");
      },
      getRandomValues: (a: Uint8Array) => a.fill(0xab),
    } as unknown as Crypto;
    expect(newUUID(c)).toMatch(V4);
  });
  it("falls back when randomUUID is missing", () => {
    const c = { getRandomValues: (a: Uint8Array) => a.fill(7) } as unknown as Crypto;
    expect(newUUID(c)).toMatch(V4);
  });
});

const fakeIO = (w: number, h: number, size: number, webp = true): ImageIO & { calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    decode: async () => ({ width: w, height: h, source: "src" }),
    encode: async (_s, width, height, type, q) => {
      calls.push([width, height, type, q]);
      if (type === "image/webp" && !webp) return new Blob([new Uint8Array(10)], { type: "image/png" });
      return new Blob([new Uint8Array(size)], { type });
    },
  };
};

describe("compressImage", () => {
  it("caps the long edge at 1600 and encodes webp at 0.8", async () => {
    const io = fakeIO(4000, 3000, 1000);
    await compressImage(new Blob(["x"]), io);
    expect(io.calls[0]).toEqual([1600, 1200, "image/webp", 0.8]);
  });
  it("never upscales a small image", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });
  it("falls back to jpeg when webp encoding is unavailable", async () => {
    const io = fakeIO(100, 100, 1000, false);
    const out = await compressImage(new Blob(["x"]), io);
    expect(out.type).toBe("image/jpeg");
  });
  it("rejects results over 2MB", async () => {
    await expect(compressImage(new Blob(["x"]), fakeIO(100, 100, MAX_IMAGE_BYTES + 1))).rejects.toThrow(
      "Image too large even after compression",
    );
  });
  it("rejects undecodable formats with a clear message", async () => {
    const io = fakeIO(1, 1, 1);
    io.decode = async () => {
      throw new Error("bad");
    };
    await expect(compressImage(new Blob(["x"]), io)).rejects.toThrow(/isn't supported/);
  });
});

describe("stageImages", () => {
  const file = (n: string) => new File(["x"], n, { type: "image/png" });
  it("keeps the first 3 and reports the rest", async () => {
    const io = fakeIO(10, 10, 10);
    const res = await stageImages([], [1, 2, 3, 4, 5].map((i) => file(`${i}.png`)), io, () => "blob:x");
    expect(res.staged.map((s) => s.name)).toEqual(["1.png", "2.png", "3.png"]);
    expect(res.errors).toEqual(["Up to 3 screenshots per report"]);
  });
  it("keeps the rest of the batch when one image fails", async () => {
    const io = fakeIO(10, 10, 10);
    let n = 0;
    const decode = io.decode;
    io.decode = async (f) => {
      if (n++ === 0) throw new Error("heic");
      return decode(f);
    };
    const res = await stageImages([], [file("a"), file("b")], io, () => "blob:x");
    expect(res.staged.map((s) => s.name)).toEqual(["b"]);
    expect(res.errors).toHaveLength(1);
  });
});

describe("imagesFromClipboard", () => {
  const item = (kind: string, type: string, f?: File) => ({ kind, type, getAsFile: () => f ?? null });
  it("extracts image files and ignores text", () => {
    const png = new File(["x"], "s.png", { type: "image/png" });
    const data = { items: [item("string", "text/plain"), item("file", "image/png", png), item("file", "application/pdf", png)] };
    expect(imagesFromClipboard(data as unknown as DataTransfer)).toEqual([png]);
  });
  it("returns nothing for a text-only paste", () => {
    expect(imagesFromClipboard({ items: [item("string", "text/plain")] } as unknown as DataTransfer)).toEqual([]);
  });
});

describe("submitReport draft handling", () => {
  const input = { description: "something broke here", key: "k", context: {}, images: [] };
  const storage = () => {
    const m = new Map<string, string>([[DRAFT_KEY, "something broke here"]]);
    return { m, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };
  it("clears the draft only after a 202", async () => {
    const st = storage();
    const ok = vi.fn(async () => new Response(JSON.stringify({ status: "saved", id: 4, key: "k" }), { status: 202 }));
    const res = await submitReport(input, { fetch: ok as unknown as typeof fetch, storage: st });
    expect(res).toEqual({ ok: true, id: 4, key: "k" });
    expect(st.m.has(DRAFT_KEY)).toBe(false);
  });
  it("keeps the draft on a server error and on a network failure", async () => {
    for (const f of [
      async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 }),
      async () => {
        throw new TypeError("offline");
      },
    ]) {
      const st = storage();
      const res = await submitReport(input, { fetch: f as unknown as typeof fetch, storage: st });
      expect(res.ok).toBe(false);
      expect(st.m.has(DRAFT_KEY)).toBe(true);
    }
  });
});

describe("safeIssueUrl", () => {
  it("allows only the fork's issue URLs", () => {
    expect(safeIssueUrl("https://github.com/Josephkready/kiwifs/issues/12")).not.toBeNull();
    expect(safeIssueUrl("https://github.com/kiwifs/kiwifs/issues/12")).toBeNull();
    expect(safeIssueUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("pollStatus", () => {
  it("stops at the time bound and survives failed polls", async () => {
    vi.useFakeTimers();
    let t = 0;
    const f = vi.fn(async () => {
      throw new TypeError("down");
    });
    pollStatus(1, () => {}, { intervalMs: 10, maxMs: 35, fetch: f as unknown as typeof fetch, now: () => t });
    for (let i = 0; i < 10; i++) {
      t += 10;
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(f.mock.calls.length).toBeGreaterThan(1);
    expect(f.mock.calls.length).toBeLessThan(10);
    vi.useRealTimers();
  });
});

describe("pollStatus outcomes", () => {
  it("reports each payload in order and stops at a final status", async () => {
    vi.useFakeTimers();
    const filed = { sync_status: "filed", issue_url: "https://github.com/Josephkready/kiwifs/issues/12" };
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sync_status: "queued" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(filed), { status: 200 }));
    const seen: unknown[] = [];
    pollStatus(1, (s) => seen.push(s), { intervalMs: 10, maxMs: 100000, fetch: f as unknown as typeof fetch, now: () => 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([{ sync_status: "queued" }, filed]);
    expect(f).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("stops polling on a failed final status", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => new Response(JSON.stringify({ sync_status: "failed" }), { status: 200 }));
    const seen: unknown[] = [];
    pollStatus(1, (s) => seen.push(s), { intervalMs: 10, maxMs: 100000, fetch: f as unknown as typeof fetch, now: () => 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(seen).toEqual([{ sync_status: "failed" }]);
    expect(f).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("cancel prevents any fetch when called before the first tick", async () => {
    vi.useFakeTimers();
    const f = vi.fn(async () => new Response(JSON.stringify({ sync_status: "queued" }), { status: 200 }));
    const cancel = pollStatus(1, () => {}, { intervalMs: 10, maxMs: 100000, fetch: f as unknown as typeof fetch, now: () => 0 });
    cancel();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("ignores a response that arrives after cancel", async () => {
    vi.useFakeTimers();
    let resolveFetch: (r: Response) => void = () => {};
    const f = vi.fn(() => new Promise<Response>((r) => { resolveFetch = r; }));
    const onUpdate = vi.fn();
    const cancel = pollStatus(1, onUpdate, { intervalMs: 10, maxMs: 100000, fetch: f as unknown as typeof fetch, now: () => 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(f).toHaveBeenCalledTimes(1);
    cancel();
    resolveFetch(new Response(JSON.stringify({ sync_status: "queued" }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(onUpdate).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe("submitReport error and attachment handling", () => {
  const input = { description: "something broke here", key: "k", context: {}, images: [] };
  const noopStorage = { setItem: () => {}, removeItem: () => {} };
  it("returns the server's JSON error string as the message", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "Too large" }), { status: 413 }));
    const res = await submitReport(input, { fetch: f as unknown as typeof fetch, storage: noopStorage });
    expect(res).toEqual({ ok: false, message: "Too large" });
  });
  it("falls back to the generic message for a non-JSON error body", async () => {
    const f = vi.fn(async () => new Response("oops", { status: 500 }));
    const res = await submitReport(input, { fetch: f as unknown as typeof fetch, storage: noopStorage });
    expect(res).toEqual({ ok: false, message: "Could not save the report. Your draft is kept." });
  });
  it("appends a webp screenshot as screenshot-1.webp", async () => {
    let captured: FormData | undefined;
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      captured = init?.body as FormData;
      return new Response(JSON.stringify({ id: 1, key: "k" }), { status: 202 });
    });
    await submitReport(
      { ...input, images: [new Blob(["x"], { type: "image/webp" })] },
      { fetch: f as unknown as typeof fetch, storage: noopStorage },
    );
    expect((captured?.get("attachments") as File).name).toBe("screenshot-1.webp");
  });
});

describe("statusLabel", () => {
  it.each([
    ["pending-sync", "Saved, waiting to sync"],
    ["queued", "Saved, queued for GitHub"],
    ["retry", "Saved, GitHub is delayed"],
    ["filed", "Filed"],
    ["failed", "Saved, needs attention"],
    ["uncertain", "Saved, needs attention"],
  ] as const)("%s maps to its label", (status, label) => {
    expect(statusLabel(status)).toBe(label);
  });
});
