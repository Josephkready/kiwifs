"""Tests for flowstore.py — ingest validation (the client is untrusted), idempotency, mining."""

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from flowstore import BatchError, FlowStore, main, ua_class  # noqa: E402

SID = "a1b2c3d4e5f60718"


@pytest.fixture
def store(tmp_path):
    s = FlowStore(tmp_path / "flows.db")
    yield s
    s.close()


def ev(seq, type_, path="/", target=None, data=None, t=None):
    return {"seq": seq, "t": seq * 100 if t is None else t, "type": type_, "path": path, "target": target, "data": data}


def batch(events, sid=SID, viewport=None):
    return {"session_id": sid, "viewport": viewport or {"w": 375, "h": 667}, "events": events}


@pytest.mark.parametrize("bad", [
    None, [], "x", {"session_id": "short", "events": [ev(0, "nav")]},
    {"session_id": "has-dashes-0001", "events": [ev(0, "nav")]},
    {"session_id": SID, "events": []}, {"session_id": SID, "events": "nope"},
    {"session_id": SID, "events": [ev(i, "nav") for i in range(501)]},
])
def test_ingest_rejects_malformed_batches(store, bad):
    with pytest.raises(BatchError):
        store.ingest(bad)


def test_ingest_drops_bad_events_and_unknown_fields(store):
    n = store.ingest(batch([
        ev(0, "nav", data={"title": "Home", "kind": "load", "cookie": "secret"}),
        ev(1, "input", target={"id": "email", "evil": "x"}, data={"kind": "email", "length": 12, "value": "me@x.com"}),
        ev(2, "keylogger"),                 # unknown type
        {"seq": "x", "t": 1, "type": "click"},  # bad seq
        ev(3, "click", t=-5),               # negative time
    ]))
    assert n == 2
    assert store.last_ingest == {"stored": 2, "duplicate": 0, "invalid": 3, "capped": False}
    events = store.session_events(SID)
    assert events[0]["data"] == {"kind": "load", "title": "Home"}
    assert events[1]["target"] == {"id": "email"}
    assert events[1]["data"] == {"kind": "email", "length": 12}  # the value never lands
    assert "me@x.com" not in json.dumps(events)


def test_ingest_is_idempotent_on_resend(store):
    b = batch([ev(0, "nav"), ev(1, "click", target={"name": "Buy"})])
    assert store.ingest(b) == 2
    assert store.ingest(b) == 0
    assert store.last_ingest == {"stored": 0, "duplicate": 2, "invalid": 0, "capped": False}
    assert store.stats()["events"] == 2
    assert store.db.execute("SELECT event_count FROM sessions").fetchone()[0] == 2


def test_ingest_caps_long_strings(store):
    store.ingest(batch([ev(0, "error", data={"message": "x" * 5000})]))
    assert len(store.session_events(SID)[0]["data"]["message"]) == 200


def test_ua_class_never_needs_raw_ua():
    assert ua_class("Mozilla/5.0 (iPhone; ...) Mobile", 390) == "mobile"
    assert ua_class("Mozilla/5.0 (iPad; ...)", 820) == "tablet"
    assert ua_class(None, 1440) == "desktop"
    assert ua_class("", 700) == "tablet"


def test_signature_collapses_noise():
    events = [ev(0, "nav", "/"), ev(1, "scroll"), ev(2, "click", target={"testid": "next"}),
              ev(3, "click", target={"testid": "next"}), ev(4, "input", target={"id": "q"}),
              ev(5, "nav", "/cart"), ev(6, "submit", target={"name": "Checkout"})]
    assert FlowStore.signature(events) == ["visit /", "click next", "visit /cart", "submit Checkout"]


def _session(store, sid, path_seq):
    evs = []
    for i, p in enumerate(path_seq):
        evs.append(ev(2 * i, "nav", p))
        evs.append(ev(2 * i + 1, "click", p, target={"name": f"go-{i}"}))
    store.ingest(batch(evs, sid=sid))


def test_mine_clusters_and_ranks_by_frequency(store):
    for i in range(3):
        _session(store, f"checkout{i:08d}", ["/", "/cart", "/pay"])
    for i in range(2):
        _session(store, f"settings{i:08d}", ["/", "/settings"])
    _session(store, "oneoff00000000", ["/", "/about"])
    mined = store.mine(top=10, min_sessions=2)
    assert [c["sessions"] for c in mined] == [3, 2]
    assert mined[0]["signature"][:3] == ["visit /", "click go-0", "visit /cart"]
    assert mined[0]["exemplar"]["events"][0]["type"] == "nav"
    assert mined[0]["viewports"] == {"mobile": 3}
    assert mined[0]["covered_by"] is None

    store.promote(mined[0]["id"], "checkout")
    again = store.mine(top=10, min_sessions=2)
    assert again[0]["covered_by"] == "checkout"
    with pytest.raises(KeyError):
        store.promote("nope", "x")


def test_prune_removes_stale_sessions_and_events(store):
    store.ingest(batch([ev(0, "nav")]))
    store.db.execute("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00+00:00'")
    store.db.commit()
    assert store.prune(30) == 1
    assert store.stats()["events"] == 0  # events cascade with their session


def test_cli_mine_writes_json(tmp_path, capsys):
    db = tmp_path / "f.db"
    s = FlowStore(db)
    for i in range(2):
        _session(s, f"sess{i:012d}", ["/", "/x"])
    s.close()
    out = tmp_path / "mined.json"
    assert main(["mine", "--db", str(db), "--out", str(out)]) == 0
    assert json.loads(out.read_text())[0]["sessions"] == 2
    assert main(["stats", "--db", str(db)]) == 0
    assert json.loads(capsys.readouterr().out)["sessions"] == 2


def test_ingest_reports_session_cap(store, monkeypatch):
    import flowstore
    monkeypatch.setattr(flowstore, "MAX_EVENTS_PER_SESSION", 3)
    assert store.ingest(batch([ev(i, "click") for i in range(5)])) == 3
    assert store.last_ingest == {"stored": 3, "duplicate": 0, "invalid": 0, "capped": True}


def test_cli_promote_and_prune(tmp_path, capsys):
    db = tmp_path / "f.db"
    s = FlowStore(db)
    for i in range(2):
        _session(s, f"sess{i:012d}", ["/", "/x"])
    cid = s.mine()[0]["id"]
    s.close()
    assert main(["promote", "--db", str(db), "--id", cid, "--name", "x-flow"]) == 0
    assert f"promoted {cid} -> x-flow" in capsys.readouterr().out
    s = FlowStore(db)
    assert s.mine()[0]["covered_by"] == "x-flow"
    s.db.execute("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00+00:00'")
    s.db.commit()
    s.close()
    assert main(["prune", "--db", str(db), "--days", "30"]) == 0
    assert "pruned 2 session(s)" in capsys.readouterr().out
