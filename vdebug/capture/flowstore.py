#!/usr/bin/env python3
"""flowstore — SQLite store + miner for captured user flows (video-debugger Phase 1).

Stdlib only, so it drops into any Python web app. Two halves:

* **Ingest** (`FlowStore.ingest`) — called by the app's POST endpoint with the JSON
  batch that recorder.js sends. The client is untrusted: every field is validated,
  length-capped, and allowlisted here; unknown keys are dropped; the server clock
  stamps sessions. Re-sent batches are idempotent via UNIQUE(session_id, seq).
* **Mining** (`FlowStore.mine`) — collapses each session into a step signature
  (route + what was clicked/submitted), clusters identical signatures, and emits the
  most frequent clusters with one exemplar session's full event list. That JSON is
  what the coding agent reads to write Playwright flow scripts (Phase 2).

CLI:
    flowstore.py stats --db /var/lib/<app>/flows.db
    flowstore.py mine  --db ... [--top 10] [--min-sessions 3] [--out mined.json]
    flowstore.py promote --db ... --id <cluster-id> --name <vdebug-flow-name>
    flowstore.py prune --db ... --days 30
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import pathlib
import re
import sqlite3
import sys
import threading
import time
from typing import Any

SCHEMA = pathlib.Path(__file__).with_name("schema.sql")

EVENT_TYPES = {"nav", "click", "input", "change", "submit", "scroll", "resize", "error"}
TARGET_KEYS = ("testid", "id", "role", "name", "tag", "css")
# Per-type payload allowlist. Anything else the client sends is discarded.
DATA_KEYS = {
    "nav": ("title", "kind"),
    "click": ("x", "y"),
    "input": ("kind", "length"),
    "change": ("kind", "value"),  # value only arrives for elements the app allowlisted
    "submit": (),
    "scroll": ("depth_pct",),
    "resize": ("w", "h"),
    "error": ("message", "source"),
}
MAX_EVENTS_PER_BATCH = 500
MAX_STR = 200
MAX_EVENTS_PER_SESSION = 5000  # a runaway client can't grow the DB without bound
# ...and minting fresh session ids can't either: store-wide ceilings (new sessions are refused).
MAX_SESSIONS = 20_000
MAX_EVENTS = 1_000_000
SESSION_ID = re.compile(r"[A-Za-z0-9]{8,64}")  # ASCII only (str.isalnum() accepts any script)
PRUNE_INTERVAL_S = 24 * 3600

_last_prune: dict[str, float] = {}  # path -> monotonic time of the last lazy prune
_lock = threading.Lock()


class BatchError(ValueError):
    """The batch is malformed; the endpoint should answer 400."""


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _s(v: Any, cap: int = MAX_STR) -> str | None:
    if v is None:
        return None
    return str(v)[:cap]


def _int(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _clean_path(v: Any) -> str | None:
    """Path with query VALUES stripped (keys kept) — never trust the client to have done it."""
    path = _s(v)
    if path is None or "?" not in path:
        return path
    base, _, query = path.partition("?")
    keys = [kv.split("=", 1)[0] for kv in query.split("&") if kv]
    return base + ("?" + "&".join(k + "=" for k in keys) if keys else "")


def _clean_target(t: Any) -> str | None:
    if not isinstance(t, dict):
        return None
    out = {k: _s(t.get(k)) for k in TARGET_KEYS if t.get(k) not in (None, "")}
    return json.dumps(out, sort_keys=True) if out else None


def _clean_data(etype: str, d: Any) -> str | None:
    if not isinstance(d, dict):
        return None
    out = {}
    for k in DATA_KEYS[etype]:
        v = d.get(k)
        if v is None:
            continue
        out[k] = v if isinstance(v, (int, float, bool)) else _s(v)
    return json.dumps(out, sort_keys=True) if out else None


def ua_class(user_agent: str | None, viewport_w: int | None) -> str:
    """Coarse device class. The raw UA is never stored (fingerprinting surface)."""
    ua = (user_agent or "").lower()
    if "ipad" in ua or "tablet" in ua:
        return "tablet"
    if "mobi" in ua or "android" in ua or "iphone" in ua:
        return "mobile"
    if viewport_w is not None:
        return "mobile" if viewport_w < 600 else "tablet" if viewport_w < 1024 else "desktop"
    return "desktop"


class FlowStore:
    """One connection. Cheap to open per request (the schema is applied once per process).

    prune_days: lazy retention — on open, delete sessions idle longer than this, at most once
    a day per db per process. No cron/timer (and so no infra change) needed. None disables it.
    """

    def __init__(self, path: str | pathlib.Path, *, prune_days: int | None = None):
        self.path = str(path)
        pathlib.Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        # Apply the schema only when it's missing: a cheap catalog lookup, and still correct if
        # the db file was deleted and recreated while this process kept running.
        if not self.db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sessions'").fetchone():
            self.db.executescript(SCHEMA.read_text())
        self.last_ingest: dict | None = None
        if prune_days is not None:
            now = time.monotonic()
            with _lock:
                due = now - _last_prune.get(self.path, -PRUNE_INTERVAL_S) >= PRUNE_INTERVAL_S
                if due:
                    _last_prune[self.path] = now
            if due:
                self.prune(prune_days)

    def close(self) -> None:
        self.db.close()

    # ---------------------------------------------------------------- ingest
    def ingest(self, batch: Any, *, user_agent: str | None = None) -> int:
        """Validate and store one recorder.js batch. Returns events stored.

        `self.last_ingest` then holds {stored, duplicate, invalid, capped} so the endpoint can
        log anomalies: steady `invalid` means a broken/tampered client; `capped` a runaway one.
        """
        if not isinstance(batch, dict):
            raise BatchError("batch must be an object")
        sid = batch.get("session_id")
        if not isinstance(sid, str) or not SESSION_ID.fullmatch(sid):
            raise BatchError("session_id must be 8-64 alphanumerics")
        events = batch.get("events")
        if not isinstance(events, list) or not events:
            raise BatchError("events must be a non-empty list")
        if len(events) > MAX_EVENTS_PER_BATCH:
            raise BatchError(f"at most {MAX_EVENTS_PER_BATCH} events per batch")
        vp = batch.get("viewport") if isinstance(batch.get("viewport"), dict) else {}
        vw, vh = _int(vp.get("w")), _int(vp.get("h"))

        now = _now()
        with self.db:
            row = self.db.execute(
                "SELECT event_count FROM sessions WHERE id = ?", (sid,)
            ).fetchone()
            if row is None:
                n_sessions, n_events = self.db.execute(
                    "SELECT (SELECT COUNT(*) FROM sessions), (SELECT COUNT(*) FROM events)").fetchone()
                if n_sessions >= MAX_SESSIONS or n_events >= MAX_EVENTS:
                    self.last_ingest = {"stored": 0, "duplicate": 0, "invalid": 0, "capped": True}
                    return 0
                self.db.execute(
                    "INSERT INTO sessions (id, started_at, last_seen_at, viewport_w, viewport_h, ua_class)"
                    " VALUES (?, ?, ?, ?, ?, ?)",
                    (sid, now, now, vw, vh, ua_class(user_agent, vw)),
                )
                count = 0
            else:
                count = row["event_count"]
            stored = invalid = duplicate = 0
            capped = False
            for ev in events:
                if count + stored >= MAX_EVENTS_PER_SESSION:
                    capped = True
                    break
                if not isinstance(ev, dict) or ev.get("type") not in EVENT_TYPES:
                    invalid += 1
                    continue
                seq, t_ms = _int(ev.get("seq")), _int(ev.get("t"))
                if seq is None or t_ms is None or seq < 0 or t_ms < 0:
                    invalid += 1
                    continue
                cur = self.db.execute(
                    "INSERT OR IGNORE INTO events (session_id, seq, t_ms, type, path, target, data)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        sid, seq, t_ms, ev["type"], _clean_path(ev.get("path")),
                        _clean_target(ev.get("target")), _clean_data(ev["type"], ev.get("data")),
                    ),
                )
                stored += cur.rowcount
                duplicate += 1 - cur.rowcount  # INSERT OR IGNORE: an already-stored seq
            self.db.execute(
                "UPDATE sessions SET last_seen_at = ?, event_count = event_count + ? WHERE id = ?",
                (now, stored, sid),
            )
        self.last_ingest = {"stored": stored, "duplicate": duplicate, "invalid": invalid, "capped": capped}
        return stored

    def prune(self, days: int) -> int:
        """Delete sessions (and their events) not seen for `days`. Returns sessions removed."""
        cutoff = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days)).isoformat(timespec="seconds")
        with self.db:
            return self.db.execute("DELETE FROM sessions WHERE last_seen_at < ?", (cutoff,)).rowcount

    # ---------------------------------------------------------------- mining
    def session_events(self, sid: str) -> list[dict]:
        rows = self.db.execute(
            "SELECT seq, t_ms, type, path, target, data FROM events WHERE session_id = ? ORDER BY seq",
            (sid,),
        ).fetchall()
        return [
            {
                "seq": r["seq"], "t_ms": r["t_ms"], "type": r["type"], "path": r["path"],
                "target": json.loads(r["target"]) if r["target"] else None,
                "data": json.loads(r["data"]) if r["data"] else None,
            }
            for r in rows
        ]

    @staticmethod
    def signature(events: list[dict]) -> list[str]:
        """Collapse a session to its intent steps: route visits + what was acted on.

        Scroll/resize/input keystrokes are noise for flow identity; consecutive
        duplicates collapse (ten clicks on "next" is one step, not ten).
        """
        steps: list[str] = []
        for ev in events:
            t = ev.get("target") or {}
            label = t.get("testid") or t.get("name") or t.get("id") or t.get("tag") or "?"
            if ev["type"] == "nav":
                step = f"visit {ev.get('path') or '/'}"
            elif ev["type"] in ("click", "submit", "change"):
                step = f"{ev['type']} {label}"
            else:
                continue
            if not steps or steps[-1] != step:
                steps.append(step)
        return steps

    def mine(self, *, top: int = 10, min_sessions: int = 2, min_steps: int = 2) -> list[dict]:
        clusters: dict[str, dict] = {}
        for r in self.db.execute("SELECT id FROM sessions ORDER BY started_at").fetchall():
            events = self.session_events(r["id"])
            sig = self.signature(events)
            if len(sig) < min_steps:
                continue
            key = hashlib.sha1(json.dumps(sig).encode()).hexdigest()[:12]
            c = clusters.setdefault(key, {"id": key, "signature": sig, "sessions": 0, "exemplar": None,
                                          "viewports": {}, "errors": 0})
            c["sessions"] += 1
            c["errors"] += sum(1 for e in events if e["type"] == "error")
            vp = self.db.execute("SELECT ua_class FROM sessions WHERE id = ?", (r["id"],)).fetchone()[0]
            c["viewports"][vp] = c["viewports"].get(vp, 0) + 1
            # Keep the richest session as the exemplar — most detail for the agent.
            if c["exemplar"] is None or len(events) > len(c["exemplar"]["events"]):
                c["exemplar"] = {"session_id": r["id"], "events": events}
        promoted = {r["id"]: r["name"] for r in self.db.execute("SELECT id, name FROM flows")}
        out = [c for c in clusters.values() if c["sessions"] >= min_sessions]
        for c in out:
            c["covered_by"] = promoted.get(c["id"])
        out.sort(key=lambda c: (-c["sessions"], c["id"]))
        return out[:top]

    def promote(self, cluster_id: str, name: str, *, min_sessions: int = 1) -> None:
        """Record that vdebug flow `name` now covers mined cluster `cluster_id`."""
        match = next((c for c in self.mine(top=10**6, min_sessions=min_sessions, min_steps=1)
                      if c["id"] == cluster_id), None)
        if match is None:
            raise KeyError(f"no mined cluster {cluster_id}")
        with self.db:
            self.db.execute(
                "INSERT OR REPLACE INTO flows (id, name, signature, sessions, promoted_at) VALUES (?, ?, ?, ?, ?)",
                (cluster_id, name, json.dumps(match["signature"]), match["sessions"], _now()),
            )

    def stats(self) -> dict:
        q = lambda sql: self.db.execute(sql).fetchone()[0]  # noqa: E731
        return {
            "sessions": q("SELECT COUNT(*) FROM sessions"),
            "events": q("SELECT COUNT(*) FROM events"),
            "oldest": q("SELECT MIN(started_at) FROM sessions"),
            "newest": q("SELECT MAX(last_seen_at) FROM sessions"),
            "by_device": dict(self.db.execute("SELECT ua_class, COUNT(*) FROM sessions GROUP BY ua_class").fetchall()),
            "promoted_flows": q("SELECT COUNT(*) FROM flows"),
        }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("stats", "mine", "promote", "prune"):
        p = sub.add_parser(name)
        p.add_argument("--db", required=True)
        if name == "mine":
            p.add_argument("--top", type=int, default=10)
            p.add_argument("--min-sessions", type=int, default=2)
            p.add_argument("--out", help="write JSON here instead of stdout")
        if name == "promote":
            p.add_argument("--id", required=True)
            p.add_argument("--name", required=True)
        if name == "prune":
            p.add_argument("--days", type=int, required=True)
    a = ap.parse_args(argv)
    store = FlowStore(a.db)
    try:
        if a.cmd == "stats":
            print(json.dumps(store.stats(), indent=2))
        elif a.cmd == "mine":
            text = json.dumps(store.mine(top=a.top, min_sessions=a.min_sessions), indent=2)
            if a.out:
                pathlib.Path(a.out).write_text(text + "\n")
                print(f"wrote {a.out}", file=sys.stderr)
            else:
                print(text)
        elif a.cmd == "promote":
            store.promote(a.id, a.name)
            print(f"promoted {a.id} -> {a.name}")
        elif a.cmd == "prune":
            print(f"pruned {store.prune(a.days)} session(s)")
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
