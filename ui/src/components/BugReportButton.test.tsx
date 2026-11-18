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

  it("Ctrl+Enter and Cmd+Enter save once with a UUID idempotency key and close", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <TooltipProvider>
          <BugReportDialog open onClose={onClose} context={ctx} path="a.md" onSaved={() => {}} />
        </TooltipProvider>,
      );
    });
    await setText("long enough description");
    const dlg = q<HTMLElement>('[data-testid="bug-report-dialog"]')!;
    await act(async () => {
      dlg.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    expect(sentKeys(fetchMock)).toHaveLength(1);
    expect(sentKeys(fetchMock)[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <TooltipProvider>
          <BugReportDialog open onClose={onClose} context={ctx} path="a.md" onSaved={() => {}} />
        </TooltipProvider>,
      );
    });
    await setText("long enough description");
    await act(async () => {
      dlg.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
    });
    expect(sentKeys(fetchMock)).toHaveLength(2);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("Save and add keeps the dialog open, clears the text and rotates the idempotency key", async () => {
    const fetchMock = routedFetch();
    vi.stubGlobal("fetch", fetchMock);
    const onClose = vi.fn();
    await act(async () => {
      root.render(
        <TooltipProvider>
          <BugReportDialog open onClose={onClose} context={ctx} path="a.md" onSaved={() => {}} />
        </TooltipProvider>,
      );
    });
    const addBtn = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Save and add")!;
    await setText("long enough description");
    await act(async () => addBtn().click());
    expect(q<HTMLTextAreaElement>("textarea")!.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();

    await setText("second long enough description");
    await act(async () => addBtn().click());
    expect(onClose).not.toHaveBeenCalled();
    const keys = sentKeys(fetchMock);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

let postCount = 0;
function routedFetch() {
  postCount = 0;
  return vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      postCount += 1;
      return new Response(JSON.stringify({ status: "saved", id: postCount, key: "k" }), { status: 202 });
    }
    return new Response("[]");
  });
}

function sentKeys(fm: ReturnType<typeof vi.fn>): string[] {
  return fm.mock.calls
    .filter(([, i]) => (i as RequestInit | undefined)?.method === "POST")
    .map(([, i]) => String(((i as RequestInit).body as FormData).get("idempotency_key")));
}
