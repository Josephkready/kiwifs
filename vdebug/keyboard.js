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
//   - the page scrolls so the focused field sits just above the keyboard (keyboard-height
//     scroll room is added while open: a phone can pan even the last field on the page up).
// A grey keyboard panel is drawn over the bottom of the screen, so it shows up in the video and
// the screenshots. It has pointer-events:none, so flows can still click; the DOM checks
// (layout_checks.js: keyboard-covers-focus, keyboard-covers-control) report what it hides.
// Blur (tapping a button, pressing Escape) closes it, as on a phone.
//
// Not modelled: Android `interactive-widget=resizes-content` (the layout viewport shrinks),
// iOS home-screen PWA (display: standalone) quirks, hardware keyboards, and the iOS
// focus-zoom itself (layout_checks.js flags its cause instead: inputs under 16px).
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
    const p = document.createElement("div");
    p.id = "__vd_keyboard";
    p.setAttribute("aria-hidden", "true");
    p.style.cssText = [
      "position:fixed", "left:0", "right:0", "bottom:0", `height:${H}px`, "z-index:2147483647",
      "pointer-events:none", "box-sizing:border-box", "padding:8px 4px",
      "background:#d1d4db", "border-top:1px solid #aab", "display:flex", "flex-direction:column", "gap:10px",
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
    setVisualHeight(true);
    // Like the phone: bring the field into the visible area above the keyboard.
    requestAnimationFrame(() => {
      const r = field.getBoundingClientRect();
      const limit = window.innerHeight - H - 12;
      if (r.bottom > limit) window.scrollBy(0, r.bottom - limit);
      else if (r.top < 0) window.scrollBy(0, r.top - 12);
    });
  }

  function close() {
    if (panel) {
      panel.remove();
      panel = null;
      room.remove();
      room = null;
    }
    setVisualHeight(false);
  }

  document.addEventListener("focusin", (e) => { if (isText(e.target)) open(e.target); }, true);
  document.addEventListener("focusout", () => {
    // Focus moving between fields keeps the keyboard up; anywhere else closes it.
    setTimeout(() => { if (!isText(document.activeElement)) close(); }, 0);
  }, true);
  window.__vdKeyboard = { open: false };
})();
