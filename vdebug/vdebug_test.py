"""Tests for vdebug.py — pure helpers, plus a real-browser run against a fixture page with
planted layout bugs, and the recorder.js -> flowstore capture round trip (Phase 1 -> 2)."""

import http.server
import json
import pathlib
import sys
import threading

import pytest

HERE = pathlib.Path(__file__).resolve().parent
# Adjust these two when you install into an app (capture.md "Where the files go"):
CAPTURE_DIR = HERE / "capture"                      # dir holding flowstore.py + schema.sql
RECORDER_JS = CAPTURE_DIR / "recorder.js"           # the recorder the app serves
FIXTURE_FLOWS = HERE / "testdata" / "flows"         # fixture flows; never your app's flows/
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(CAPTURE_DIR))
import vdebug  # noqa: E402
from flowstore import FlowStore  # noqa: E402


# ------------------------------------------------------------------ pure
def test_parse_viewports_mixes_all_with_custom():
    vps = vdebug.parse_viewports("all,kiosk=2560x1600,mobile")   # "mobile" is an alias of iphone-13-pro
    assert [v.name for v in vps] == ["iphone-13-pro", "ipad-pro-11", "2k", "4k", "half-2k", "third-4k", "kiosk"]


def test_reset_cmd_errors_are_reported():
    assert vdebug.run_reset("true") is None
    assert vdebug.run_reset("echo nope >&2; exit 3") == "reset-cmd exited 3: nope"


def test_parse_viewports_dedups_a_repeated_custom_spec():
    assert [v.name for v in vdebug.parse_viewports("kiosk=2560x1600,kiosk=2560x1600")] == ["kiosk"]


def test_parse_viewports_presets_custom_and_all():
    assert [(v.name, v.width, v.height, v.mobile) for v in vdebug.parse_viewports("all")] == [
        ("iphone-13-pro", 390, 844, True), ("ipad-pro-11", 834, 1194, True), ("2k", 2560, 1440, False),
        ("4k", 3840, 2160, False), ("half-2k", 1280, 1440, False), ("third-4k", 1280, 2160, False)]
    assert [v.name for v in vdebug.parse_viewports("mobile,tablet,desktop,ultrawide")] == [
        "iphone-13-pro", "ipad-pro-11", "2k", "4k"]                   # old generic names still work
    se, big = vdebug.parse_viewports("phone-se=320x568, 1920x1080")
    assert (se.name, se.width, se.mobile) == ("phone-se", 320, True)
    assert (big.name, big.mobile) == ("1920x1080", False)
    with pytest.raises(ValueError):
        vdebug.parse_viewports("watch")


def test_video_size_caps_long_edge_and_stays_even():
    assert vdebug.video_size(vdebug.VIEWPORTS["iphone-13-pro"]) == {"width": 390, "height": 844}
    assert vdebug.video_size(vdebug.VIEWPORTS["4k"]) == {"width": 1920, "height": 1080}
    assert vdebug.video_size(vdebug.VIEWPORTS["third-4k"]) == {"width": 1136, "height": 1920}


def _write_flow(d, name, body="def run(page, vd):\n    pass\n", extra=""):
    (d / f"{name.replace('-', '_')}.py").write_text(f'NAME = "{name}"\n{extra}\n{body}')


def test_load_flows_contract(tmp_path):
    _write_flow(tmp_path, "a", extra='VIEWPORTS = ["mobile"]\nSOURCE = "mined:abc"')
    (tmp_path / "_helpers.py").write_text("x = 1\n")
    (tmp_path / "a_test.py").write_text("")
    [f] = vdebug.load_flows(tmp_path)
    assert (f.name, f.viewports, f.source, f.start) == ("a", ["mobile"], "mined:abc", "/")
    assert vdebug.select_flows([f], ["a*"]) == [f]
    with pytest.raises(ValueError):
        vdebug.select_flows([f], ["zzz"])
    (tmp_path / "b.py").write_text('NAME = "a"\ndef run(page, vd): pass\n')
    with pytest.raises(ValueError, match="duplicate"):
        vdebug.load_flows(tmp_path)


def test_load_flows_requires_run(tmp_path):
    (tmp_path / "x.py").write_text('NAME = "x"\n')
    with pytest.raises(ValueError, match="run"):
        vdebug.load_flows(tmp_path)


def test_exit_code_levels():
    ok = {"runs": [{"checks": [], "error": None, "judge": {"findings": [{"severity": "minor"}]}}]}
    hit = {"runs": [{"checks": [{"check": "x"}], "error": None}]}
    major = {"runs": [{"checks": [], "error": None, "judge": {"findings": [{"severity": "major"}]}}]}
    crash = {"runs": [{"checks": [], "error": "boom"}]}
    assert [vdebug.exit_code(ok, m) for m in ("error", "check", "major")] == [0, 0, 0]
    assert [vdebug.exit_code(hit, m) for m in ("error", "check", "major")] == [0, 1, 0]
    assert [vdebug.exit_code(major, m) for m in ("error", "check", "major")] == [0, 1, 1]
    assert vdebug.exit_code(crash, "error") == 1 and vdebug.exit_code(crash, "never") == 0


# ------------------------------------------------------------------ real browser
@pytest.fixture(scope="module")
def app(tmp_path_factory):
    """Fixture app: broken.html at /, recorder.js, and a flowstore-backed POST /ingest."""
    db = tmp_path_factory.mktemp("cap") / "flows.db"
    FlowStore(db).close()
    page_html = (HERE / "testdata" / "broken.html").read_bytes()
    keyboard_html = (HERE / "testdata" / "keyboard.html").read_bytes()
    recorder = RECORDER_JS.read_bytes()

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path.startswith("/recorder.js"):
                body, ctype = recorder, "text/javascript"
            elif self.path.startswith("/keyboard"):
                body, ctype = keyboard_html, "text/html"
            else:
                body, ctype = page_html, "text/html"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if not self.path.startswith("/ingest"):          # the fixture's real <form method=post>
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.end_headers()
                self.wfile.write(b"<p>thanks</p>")
                return
            store = FlowStore(db)
            try:
                store.ingest(json.loads(raw), user_agent=self.headers.get("User-Agent"))
                self.send_response(204)
            except ValueError:
                self.send_response(400)
            finally:
                store.close()
            self.end_headers()

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", db
    srv.shutdown()


@pytest.mark.browser  # real Chromium
def test_record_matrix_finds_planted_bugs(app, tmp_path):
    base, _ = app
    flows = vdebug.select_flows(vdebug.load_flows(FIXTURE_FLOWS), ["home-nav"])
    vps = vdebug.parse_viewports("mobile,desktop")
    run_dir = vdebug.record(flows, vps, base, tmp_path / "runs", log=lambda m: None)
    report = json.loads((run_dir / "report.json").read_text())
    assert (tmp_path / "runs" / "latest").resolve() == run_dir.resolve()
    by_vp = {e["viewport"]: e for e in report["runs"]}
    assert set(by_vp) == {"iphone-13-pro", "2k"}
    for e in by_vp.values():
        assert e["error"] is None, e["error"]
        assert (run_dir / e["video"]).stat().st_size > 1000
        assert all((run_dir / f["path"]).exists() for f in e["frames"])
    # Mobile takes the hamburger branch; desktop does not.
    assert [f["label"] for f in by_vp["iphone-13-pro"]["frames"]] == ["start", "nav open", "first nav page", "end"]
    assert [f["label"] for f in by_vp["2k"]["frames"]] == ["start", "first nav page", "end"]

    mobile = {c["check"] for c in by_vp["iphone-13-pro"]["checks"]}
    desktop = {c["check"] for c in by_vp["2k"]["checks"]}
    assert {"horizontal-overflow", "offscreen-right", "small-tap-target", "text-overflow"} <= mobile
    assert "horizontal-overflow" not in desktop and "small-tap-target" not in desktop
    assert "text-overflow" in desktop  # the fixed-width button is broken at every size
    for checks in (mobile, desktop):   # fixed-size planted bugs, broken at every size
        assert {"text-clipped", "overlapping-controls"} <= checks
    clipped = next(c for c in by_vp["2k"]["checks"] if c["check"] == "text-clipped")
    assert "clip-label" in clipped["selector"]
    overlap = next(c for c in by_vp["2k"]["checks"] if c["check"] == "overlapping-controls")
    assert "chip" in overlap["selector"] and "chip" in overlap["detail"]
    # planted NON-bugs stay quiet
    for e in by_vp.values():
        sels = {(c["check"], c["selector"] or "") for c in e["checks"]}
        assert not any(sel and "sr-only" in sel for chk, sel in sels), sels
        assert not any(chk == "text-overflow" and "icon-btn" in sel for chk, sel in sels)
        assert not any(chk == "small-tap-target" and "hit-expanded" in sel for chk, sel in sels)
        assert not any(chk == "overlapping-controls" and "under-" in sel for chk, sel in sels)
        assert not any("park-" in sel for chk, sel in sels)                       # inert, parked off-screen
        assert not any("ghost-ok" in sel for chk, sel in sels)                    # hidden AND pointer-events:none
        assert any(chk == "invisible-hit-target" and "ghost-undo" in sel for chk, sel in sels)  # still eats taps
        assert not any(chk == "text-overflow" and "deco" in sel for chk, sel in sels)  # ::after decoration
    assert any(c["check"] == "small-tap-target" and "icon-btn" in (c["selector"] or "")
               for c in by_vp["iphone-13-pro"]["checks"])  # the icon button IS too small to tap
    offender = next(c for c in by_vp["iphone-13-pro"]["checks"] if c["check"] == "offscreen-right")
    assert "hero-banner" in offender["selector"]
    # A static defect is reported once, with every checkpoint it was seen at.
    assert offender["frame"] == "start" and offender["frames"] == ["start", "nav open", "first nav page", "end"]
    keys = [(c["check"], c["selector"]) for c in by_vp["iphone-13-pro"]["checks"]]
    assert len(keys) == len(set(keys))
    for c in by_vp["iphone-13-pro"]["checks"]:         # no repeated consecutive mark labels
        assert all(a != b for a, b in zip(c["frames"], c["frames"][1:], strict=False)), c

    md = vdebug.write_markdown(run_dir, report).read_text()
    assert "| home-nav | iphone-13-pro 390x844 |" in md and "horizontal-overflow" in md


@pytest.mark.browser  # real Chromium
def test_crashing_flow_is_recorded_not_fatal(app, tmp_path):
    base, _ = app
    _write_flow(tmp_path, "boom", body="def run(page, vd):\n    page.click('#does-not-exist', timeout=500)\n")
    [flow] = vdebug.load_flows(tmp_path)
    run_dir = vdebug.record([flow], vdebug.parse_viewports("desktop"), base, tmp_path / "runs", log=lambda m: None)
    [e] = json.loads((run_dir / "report.json").read_text())["runs"]
    assert e["error"].startswith("TimeoutError")
    assert "does-not-exist" in e["error"]              # Playwright's call log (names the locator) is kept
    assert e["frames"][-1]["label"] == "error" and e["video"]


@pytest.mark.browser  # real Chromium
def test_recorder_round_trip_into_flowstore(app):
    """recorder.js in a real browser -> POST -> flowstore, with no input value leaking."""
    from playwright.sync_api import sync_playwright

    base, db = app
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 375, "height": 667})
        page.add_init_script("window.VD_CAPTURE = {captureAutomation: true, flushMs: 200};")
        page.goto(base + "/?q=secret-search")
        page.get_by_role("button", name="Menu").click()
        page.get_by_test_id("nav-products").click()
        page.get_by_label("Email").fill("person@example.com")
        page.get_by_label("Email").dispatch_event("change")
        page.get_by_label("Plan").select_option("pro")          # opted in: value captured
        page.get_by_label("Newsletter").check()                 # not opted in: value withheld
        page.get_by_role("button", name="Sign up").click()
        page.wait_for_timeout(800)
        b.close()
    store = FlowStore(db)
    try:
        [sid] = [r[0] for r in store.db.execute("SELECT id FROM sessions")]
        events = store.session_events(sid)
        dump = json.dumps(events)
        assert "person@example.com" not in dump and "secret-search" not in dump
        assert events[0]["type"] == "nav" and events[0]["path"] == "/?q="
        types = [e["type"] for e in events]
        assert {"click", "input", "submit"} <= set(types)
        changes = {e["target"].get("name") or e["target"].get("tag"): e["data"] for e in events if e["type"] == "change"}
        assert changes["Plan"] == {"kind": "select-one", "value": "pro"}
        assert changes["Newsletter"] == {"kind": "checkbox"}   # no "value" key without the opt-in
        email = next(e for e in events if e["type"] == "input")
        assert email["data"] == {"kind": "email", "length": len("person@example.com")}
        clicked = [e["target"] for e in events if e["type"] == "click"]
        assert {"role": "button", "name": "Menu"}.items() <= clicked[0].items()
        assert any(t.get("testid") == "nav-products" for t in clicked)
        assert store.db.execute("SELECT ua_class FROM sessions").fetchone()[0] == "mobile"
    finally:
        store.close()


@pytest.mark.browser  # real Chromium
def test_basket_toast_fixture_flow_marks_the_settled_state(app, tmp_path):
    """The motion probe: the checkpoint must be taken AFTER the toast animation finishes."""
    base, _ = app
    [flow] = vdebug.select_flows(vdebug.load_flows(FIXTURE_FLOWS), ["basket-toast"])
    run_dir = vdebug.record([flow], vdebug.parse_viewports("desktop"), base, tmp_path / "runs", log=lambda m: None)
    [e] = json.loads((run_dir / "report.json").read_text())["runs"]
    assert e["error"] is None and [f["label"] for f in e["frames"]] == ["start", "added to basket", "end"]
    toast_mark = e["frames"][1]["t"] - e["frames"][0]["t"]
    assert toast_mark >= 1.0  # the 1s entry animation had finished before the frame was taken


def test_cli_judge_wiring_passes_fps_and_model(tmp_path, monkeypatch, capsys):
    """record --judge reaches judge.judge_run with --fps/--model; --judge-mode no longer exists."""
    import judge
    run_dir = tmp_path / "runs" / "r1"
    run_dir.mkdir(parents=True)
    (run_dir / "report.json").write_text(json.dumps({"run_id": "r1", "base_url": "u", "runs": []}))
    monkeypatch.setattr(vdebug, "record", lambda *a, **k: run_dir)
    seen = {}

    def fake_judge_run(rd, **kw):
        seen.update(kw)
        return {"run_id": "r1", "base_url": "u", "runs": [], "judge": {"model": kw["model"], "fps": kw["fps"],
                                                                       "cost_usd": 0.0}}
    monkeypatch.setattr(judge, "judge_run", fake_judge_run)
    monkeypatch.setenv("OPENROUTER_API_KEY", "k")
    monkeypatch.setattr(vdebug.shutil, "which", lambda name: "/usr/bin/" + name)  # no real ffmpeg needed
    rc = vdebug.main(["--flows-dir", str(FIXTURE_FLOWS), "record", "--base-url", "http://x", "--judge",
                      "--fps", "15", "--model", "m/x"])
    assert rc == 0 and seen["fps"] == 15 and seen["model"] == "m/x"
    assert seen["notes"] == judge.load_notes(vdebug.HERE / "judge_notes.md")
    assert "video frames @ 15 fps" in (run_dir / "report.md").read_text()
    with pytest.raises(SystemExit):
        vdebug.main(["--flows-dir", str(FIXTURE_FLOWS), "record", "--base-url", "http://x", "--judge-mode", "frames"])


def test_report_links_findings_to_the_judges_film_frames(tmp_path):
    report = {"run_id": "r", "base_url": "u", "judge": {"model": "m/x", "fps": 10, "cost_usd": 0.001}, "runs": [{
        "flow": "f", "viewport": "mobile", "width": 375, "height": 667, "video": "f/mobile/video.webm",
        "frames": [{"label": "start", "t": 0.5, "path": "f/mobile/frames/01-start.png"}], "checks": [], "error": None,
        "judge": {"summary": "s", "coverage": {"frames": 2, "reviewed": 1, "missing": ["t=1.20s"]},
                  "film": [{"label": "t=1.20s", "t": 1.2, "path": "f/mobile/film/000012.png"}],
                  "findings": [{"title": "Toast flies", "severity": "major", "category": "animation",
                                "frame": "t=1.20s", "description": "d", "location": "l"}]}}]}
    md = vdebug.write_markdown(tmp_path, report).read_text()
    assert "([frame](f/mobile/film/000012.png))" in md
    assert "no verdict for frames:** t=1.20s" in md



def _record_session(app, actions, init="window.VD_CAPTURE = {captureAutomation: true, flushMs: 200};", url="/"):
    """Run `actions(page)` in a fresh browser with the recorder; return the new sessions' events."""
    from playwright.sync_api import sync_playwright

    base, db = app
    store = FlowStore(db)
    before = {r[0] for r in store.db.execute("SELECT id FROM sessions")}
    store.close()
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 375, "height": 667})
        if init:
            page.add_init_script(init)
        page.goto(base + url)
        actions(page)
        page.wait_for_timeout(700)
        b.close()
    store = FlowStore(db)
    try:
        new = [r[0] for r in store.db.execute("SELECT id FROM sessions") if r[0] not in before]
        return [ev for sid in new for ev in store.session_events(sid)]
    finally:
        store.close()


@pytest.mark.browser  # real Chromium
def test_recorder_mask_withholds_names_positions_and_opted_in_values(app):
    def act(page):
        page.locator(".secret-text").click()                     # masked text inside an outer button
        page.get_by_test_id("secret-pick").click()
        page.get_by_label("Mood").select_option("tense")
        page.locator("#dlg-text").click()
    events = _record_session(app, act)
    dump = json.dumps(events)
    assert "Anxious" not in dump and "tense" not in dump and "Chicken" not in dump
    assert "Private diagnosis" not in dump                    # never climbed out of the mask
    pick = next(e for e in events if e["type"] == "click" and (e["target"] or {}).get("testid") == "secret-pick")
    assert pick["data"] is None                                  # no x/y inside the mask
    assert "id" not in pick["target"] and "anxious-entry" not in dump  # kiwifs: masked ids are content (anchors)
    mood = next(e for e in events if e["type"] == "change")
    assert "value" not in (mood["data"] or {})                  # opted in, but masked
    dlg = next(e for e in events if e["type"] == "click" and (e["target"] or {}).get("tag") == "p")
    assert "name" not in dlg["target"]                           # didn't climb to the dialog's label


@pytest.mark.browser  # real Chromium
def test_recorder_flushes_on_real_form_submit(app):
    events = _record_session(app, lambda page: page.get_by_role("button", name="Send it").click())
    assert any(e["type"] == "submit" for e in events)


@pytest.mark.browser  # real Chromium
@pytest.mark.parametrize("init", [
    "window.VD_CAPTURE = {captureAutomation: true, sample: 0, flushMs: 200};",   # sampled out
    None,                                                                          # automation (webdriver) skipped
])
def test_recorder_stays_silent_when_sampled_out_or_automated(app, init):
    assert _record_session(app, lambda page: page.get_by_test_id("buy").click(), init=init) == []



@pytest.mark.browser  # real Chromium
def test_must_fit_flags_a_page_taller_than_the_viewport(app, tmp_path):
    base, _ = app
    _write_flow(tmp_path, "fit", extra='MUST_FIT = ["mobile"]',
                body="def run(page, vd):\n    page.evaluate(\"document.body.style.minHeight = '3000px'\")\n")
    [flow] = vdebug.load_flows(tmp_path)
    run_dir = vdebug.record([flow], vdebug.parse_viewports("mobile,ultrawide"), base, tmp_path / "runs",
                            log=lambda m: None, reset_cmd=f"touch {tmp_path}/reset-ran")
    by_vp = {e["viewport"]: e for e in json.loads((run_dir / "report.json").read_text())["runs"]}
    assert any(c["check"] == "below-fold" for c in by_vp["iphone-13-pro"]["checks"])  # MUST_FIT=["mobile"] alias
    assert not any(c["check"] == "below-fold" for c in by_vp["4k"]["checks"])          # not requested there
    assert (tmp_path / "reset-ran").exists()


@pytest.mark.browser  # real Chromium
def test_gesture_helpers_drive_real_input():
    """flows/_helpers.py: drag and wheel reach the page; pinch sends real 2-finger touches."""
    from playwright.sync_api import sync_playwright

    sys.path.insert(0, str(HERE / "flows"))
    from _helpers import drag, pinch, wheel_zoom

    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 375, "height": 667}, is_mobile=True, has_touch=True)
        page = ctx.new_page()
        page.set_content("""<div id="pad" style="width:300px;height:300px;background:#ccc"></div><script>
          window.log = {moves: 0, wheel: 0, maxTouches: 0, spread: []};
          const pad = document.getElementById('pad');
          pad.addEventListener('mousemove', e => { if (e.buttons) log.moves++; });
          pad.addEventListener('wheel', e => { log.wheel += e.deltaY; });
          pad.addEventListener('touchmove', e => {
            log.maxTouches = Math.max(log.maxTouches, e.touches.length);
            if (e.touches.length === 2) log.spread.push(Math.abs(e.touches[0].clientX - e.touches[1].clientX));
          });</script>""")
        pad = page.locator("#pad")
        drag(page, pad, 60, 0, steps=6)
        wheel_zoom(page, pad, -120, at=(0.25, 0.75))
        pinch(page, pad, 2.0, steps=5)
        got = page.evaluate("window.log")
        b.close()
    assert got["moves"] >= 5 and got["wheel"] < 0  # mobile emulation scales wheel deltas
    assert got["maxTouches"] == 2 and got["spread"][-1] > got["spread"][0]  # fingers moved apart



@pytest.mark.browser  # real Chromium
def test_recorder_unmask_and_title_opt_in(app):
    events = _record_session(app, lambda page: page.get_by_test_id("send-btn").click())
    send = next(e for e in events if e["type"] == "click" and (e["target"] or {}).get("testid") == "send-btn")
    assert send["target"].get("name") == "Send" and send["data"]         # unmasked: name + position
    assert all("title" not in (e["data"] or {}) for e in events if e["type"] == "nav")   # off by default
    titled = _record_session(app, lambda page: None,
                             init="window.VD_CAPTURE = {captureAutomation: true, flushMs: 200, captureTitle: true};")
    assert next(e for e in titled if e["type"] == "nav")["data"]["title"] == "Fixture Shop"


@pytest.mark.browser  # real Chromium
def test_failed_reset_marks_the_recording_errored(app, tmp_path):
    base, _ = app
    _write_flow(tmp_path, "ok")
    [flow] = vdebug.load_flows(tmp_path)
    run_dir = vdebug.record([flow], vdebug.parse_viewports("desktop"), base, tmp_path / "runs",
                            log=lambda m: None, reset_cmd="echo db locked >&2; exit 1")
    [e] = json.loads((run_dir / "report.json").read_text())["runs"]
    assert e["reset_error"] == "reset-cmd exited 1: db locked"
    assert e["error"].startswith("recorded from UNKNOWN app state") and vdebug.exit_code({"runs": [e]}, "error") == 1



@pytest.mark.browser  # real Chromium
def test_settle_waits_for_finite_animations_and_setup_runs_before_start(app, tmp_path):
    base, _ = app
    marker = tmp_path / "setup-ran"
    (tmp_path / "anim.py").write_text(f"""NAME = "anim"
import time, pathlib
def setup(page, vd):
    pathlib.Path({str(marker)!r}).write_text(str(time.monotonic()))
def run(page, vd):
    page.get_by_test_id("buy").click()
    t = time.monotonic()
    vd.mark("toast")                     # no explicit wait: settle() must wait out the 1s animation
    pathlib.Path({str(marker)!r} + "-mark").write_text(str(time.monotonic() - t))
""")
    [flow] = vdebug.load_flows(tmp_path)
    run_dir = vdebug.record([flow], vdebug.parse_viewports("desktop"), base, tmp_path / "runs", log=lambda m: None)
    [e] = json.loads((run_dir / "report.json").read_text())["runs"]
    assert e["error"] is None and [f["label"] for f in e["frames"]] == ["start", "toast", "end"]
    assert marker.exists()                                        # setup ran (before START's goto)
    assert float((tmp_path / "setup-ran-mark").read_text()) >= 0.9  # mark waited for the animation



@pytest.mark.browser  # real Chromium
def test_custom_viewport_named_like_an_alias_matches_flow_lists(app, tmp_path):
    base, _ = app
    _write_flow(tmp_path, "phone-only", extra='VIEWPORTS = ["iphone-13-pro"]\nMUST_FIT = ["mobile"]',
                body="def run(page, vd):\n    page.evaluate(\"document.body.style.minHeight = '3000px'\")\n")
    [flow] = vdebug.load_flows(tmp_path)
    run_dir = vdebug.record([flow], vdebug.parse_viewports("mobile=400x800,2k"), base, tmp_path / "runs",
                            log=lambda m: None)
    [e] = json.loads((run_dir / "report.json").read_text())["runs"]   # 2k filtered out by VIEWPORTS
    assert e["viewport"] == "mobile" and e["width"] == 400
    assert any(c["check"] == "below-fold" for c in e["checks"])



def test_flow_selection_accepts_comma_lists(tmp_path):
    for n in ("alpha", "beta", "gamma"):
        _write_flow(tmp_path, n)
    flows = vdebug.load_flows(tmp_path)
    assert [f.name for f in vdebug.select_flows(flows, ["alpha,gam*"])] == ["alpha", "gamma"]
    assert [f.name for f in vdebug.select_flows(flows, ["beta", "gamma"])] == ["beta", "gamma"]


def test_helpers_from_another_flows_dir_do_not_shadow(tmp_path):
    for name in ("one", "two"):
        d = tmp_path / name
        d.mkdir()
        (d / "_helpers.py").write_text(f'WHO = "{name}"\n')
        (d / "f.py").write_text(f'NAME = "f-{name}"\nfrom _helpers import WHO\ndef run(page, vd): pass\n')
    vdebug.load_flows(tmp_path / "one")
    [flow] = vdebug.load_flows(tmp_path / "two")
    assert flow.run.__globals__["WHO"] == "two"


@pytest.mark.browser  # real Chromium
def test_per_check_cap_limits_noisy_checks():
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page(viewport={"width": 390, "height": 844})
        page.set_content("<body>" + "".join(f'<button style="width:10px;height:10px">{i}</button>' for i in range(30)))
        hits = page.evaluate(vdebug.LAYOUT_CHECKS_JS)
        b.close()
    assert sum(h["check"] == "small-tap-target" for h in hits) == 15


@pytest.mark.browser  # real Chromium
def test_mark_show_scrolls_the_state_into_view(app, tmp_path):
    base, _ = app
    (tmp_path / "show.py").write_text('''NAME = "show"
def run(page, vd):
    page.evaluate("document.getElementById('real-post').style.marginTop = '3000px'")  # push it far below the fold
    vd.mark("bottom form", show=page.locator("#real-post"))
    assert page.evaluate("window.scrollY") > 0, "show= did not scroll"
''')
    [flow] = vdebug.load_flows(tmp_path)
    run_dir = vdebug.record([flow], vdebug.parse_viewports("iphone-13-pro"), base, tmp_path / "runs", log=lambda m: None)
    [e] = json.loads((run_dir / "report.json").read_text())["runs"]
    assert e["error"] is None and "bottom form" in [f["label"] for f in e["frames"]]


@pytest.mark.browser  # real Chromium
def test_recorder_never_breaks_the_page_and_ignores_malformed_state(app):
    from playwright.sync_api import sync_playwright

    base, db = app
    errors = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_page()
        page.on("pageerror", lambda e: errors.append(str(e)))
        # sabotage the network: a recorder failure must stay inside the recorder
        page.add_init_script("window.VD_CAPTURE = {captureAutomation: true, flushMs: 100};"
                             "window.fetch = () => { throw new Error('boom'); };"
                             "navigator.sendBeacon = () => { throw new Error('boom'); };")
        page.goto(base + "/")
        page.get_by_test_id("buy").click()
        page.wait_for_timeout(400)
        b.close()
    assert not any("boom" in e for e in errors), errors
    # malformed saved state (wrong shape) is replaced, not reused
    events = _record_session(app, lambda page: page.get_by_test_id("buy").click(),
                             init="sessionStorage.setItem('vd_session', JSON.stringify({id: 'x', seq: 'no'}));"
                                  "window.VD_CAPTURE = {captureAutomation: true, flushMs: 200};")
    assert any(e["type"] == "click" for e in events)


@pytest.mark.browser  # real Chromium
def test_tap_target_check_covers_touch_tablets_and_reports_effective_size():
    """ipad-pro-11 (834px, touch) must be checked; the message shows the effective hit area."""
    from playwright.sync_api import sync_playwright

    html = """<style>.x{position:relative;display:inline-block;width:20px;height:16px}
      .x::after{content:"";position:absolute;left:0;top:-14px;width:20px;height:44px}</style>
      <button class="plain" style="width:18px;height:18px">a</button><button class="x">b</button>"""
    with sync_playwright() as p:
        b = p.chromium.launch()
        results = {}
        for name, touch in (("ipad-pro-11", True), ("2k-mouse", False)):
            ctx = b.new_context(viewport={"width": 834, "height": 1194}, is_mobile=touch, has_touch=touch)
            page = ctx.new_page()
            page.set_content(html)
            results[name] = [h for h in page.evaluate(vdebug.LAYOUT_CHECKS_JS) if h["check"] == "small-tap-target"]
            ctx.close()
        b.close()
    assert any("plain" in h["selector"] for h in results["ipad-pro-11"])        # touch tablet: checked
    x = next(h for h in results["ipad-pro-11"] if h["selector"].endswith("button.x"))
    assert x["detail"].startswith("20x44px effective hit area (20x16px painted")  # width still too small
    assert results["2k-mouse"] == []                                             # 834px with a mouse: not a touch target



def test_second_load_moves_its_flows_dir_to_the_front(tmp_path):
    """If dir B was already on sys.path BEHIND dir A, loading B must still put B first."""
    a, b = tmp_path / "a", tmp_path / "b"
    for d in (a, b):
        d.mkdir()
        (d / "_helpers.py").write_text(f'WHO = "{d.name}"\n')
        (d / "f.py").write_text(f'NAME = "f-{d.name}"\nfrom _helpers import WHO\ndef run(page, vd): pass\n')
    vdebug.load_flows(b)
    vdebug.load_flows(a)                          # a is now in front of b
    [flow] = vdebug.load_flows(b)                 # b must move back to the front
    assert flow.run.__globals__["WHO"] == "b"
    assert sys.path[0] == str(b.resolve())


def _kb_flow(d, name, body, extra=""):
    (d / f"{name.replace('-', '_')}.py").write_text(f'NAME = "{name}"\nSTART = "/keyboard"\n{extra}\n{body}')


def _run_kb(app, tmp_path, name, body, viewports="iphone-13-pro", extra=""):
    base, _ = app
    d = tmp_path / name
    d.mkdir()
    _kb_flow(d, name, body, extra)
    [flow] = vdebug.load_flows(d)
    run_dir = vdebug.record([flow], vdebug.parse_viewports(viewports), base, tmp_path / f"runs-{name}", log=lambda m: None)
    return {e["viewport"]: e for e in json.loads((run_dir / "report.json").read_text())["runs"]}


def _checks(entry, label=None):
    return {(c["check"], c["selector"]) for c in entry["checks"] if label is None or label in c["frames"]}


def test_touch_presets_have_keyboards_and_desktops_do_not():
    vps = {v.name: v for v in vdebug.parse_viewports("all,phone=320x568,wide=1920x1080")}
    assert vps["iphone-13-pro"].keyboard == 336 and vps["ipad-pro-11"].keyboard == 360
    assert vps["phone"].keyboard == round(568 * 0.4) and vps["2k"].keyboard == 0 and vps["wide"].keyboard == 0


@pytest.mark.browser  # real Chromium
def test_keyboard_hides_a_fixed_bottom_bar_that_ignores_it(app, tmp_path):
    body = ("def run(page, vd):\n"
            "    page.evaluate(\"window.__vvResizes = 0; visualViewport.addEventListener('resize', () => window.__vvResizes++)\")\n"
            "    page.locator('#msg').click()\n"
            "    vd.mark('typing')\n"
            "    assert page.evaluate('window.visualViewport.height') == 844 - 336\n"
            "    assert page.evaluate('window.__vvResizes') >= 1\n"
            "    assert page.locator('#__vd_keyboard').count() == 1\n"
            "    page.locator('#send').click(force=True)\n"  # blur: tapping a button closes the keyboard
            "    vd.mark('sent')\n"
            "    assert page.locator('#__vd_keyboard').count() == 0\n"
            "    assert page.evaluate('window.visualViewport.height') == 844\n")
    e = _run_kb(app, tmp_path, "kb-bar", body)["iphone-13-pro"]
    assert e["error"] is None, e["error"]
    typing = _checks(e, "typing")
    assert ("keyboard-covers-focus", "#msg") in typing and ("keyboard-covers-control", "#send") in typing
    assert ("keyboard-covers-control", "#draft") in typing          # position:sticky pins it too
    assert not {c for c in _checks(e, "sent") if c[0].startswith("keyboard-")} - typing  # nothing new once closed


@pytest.mark.browser  # real Chromium
def test_keyboard_aware_bar_passes_and_far_field_is_scrolled_into_view(app, tmp_path):
    body = ("def run(page, vd):\n"
            "    vd.goto('/keyboard?aware=1')\n"
            "    page.locator('#msg').click()\n"
            "    vd.mark('aware typing')\n"
            "    page.locator('#late').focus()\n"
            "    vd.mark('late field')\n")
    e = _run_kb(app, tmp_path, "kb-aware", body)["iphone-13-pro"]
    assert e["error"] is None, e["error"]
    assert not any(c[0].startswith("keyboard-") for c in _checks(e, "aware typing"))
    assert ("keyboard-covers-focus", "#late") not in _checks(e, "late field")


@pytest.mark.browser  # real Chromium
def test_ios_input_zoom_flagged_on_touch_only_and_no_keyboard_on_desktop(app, tmp_path):
    body = "def run(page, vd):\n    page.locator('#name').click()\n    vd.mark('focused')\n"
    by = _run_kb(app, tmp_path, "kb-zoom", body, viewports="iphone-13-pro,2k")
    phone, desk = by["iphone-13-pro"], by["2k"]
    assert ("ios-input-zoom", "#note") in _checks(phone) and ("ios-input-zoom", "#name") not in _checks(phone)
    assert not any(c[0] == "ios-input-zoom" for c in _checks(desk))
    assert not any(c[0].startswith("keyboard-") for c in _checks(desk))


@pytest.mark.browser  # real Chromium
def test_flow_can_opt_out_of_the_keyboard(app, tmp_path):
    body = ("def run(page, vd):\n"
            "    page.locator('#msg').click()\n"
            "    assert page.locator('#__vd_keyboard').count() == 0\n"
            "    vd.mark('typing')\n")
    e = _run_kb(app, tmp_path, "kb-off", body, extra="KEYBOARD = False")["iphone-13-pro"]
    assert e["error"] is None, e["error"]
    assert e["keyboard"] is False
    assert not any(c[0].startswith("keyboard-") for c in _checks(e))


@pytest.mark.browser  # real Chromium
def test_checkbox_and_radio_do_not_open_the_keyboard(app, tmp_path):
    body = ("def run(page, vd):\n"
            "    for sel in ('#agree', '#plan-a'):\n"
            "        page.locator(sel).click()\n"
            "        assert page.locator(sel).evaluate('el => el === document.activeElement')\n"
            "        assert page.locator('#__vd_keyboard').count() == 0, sel\n"
            "        assert page.evaluate('window.visualViewport.height') == 844, sel\n"
            "    vd.mark('ticked')\n")
    e = _run_kb(app, tmp_path, "kb-box", body)["iphone-13-pro"]
    assert e["error"] is None, e["error"]
    assert e["keyboard"] is True
    assert not any(c[0].startswith("keyboard-") for c in _checks(e))


def test_judge_prompt_explains_the_simulated_keyboard():
    import judge
    assert "SIMULATED on-screen" in judge.SYSTEM_PROMPT and "keyboard" in judge.SYSTEM_PROMPT


def test_every_marker_is_registered_by_the_copied_conftest():
    """Only `browser` is registered (pytest.ini). A stray `live` passes here, where dante-config
    registers it, and then gets deselected or rejected in the repos the templates are copied to."""
    import re
    for f in (HERE / "vdebug_test.py", HERE / "judge_test.py", CAPTURE_DIR / "flowstore_test.py"):
        used = set(re.findall(r"@pytest\.mark\.(\w+)", f.read_text()))
        assert used <= {"browser", "parametrize"}, (f.name, used)


class _FakePage:
    """Just enough of a Playwright page for VD.mark(): `fail` names which evaluate() raises."""
    url = "http://x/"

    def __init__(self, fail):
        self.fail = fail

    def screenshot(self, path, full_page=False):
        pathlib.Path(path).write_bytes(b"")

    def evaluate(self, js):
        which = "layout" if js is vdebug.LAYOUT_CHECKS_JS else "fit"
        if which == self.fail:
            raise RuntimeError("Execution context was destroyed, most likely because of a navigation")
        return [] if which == "layout" else [3000, 844]


@pytest.mark.parametrize("fail", ["layout", "fit"])
def test_a_check_that_raises_is_reported_as_checks_failed(tmp_path, fail):
    """A navigating page can't be evaluated. The mark must record checks-failed, not crash the
    flow, and a failed layout evaluation must not also swallow the MUST_FIT guard (or vice versa)."""
    vp = vdebug.VIEWPORTS["iphone-13-pro"]
    vd = vdebug.VD(_FakePage(fail), "http://x", vp, tmp_path / "f" / vp.name, tmp_path, must_fit=True)
    vd.mark("m", settle=False)
    by = {c["check"]: c for c in vd.checks}
    assert set(by) == {"checks-failed", "below-fold"} - ({"below-fold"} if fail == "fit" else set())
    assert "Execution context was destroyed" in by["checks-failed"]["detail"]
    assert by["checks-failed"]["detail"].startswith("MUST_FIT") == (fail == "fit")
    assert by["checks-failed"]["frames"] == ["m"]


def _phone_probe(app, query, before=None, after=None, keyboard=True):
    """Open /keyboard<query> on an iPhone-sized touch page (with keyboard.js unless keyboard=False),
    run before(page), take the layout checks, run after(page). -> (hits, before_val, after_val)."""
    from playwright.sync_api import sync_playwright

    base, _ = app
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        if keyboard:
            ctx.add_init_script(vdebug.KEYBOARD_JS.replace("__VD_KB_HEIGHT__", "336"))
        page = ctx.new_page()
        page.goto(base + "/keyboard" + query)
        got_before = before(page) if before else None
        hits = {(h["check"], h["selector"]) for h in page.evaluate(vdebug.LAYOUT_CHECKS_JS)}
        got_after = after(page) if after else None
        b.close()
    return hits, got_before, got_after


def _focus(page, sel):
    page.evaluate("s => document.querySelector(s).focus({preventScroll: true})", sel)
    # keyboard.js scrolls in a requestAnimationFrame. A fixed sleep races it: the first page of a
    # fresh browser often hasn't produced a frame 150ms in, so wait for two real frames instead.
    page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
    page.wait_for_timeout(50)


@pytest.mark.browser  # real Chromium
@pytest.mark.parametrize("case,field,flagged,quiet", [
    # body{position:fixed} scroll lock: page content is not "pinned"; the real fixed bar still is
    ("lock", "#lock-field", {"#send"}, {"#lock-btn"}),
    # a fixed drawer's own scroller clips #sheet-more above the keyboard: scroll it into view
    ("sheet", "#sheet-field", {"#send"}, {"#sheet-more"}),
    # a full-screen player covers the page's bar: the keyboard isn't what hides it
    ("cover", "#player-search", {"#player-play"}, {"#send", "#draft"}),
])
def test_keyboard_covers_control_skips_what_is_reachable_or_already_covered(app, case, field, flagged, quiet):
    hits, _, _ = _phone_probe(app, f"?case={case}", before=lambda page: _focus(page, field))
    covered = {s for c, s in hits if c == "keyboard-covers-control"}
    assert flagged <= covered and not (quiet & covered), covered


@pytest.mark.browser  # real Chromium
def test_keyboard_scrolls_the_fields_own_scroller_and_never_leaves_page_scroll(app):
    state = "() => ({y: scrollY, drawer: document.getElementById('drawer')?.scrollTop})"
    # A field deep in a full-screen fixed drawer: scroll the DRAWER, never the page.
    hits, got, _ = _phone_probe(app, "?case=drawer", before=lambda page: (_focus(page, "#drawer-deep"),
                                                                        page.evaluate(state))[1])
    assert got["drawer"] > 0 and got["y"] == 0, got
    assert ("keyboard-covers-focus", "#drawer-deep") not in hits

    def fixed_then_page(page):
        _focus(page, "#msg")                 # fixed bar, no scroller: page scrolling can't help
        seen = [page.evaluate("scrollY")]
        page.evaluate("document.activeElement.blur()")
        page.wait_for_timeout(50)
        seen.append(page.evaluate("scrollY"))
        page.evaluate("window.scrollTo(0, document.getElementById('mid').getBoundingClientRect().top - 700)")
        seen.append(page.evaluate("scrollY"))  # #mid now sits at y=700, under the keyboard
        _focus(page, "#mid")
        seen.append(page.evaluate("scrollY"))
        page.evaluate("document.activeElement.blur()")
        page.wait_for_timeout(50)
        seen.append(page.evaluate("scrollY"))
        return seen
    _, (fixed_open, fixed_closed, start, opened, closed), _ = _phone_probe(app, "", before=fixed_then_page)
    assert fixed_open == 0 and fixed_closed == 0
    assert opened > start and closed == start   # the keyboard's own page scroll is undone on close


@pytest.mark.browser  # real Chromium
def test_keyboard_panel_sits_above_a_modal_dialog_and_stays_click_through(app):
    def open_dialog_over_keyboard(page):
        _focus(page, "#name")                                            # keyboard already up...
        page.evaluate("document.getElementById('dlg').showModal()")      # ...then a modal opens
        page.wait_for_timeout(150)
        # Painted on top? A modal makes the rest of the page (the panel too) inert, so hit tests
        # can't say. Compare pixels instead: with the panel above the dialog, removing the dimmed,
        # blurred ::backdrop changes nothing inside the keyboard area.
        spot = {"x": 150, "y": 830, "width": 40, "height": 10}
        dimmed = page.screenshot(clip=spot)
        page.add_style_tag(content="#dlg::backdrop { background: none !important; backdrop-filter: none !important }")
        on_top = page.screenshot(clip=spot) == dimmed
        return {**page.evaluate("""() => {
          const p = document.getElementById('__vd_keyboard');
          return {focus: document.activeElement.id, open: p.matches(':popover-open'), pe: getComputedStyle(p).pointerEvents};
        }"""), "onTop": on_top}

    def tap_save_under_keyboard(page):
        box = page.locator("#dlg-ok").bounding_box()
        page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        return page.evaluate("window.__dlgOk === true")
    hits, got, tapped = _phone_probe(app, "?case=modal", before=open_dialog_over_keyboard, after=tap_save_under_keyboard)
    assert got == {"focus": "dlg-field", "open": True, "pe": "none", "onTop": True}, got
    assert tapped                                        # pointer-events:none, even in the top layer
    assert ("keyboard-covers-control", "#dlg-ok") in hits   # a sheet's button under the keyboard: real
    # #under-dlg is page content right under the dialog's button: the dialog covering it is intended
    assert not any(c == "overlapping-controls" and s in ("#under-dlg", "#dlg-ok") for c, s in hits), hits


@pytest.mark.browser  # real Chromium
def test_overlapping_controls_ignores_closed_details_and_drawer_covered_controls(app):
    hits, _, _ = _phone_probe(app, "?case=overlap", keyboard=False)
    overlaps = {s for c, s in hits if c == "overlapping-controls"}
    assert "#cover-a" in overlaps                                   # #cover-b eats its taps: real
    assert not overlaps & {"#page-btn", "#drawer-btn", "#det-a", "#det-b"}, overlaps


@pytest.mark.browser  # real Chromium
def test_tap_target_invisible_input_and_zoom_checks_skip_their_false_positives(app):
    hits, _, _ = _phone_probe(app, "?case=targets", keyboard=False)
    assert ("invisible-hit-target", "#bare-ghost") in hits
    assert ("invisible-hit-target", "#pill-radio") not in hits      # custom radio pill: tap the label
    assert {("small-tap-target", "#view-link"), ("small-tap-target", "#tiny-on")} <= hits
    assert not {("small-tap-target", "#text-link"), ("small-tap-target", "#tiny-off")} & hits
    assert ("ios-input-zoom", "#note") in hits
    assert ("ios-input-zoom", "#side-search") not in hits           # collapsed sidebar, x=-264


@pytest.mark.browser  # real Chromium
def test_zoom_disabled_viewport_is_one_page_hit_instead_of_per_input_hits(app):
    hits, _, _ = _phone_probe(app, "?case=nozoom", keyboard=False)
    assert ("zoom-disabled", None) in hits
    assert not any(c == "ios-input-zoom" for c, _ in hits), hits
