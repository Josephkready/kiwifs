// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ReadAlongButton } from "./ReadAlongButton";
import { TooltipProvider } from "./ui/tooltip";
import { useUIConfigStore } from "@kw/lib/uiConfigStore";
import { DEFAULT_UI_FEATURES } from "@kw/lib/uiFeatures";
import type { ReadAlong } from "@kw/lib/useReadAlong";
import type { SessionState } from "@kw/lib/readAlongSession";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const idle: ReadAlong = { session: null, state: null, empty: false, start: () => {}, stop: () => {} };
let root: Root | null = null;
let host: HTMLElement | null = null;

async function render(features: Partial<typeof DEFAULT_UI_FEATURES>) {
  useUIConfigStore.setState({ features: { ...DEFAULT_UI_FEATURES, ...features } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <TooltipProvider>
        <ReadAlongButton readAlong={idle} />
      </TooltipProvider>,
    );
  });
  return host;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
});

describe("ReadAlongButton", () => {
  it("is absent with the default config (tts off)", async () => {
    const h = await render({});
    expect(h.querySelector("[data-testid=read-along-button]")).toBeNull();
  });
  it("is present when the tts flag is on", async () => {
    const h = await render({ tts: true });
    expect(h.querySelector("[data-testid=read-along-button]")).not.toBeNull();
  });

  describe("derived label, disabled state and click routing", () => {
    const st = (o: object) => o as unknown as SessionState;
    const fakeSession = (toggle: () => void) =>
      ({ toggle, getState: () => null, subscribe: () => () => {}, start: () => {}, stop: () => {} }) as unknown as ReadAlong["session"];

    async function renderWith(readAlong: ReadAlong) {
      useUIConfigStore.setState({ features: { ...DEFAULT_UI_FEATURES, tts: true } });
      host = document.createElement("div");
      document.body.appendChild(host);
      root = createRoot(host);
      await act(async () => {
        root!.render(
          <TooltipProvider>
            <ReadAlongButton readAlong={readAlong} />
          </TooltipProvider>,
        );
      });
      return host;
    }

    const btn = (h: HTMLElement) => h.querySelector("[data-testid=read-along-button]") as HTMLButtonElement;

    it("shows nothing-to-read and is disabled when empty", async () => {
      const h = await renderWith({ ...idle, empty: true });
      expect(btn(h).getAttribute("aria-label")).toBe("Nothing to read on this page");
      expect(btn(h).disabled).toBe(true);
    });

    it("shows Read aloud when idle with no state", async () => {
      const h = await renderWith(idle);
      expect(btn(h).getAttribute("aria-label")).toBe("Read aloud");
      expect(btn(h).disabled).toBe(false);
    });

    it("shows Generating while buffering", async () => {
      const h = await renderWith({
        ...idle,
        state: st({ phase: "buffering", ready: 0, loading: true, chunks: [{ status: "pending" }] }),
      });
      expect(btn(h).getAttribute("aria-label")).toBe("Generating…");
    });

    it("shows Pause while playing", async () => {
      const h = await renderWith({
        ...idle,
        state: st({ phase: "playing", ready: 1, loading: false, chunks: [{ status: "ready" }] }),
      });
      expect(btn(h).getAttribute("aria-label")).toBe("Pause");
    });

    it("shows Resume when paused with a state", async () => {
      const h = await renderWith({
        ...idle,
        state: st({ phase: "paused", ready: 1, loading: false, chunks: [{ status: "ready" }] }),
      });
      expect(btn(h).getAttribute("aria-label")).toBe("Resume");
    });

    it("shows service unavailable when the first chunk errored", async () => {
      const h = await renderWith({
        ...idle,
        state: st({ phase: "idle", ready: 0, loading: false, chunks: [{ status: "error" }] }),
      });
      expect(btn(h).getAttribute("aria-label")).toBe("Speech service unavailable");
    });

    it("calls start() (not toggle) when there is no session", async () => {
      let started = 0;
      let toggled = 0;
      const h = await renderWith({ ...idle, start: () => { started++; } });
      await act(async () => btn(h).click());
      expect(started).toBe(1);
      expect(toggled).toBe(0);
    });

    it("calls toggle() on a live session", async () => {
      let started = 0;
      let toggled = 0;
      const h = await renderWith({
        session: fakeSession(() => { toggled++; }),
        state: st({ phase: "playing", ready: 1, loading: false, chunks: [{ status: "ready" }] }),
        empty: false,
        start: () => { started++; },
        stop: () => {},
      });
      await act(async () => btn(h).click());
      expect(toggled).toBe(1);
      expect(started).toBe(0);
    });

    it("calls start() again when the service is unavailable, even with a session", async () => {
      let started = 0;
      let toggled = 0;
      const h = await renderWith({
        session: fakeSession(() => { toggled++; }),
        state: st({ phase: "idle", ready: 0, loading: false, chunks: [{ status: "error" }] }),
        empty: false,
        start: () => { started++; },
        stop: () => {},
      });
      await act(async () => btn(h).click());
      expect(started).toBe(1);
      expect(toggled).toBe(0);
    });
  });
});
