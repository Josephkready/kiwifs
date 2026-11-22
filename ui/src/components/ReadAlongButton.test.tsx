// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ReadAlongButton } from "./ReadAlongButton";
import { TooltipProvider } from "./ui/tooltip";
import { useUIConfigStore } from "@kw/lib/uiConfigStore";
import { DEFAULT_UI_FEATURES } from "@kw/lib/uiFeatures";
import type { ReadAlong } from "@kw/lib/useReadAlong";

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
});
