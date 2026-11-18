// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BugReportDialog } from "./BugReportButton";
import { TooltipProvider } from "./ui/tooltip";
import { DRAFT_KEY } from "../lib/bugReport";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
  vi.stubGlobal("createImageBitmap", async () => ({ width: 10, height: 10 }));
  HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as never;
  HTMLCanvasElement.prototype.toBlob = function (cb: BlobCallback, type?: string) {
    cb(new Blob(["img"], { type }));
  } as never;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const ctx = { current: { path: "a.md" } };
async function render(open: boolean) {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <BugReportDialog open={open} onClose={() => {}} context={ctx} path="a.md" onSaved={() => {}} />
      </TooltipProvider>,
    );
  });
}
const q = <T extends Element>(s: string) => document.querySelector<T>(s);
const setText = async (v: string) => {
  const ta = q<HTMLTextAreaElement>("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(ta, v);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const attach = async () => {
  const input = q<HTMLInputElement>('[data-testid="bug-report-file"]')!;
  const file = new File(["x"], "s.png", { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

describe("BugReportDialog", () => {
  it("shows the draft, keeps it when the save fails, clears it after 202", async () => {
    localStorage.setItem(DRAFT_KEY, "persisted draft text");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("[]"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "boom" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "saved", id: 1, key: "k" }), { status: 202 }))
      .mockResolvedValue(new Response("[]"));
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    expect(q<HTMLTextAreaElement>("textarea")!.value).toBe("persisted draft text");
    const done = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Save and done")!;
    await act(async () => done().click());
    expect(localStorage.getItem(DRAFT_KEY)).toBe("persisted draft text");
    expect(document.body.textContent).toContain("boom");
    await act(async () => done().click());
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it("drops staged screenshots when the dialog is reopened", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
    await render(true);
    await setText("long enough description");
    await attach();
    expect(document.querySelectorAll('img[alt^="Screenshot"]')).toHaveLength(1);
    await render(false);
    await render(true);
    expect(document.querySelectorAll('img[alt^="Screenshot"]')).toHaveLength(0);
  });
});
