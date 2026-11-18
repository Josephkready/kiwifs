// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Network, Plus } from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBugReport } from "./BugReportButton";
import { HeaderOverflowMenu, type OverflowItem } from "./HeaderOverflowMenu";
import { TooltipProvider } from "./ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const onGraph = vi.fn();

function Harness() {
  const bug = useBugReport({ getContext: () => ({ path: "a.md" }), path: "a.md" });
  const items: OverflowItem[] = [
    { id: "new", label: "New page", Icon: Plus, onSelect: () => {} },
    { id: "graph", label: "Knowledge graph", Icon: Network, onSelect: onGraph },
  ];
  return (
    <TooltipProvider>
      <HeaderOverflowMenu items={items} bug={bug} />
      {bug.node}
    </TooltipProvider>
  );
}

const flush = () => act(async () => {});
const hamburger = () => document.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!;
const items = () => Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));

beforeEach(async () => {
  window.innerWidth = 390;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (u: string) =>
      u.includes("/config") ? new Response('{"available":true}') : new Response("[]"),
    ),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(<Harness />));
  await flush();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  onGraph.mockClear();
});

describe("HeaderOverflowMenu", () => {
  it("lists the actions with Report a bug last, and exposes menu semantics", async () => {
    expect(hamburger().getAttribute("aria-haspopup")).toBe("menu");
    expect(hamburger().getAttribute("aria-expanded")).toBe("false");
    await act(async () => hamburger().click());
    expect(hamburger().getAttribute("aria-expanded")).toBe("true");
    expect(items().map((i) => i.textContent)).toEqual(["New page", "Knowledge graph", "Report a bug"]);
    expect(items().at(-1)!.getAttribute("data-feature")).toBe("header.bug");
    expect(items().every((i) => i.querySelector("svg"))).toBe(true);
  });

  it("runs an action and closes the menu", async () => {
    await act(async () => hamburger().click());
    await act(async () => items()[1].click());
    expect(onGraph).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("Escape closes the menu", async () => {
    await act(async () => hamburger().click());
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("Report a bug opens the dialog and focus returns to the hamburger on close", async () => {
    await act(async () => hamburger().click());
    await act(async () => items().at(-1)!.click());
    await flush();
    const dialog = document.querySelector('[data-testid="bug-report-dialog"]');
    expect(dialog).not.toBeNull();
    expect(document.activeElement).toBe(dialog!.querySelector("textarea"));
    const close = [...dialog!.querySelectorAll("button")].find((b) => b.textContent === "Close")!;
    await act(async () => close.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(document.querySelector('[data-testid="bug-report-dialog"]')).toBeNull();
    expect(document.activeElement).toBe(hamburger());
  });
});
