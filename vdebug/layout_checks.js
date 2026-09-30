// video-debugger deterministic layout checks. Evaluated in the page at every
// vd.mark() by vdebug.py: `page.evaluate(LAYOUT_CHECKS_JS)` returns a list of issues.
//
// These run BEFORE (and are handed to) the AI judge. A DOM measurement is exact and
// free; a vision model is neither. The judge's job is what the DOM can't tell you
// (overlap that looks wrong, awkward wrapping, visual hierarchy) — and to confirm or
// reject these hints against the pixels.
(() => {
  const MAX = 60;
  const PER_CHECK = 15;  // one noisy check (e.g. tap targets) must not crowd out the others
  const issues = [];
  const perCheck = {};
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const touch = vw < 768 || (window.matchMedia && matchMedia("(pointer: coarse)").matches);
  const add = (check, el, detail) => {
    if (issues.length >= MAX || (perCheck[check] = (perCheck[check] || 0) + 1) > PER_CHECK) return;
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
  // Effective opacity through the ancestor chain (memoised): a control inside a faded-out
  // container is invisible even though its own opacity is 1.
  const alphaMemo = new Map();
  const alphaOf = (el) => {
    if (!el || el.nodeType !== 1) return 1;
    if (alphaMemo.has(el)) return alphaMemo.get(el);
    const a = parseFloat(getComputedStyle(el).opacity) * alphaOf(el.parentElement);
    alphaMemo.set(el, a);
    return a;
  };
  const visible = (el, cs) => {
    if (cs.display === "none" || cs.visibility === "hidden" || alphaOf(el) <= 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // scrollWidth also counts absolutely-positioned ::before/::after decorations; measure the
  // element's own text runs instead to confirm the TEXT really leaves the box.
  const textSpills = (el, r) => {
    const range = document.createRange();
    for (const n of el.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      range.selectNodeContents(n);
      const tr = range.getBoundingClientRect();
      if (tr.right > r.right + 2 || tr.left < r.left - 2) return true;
    }
    return false;
  };
  // The part of `r` not clipped away by overflow:hidden/auto/scroll ancestors, or null.
  const visibleRect = (el, r) => {
    let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const pcs = getComputedStyle(p);
      if (pcs.overflowX === "visible" && pcs.overflowY === "visible") continue;
      const pr = p.getBoundingClientRect();
      if (pcs.overflowX !== "visible") { left = Math.max(left, pr.left); right = Math.min(right, pr.right); }
      if (pcs.overflowY !== "visible") { top = Math.max(top, pr.top); bottom = Math.min(bottom, pr.bottom); }
      if (right - left <= 0 || bottom - top <= 0) return null;
    }
    return { left, top, right, bottom };
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
    // Closed sheets/drawers parked off-screen are inert or aria-hidden: not part of the page yet.
    if (el.closest('[inert],[aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();

    // 2. Element sticking out past the right edge (the culprit behind #1).
    if (r.right > vw + 1 && r.left < vw && !clippedX(el) && r.width <= sw) {
      // Report only the outermost offender, not every descendant of it.
      const parentR = el.parentElement ? el.parentElement.getBoundingClientRect() : null;
      if (!parentR || parentR.right <= vw + 1) add("offscreen-right", el, `right edge at ${Math.round(r.right)}px, viewport ${vw}px`);
    }

    // 3. Text clipped by its own box without an intentional ellipsis.
    const ownText = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join("").trim();
    const hasText = ownText.length > 0;
    // Visually-hidden (sr-only) text is clipped ON PURPOSE: 1x1 box / clip / clip-path.
    const srOnly = (r.width <= 1 && r.height <= 1) || (cs.clip && cs.clip !== "auto") || /inset\(50%\)/.test(cs.clipPath);
    if (hasText && !srOnly && (cs.overflow === "hidden" || cs.overflowX === "hidden") && cs.textOverflow !== "ellipsis"
        && el.scrollWidth > el.clientWidth + 2) {
      add("text-clipped", el, `content ${el.scrollWidth}px in ${el.clientWidth}px box`);
    }
    // 3b. Text spilling out of a fixed-size box (e.g. a button with a hardcoded width).
    // Icon glyphs (emoji / 1-2 symbol labels) overhang their box by a few px by design.
    const iconOnly = [...ownText].length <= 2;
    if (hasText && !iconOnly && cs.overflow === "visible" && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0
        && textSpills(el, r)
        && /^(BUTTON|A|LABEL|SPAN|TD|TH|LI)$/.test(el.tagName)) {
      add("text-overflow", el, `text ${el.scrollWidth}px spills out of ${el.clientWidth}px ${el.tagName.toLowerCase()}`);
    }

    if (el.matches("a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link]")) {
      // Overlap is judged on the VISIBLE box: what's clipped away by an overflow ancestor
      // (a zoomed/scrolled container) can't cover anything. SVG shapes are skipped: their
      // bounding boxes of radial/diagonal shapes (wheel wedges, map regions) always "overlap".
      const vr = visibleRect(el, r);
      if (vr && !(el instanceof SVGElement)) interactive.push({ el, r: vr });
      // 4. Tap targets below WCAG 2.2 minimum (24x24 CSS px), on touch-sized viewports.
      // A ::before/::after overlay (the common "expand the hit area" trick) counts as target.
      const hit = [r.width, r.height];
      for (const pe of ["::before", "::after"]) {
        const ps = getComputedStyle(el, pe);
        if (ps.content && ps.content !== "none" && ps.position === "absolute") {
          hit[0] = Math.max(hit[0], parseFloat(ps.width) || 0);
          hit[1] = Math.max(hit[1], parseFloat(ps.height) || 0);
        }
      }
      // Touch screens, not a width guess: the iPad Pro 11" (834px) is a touch viewport too.
      if (touch && (hit[0] < 24 || hit[1] < 24) && r.top < vh * 3 && !(el.tagName === "A" && cs.display === "inline")) {
        const painted = `${Math.round(r.width)}x${Math.round(r.height)}`;
        const eff = `${Math.round(hit[0])}x${Math.round(hit[1])}`;
        add("small-tap-target", el, eff === painted ? `${painted}px < 24x24`
          : `${eff}px effective hit area (${painted}px painted + ::before/::after) < 24x24`);
      }
    }
  }

  // 5. Invisible but still tappable: a control faded to (near) opacity 0 — by itself or via an
  // ancestor — that still takes pointer events and is the topmost element at its centre. The
  // classic "dismissed toast/undo bar whose button keeps eating taps" (found twice in the
  // rollout, both major). The main loop skips invisible elements, so this is its own pass.
  const INTERACTIVE = "a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link]";
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    if (issues.length >= MAX) break;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || cs.pointerEvents === "none") continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) continue;  // 1x1 visually-hidden (skip-link) pattern
    const alpha = alphaOf(el);
    if (alpha > 0.05) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) continue;
    const top = document.elementFromPoint(cx, cy);
    if (top && (el === top || el.contains(top))) {
      add("invisible-hit-target", el, `opacity ${alpha.toFixed(2)} but still receives taps at ${Math.round(cx)},${Math.round(cy)}`);
    }
  }

  // 6. Interactive elements overlapping each other (one covers the other's hit area).
  for (let i = 0; i < interactive.length && issues.length < MAX; i++) {
    for (let j = i + 1; j < interactive.length; j++) {
      const a = interactive[i], b = interactive[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ix > 4 && iy > 4) {
        // Hit-test the middle of the overlap: if something else is on top there (an open
        // modal/sheet/backdrop covering both), neither control is reachable, so they don't
        // collide. Off-viewport points can't be hit-tested; judge those on geometry alone.
        const cx = Math.max(a.r.left, b.r.left) + ix / 2, cy = Math.max(a.r.top, b.r.top) + iy / 2;
        const top = (cx >= 0 && cy >= 0 && cx < vw && cy < vh) ? document.elementFromPoint(cx, cy) : null;
        if (top && !a.el.contains(top) && !b.el.contains(top) && !top.contains(a.el) && !top.contains(b.el)) continue;
        add("overlapping-controls", a.el, `overlaps ${sel(b.el)} by ${Math.round(ix)}x${Math.round(iy)}px`);
        break;
      }
    }
  }
  // 7. Touch devices: iOS Safari zooms the whole page when a field whose text is < 16px gets
  //    focus (and doesn't zoom back). Deterministic cause, so check it at every mark.
  if (navigator.maxTouchPoints > 0) {
    for (const el of document.querySelectorAll(
        "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=range])" +
        ":not([type=button]):not([type=submit]):not([type=color]):not([type=file]),textarea,select")) {
      if (el.closest('[inert],[aria-hidden="true"]')) continue;
      const cs = getComputedStyle(el);
      if (!visible(el, cs) || el.disabled) continue;
      const px = parseFloat(cs.fontSize);
      if (px < 16) add("ios-input-zoom", el, `font-size ${px}px < 16px: iOS zooms the page when this field is focused`);
    }
  }

  // 8. On-screen keyboard (simulated by keyboard.js on touch viewports) is open: what does it hide?
  const kb = window.__vdKeyboard;
  if (kb && kb.open) {
    const kbTop = window.innerHeight - kb.height;
    const f = document.activeElement;
    if (f && f !== document.body) {
      const fr = f.getBoundingClientRect();
      if (fr.height > 0 && fr.bottom > kbTop + 1) {
        add("keyboard-covers-focus", f, `field being typed in ends at ${Math.round(fr.bottom)}px, keyboard starts at ${Math.round(kbTop)}px`);
      }
    }
    // Page content under the keyboard can be scrolled up; fixed/sticky controls can't.
    const pinned = (el) => {
      for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
        const pos = getComputedStyle(p).position;
        if (pos === "fixed" || pos === "sticky") return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll("a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link]")) {
      if (el === f || el.closest("#__vd_keyboard") || el.closest('[inert],[aria-hidden="true"]')) continue;
      const cs = getComputedStyle(el);
      if (!visible(el, cs) || !pinned(el)) continue;
      const r = el.getBoundingClientRect();
      const hidden = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, kbTop);
      if (hidden > r.height / 2) {
        add("keyboard-covers-control", el, `pinned control: ${Math.round(hidden)} of ${Math.round(r.height)}px behind the open keyboard`);
      }
    }
  }
  return issues;
})()
