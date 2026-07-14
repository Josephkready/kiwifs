import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeEntry } from "../lib/api";
import { TooltipProvider } from "./ui/tooltip";

const { receivedTreeRoots } = vi.hoisted(() => ({
  receivedTreeRoots: [] as Array<TreeEntry | null | undefined>,
}));

vi.mock("./KiwiTree", () => ({
  KiwiTree: (props: { treeRoot?: TreeEntry | null }) => {
    receivedTreeRoots.push(props.treeRoot);
    return null;
  },
}));

vi.mock("./SpaceSelector", () => ({ SpaceSelector: () => null }));

import { AppSidebar } from "./AppSidebar";

describe("AppSidebar", () => {
  beforeEach(() => receivedTreeRoots.splice(0));

  it("shares the provided root with section and page trees", () => {
    const treeRoot: TreeEntry = {
      path: "",
      name: "/",
      isDir: true,
      children: [],
    };

    renderToStaticMarkup(
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

    expect(receivedTreeRoots).toHaveLength(2);
    expect(receivedTreeRoots.every((root) => root === treeRoot)).toBe(true);
  });
});
