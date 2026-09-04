import { describe, expect, it } from "vitest";
import { remarkNeutralizeTextDirectives } from "./remarkDirectives";

// Concatenate the visible text of an mdast phrasing subtree.
function textOf(nodes: any[]): string {
  return nodes
    .map((n) => (n.type === "text" ? n.value : textOf(n.children ?? [])))
    .join("");
}

function run(tree: any) {
  remarkNeutralizeTextDirectives()(tree);
  return tree;
}

describe("remarkNeutralizeTextDirectives", () => {
  it("rewrites a bare text directive (':1' from '1:1') back to literal text", () => {
    // remark-directive parses "1:1 for one year" as text "1" + textDirective(name:"1") + " for one year"
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "1" },
            { type: "textDirective", name: "1", children: [] },
            { type: "text", value: " for one year" },
          ],
        },
      ],
    };
    run(tree);
    const p = tree.children[0];
    expect(p.children.some((n: any) => n.type === "textDirective")).toBe(false);
    expect(textOf(p.children)).toBe("1:1 for one year");
  });

  it("restores a clock time like '11:24'", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "logged at 11" },
            { type: "textDirective", name: "24", children: [] },
          ],
        },
      ],
    };
    run(tree);
    expect(textOf(tree.children[0].children)).toBe("logged at 11:24");
  });

  it("preserves a real [label] on a text directive", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "textDirective", name: "note", children: [{ type: "text", value: "hi" }] },
          ],
        },
      ],
    };
    run(tree);
    expect(textOf(tree.children[0].children)).toBe(":note[hi]");
  });

  it("leaves a directive already handled by another plugin (data.hName set)", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "textDirective", name: "x", data: { hName: "span" }, children: [] },
          ],
        },
      ],
    };
    run(tree);
    expect(tree.children[0].children[0].type).toBe("textDirective");
  });

  it("does not touch container/leaf directives (only text directives)", () => {
    const tree = {
      type: "root",
      children: [
        { type: "containerDirective", name: "tabs", children: [] },
        { type: "leafDirective", name: "col", children: [] },
      ],
    };
    run(tree);
    expect(tree.children[0].type).toBe("containerDirective");
    expect(tree.children[1].type).toBe("leafDirective");
  });
});
