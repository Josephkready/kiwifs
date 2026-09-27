import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeEntry } from "../lib/api";
import { TooltipProvider } from "./ui/tooltip";

const { receivedTreeRoots, receivedCreateChild, uiConfig } = vi.hoisted(() => ({
  receivedTreeRoots: [] as Array<TreeEntry | null | undefined>,
  receivedCreateChild: [] as unknown[],
  uiConfig: { features: {} as Record<string, boolean> },
}));

// zustand serves its initial state to renderToStaticMarkup, so setState would
// never reach the render; stub the selector hook with a mutable config instead.
vi.mock("../lib/uiConfigStore", () => ({
  useUIConfigStore: <T,>(selector: (state: typeof uiConfig) => T) => selector(uiConfig),
}));

vi.mock("./KiwiTree", () => ({
  KiwiTree: (props: { treeRoot?: TreeEntry | null; onCreateChild?: unknown }) => {
    receivedTreeRoots.push(props.treeRoot);
    receivedCreateChild.push(props.onCreateChild);
    return null;
  },
}));

vi.mock("./SpaceSelector", () => ({ SpaceSelector: () => null }));

import { AppSidebar } from "./AppSidebar";
import { DEFAULT_UI_FEATURES } from "../lib/uiFeatures";

function renderSidebar(treeRoot: TreeEntry | null = null): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <AppSidebar
        activePath={null}
        treeRoot={treeRoot}
        isMobile={false}
        sidebarOpen
        sidebarWidth={272}
        resizing={{ current: false }}
        treeRef={createRef()}
        treeFilterRef={createRef()}
        treeFilter=""
        treeRevealRequest={null}
        treeSortMode="name"
        refreshKey={0}
        kanbanOpen={false}
        sidebarConfig={{ pinned: [], hidden: [], sections: [{ label: "Notes", paths: ["notes/"] }] }}
        starred={[]}
        pinned={[]}
        recent={[]}
        onSpaceSwitch={vi.fn()}
        onNavigate={vi.fn()}
        onToggleStar={vi.fn()}
        onTogglePin={vi.fn()}
        onCreatePage={vi.fn()}
        onTreeFilterChange={vi.fn()}
        onTreeSortModeChange={vi.fn()}
        onActivePathChange={vi.fn()}
        onTreeRefresh={vi.fn()}
      />
    </TooltipProvider>,
  );
}

describe("AppSidebar", () => {
  beforeEach(() => {
    receivedTreeRoots.splice(0);
    receivedCreateChild.splice(0);
    uiConfig.features = { ...DEFAULT_UI_FEATURES };
  });

  it("shares the provided root with section and page trees", () => {
    const treeRoot: TreeEntry = {
      path: "",
      name: "/",
      isDir: true,
      children: [],
    };

    renderSidebar(treeRoot);

    expect(receivedTreeRoots).toHaveLength(2);
    expect(receivedTreeRoots.every((root) => root === treeRoot)).toBe(true);
  });

  it("shows authoring chrome by default", () => {
    const html = renderSidebar();

    expect(html).toContain('aria-label="New page"');
    expect(html).toContain("published list");
    expect(receivedCreateChild.every((fn) => typeof fn === "function")).toBe(true);
  });

  it("hides New page and child creation when edit is disabled", () => {
    uiConfig.features.edit = false;
    const html = renderSidebar();

    expect(html).not.toContain('aria-label="New page"');
    expect(html).toContain("published list");
    expect(receivedCreateChild).toHaveLength(2);
    expect(receivedCreateChild.every((fn) => fn === undefined)).toBe(true);
  });

  it("hides the published-list toggle when publish is disabled", () => {
    uiConfig.features.publish = false;
    const html = renderSidebar();

    expect(html).not.toContain("published list");
    expect(html).toContain('aria-label="New page"');
  });
});
