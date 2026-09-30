"""Tests for judge.py — frame extraction/dedup, request shape, response parsing, failure
containment. No network (call_openrouter is monkeypatched); frame extraction needs ffmpeg."""

import json
import pathlib
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import judge  # noqa: E402

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")


@pytest.fixture(scope="module")
def static_then_moving(tmp_path_factory):
    """2 s video: 1 s of a still white frame, then 1 s of ffmpeg's constantly-changing testsrc."""
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not installed")
    out = tmp_path_factory.mktemp("vid") / "video.webm"
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y",
                    "-f", "lavfi", "-i", "color=c=white:s=160x120:d=1:r=25",
                    "-f", "lavfi", "-i", "testsrc=s=160x120:d=1:r=25",
                    "-filter_complex", "[0][1]concat=n=2:v=1:a=0", "-c:v", "libvpx", "-b:v", "200k", str(out)],
                   check=True)
    return out


@pytest.fixture
def run_dir(tmp_path, static_then_moving):
    d = tmp_path / "home-nav" / "iphone-13-pro"
    d.mkdir(parents=True)
    shutil.copy(static_then_moving, d / "video.webm")
    return tmp_path


@pytest.fixture
def entry():
    return {
        "flow": "home-nav", "description": "Home -> nav", "viewport": "iphone-13-pro", "width": 390, "height": 844,
        "video": "home-nav/iphone-13-pro/video.webm",
        "frames": [{"label": "start", "t": 0.4, "path": "home-nav/iphone-13-pro/frames/01-start.png"},
                   {"label": "end", "t": 1.9, "path": "home-nav/iphone-13-pro/frames/02-end.png"}],
        "checks": [{"check": "horizontal-overflow", "frame": "start", "frames": ["start", "end"],
                    "selector": None, "detail": "503 > 390"}],
        "error": None,
    }


def _body(content, **usage):
    return {"choices": [{"message": {"content": content}}],
            "usage": {"cost": 0.0012, "prompt_tokens": 9000, "completion_tokens": 300, **usage}}


GOOD = {"summary": "Overflow on mobile.", "frames_reviewed": [{"frame": "t=0.00s", "verdict": "issues", "note": ""}],
        "findings": [{"title": "Banner overflows", "severity": "major", "frame": "t=1.20s"}]}


# ------------------------------------------------------------------ frame extraction
@needs_ffmpeg
def test_extract_frames_collapses_static_stretch_and_keeps_every_change(static_then_moving, tmp_path):
    frames = judge.extract_frames(static_then_moving, tmp_path / "film", fps=10)
    labels = [f["label"] for f in frames]
    # the whole still second is ONE frame; each 1/10 s of motion survives
    assert labels == ["t=0.00s"] + [f"t={1 + i / 10:.2f}s" for i in range(10)]
    assert all(pathlib.Path(f["path"]).exists() for f in frames)
    assert [f["t"] for f in frames] == sorted(f["t"] for f in frames)


@needs_ffmpeg
def test_extract_frames_fps_controls_motion_density(static_then_moving, tmp_path):
    assert len(judge.extract_frames(static_then_moving, tmp_path / "a", fps=5)) == 1 + 5


@needs_ffmpeg
def test_extract_frames_caps_always_moving_content_keeping_first_and_last(static_then_moving, tmp_path):
    frames = judge.extract_frames(static_then_moving, tmp_path / "film", fps=10, max_frames=4)
    assert len(frames) == 4 and frames[0]["label"] == "t=0.00s" and frames[-1]["label"] == "t=1.90s"
    assert frames[0]["candidates"] == 11
    assert len(list((tmp_path / "film").glob("*.png"))) == 4  # thinned frames are deleted, not just skipped


@needs_ffmpeg
def test_extract_frames_replaces_a_previous_extraction(static_then_moving, tmp_path):
    (tmp_path / "film").mkdir()
    (tmp_path / "film" / "999999.png").write_bytes(b"stale")
    judge.extract_frames(static_then_moving, tmp_path / "film", fps=5)
    assert not (tmp_path / "film" / "999999.png").exists()


def test_extract_frames_reports_missing_ffmpeg(monkeypatch, tmp_path):
    monkeypatch.setattr(judge.shutil, "which", lambda name: None)
    with pytest.raises(RuntimeError, match="ffmpeg not found"):
        judge.extract_frames(tmp_path / "v.webm", tmp_path / "film")


@needs_ffmpeg
def test_extract_frames_reports_unreadable_video(tmp_path):
    bad = tmp_path / "v.webm"
    bad.write_bytes(b"not a video")
    with pytest.raises(RuntimeError, match="ffmpeg failed"):
        judge.extract_frames(bad, tmp_path / "film")


# ------------------------------------------------------------------ request
def test_messages_send_every_frame_in_order_with_time_captions(entry, tmp_path):
    frames = []
    for i, t in enumerate((0.0, 1.2, 1.3)):
        p = tmp_path / f"{i}.png"
        p.write_bytes(bytes([i]) * 4)
        frames.append({"label": f"t={t:.2f}s", "t": t, "path": p})
    msgs = judge.build_messages(entry, frames)
    assert msgs[0]["role"] == "system" and "MOTION" in msgs[0]["content"] and "duplicate" in msgs[0]["content"]
    content = msgs[1]["content"]
    captions = [p["text"] for p in content[1:] if p["type"] == "text"]
    assert captions == ["Frame t=0.00s:", "Frame t=1.20s:", "Frame t=1.30s:"]
    images = [p for p in content if p["type"] == "image_url"]
    assert len(images) == 3 and not any(p["type"] == "video_url" for p in content)
    intro = content[0]["text"]
    assert "390x844" in intro and "3 frames follow" in intro and "start @ 0.4s" in intro
    assert '"id": "c0"' in intro and '"seen_at": ["start", "end"]' in intro


def test_failed_flow_is_told_to_the_model(entry):
    entry["error"] = "TimeoutError: locator.click"
    assert "FAILED: TimeoutError" in judge.build_messages(entry, [])[1]["content"][0]["text"]


def test_request_forces_schema_and_capable_endpoint():
    req = judge.build_request("m/x", [])
    assert req["provider"] == {"require_parameters": True} and req["max_tokens"] == judge.MAX_TOKENS
    # temperature is unsupported by reasoning models; with require_parameters it 404s routing
    assert "temperature" not in req
    schema = req["response_format"]["json_schema"]["schema"]
    assert req["response_format"]["json_schema"]["strict"] is True
    assert schema["required"] == ["summary", "frames_reviewed", "findings"]
    item = schema["properties"]["findings"]["items"]
    assert set(item["required"]) == set(item["properties"])  # strict mode requires all keys listed
    assert "animation" in item["properties"]["category"]["enum"]


def test_schema_has_no_type_unions():
    """Seed (and others) 400 on ["string", "null"]; keep every property a single type."""
    def walk(node):
        if isinstance(node, dict):
            assert not isinstance(node.get("type"), list), node
            for v in node.values():
                walk(v)
    walk(judge.FINDINGS_SCHEMA)


# ------------------------------------------------------------------ response
@pytest.mark.parametrize("content", [
    json.dumps(GOOD),
    "```json\n" + json.dumps(GOOD) + "\n```",
    "Here you go: " + json.dumps(GOOD) + " hope it helps",
    [{"type": "text", "text": json.dumps(GOOD)}],
])
def test_parse_response_tolerates_wrappers(content):
    assert judge.parse_response(_body(content))["findings"][0]["title"] == "Banner overflows"


def test_parse_response_maps_sentinels_to_none():
    out = judge.parse_response(_body(json.dumps({"summary": "", "findings": [
        {"severity": "major", "frame": "", "confirms_check": "", "timestamp_s": -1},
        {"severity": "major", "frame": "t=1.20s", "confirms_check": "c1", "timestamp_s": 2.5}]})))
    assert [(f["frame"], f["confirms_check"], f["timestamp_s"]) for f in out["findings"]] == [
        (None, None, None), ("t=1.20s", "c1", 2.5)]


def test_parse_response_normalizes_severity_and_drops_junk():
    out = judge.parse_response(_body(json.dumps({"summary": "", "findings": [{"severity": "BAD"}, "junk"]})))
    assert out["findings"] == [{"severity": "minor", "timestamp_s": None}] and out["frames_reviewed"] == []


@pytest.mark.parametrize("body", [{}, _body("no json here"), _body(json.dumps({"summary": "x"}))])
def test_parse_response_rejects_unusable(body):
    with pytest.raises(ValueError):
        judge.parse_response(body)


def test_coverage_flags_frames_without_a_verdict():
    frames = [{"label": "t=0.00s"}, {"label": "t=1.20s"}]
    got = judge.coverage({"frames_reviewed": [{"frame": "'T=0.00S'"}]}, frames)
    assert got == {"frames": 2, "reviewed": 1, "missing": ["t=1.20s"]}


def test_usage_cost_counts_byok_upstream_spend():
    assert judge.usage_cost({"cost": 0.002}) == 0.002
    assert judge.usage_cost({"cost": 0, "is_byok": True,
                             "cost_details": {"upstream_inference_cost": 0.0002053}}) == 0.0002053
    assert judge.usage_cost({}) is None


# ------------------------------------------------------------------ judge_entry / judge_run
@needs_ffmpeg
def test_judge_entry_sends_one_request_with_the_deduped_frames(entry, run_dir, monkeypatch):
    sent = []
    monkeypatch.setattr(judge, "call_openrouter", lambda req, key, timeout=180: sent.append(req) or _body(
        json.dumps(GOOD), prompt_tokens_details={"cached_tokens": 4000}))
    out = judge.judge_entry(entry, run_dir, model="m/x", api_key="k", fps=10)
    assert len(sent) == 1
    assert sum(p["type"] == "image_url" for p in sent[0]["messages"][1]["content"]) == 11
    assert out["tokens"] == {"prompt": 9000, "completion": 300, "cached": 4000} and out["cost_usd"] == 0.0012
    assert out["fps"] == 10 and out["coverage"]["frames"] == 11 and out["coverage"]["reviewed"] == 1
    assert out["thinned_from"] is None
    assert out["film"][0] == {"label": "t=0.00s", "t": 0.0, "path": "home-nav/iphone-13-pro/film/000000.png"}
    assert (run_dir / out["film"][-1]["path"]).exists()


@needs_ffmpeg
def test_judge_entry_honours_film_dir(entry, run_dir, monkeypatch, tmp_path):
    monkeypatch.setattr(judge, "call_openrouter", lambda req, key, timeout=180: _body(json.dumps(GOOD)))
    out = judge.judge_entry(entry, run_dir, model="m/x", api_key="k", fps=5, film_dir=run_dir / "elsewhere")
    assert out["film"][0]["path"].startswith("elsewhere/") and not (run_dir / "home-nav/iphone-13-pro/film").exists()


@needs_ffmpeg
def test_falls_back_to_prompt_schema_when_no_endpoint_supports_it(entry, run_dir, monkeypatch):
    reqs = []

    def fake(req, key, timeout=180):
        reqs.append(req)
        if "response_format" in req:
            raise RuntimeError("OpenRouter HTTP 404: No endpoints found that can handle the requested parameters.")
        return _body(json.dumps(GOOD))
    monkeypatch.setattr(judge, "call_openrouter", fake)
    out = judge.judge_entry(entry, run_dir, model="m/x", api_key="k")
    assert out["structured"] is False and out["findings"][0]["title"] == "Banner overflows"
    assert "JSON Schema" in reqs[1]["messages"][0]["content"] and "provider" not in reqs[1]
    assert sum(p["type"] == "image_url" for p in reqs[1]["messages"][1]["content"]) == 11  # frames kept


def test_judge_entry_contains_failures(entry, run_dir, monkeypatch):
    def boom(req, key, timeout=180):
        raise RuntimeError("OpenRouter HTTP 402: out of credit")
    monkeypatch.setattr(judge, "call_openrouter", boom)
    assert judge.judge_entry(entry, run_dir, model="m/x", api_key="k")["error"].startswith("OpenRouter HTTP 402")
    assert judge.judge_entry({**entry, "video": None}, run_dir, model="m/x", api_key="k")["error"] == \
        "no video recorded for this flow"


@needs_ffmpeg
def test_judge_run_rewrites_report_and_logs_frames_cost_cache(entry, run_dir, monkeypatch):
    other = {**entry, "viewport": "desktop"}
    (run_dir / "report.json").write_text(json.dumps({"run_id": "r", "base_url": "u", "runs": [entry, other]}))
    monkeypatch.setattr(judge, "call_openrouter", lambda req, key, timeout=180: _body(
        json.dumps(GOOD), prompt_tokens_details={"cached_tokens": 100}))
    lines = []
    report = judge.judge_run(run_dir, model="m/x", api_key="k", fps=10, log=lines.append)
    assert report["judge"] == {"model": "m/x", "fps": 10, "cost_usd": 0.0024}
    saved = json.loads((run_dir / "report.json").read_text())
    assert saved["runs"][0]["judge"]["findings"][0]["title"] == "Banner overflows"
    assert any("11 frame(s)" in line and "100 cached" in line and "300 completion" in line and "SKIPPED" in line
               for line in lines)


@needs_ffmpeg
def test_judge_run_logs_unstructured_fallback(entry, run_dir, monkeypatch):
    (run_dir / "report.json").write_text(json.dumps({"run_id": "r", "base_url": "u", "runs": [entry]}))

    def fake(req, key, timeout=180):
        if "response_format" in req:
            raise RuntimeError("OpenRouter HTTP 404: No endpoints found")
        return _body(json.dumps(GOOD))
    monkeypatch.setattr(judge, "call_openrouter", fake)
    lines = []
    judge.judge_run(run_dir, model="m/x", api_key="k", log=lines.append)
    assert any("unstructured" in line for line in lines)


@needs_ffmpeg
def test_judge_entry_reports_thinning(entry, run_dir, monkeypatch):
    monkeypatch.setattr(judge, "call_openrouter", lambda req, key, timeout=180: _body(json.dumps(GOOD)))
    out = judge.judge_entry(entry, run_dir, model="m/x", api_key="k", fps=10, max_frames=4)
    assert out["thinned_from"] == 11 and out["coverage"]["frames"] == 4


@needs_ffmpeg
@pytest.mark.parametrize("max_frames", [2, 3, 10])   # 10 = one under the 11 distinct frames (smallest thinning)
def test_extract_frames_cap_keeps_exactly_max_frames(static_then_moving, tmp_path, max_frames):
    frames = judge.extract_frames(static_then_moving, tmp_path / "film", fps=10, max_frames=max_frames)
    assert len(frames) == max_frames and frames[0]["label"] == "t=0.00s" and frames[-1]["label"] == "t=1.90s"


def test_extract_frames_rejects_max_frames_below_two(tmp_path):
    with pytest.raises(ValueError, match="max_frames"):
        judge.extract_frames(tmp_path / "v.webm", tmp_path / "film", max_frames=1)


def test_extract_frames_reports_empty_extraction(monkeypatch, tmp_path):
    monkeypatch.setattr(judge.shutil, "which", lambda name: "/usr/bin/ffmpeg")
    monkeypatch.setattr(judge.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 0, "", ""))
    with pytest.raises(RuntimeError, match="no frames extracted"):
        judge.extract_frames(tmp_path / "v.webm", tmp_path / "film")


def test_judge_entry_contains_bad_max_frames(entry, tmp_path):
    out = judge.judge_entry(entry, tmp_path, model="m/x", api_key="k", max_frames=1)
    assert "max_frames" in out["error"] and out["findings"] == []



def test_notes_file_is_sent_as_intentional_design(entry, tmp_path):
    assert judge.load_notes(tmp_path / "missing.md") is None and judge.load_notes(None) is None
    (tmp_path / "judge_notes.md").write_text("The column is 468px wide on purpose.\n")
    notes = judge.load_notes(tmp_path / "judge_notes.md")
    intro = judge.build_messages(entry, [], notes)[1]["content"][0]["text"]
    assert "intentional design" in intro and "468px wide on purpose" in intro
    assert "Project notes" not in judge.build_messages(entry, [])[1]["content"][0]["text"]
    (tmp_path / "bad.md").write_bytes(b"\xff\xfe not utf-8 \xff")
    assert judge.load_notes(tmp_path / "bad.md") is None          # warns, never raises
    (tmp_path / "big.md").write_text("x" * 10000)
    assert len(judge.load_notes(tmp_path / "big.md")) == judge.NOTES_MAX


def test_prompt_rules_cover_known_false_positives():
    p = judge.SYSTEM_PROMPT
    assert "blank white browser page" in p and "video-encoding artifact" in p and "automated test that scrolls" in p
    assert "below the fold" in p and "narrow, centred column" in p and "trust" in p and "Project notes" in p
