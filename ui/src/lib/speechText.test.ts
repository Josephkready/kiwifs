// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { chunkSpeech, extractSpeech, rangeForSpoken, spokenIndexFor } from "./speechText";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.className = "kiwi-prose";
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

const FIXTURE = `
  <h1>Release <em>notes</em></h1>
  <p>Read the <a href="/x">full guide</a> first. It is short.</p>
  <ul><li>Alpha item</li><li>Beta item</li></ul>
  <pre><code>const secret = 1;</code></pre>
  <p>Inline <code>skipme()</code> code and <span class="katex">E=mc2</span> math.</p>
  <table><tr><td>cell text</td></tr></table>
  <img alt="pic alt" src="a.png">
  <blockquote><p>Quoted words</p></blockquote>
  <div class="kiwi-backlinks-section"><p>Backlink noise</p></div>
`;

describe("extractSpeech", () => {
  const root = mount(FIXTURE);
  const doc = extractSpeech(root);

  it("reads headings, paragraphs, list items, quotes and link text", () => {
    for (const s of ["Release notes", "full guide", "Alpha item", "Beta item", "Quoted words"]) {
      expect(doc.text).toContain(s);
    }
  });

  it("skips code, math, tables, images, and panels", () => {
    for (const s of ["secret", "skipme", "E=mc2", "cell text", "pic alt", "Backlink noise"]) {
      expect(doc.text).not.toContain(s);
    }
    expect(doc.text).toContain("Inline code and math.");
  });

  it("does not run blocks together", () => {
    expect(doc.text).toContain("Release notes. Read the");
    expect(doc.text).toContain("Alpha item. Beta item.");
  });

  it("maps every non-inserted char back to the identical DOM char", () => {
    let mapped = 0;
    for (let i = 0; i < doc.text.length; i++) {
      const ni = doc.nodeIdx[i];
      if (ni < 0) continue;
      mapped++;
      const ch = doc.nodes[ni].data[doc.local[i]];
      // whitespace runs collapse to one space
      if (doc.text[i] === " ") expect(/\s/.test(ch)).toBe(true);
      else expect(ch).toBe(doc.text[i]);
    }
    expect(mapped).toBeGreaterThan(40);
    // inserted separators exist and carry no position
    const dot = doc.text.indexOf("notes. Read") + "notes".length;
    expect(doc.nodeIdx[dot]).toBe(-1);
  });

  it("builds a Range over a word that crosses inline elements", () => {
    const start = doc.text.indexOf("Release notes");
    const range = rangeForSpoken(doc, start, start + "Release notes".length)!;
    expect(range.toString()).toBe("Release notes");
  });

  it("maps a DOM position back to a spoken index", () => {
    const textNode = root.querySelector("a")!.firstChild!;
    const idx = spokenIndexFor(doc, textNode, 5)!;
    expect(doc.text.slice(idx, idx + 5)).toBe("guide");
  });
});

describe("chunkSpeech", () => {
  const paras = Array.from({ length: 12 }, (_, i) => `<p>Paragraph number ${i} has some words in it.</p>`).join("");
  const root = mount(paras);
  const doc = extractSpeech(root);

  it("respects the max and cuts at block boundaries", () => {
    const chunks = chunkSpeech(doc, 120);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(120);
      expect(doc.blockStarts).toContain(c.base);
      expect(doc.text.slice(c.base, c.base + c.text.length)).toBe(c.text);
    }
    expect(chunks.map((c) => c.text).join(" ").replace(/\s+/g, " ")).toContain("Paragraph number 11");
  });

  it("splits an oversize block at sentences, then words", () => {
    const long = mount(`<p>${"One sentence here. ".repeat(20)}</p><p>${"word ".repeat(60)}</p>`);
    const d = extractSpeech(long);
    const chunks = chunkSpeech(d, 50);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(50);
      expect(d.text.slice(c.base, c.base + c.text.length)).toBe(c.text);
      expect(c.text).toBe(c.text.trim());
    }
    expect(chunks[0].text.endsWith(".")).toBe(true); // sentence cut
    expect(chunks.every((c) => !/^\w+$/.test(c.text) || c.text.length <= 50)).toBe(true);
  });
});
