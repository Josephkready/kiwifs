#!/usr/bin/env python3
"""vdebug — record user flows across a responsive viewport matrix, optionally AI-judge them.

    vdebug.py list
    vdebug.py record --base-url http://localhost:8000 [--flow NAME ...] [--viewports mobile,desktop]
                     [--judge [--model M] [--fps 10]] [--fail-on error|check|major|never]

Each flow is a Python file in flows/ (see flows/example_home.py) that drives a Playwright
page and calls vd.mark("label") at every state worth judging. For every flow × viewport
vdebug writes, under <out>/<run-id>/<flow>/<viewport>/:

    video.webm            the whole flow (Playwright context video)
    frames/NN-label.png   a crisp viewport screenshot at each vd.mark()

and at every mark runs deterministic DOM layout checks (layout_checks.js). The run's
report.json / report.md list every frame, check hit and — with --judge — the multimodal
model's findings. <out>/latest always points at the newest run.

--judge (judge.py) cuts each video.webm into frames at --fps, drops consecutive duplicates,
and sends every remaining frame in one request — so the model sees animations and
transitions, not just the settled checkpoint states. The frames it sent are kept in
<flow>/<viewport>/film/ and linked from report.md.

Needs: `pip install playwright && playwright install chromium`; --judge also needs ffmpeg and
OPENROUTER_API_KEY.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import fnmatch
import importlib.util
import json
import os
import pathlib
import re
import shutil
import sys
import time
import types
from urllib.parse import urljoin

os.environ.setdefault("NODE_OPTIONS", "--no-deprecation")  # silence Playwright driver noise

HERE = pathlib.Path(__file__).resolve().parent
LAYOUT_CHECKS_JS = (HERE / "layout_checks.js").read_text()


@dataclasses.dataclass(frozen=True)
class Viewport:
    name: str
    width: int
    height: int
    mobile: bool = False  # is_mobile + has_touch, so the app takes its touch/mobile branch


VIEWPORTS = {
    "mobile": Viewport("mobile", 375, 667, mobile=True),
    "tablet": Viewport("tablet", 768, 1024, mobile=True),
    "desktop": Viewport("desktop", 1440, 900),
    "ultrawide": Viewport("ultrawide", 2560, 1440),
}
VIDEO_MAX_EDGE = 1280  # judge cost scales with pixels; 1280 keeps ultrawide legible


def parse_viewports(spec: str) -> list[Viewport]:
    """'mobile,desktop' or 'all' or custom 'phone-se=320x568'."""
    if spec == "all":
        return list(VIEWPORTS.values())
    out = []
    for part in filter(None, (p.strip() for p in spec.split(","))):
        if part in VIEWPORTS:
            out.append(VIEWPORTS[part])
            continue
        m = re.fullmatch(r"(?:([\w-]+)=)?(\d+)x(\d+)", part)
        if not m:
            raise ValueError(f"unknown viewport {part!r} (presets: {', '.join(VIEWPORTS)}, or NAME=WxH)")
        w, h = int(m.group(2)), int(m.group(3))
        out.append(Viewport(m.group(1) or f"{w}x{h}", w, h, mobile=w < 768))
    return out


def video_size(vp: Viewport) -> dict:
    scale = min(1.0, VIDEO_MAX_EDGE / max(vp.width, vp.height))
    # VP8 wants even dimensions.
    return {"width": int(vp.width * scale) // 2 * 2, "height": int(vp.height * scale) // 2 * 2}


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:40] or "mark"


# ------------------------------------------------------------------ flows
@dataclasses.dataclass
class Flow:
    name: str
    description: str
    source: str
    start: str | None
    viewports: list[str] | None
    run: types.FunctionType
    path: pathlib.Path


def load_flows(flows_dir: pathlib.Path) -> list[Flow]:
    flows = []
    # Flows import shared helpers (`from _helpers import ...`), so the flows dir must be importable.
    if str(flows_dir.resolve()) not in sys.path:
        sys.path.insert(0, str(flows_dir.resolve()))
    for path in sorted(flows_dir.glob("*.py")):
        if path.name.startswith("_") or path.name.endswith("_test.py"):
            continue
        spec = importlib.util.spec_from_file_location(f"vdebug_flow_{path.stem}", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        if not callable(getattr(mod, "run", None)):
            raise ValueError(f"{path}: flow must define run(page, vd)")
        flows.append(Flow(
            name=getattr(mod, "NAME", path.stem),
            description=getattr(mod, "DESCRIPTION", (mod.__doc__ or "").strip().split("\n")[0]),
            source=getattr(mod, "SOURCE", "standard"),
            start=getattr(mod, "START", "/"),
            viewports=getattr(mod, "VIEWPORTS", None),
            run=mod.run,
            path=path,
        ))
    names = [f.name for f in flows]
    dupes = {n for n in names if names.count(n) > 1}
    if dupes:
        raise ValueError(f"duplicate flow NAME(s): {', '.join(sorted(dupes))}")
    return flows


def select_flows(flows: list[Flow], patterns: list[str] | None) -> list[Flow]:
    if not patterns:
        return flows
    picked = [f for f in flows if any(fnmatch.fnmatch(f.name, p) for p in patterns)]
    if not picked:
        raise ValueError(f"no flow matches {patterns}; have: {', '.join(f.name for f in flows)}")
    return picked


class VD:
    """The handle a flow's run(page, vd) receives."""

    def __init__(self, page, base_url: str, viewport: Viewport, out_dir: pathlib.Path, run_dir: pathlib.Path):
        self.page, self.base_url, self.viewport = page, base_url, viewport
        self._out, self._run_dir = out_dir, run_dir
        self._t0 = time.monotonic()
        self.frames: list[dict] = []
        self.checks: list[dict] = []
        self._seen: dict[tuple, dict] = {}

    def url(self, path: str) -> str:
        return urljoin(self.base_url.rstrip("/") + "/", path.lstrip("/"))

    def goto(self, path: str, **kw):
        return self.page.goto(self.url(path), **kw)

    def settle(self, timeout_ms: int = 3000) -> None:
        """Wait for network quiet + web fonts so a frame shows the settled layout."""
        try:
            self.page.wait_for_load_state("networkidle", timeout=timeout_ms)
        except Exception:
            pass  # long-polling apps never go idle; a frame of the busy state is still useful
        try:
            self.page.evaluate("document.fonts ? document.fonts.ready.then(() => true) : true")
        except Exception:
            pass
        self.page.wait_for_timeout(150)

    def mark(self, label: str, *, settle: bool = True, full_page: bool = False) -> None:
        """Checkpoint: screenshot + DOM layout checks, stamped with video time."""
        if settle:
            self.settle()
        t = round(time.monotonic() - self._t0, 2)
        n = len(self.frames) + 1
        rel = pathlib.Path(self._out.relative_to(self._run_dir), "frames", f"{n:02d}-{slug(label)}.png")
        (self._run_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        self.page.screenshot(path=str(self._run_dir / rel), full_page=full_page)
        self.frames.append({"label": label, "t": t, "path": str(rel), "url": self.page.url})
        try:
            hits = self.page.evaluate(LAYOUT_CHECKS_JS)
        except Exception as e:  # a navigating page can't be evaluated; record, don't die
            hits = [{"check": "checks-failed", "detail": str(e)[:200], "selector": None, "rect": None}]
        # A static defect hits at every mark; report it once, listing where it was seen.
        for h in hits:
            prior = self._seen.get((h["check"], h.get("selector")))
            if prior:
                prior["frames"].append(label)
                continue
            h["frame"], h["t"], h["frames"] = label, t, [label]
            self._seen[(h["check"], h.get("selector"))] = h
            self.checks.append(h)


# ------------------------------------------------------------------ recording
def record_one(browser, flow: Flow, vp: Viewport, base_url: str, run_dir: pathlib.Path,
               log=print, step_timeout_ms: int = 15000) -> dict:
    out = run_dir / slug(flow.name) / vp.name
    out.mkdir(parents=True, exist_ok=True)
    ctx = browser.new_context(
        viewport={"width": vp.width, "height": vp.height},
        device_scale_factor=1,
        is_mobile=vp.mobile,
        has_touch=vp.mobile,
        record_video_dir=str(out / "_video"),
        record_video_size=video_size(vp),
        reduced_motion="no-preference",
    )
    ctx.set_default_timeout(step_timeout_ms)
    page = ctx.new_page()
    vd = VD(page, base_url, vp, out, run_dir)
    console_errors: list[str] = []
    page.on("console", lambda m: m.type == "error" and console_errors.append(m.text[:300]))
    page.on("pageerror", lambda e: console_errors.append(f"pageerror: {str(e)[:300]}"))
    error = None
    started = time.monotonic()
    try:
        if flow.start is not None:
            vd.goto(flow.start)
            vd.mark("start")
        flow.run(page, vd)
        vd.mark("end")
    except Exception as e:
        error = f"{type(e).__name__}: {str(e).splitlines()[0][:300] if str(e) else ''}"
        log(f"  FAILED: {error}")
        try:
            vd.mark("error", settle=False)
        except Exception as e2:
            log(f"  (also failed to capture the error frame: {type(e2).__name__}: {str(e2)[:200]})")
    finally:
        video = page.video
        ctx.close()  # finalizes the video file
    video_rel = None
    if video:
        dest = out / "video.webm"
        video.save_as(str(dest))
        video.delete()
        video_rel = str(dest.relative_to(run_dir))
    try:
        (out / "_video").rmdir()
    except OSError:
        pass
    return {
        "flow": flow.name, "description": flow.description, "source": flow.source,
        "viewport": vp.name, "width": vp.width, "height": vp.height,
        "video": video_rel, "duration_s": round(time.monotonic() - started, 2),
        "frames": vd.frames, "checks": vd.checks, "console_errors": console_errors[:20],
        "error": error,
    }


def record(flows: list[Flow], viewports: list[Viewport], base_url: str, out_root: pathlib.Path,
           *, headed: bool = False, log=print) -> pathlib.Path:
    from playwright.sync_api import sync_playwright

    run_id = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = out_root / run_id
    run_dir.mkdir(parents=True, exist_ok=False)
    report = {"run_id": run_id, "base_url": base_url, "created": dt.datetime.now().isoformat(timespec="seconds"),
              "viewports": [dataclasses.asdict(v) for v in viewports], "runs": []}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed)
        try:
            for flow in flows:
                for vp in viewports:
                    if flow.viewports and vp.name not in flow.viewports:
                        continue
                    log(f"recording {flow.name} @ {vp.name} ({vp.width}x{vp.height})")
                    entry = record_one(browser, flow, vp, base_url, run_dir, log=log)
                    report["runs"].append(entry)
                    log(f"  {len(entry['frames'])} frame(s), {len(entry['checks'])} check hit(s), {entry['duration_s']}s")
        finally:
            browser.close()
    (run_dir / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    latest = out_root / "latest"
    if latest.is_symlink() or not latest.exists():
        latest.unlink(missing_ok=True)
        latest.symlink_to(run_id)
    else:
        log(f"WARNING: {latest} exists and is not a symlink; not updating it (newest run: {run_dir})")
    return run_dir


# ------------------------------------------------------------------ reporting
SEV_RANK = {"critical": 0, "major": 1, "minor": 2}


def write_markdown(run_dir: pathlib.Path, report: dict) -> pathlib.Path:
    lines = [f"# vdebug run {report['run_id']}", "", f"Base URL: {report['base_url']}", ""]
    j = report.get("judge")
    if j:
        lines += [f"Judge: `{j['model']}` (video frames @ {j.get('fps')} fps, deduped), total ${j['cost_usd']:.4f}", ""]
    lines += ["| flow | viewport | frames | DOM checks | AI findings | status |", "|---|---|---|---|---|---|"]
    for e in report["runs"]:
        jd = e.get("judge") or {}
        ai = "—" if not jd else ("judge error" if jd.get("error") else str(len(jd.get("findings", []))))
        status = "FAILED" if e.get("error") else "ok"
        lines.append(f"| {e['flow']} | {e['viewport']} {e['width']}x{e['height']} | {len(e['frames'])} "
                     f"| {len(e['checks'])} | {ai} | {status} |")
    for e in report["runs"]:
        jd = e.get("judge") or {}
        findings = sorted(jd.get("findings", []), key=lambda f: SEV_RANK.get(f.get("severity"), 3))
        if not (e.get("error") or e["checks"] or findings or jd.get("error")):
            continue
        lines += ["", f"## {e['flow']} @ {e['viewport']} ({e['width']}x{e['height']})", ""]
        if e.get("video"):
            lines.append(f"Video: [{e['video']}]({e['video']})")
        if e.get("error"):
            lines.append(f"**Flow failed:** `{e['error']}`")
        if jd.get("summary"):
            lines += ["", f"> {jd['summary']}"]
        if jd.get("error"):
            lines.append(f"**Judge error:** {jd['error']}")
        if (jd.get("coverage") or {}).get("missing"):
            lines.append(f"**Judge gave no verdict for frames:** {', '.join(jd['coverage']['missing'])} — "
                         "treat 'no findings' there with suspicion; re-judge or look at those frames yourself")
        # Findings cite the judge's film frames (t=1.20s); checkpoint names still resolve too.
        frame_path = {f["label"]: f["path"] for f in e["frames"]}
        frame_path.update({f["label"]: f["path"] for f in jd.get("film", [])})
        for f in findings:
            where = f.get("frame") or (f"{f['timestamp_s']}s" if f.get("timestamp_s") is not None else "?")
            link = f" ([frame]({frame_path[f['frame']]}))" if f.get("frame") in frame_path else ""
            lines += ["", f"- **[{f['severity']}] {f['title']}** — {f.get('category')} at {where}{link}",
                      f"  - {f['description']} ({f.get('location', '')})",
                      f"  - likely cause: {f.get('likely_cause', '')}; fix: {f.get('suggested_fix', '')}"]
        if e["checks"]:
            lines += ["", "DOM check hits:", ""]
            for c in e["checks"]:
                seen = ", ".join(c.get("frames") or [c["frame"]])
                lines.append(f"- `{c['check']}` @ {seen}: {c.get('selector') or 'page'} — {c.get('detail')}")
        if e.get("console_errors"):
            lines += ["", "Console errors:", ""] + [f"- `{m}`" for m in e["console_errors"]]
    path = run_dir / "report.md"
    path.write_text("\n".join(lines) + "\n")
    return path


def exit_code(report: dict, fail_on: str) -> int:
    runs = report["runs"]
    if fail_on == "never":
        return 0
    if any(e.get("error") for e in runs):
        return 1
    if fail_on == "check" and any(e["checks"] for e in runs):
        return 1
    if fail_on in ("check", "major") and any(
        f.get("severity") in ("critical", "major") for e in runs for f in (e.get("judge") or {}).get("findings", [])
    ):
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Record user flows across viewports; optionally AI-judge them.")
    ap.add_argument("--flows-dir", type=pathlib.Path, default=HERE / "flows")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="list flows and viewport presets")
    r = sub.add_parser("record", help="record flows (and judge with --judge)")
    r.add_argument("--base-url", default=os.environ.get("VDEBUG_BASE_URL"), help="app under test (or VDEBUG_BASE_URL)")
    r.add_argument("--flow", action="append", help="flow NAME or glob; repeatable (default: all)")
    r.add_argument("--viewports", default="all", help="all | comma list of presets or NAME=WxH")
    r.add_argument("--out", type=pathlib.Path, default=pathlib.Path("vdebug-runs"))
    r.add_argument("--headed", action="store_true")
    r.add_argument("--judge", action="store_true", help="send recordings to the multimodal judge on OpenRouter")
    r.add_argument("--model", default=None, help="OpenRouter model id (default: judge.DEFAULT_MODEL / VDEBUG_MODEL)")
    r.add_argument("--fps", type=int, default=10,
                   help="judge: sample the recording at this rate before dropping duplicate frames (default 10)")
    r.add_argument("--fail-on", choices=("error", "check", "major", "never"), default="error",
                   help="exit 1 on: error = a crashed flow; major = error + any critical/major AI "
                        "finding; check = major + any DOM check hit (strictest); never = always 0")
    a = ap.parse_args(argv)
    log = lambda m: print(m, file=sys.stderr)  # noqa: E731

    flows = load_flows(a.flows_dir)
    if a.cmd == "list":
        for f in flows:
            vps = ",".join(f.viewports) if f.viewports else "all"
            print(f"{f.name:28} {f.source:18} viewports={vps:18} {f.description}")
        print("\nviewport presets: " + ", ".join(f"{v.name}={v.width}x{v.height}" for v in VIEWPORTS.values()))
        return 0

    if not a.base_url:
        ap.error("--base-url (or VDEBUG_BASE_URL) is required")
    key = os.environ.get("OPENROUTER_API_KEY")
    if a.judge and not key:
        ap.error("--judge needs OPENROUTER_API_KEY")
    if a.judge and not shutil.which("ffmpeg"):
        ap.error("--judge needs ffmpeg (it cuts each recording into frames)")
    run_dir = record(select_flows(flows, a.flow), parse_viewports(a.viewports), a.base_url, a.out,
                     headed=a.headed, log=log)
    report = json.loads((run_dir / "report.json").read_text())
    if a.judge:
        sys.path.insert(0, str(HERE))
        import judge
        report = judge.judge_run(run_dir, model=a.model or os.environ.get("VDEBUG_MODEL", judge.DEFAULT_MODEL),
                                 fps=a.fps, api_key=key, log=log)
    md = write_markdown(run_dir, report)
    print(md)
    return exit_code(report, a.fail_on)


if __name__ == "__main__":
    sys.exit(main())
