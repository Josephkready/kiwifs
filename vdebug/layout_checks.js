// video-debugger deterministic layout checks. Evaluated in the page at every
// vd.mark() by vdebug.py: `page.evaluate(LAYOUT_CHECKS_JS)` returns a list of issues.
//
// These run BEFORE (and are handed to) the AI judge. A DOM measurement is exact and
// free; a vision model is neither. The judge's job is what the DOM can't tell you
// (overlap that looks wrong, awkward wrapping, visual hierarchy) — and to confirm or
// reject these hints against the pixels.
(() => {
  const MAX = 40;
  const issues = [];
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const add = (check, el, detail) => {
    if (issues.length >= MAX) return;
    const r = el ? el.getBoundingClientRect() : null;
    issues.push({
      check, detail,
      selector: el ? sel(el) : null,
      rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
    });
  };
  function sel(el) {
    if (el.id) return "#" + CSS.escape(el.id);
    const tid = el.getAttribute("data-testid");
    if (tid) return `[data-testid="${tid}"]`;
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 4) {
      let p = el.tagName.toLowerCase();
      if (el.classList.length) p += "." + [...el.classList].slice(0, 2).map(c => CSS.escape(c)).join(".");
      parts.unshift(p);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }
  const visible = (el, cs) => {
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // An ancestor that clips or scrolls horizontally makes overflow intentional.
  const clippedX = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox !== "visible") return true;
    }
    return false;
  };

  // 1. Page-level horizontal scroll — the #1 responsive bug.
  const sw = document.documentElement.scrollWidth;
  if (sw > vw + 1) add("horizontal-overflow", null, `page scrollWidth ${sw}px > viewport ${vw}px`);

  const all = document.body ? document.body.querySelectorAll("*") : [];
  const interactive = [];
  for (const el of all) {
    if (issues.length >= MAX) break;
    const cs = getComputedStyle(el);
    if (!visible(el, cs) || cs.position === "fixed") continue;
    const r = el.getBoundingClientRect();

    // 2. Element sticking out past the right edge (the culprit behind #1).
    if (r.right > vw + 1 && r.left < vw && !clippedX(el) && r.width <= sw) {
      // Report only the outermost offender, not every descendant of it.
      const parentR = el.parentElement ? el.parentElement.getBoundingClientRect() : null;
      if (!parentR || parentR.right <= vw + 1) add("offscreen-right", el, `right edge at ${Math.round(r.right)}px, viewport ${vw}px`);
    }

    // 3. Text clipped by its own box without an intentional ellipsis.
    const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (hasText && (cs.overflow === "hidden" || cs.overflowX === "hidden") && cs.textOverflow !== "ellipsis"
        && el.scrollWidth > el.clientWidth + 2) {
      add("text-clipped", el, `content ${el.scrollWidth}px in ${el.clientWidth}px box`);
    }
    // 3b. Text spilling out of a fixed-size box (e.g. a button with a hardcoded width).
    if (hasText && cs.overflow === "visible" && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0
        && /^(BUTTON|A|LABEL|SPAN|TD|TH|LI)$/.test(el.tagName)) {
      add("text-overflow", el, `text ${el.scrollWidth}px spills out of ${el.clientWidth}px ${el.tagName.toLowerCase()}`);
    }

    if (el.matches("a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link]")) {
      interactive.push({ el, r });
      // 4. Tap targets below WCAG 2.2 minimum (24x24 CSS px), on touch-sized viewports.
      if (vw < 768 && (r.width < 24 || r.height < 24) && r.top < vh * 3 && !(el.tagName === "A" && cs.display === "inline")) {
        add("small-tap-target", el, `${Math.round(r.width)}x${Math.round(r.height)}px < 24x24`);
      }
    }
  }

  // 5. Interactive elements overlapping each other (one covers the other's hit area).
  for (let i = 0; i < interactive.length && issues.length < MAX; i++) {
    for (let j = i + 1; j < interactive.length; j++) {
      const a = interactive[i], b = interactive[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix > 4 && iy > 4) { add("overlapping-controls", a.el, `overlaps ${sel(b.el)} by ${Math.round(ix)}x${Math.round(iy)}px`); break; }
    }
  }
  return issues;
})()
