"""Tests for vdebug.py — pure helpers, plus a real-browser run against a fixture page with
planted layout bugs, and the recorder.js -> flowstore capture round trip (Phase 1 -> 2)."""

import http.server
import json
import pathlib
import sys
import threading

import pytest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "capture"))
import vdebug  # noqa: E402
from flowstore import FlowStore  # noqa: E402


# ------------------------------------------------------------------ pure
def test_parse_viewports_presets_custom_and_all():
    assert [v.name for v in vdebug.parse_viewports("all")] == ["mobile", "tablet", "desktop", "ultrawide"]
    se, big = vdebug.parse_viewports("phone-se=320x568, 1920x1080")
    assert (se.name, se.width, se.mobile) == ("phone-se", 320, True)
    assert (big.name, big.mobile) == ("1920x1080", False)
    with pytest.raises(ValueError):
        vdebug.parse_viewports("watch")


def test_video_size_caps_long_edge_and_stays_even():
    assert vdebug.video_size(vdebug.VIEWPORTS["mobile"]) == {"width": 374, "height": 666}
    uw = vdebug.video_size(vdebug.VIEWPORTS["ultrawide"])
    assert uw == {"width": 1280, "height": 720}


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
    recorder = (HERE / "capture" / "recorder.js").read_bytes()

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body, ctype = (recorder, "text/javascript") if self.path.startswith("/recorder.js") else (page_html, "text/html")
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
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


@pytest.mark.live  # real Chromium
def test_record_matrix_finds_planted_bugs(app, tmp_path):
    base, _ = app
    flows = vdebug.load_flows(HERE / "testdata" / "example_flows")
    vps = vdebug.parse_viewports("mobile,desktop")
    run_dir = vdebug.record(flows, vps, base, tmp_path / "runs", log=lambda m: None)
    report = json.loads((run_dir / "report.json").read_text())
    assert (tmp_path / "runs" / "latest").resolve() == run_dir.resolve()
    by_vp = {e["viewport"]: e for e in report["runs"]}
    assert set(by_vp) == {"mobile", "desktop"}
    for e in by_vp.values():
        assert e["error"] is None, e["error"]
        assert (run_dir / e["video"]).stat().st_size > 1000
        assert all((run_dir / f["path"]).exists() for f in e["frames"])
    # Mobile takes the hamburger branch; desktop does not.
    assert [f["label"] for f in by_vp["mobile"]["frames"]] == ["start", "nav open", "first nav page", "end"]
    assert [f["label"] for f in by_vp["desktop"]["frames"]] == ["start", "first nav page", "end"]

    mobile = {c["check"] for c in by_vp["mobile"]["checks"]}
    desktop = {c["check"] for c in by_vp["desktop"]["checks"]}
    assert {"horizontal-overflow", "offscreen-right", "small-tap-target", "text-overflow"} <= mobile
    assert "horizontal-overflow" not in desktop and "small-tap-target" not in desktop
    assert "text-overflow" in desktop  # the fixed-width button is broken at every size
    for checks in (mobile, desktop):   # fixed-size planted bugs, broken at every size
        assert {"text-clipped", "overlapping-controls"} <= checks
    clipped = next(c for c in by_vp["desktop"]["checks"] if c["check"] == "text-clipped")
    assert "clip-label" in clipped["selector"]
    overlap = next(c for c in by_vp["desktop"]["checks"] if c["check"] == "overlapping-controls")
    assert "chip" in overlap["selector"] and "chip" in overlap["detail"]
    offender = next(c for c in by_vp["mobile"]["checks"] if c["check"] == "offscreen-right")
    assert "hero-banner" in offender["selector"]
    # A static defect is reported once, with every checkpoint it was seen at.
    assert offender["frame"] == "start" and offender["frames"] == ["start", "nav open", "first nav page", "end"]
    keys = [(c["check"], c["selector"]) for c in by_vp["mobile"]["checks"]]
    assert len(keys) == len(set(keys))

    md = vdebug.write_markdown(run_dir, report).read_text()
    assert "| home-nav | mobile 375x667 |" in md and "horizontal-overflow" in md


@pytest.mark.live  # real Chromium
def test_crashing_flow_is_recorded_not_fatal(app, tmp_path):
    base, _ = app
    _write_flow(tmp_path, "boom", body="def run(page, vd):\n    page.click('#does-not-exist', timeout=500)\n")
    [flow] = vdebug.load_flows(tmp_path)
    run_dir = vdebug.record([flow], vdebug.parse_viewports("desktop"), base, tmp_path / "runs", log=lambda m: None)
    [e] = json.loads((run_dir / "report.json").read_text())["runs"]
    assert e["error"].startswith("TimeoutError")
    assert e["frames"][-1]["label"] == "error" and e["video"]


@pytest.mark.live  # real Chromium
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


@pytest.mark.live  # real Chromium
def test_basket_toast_fixture_flow_marks_the_settled_state(app, tmp_path):
    """The motion probe: the checkpoint must be taken AFTER the toast animation finishes."""
    base, _ = app
    [flow] = vdebug.load_flows(HERE / "testdata" / "flows")
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
    rc = vdebug.main(["--flows-dir", str(HERE / "flows"), "record", "--base-url", "http://x", "--judge",
                      "--fps", "15", "--model", "m/x"])
    assert rc == 0 and seen["fps"] == 15 and seen["model"] == "m/x"
    assert "video frames @ 15 fps" in (run_dir / "report.md").read_text()
    with pytest.raises(SystemExit):
        vdebug.main(["--flows-dir", str(HERE / "flows"), "record", "--base-url", "http://x", "--judge-mode", "frames"])


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
