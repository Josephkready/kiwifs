import { describe, expect, it } from "vitest";

// Live contract check against the real speech service. Runs only when
// KIWI_SPEECH_LIVE_ENDPOINT is set (e.g. http://localhost:8080/api/speech), so it is
// skipped in the default test run. It cannot force a fallback; it verifies that the
// inline response shape matches what noteMeta reads (top-level fallback_reason / mode).
const endpoint = (process.env.KIWI_SPEECH_LIVE_ENDPOINT ?? "").replace(/\/+$/, "");

describe.skipIf(!endpoint)("speech service live contract (run on demand)", () => {
  it("synthesize response has id and top-level fallback_reason/mode with the expected types", async () => {
    const r = await fetch(`${endpoint}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Read-along live contract check." }),
    });
    expect([200, 202]).toContain(r.status);
    const body = await r.json();
    if (r.status === 200) {
      expect(typeof body.id).toBe("string");
      if ("fallback_reason" in body) {
        expect(body.fallback_reason === null || typeof body.fallback_reason === "string").toBe(true);
      }
      if ("mode" in body) expect(typeof body.mode).toBe("string");
    } else {
      expect(typeof body.job_id).toBe("string");
    }
  });
});
