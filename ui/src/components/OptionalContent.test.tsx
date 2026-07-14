import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { OptionalContent } from "./OptionalContent";

describe("OptionalContent", () => {
  it("does not mount lazy content while its view is closed", () => {
    const onRender = vi.fn();
    function Probe() {
      onRender();
      return <span>loaded</span>;
    }

    expect(renderToStaticMarkup(
      <OptionalContent when={false}><Probe /></OptionalContent>,
    )).toBe("");
    expect(onRender).not.toHaveBeenCalled();
  });

  it("mounts content after its view opens", () => {
    expect(renderToStaticMarkup(
      <OptionalContent when><span>loaded</span></OptionalContent>,
    )).toContain("loaded");
  });
});
