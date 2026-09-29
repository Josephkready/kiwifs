#!/usr/bin/env python3
"""judge — show a multimodal model on OpenRouter what a recorded flow LOOKED like, get UI bugs back.

Used by `vdebug.py record --judge`, or standalone to re-judge an existing run
(e.g. with another model) without re-recording:

    judge.py vdebug-runs/<run-id> [--model openai/gpt-6-luna] [--fps 10]

Stdlib only (urllib) + the ffmpeg binary. Needs OPENROUTER_API_KEY.

One method — deduped video frames in ONE request:
  1. sample the flow's .webm recording at --fps (default 10) with ffmpeg,
  2. drop consecutive near-duplicate frames (ffmpeg mpdecimate) — static stretches collapse to
     one frame, so what survives is the start state plus every visible CHANGE,
  3. send them all, in order and captioned with their timestamp, in a single request, with the
     DOM check hits as hints.
It caught a planted mid-animation glitch in every run (6/6 final, 12/12 prototype); judging the settled checkpoint
screenshots caught it 0/18, in every variant tried (one call per screenshot, all in one
call, a multi-turn conversation). Raw video input exists only on Gemini models, which sample
it at ~1 fps (too coarse for a 150-300 ms transition) and scored worst on static bugs, so it
is not offered. See ../../judge.md for the measurements.

The response must carry a verdict for every frame (`frames_reviewed`); frames the model
skipped are recorded as `coverage.missing`, so skimming is visible rather than silent.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import pathlib
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

# Chosen 2026-09-29 by eval/judge_eval.py: gpt-6-luna was the only model that saw the
# vision-only planted bug in every configuration, and caught the animation bug 6/6 with this
# method (~$0.005-0.006 and ~30 s for 2 flows x 2 viewports). The catalog churns: re-run the eval before
# trusting this; override per run with --model or VDEBUG_MODEL.
DEFAULT_MODEL = "openai/gpt-6-luna"
DEFAULT_FPS = 10      # measured as good as 15 fps at ~3/4 of the tokens
MAX_FRAMES = 60       # ~80k tokens at 1280px; caps always-moving pages (spinners, carousels)
ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
MAX_TOKENS = 8192
# "Near-duplicate" for mpdecimate: a frame is dropped unless it differs from the last KEPT
# frame by more than a few blocks' worth — tuned so a toast sliding in survives but video
# encoder noise on a still page does not.
DEDUP_FILTER = "mpdecimate=hi=64*12:lo=64*5:frac=0.33"

SEVERITIES = ("critical", "major", "minor")
CATEGORIES = (
    "overflow", "clipping", "overlap", "misalignment", "wrapping", "spacing",
    "contrast", "tap-target", "layout-shift", "animation", "rendering", "content", "other",
)

FINDINGS_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "frames_reviewed", "findings"],
    "properties": {
        "summary": {"type": "string", "description": "One or two sentences on overall visual health."},
        "frames_reviewed": {
            "type": "array",
            "description": "One entry per frame, in order, written BEFORE findings.",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["frame", "verdict", "note"],
                "properties": {
                    "frame": {"type": "string", "description": "The frame label, e.g. t=1.20s."},
                    "verdict": {"type": "string", "enum": ["ok", "issues"]},
                    "note": {"type": "string", "description": "What you saw in this frame / what changed."},
                },
            },
        },
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title", "category", "severity", "frame", "timestamp_s", "location",
                             "description", "likely_cause", "suggested_fix", "confirms_check"],
                "properties": {
                    "title": {"type": "string"},
                    "category": {"type": "string", "enum": list(CATEGORIES)},
                    "severity": {"type": "string", "enum": list(SEVERITIES)},
                    # Plain types + sentinels, not ["string", "null"]: some providers (Seed) reject
                    # type unions in json_schema. parse_response maps sentinels back to None.
                    "frame": {"type": "string", "description": "Label of the first frame showing it, or \"\"."},
                    "timestamp_s": {"type": "number", "description": "Seconds into the flow, else -1."},
                    "location": {"type": "string", "description": "Where on screen, e.g. 'header, right of logo'."},
                    "description": {"type": "string", "description": "What is visibly wrong, concretely."},
                    "likely_cause": {"type": "string", "description": "Best CSS/layout guess, e.g. 'fixed width: 480px'."},
                    "suggested_fix": {"type": "string"},
                    "confirms_check": {"type": "string",
                                       "description": "The automated check id this confirms (e.g. c2), or \"\"."},
                },
            },
        },
    },
}

SYSTEM_PROMPT = """You are a meticulous UI/UX QA reviewer for a web application.
You are shown ONE scripted user flow at ONE viewport size, as a sequence of frames taken from a
screen recording. Consecutive duplicate frames were removed, so every frame after the first shows
a visible change, and frames close together in time are an animation or transition in progress.
Report visual defects a user would notice:

- horizontal overflow / an unintended horizontal scrollbar; content cut off at the edge
- elements clipping past their container, text overflowing or cut mid-word
- text wrapping over, under or through buttons, icons or other text
- overlapping elements, misaligned grid/flex columns, inconsistent spacing or gutters
- low-contrast text, unreadably small text, tap targets too small for the viewport
- MOTION defects: elements that fly, jump, overshoot, flicker, scale wildly, flash unstyled, or
  cover content mid-transition; layout that shifts and snaps back; broken or janky animations
- layouts that are merely stretched or empty at large viewports (content lost in whitespace)

Rules:
- Examine EVERY frame and compare it with the previous one. A defect may exist in only one or
  two frames of a transition. Record a verdict for each frame in frames_reviewed.
- Report only what is VISIBLE in the frames. Do not invent bugs to seem thorough; an empty
  findings list is a valid, good answer for a clean flow.
- You are also given automated DOM check hits, measured at named checkpoints (times given).
  Confirm each one you can see (set confirms_check to its id) and silently ignore ones that
  look fine; they are hints, not truth.
- Severity: critical = blocks the flow or hides content; major = clearly broken, looks unprofessional;
  minor = polish.
- One finding per distinct defect; cite the first frame that shows it.
Return JSON matching the schema."""


def _data_url(path: pathlib.Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()


def extract_frames(video: pathlib.Path, out_dir: pathlib.Path, *, fps: int = DEFAULT_FPS,
                   max_frames: int = MAX_FRAMES) -> list[dict]:
    """Sample `video` at `fps`, drop consecutive near-duplicates, return [{label, t, path, candidates}]
    (`candidates` = how many distinct frames existed before the max_frames cap).

    `-frame_pts 1` names each kept frame by its timestamp in 1/fps units, so labels carry
    the real time in the flow. More than `max_frames` survivors (content that never stops
    moving) are thinned evenly, always keeping the first and last.
    """
    if max_frames < 2:  # the thinning keeps first AND last, and divides by max_frames - 1
        raise ValueError(f"max_frames must be >= 2, got {max_frames}")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found on PATH (needed to cut the recording into frames)")
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.png"):
        old.unlink()
    proc = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", str(video), "-vf", f"fps={fps},{DEDUP_FILTER}",
         "-fps_mode", "vfr", "-frame_pts", "1", str(out_dir / "%06d.png")],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed on {video}: {proc.stderr.strip()[:300]}")
    paths = sorted(out_dir.glob("*.png"))
    if not paths:
        raise RuntimeError(f"no frames extracted from {video}")
    candidates = len(paths)
    if len(paths) > max_frames:
        # Evenly spaced indices; the step (n-1)/(m-1) > 1 whenever n > m, so the rounded
        # indices are distinct and exactly max_frames survive.
        keep = {round(i * (len(paths) - 1) / (max_frames - 1)) for i in range(max_frames)}
        for i, p in enumerate(paths):
            if i not in keep:
                p.unlink()
        paths = [p for i, p in enumerate(paths) if i in keep]
    return [{"label": f"t={int(p.stem) / fps:.2f}s", "t": round(int(p.stem) / fps, 2), "path": p,
             "candidates": candidates} for p in paths]


def build_messages(entry: dict, frames: list[dict]) -> list[dict]:
    """The chat messages for one flow × viewport entry. Pure; no network, no ffmpeg."""
    checks = [
        {"id": f"c{i}", "check": c["check"], "seen_at": c.get("frames") or [c.get("frame")],
         "selector": c.get("selector"), "detail": c.get("detail")}
        for i, c in enumerate(entry.get("checks", []))
    ]
    marks = ", ".join("%s @ %.1fs" % (f["label"], f["t"]) for f in entry.get("frames", []))
    intro = (
        f"Flow: {entry['flow']} — {entry.get('description', '')}\n"
        f"Viewport: {entry['viewport']} ({entry['width']}x{entry['height']} CSS px)\n"
        f"{len(frames)} frames follow (duplicates removed), labelled by time in the flow.\n"
        f"Named checkpoints: {marks or 'none'}\n"
        f"Automated DOM check hits (hints, seen_at = checkpoint names): {json.dumps(checks) if checks else 'none'}"
    )
    if entry.get("error"):
        intro += f"\nThe flow script FAILED: {entry['error']} (the last frames show the failure state)."
    content: list[dict] = [{"type": "text", "text": intro}]
    for f in frames:
        content.append({"type": "text", "text": f"Frame {f['label']}:"})
        content.append({"type": "image_url", "image_url": {"url": _data_url(pathlib.Path(f["path"]), "image/png")}})
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": content}]


def build_request(model: str, messages: list[dict]) -> dict:
    return {
        "model": model,
        "messages": messages,
        # No `temperature`: reasoning models (gpt-6-luna included) don't accept it, and with
        # require_parameters below one unsupported parameter rules out EVERY endpoint — each
        # call 404'd into the unstructured fallback until this was removed.
        # Explicit: some providers' default output cap truncates the JSON mid-object.
        "max_tokens": MAX_TOKENS,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "ui_findings", "strict": True, "schema": FINDINGS_SCHEMA},
        },
        # Without this, an endpoint that doesn't support json_schema silently drops it and
        # returns prose (see the openrouter skill: capabilities are per-endpoint).
        "provider": {"require_parameters": True},
    }


def coverage(result: dict, frames: list[dict]) -> dict:
    labels = [f["label"] for f in frames]
    reviewed = {str(fr.get("frame", "")).strip().strip("'\"").lower() for fr in result.get("frames_reviewed", [])
                if isinstance(fr, dict)}
    missing = [l for l in labels if l.lower() not in reviewed]
    return {"frames": len(labels), "reviewed": len(labels) - len(missing), "missing": missing}


def parse_response(body: dict) -> dict:
    """Pull the findings object out of an OpenRouter chat completion. Raises ValueError."""
    try:
        text = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ValueError(f"no message in response: {json.dumps(body)[:300]}")
    if isinstance(text, list):  # some providers return content parts
        text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
    text = (text or "").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    try:
        out = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise ValueError(f"response is not JSON: {text[:300]}")
        out = json.loads(text[start:end + 1])
    if not isinstance(out, dict) or not isinstance(out.get("findings"), list):
        raise ValueError("response JSON lacks a findings list")
    out["findings"] = [f for f in out["findings"] if isinstance(f, dict)]
    if not isinstance(out.get("frames_reviewed"), list):
        out["frames_reviewed"] = []
    for f in out["findings"]:
        if f.get("severity") not in SEVERITIES:
            f["severity"] = "minor"
        for k in ("frame", "confirms_check"):
            if f.get(k) in ("", "null", "none", "None"):
                f[k] = None
        ts = f.get("timestamp_s")
        if not isinstance(ts, (int, float)) or ts < 0:
            f["timestamp_s"] = None
    return out


def usage_cost(usage: dict) -> float | None:
    """Dollars actually spent. On a BYOK account `cost` is only OpenRouter's fee (often 0);
    the provider bill is in cost_details.upstream_inference_cost."""
    cost = usage.get("cost")
    upstream = (usage.get("cost_details") or {}).get("upstream_inference_cost")
    if usage.get("is_byok") and upstream is not None:
        return round((cost or 0) + upstream, 8)
    return cost


def call_openrouter(request: dict, api_key: str, timeout: float = 180) -> dict:
    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(request).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-Title": "vdebug",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"OpenRouter HTTP {e.code}: {e.read().decode(errors='replace')[:500]}") from None


def _complete(model: str, messages: list[dict], api_key: str) -> tuple[dict, dict]:
    """One judged call -> (parsed result, usage). Falls back to schema-in-prompt when no
    endpoint for the model supports json_schema (require_parameters turns that into a 404)."""
    try:
        body = call_openrouter(build_request(model, messages), api_key)
        structured = True
    except RuntimeError as e:
        if "HTTP 404" not in str(e):
            raise
        loose = [{**messages[0], "content": messages[0]["content"] + "\n\nReply with ONLY a JSON object matching "
                  "this JSON Schema, no prose:\n" + json.dumps(FINDINGS_SCHEMA)}] + messages[1:]
        body = call_openrouter({"model": model, "messages": loose, "max_tokens": MAX_TOKENS}, api_key)
        structured = False
    result = parse_response(body)
    result["structured"] = structured
    result["model"] = body.get("model", model)
    return result, body.get("usage") or {}


def judge_entry(entry: dict, run_dir: pathlib.Path, *, model: str, api_key: str,
                fps: int = DEFAULT_FPS, max_frames: int = MAX_FRAMES,
                film_dir: pathlib.Path | None = None) -> dict:
    """Judge one flow × viewport. Never raises for model/ffmpeg trouble — returns {'error': ...}.

    Frames are cut into `film_dir` (default: <flow>/<viewport>/film/ beside the video) and
    listed under `film` so findings' frame labels resolve to an image in report.md. Pass a
    distinct film_dir when judging the same recording concurrently (the eval does).
    """
    try:
        if not entry.get("video"):
            raise RuntimeError("no video recorded for this flow")
        video = run_dir / entry["video"]
        frames = extract_frames(video, film_dir or video.parent / "film", fps=fps, max_frames=max_frames)
        result, usage = _complete(model, build_messages(entry, frames), api_key)
        result["cost_usd"] = usage_cost(usage)
        result["tokens"] = {
            "prompt": usage.get("prompt_tokens") or 0,
            "completion": usage.get("completion_tokens") or 0,
            # Prompt-cache hits (automatic for repeated prefixes, e.g. re-judging a run).
            "cached": (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0,
        }
        result["coverage"] = coverage(result, frames)
        result["fps"] = fps
        # >max_frames distinct frames = content that never stops moving; thinning may hide a glitch.
        result["thinned_from"] = frames[0]["candidates"] if frames[0]["candidates"] > len(frames) else None
        result["film"] = [{"label": f["label"], "t": f["t"], "path": os.path.relpath(f["path"], run_dir)}
                          for f in frames]
        return result
    except (RuntimeError, ValueError, OSError) as e:
        return {"error": str(e), "model": model, "findings": []}


def judge_run(run_dir: pathlib.Path, *, model: str, api_key: str, fps: int = DEFAULT_FPS,
              log=print, workers: int = 6) -> dict:
    """Judge every entry in <run_dir>/report.json (concurrently) and rewrite it in place."""
    report_path = run_dir / "report.json"
    report = json.loads(report_path.read_text())
    runs = report["runs"]
    log(f"judging {len(runs)} flow x viewport recording(s) with {model} (video frames @ {fps} fps, deduped) ...")
    with ThreadPoolExecutor(max_workers=max(1, min(workers, len(runs)))) as pool:
        results = list(pool.map(lambda e: judge_entry(e, run_dir, model=model, api_key=api_key, fps=fps), runs))
    total = 0.0
    for entry, j in zip(runs, results):
        entry["judge"] = j
        where = f"  {entry['flow']} @ {entry['viewport']}:"
        if j.get("error"):
            log(f"{where} judge error: {j['error']}")
        else:
            cov, tok = j.get("coverage") or {}, j.get("tokens") or {}
            skipped = f"; SKIPPED frames {cov['missing']}" if cov.get("missing") else ""
            loose = "; unstructured (no json_schema endpoint; schema-in-prompt fallback)" \
                if j.get("structured") is False else ""
            thinned = (f"; THINNED {j['thinned_from']}->{cov.get('frames')} frames (always-moving content?)"
                       if j.get("thinned_from") else "")
            log(f"{where} {len(j['findings'])} finding(s) from {cov.get('frames')} frame(s); "
                f"${j.get('cost_usd') or 0:.4f}; {tok.get('prompt')} prompt tok ({tok.get('cached')} cached), "
                f"{tok.get('completion')} completion tok{thinned}{skipped}{loose}")
        total += j.get("cost_usd") or 0
    report["judge"] = {"model": model, "fps": fps, "cost_usd": round(total, 6)}
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    return report


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Re-judge an existing vdebug run directory.")
    ap.add_argument("run_dir", type=pathlib.Path)
    ap.add_argument("--model", default=os.environ.get("VDEBUG_MODEL", DEFAULT_MODEL))
    ap.add_argument("--fps", type=int, default=DEFAULT_FPS, help="video sampling rate before dedup (default 10)")
    a = ap.parse_args(argv)
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        print("OPENROUTER_API_KEY is not set", file=sys.stderr)
        return 2
    report = judge_run(a.run_dir, model=a.model, api_key=key, fps=a.fps, log=lambda m: print(m, file=sys.stderr))
    sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
    from vdebug import write_markdown  # noqa: E402  (sibling module; avoids a cycle at import time)
    write_markdown(a.run_dir, report)
    print(a.run_dir / "report.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
