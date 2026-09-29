/* video-debugger flow recorder (Phase 1) — framework-agnostic, no dependencies.
 *
 * Captures SEMANTIC intent events (route changes, clicks, submits, coarse scroll,
 * JS errors) — not a DOM replay. That is deliberate: the goal is to mine which paths
 * users actually take so an agent can write Playwright flows for them, and intent
 * events mine cleanly while rrweb-style DOM snapshots are heavy and full of PII.
 *
 * Privacy contract (keep it when you adapt this file):
 *   - Input VALUES are never sent — only the field kind and length. The one exception
 *     is <select>/radio/checkbox elements the app opts in with data-vd-capture-value.
 *   - Query-string VALUES are stripped from paths (keys kept: ?q=&page=).
 *   - Anything under [data-vd-mask] reports no accessible name.
 *   - Session ids are random per tab session, never tied to a user id.
 *
 * Install: serve this file and add, in the app shell,
 *   <script src="/static/vd-recorder.js" data-endpoint="/api/_vd/events"
 *           data-sample="1.0" defer></script>
 * Turn it off without a deploy by serving data-sample="0".
 */
(function () {
  "use strict";
  var script = document.currentScript || {};
  var ds = script.dataset || {};
  var cfg = Object.assign(
    { endpoint: "/api/_vd/events", sample: 1, flushMs: 5000, maxBatch: 50 },
    { endpoint: ds.endpoint, sample: ds.sample != null ? parseFloat(ds.sample) : undefined },
    window.VD_CAPTURE || {}
  );
  Object.keys(cfg).forEach(function (k) { if (cfg[k] === undefined) delete cfg[k]; });
  if (cfg.endpoint === undefined) cfg.endpoint = "/api/_vd/events";
  if (navigator.webdriver && !cfg.captureAutomation) return; // don't mine our own Playwright runs

  var KEY = "vd_session";
  var state;
  try { state = JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { state = null; }
  if (!state) {
    var id = "";
    var bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes.forEach(function (b) { id += ("0" + b.toString(16)).slice(-2); });
    state = { id: id, start: Date.now(), seq: 0, on: Math.random() < (cfg.sample == null ? 1 : cfg.sample) };
  }
  function save() { try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode */ } }
  save();
  if (!state.on) return;

  var queue = [];
  function cleanPath() {
    var q = location.search ? "?" + location.search.slice(1).split("&").map(function (kv) { return kv.split("=")[0] + "="; }).join("&") : "";
    return location.pathname + q;
  }
  function cssPath(el) {
    var parts = [];
    while (el && el.nodeType === 1 && parts.length < 4) {
      var p = el.tagName.toLowerCase();
      if (el.classList && el.classList.length) p += "." + Array.prototype.slice.call(el.classList, 0, 2).join(".");
      parts.unshift(p);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }
  function accName(el) {
    if (el.closest && el.closest("[data-vd-mask]")) return null;
    var n = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt");
    if (!n && el.labels && el.labels[0]) {
      // A wrapping <label> contains the control itself: drop it, or a <select>'s name would
      // be "Plan basicpro" (every option's text) — a useless locator and a content leak.
      var lab = el.labels[0].cloneNode(true);
      Array.prototype.forEach.call(lab.querySelectorAll("select,input,textarea"), function (c) { c.remove(); });
      n = lab.textContent;
    }
    if (!n && /^(BUTTON|A|SUMMARY|OPTION|LABEL)$/.test(el.tagName)) n = el.textContent;
    return n ? n.replace(/\s+/g, " ").trim().slice(0, 60) : null;
  }
  // Locator hints in the order Playwright prefers: testid > role+name > id > css.
  function target(el) {
    var act = el.closest ? el.closest("a,button,[role],input,select,textarea,summary,label,[data-testid]") || el : el;
    // kiwifs: ids under [data-vd-mask] are content-derived (heading anchors), so drop them too.
    var masked = act.closest && act.closest("[data-vd-mask]");
    var id = !masked && act.id && !/\d{3,}|^[a-f0-9-]{16,}$/i.test(act.id) ? act.id : null; // skip generated ids
    return {
      testid: act.getAttribute("data-testid"),
      role: act.getAttribute("role") || ({ A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox" })[act.tagName] || null,
      name: accName(act), id: id, tag: act.tagName.toLowerCase(), css: cssPath(act)
    };
  }
  function push(type, extra) {
    extra = extra || {};
    queue.push({ seq: state.seq++, t: Date.now() - state.start, type: type, path: cleanPath(), target: extra.target, data: extra.data });
    save();
    if (queue.length >= cfg.maxBatch) flush(false);
  }
  function flush(unloading) {
    if (!queue.length) return;
    var body = JSON.stringify({ session_id: state.id, viewport: { w: innerWidth, h: innerHeight }, events: queue.splice(0, queue.length) });
    if (unloading && navigator.sendBeacon) { navigator.sendBeacon(cfg.endpoint, new Blob([body], { type: "application/json" })); return; }
    fetch(cfg.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: body, keepalive: true }).catch(function () {});
  }

  // Route changes: full loads, SPA history API, hash routing.
  var lastPath = null;
  function nav(kind) { var p = cleanPath(); if (p !== lastPath) { lastPath = p; push("nav", { data: { kind: kind, title: document.title.slice(0, 80) } }); } }
  ["pushState", "replaceState"].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); setTimeout(function () { nav(m); }, 0); return r; };
  });
  addEventListener("popstate", function () { nav("popstate"); });
  addEventListener("hashchange", function () { nav("hash"); });
  nav("load");

  document.addEventListener("click", function (e) {
    var t = e.target; if (!t || t.nodeType !== 1) return;
    push("click", { target: target(t), data: { x: Math.round(e.clientX / innerWidth * 100), y: Math.round(e.clientY / innerHeight * 100) } });
  }, true);
  document.addEventListener("change", function (e) {
    var el = e.target; if (!el || !el.tagName) return;
    var kind = el.type || el.tagName.toLowerCase();
    if (/^(text|email|password|search|tel|url|number|textarea)$/.test(kind)) {
      push("input", { target: target(el), data: { kind: kind, length: (el.value || "").length } }); // never the value
    } else {
      var v = el.hasAttribute("data-vd-capture-value") ? String(el.type === "checkbox" ? el.checked : el.value).slice(0, 60) : undefined;
      push("change", { target: target(el), data: { kind: kind, value: v } });
    }
  }, true);
  document.addEventListener("submit", function (e) { push("submit", { target: target(e.target) }); }, true);

  var maxDepth = 0, scrollTimer = null;
  addEventListener("scroll", function () {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = null;
      var h = document.documentElement.scrollHeight - innerHeight;
      var d = h > 0 ? Math.round(scrollY / h * 100) : 100;
      if (d >= maxDepth + 25) { maxDepth = d; push("scroll", { data: { depth_pct: d } }); } // quartiles only
    }, 1000);
  }, { passive: true });
  var resizeTimer = null;
  addEventListener("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(function () { push("resize", { data: { w: innerWidth, h: innerHeight } }); }, 500); });
  addEventListener("error", function (e) { push("error", { data: { message: String(e.message || "error").slice(0, 200), source: String(e.filename || "").split("?")[0].slice(-120) } }); });

  setInterval(function () { flush(false); }, cfg.flushMs);
  addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(true); });
  addEventListener("pagehide", function () { flush(true); });
})();
