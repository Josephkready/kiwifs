// video-debugger on-screen keyboard. vdebug.py injects this into every page on touch
// viewports (iPhone / iPad presets) with __VD_KB_HEIGHT__ replaced by the device's keyboard
// height in CSS px. Headless Chrome never shows an OS keyboard, so without this, recordings
// can't catch the most common mobile bugs: a field hidden behind the keyboard, a fixed "Send"
// bar stuck underneath it, or content that jumps when it opens.
//
// It models what iOS Safari and Android Chrome (default `resizes-visual` mode) do when a text
// field gains focus:
//   - the LAYOUT viewport keeps its size, so `position:fixed; bottom:0` elements stay at the
//     real bottom of the screen, i.e. under the keyboard;
//   - the VISUAL viewport shrinks by the keyboard height: window.visualViewport.height drops and
//     visualViewport fires "resize", so apps that lift their UI on that event behave as on
//     a device;
//   - the focused field is brought up to sit just above the keyboard: its nearest scrollable
//     ancestor is scrolled first, then the page (keyboard-height scroll room is added while
//     open: a phone can pan even the last field on the page up). The page is NOT scrolled when
//     the field has a fixed/sticky ancestor: scrolling can't move it, and would only leave a
//     stray page scroll behind. Any page scroll added here is undone when the keyboard closes.
// A grey keyboard panel is drawn over the bottom of the screen, so it shows up in the video and
// the screenshots. It lives in the top layer (a manual popover), so a modal <dialog>'s
// ::backdrop can't paint over (and blur) it. It has pointer-events:none, so flows can still
// click; the DOM checks (layout_checks.js: keyboard-covers-focus, keyboard-covers-control)
// report what it hides. Blur (tapping a button or anything else that takes focus) closes it,
// as on a phone. There is no Escape handling: phones have no Escape key.
//
// Not modelled: Android `interactive-widget=resizes-content` (the layout viewport shrinks),
// iOS home-screen PWA (display: standalone) quirks, hardware keyboards, and the iOS
// focus-zoom itself (layout_checks.js flags its cause instead: inputs under 16px).
// Also not modelled: real iOS PANS the visual viewport (visualViewport.offsetTop > 0) to bring
// a field in a fixed or scroll-locked (`body{position:fixed}`) page above the keyboard. Here
// the visual viewport never pans, so a field in a fixed bottom sheet with no scroller of its
// own stays under the panel and keyboard-covers-focus fires where iOS would have panned it into
// view. Treat that hit as "iOS pans, other engines may not". The pan only lifts the focused
// field to just above the keyboard, though: the sheet's buttons below it stay under the
// keyboard on the phone too, so keyboard-covers-control on them is still a real bug.
(() => {
  if (window.__vdKeyboardInstalled) return;
  window.__vdKeyboardInstalled = true;
  const H = __VD_KB_HEIGHT__;
  const TEXT = [
    "input:not([type])", "input[type=text]", "input[type=email]", "input[type=search]",
    "input[type=tel]", "input[type=url]", "input[type=number]", "input[type=password]",
    "textarea", "[contenteditable='']", "[contenteditable=true]",
  ].join(",");
  const isText = (el) => !!(el && el.matches && el.matches(TEXT) && !el.disabled && !el.readOnly);
  const vv = window.visualViewport;
  let panel = null;
  let room = null;  // extra scroll room: a phone can pan even the page's last field above the keyboard
  let pageScrolled = 0;  // page scroll WE added while open; undone on close so no stray scroll is left

  function setVisualHeight(open) {
    window.__vdKeyboard = open ? { open: true, height: H, top: window.innerHeight - H } : { open: false };
    if (!vv) return;
    try {
      Object.defineProperty(vv, "height", {
        configurable: true,
        get: () => (open ? Math.max(0, window.innerHeight - H) : window.innerHeight),
      });
    } catch (e) { /* non-configurable in this engine: apps just won't see the change */ }
    vv.dispatchEvent(new Event("resize"));
  }

  function drawPanel() {
    // Inline display:flex also beats the UA's `[popover]:not(:popover-open) {display:none}`, so
    // the panel still shows when the popover API is missing or refuses (the fallback).
    const p = document.createElement("div");
    p.id = "__vd_keyboard";
    p.setAttribute("aria-hidden", "true");
    // popover="manual": shown into the top layer by raise(). A popover never light-dismisses in
    // manual mode, and the explicit inset/margin/border/width/overflow below override the UA's
    // centred [popover] box. z-index only matters for the no-popover fallback.
    p.setAttribute("popover", "manual");
    p.style.cssText = [
      "position:fixed", "inset:auto 0 0 0", "margin:0", "width:auto", `height:${H}px`, "max-width:none",
      "max-height:none", "overflow:hidden", "z-index:2147483647", "color:inherit",
      "pointer-events:none", "box-sizing:border-box", "padding:8px 4px",
      "background:#d1d4db", "border:0", "border-top:1px solid #aab", "display:flex", "flex-direction:column", "gap:10px",
    ].join(";");
    for (const n of [10, 9, 9, 5]) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;justify-content:center;flex:1";
      for (let i = 0; i < n; i++) {
        const key = document.createElement("div");
        key.style.cssText = `flex:${n === 5 && i === 2 ? 5 : 1};max-width:${n === 5 && i === 2 ? "none" : "42px"};` +
          "background:#fff;border-radius:5px;box-shadow:0 1px 0 #889";
        row.appendChild(key);
      }
      p.appendChild(row);
    }
    return p;
  }

  // Put the panel on top of everything, including a modal <dialog> and its ::backdrop. The top
  // layer is ordered by insertion, so re-show it on every open: a dialog opened while the
  // keyboard was already up would otherwise sit above it. Without popover support the fixed,
  // max-z-index panel is the fallback (a modal backdrop can then paint over it).
  function raise() {
    if (!panel.showPopover) return;
    try {
      if (panel.matches(":popover-open")) panel.hidePopover();
      panel.showPopover();
    } catch (e) { /* not connected / engine refuses: stay a plain fixed panel */ }
  }

  // The field's nearest scrollable ancestor below <body>, and whether a fixed/sticky ancestor
  // pins it. The walk stops at body/html: a scroll lock (`body{position:fixed}`) is not a
  // pinned container, it's the page.
  function containers(field) {
    let scroller = null, pinned = false;
    for (let p = field.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (!scroller && /(auto|scroll|overlay)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 1) scroller = p;
      if (cs.position === "fixed" || cs.position === "sticky") pinned = true;
    }
    return { scroller, pinned };
  }

  // How far `field` must move up (+) or down (-) to sit in the visible area above the keyboard.
  function overshoot(field) {
    const r = field.getBoundingClientRect();
    const limit = window.innerHeight - H - 12;
    if (r.bottom > limit) return r.bottom - limit;
    if (r.top < 0) return r.top - 12;
    return 0;
  }

  function open(field) {
    if (!panel) {
      panel = drawPanel();
      document.documentElement.appendChild(panel);
      room = document.createElement("div");
      room.id = "__vd_keyboard_room";
      room.setAttribute("aria-hidden", "true");
      room.style.cssText = `height:${H}px;pointer-events:none`;
      (document.body || document.documentElement).appendChild(room);
    }
    raise();
    setVisualHeight(true);
    // Like the phone: bring the field into the visible area above the keyboard. Its own
    // scroller first (a sheet's body, a chat log): the page scrolling can't reveal a field
    // inside a fixed panel, and leaves the page scrolled for no reason after the keyboard closes.
    requestAnimationFrame(() => {
      const { scroller, pinned } = containers(field);
      let d = overshoot(field);
      if (d && scroller) {
        scroller.scrollTop += d;
        d = overshoot(field);
      }
      if (d && !pinned) {
        const before = window.scrollY;
        window.scrollBy(0, d);
        pageScrolled += window.scrollY - before;
      }
    });
  }

  function close() {
    // Undo our page scroll BEFORE the scroll room goes: removing it can clamp scrollY, and the
    // target is computed against the page as it was while open.
    const target = window.scrollY - pageScrolled;
    pageScrolled = 0;
    if (panel) {
      panel.remove();
      panel = null;
      room.remove();
      room = null;
    }
    if (target !== window.scrollY) window.scrollTo(window.scrollX, Math.max(0, target));
    setVisualHeight(false);
  }

  document.addEventListener("focusin", (e) => { if (isText(e.target)) open(e.target); }, true);
  document.addEventListener("focusout", () => {
    // Focus moving between fields keeps the keyboard up; anywhere else closes it.
    setTimeout(() => { if (!isText(document.activeElement)) close(); }, 0);
  }, true);
  window.__vdKeyboard = { open: false };
})();
