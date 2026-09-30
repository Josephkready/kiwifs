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


def test_session_id_must_be_ascii(store):
    with pytest.raises(BatchError):
        store.ingest(batch([ev(0, "nav")], sid="ａｂｃｄｅｆｇｈ12"))   # full-width letters pass isalnum()


def test_open_creates_parent_dir_and_applies_schema_once(tmp_path, monkeypatch):
    import flowstore
    db = tmp_path / "deep" / "er" / "flows.db"
    FlowStore(db).close()
    assert db.exists()
    reads = []
    real = flowstore.SCHEMA.read_text
    monkeypatch.setattr(flowstore, "SCHEMA", type("S", (), {"read_text": lambda self: reads.append(1) or real()})())
    FlowStore(db).close()
    assert reads == []  # tables exist: schema not re-applied
    db.unlink()         # deleted and recreated while the process keeps running
    s = FlowStore(db)
    assert s.ingest(batch([ev(0, "nav")])) == 1 and reads == [1]
    s.close()


def test_lazy_prune_runs_at_most_once_per_interval(tmp_path, monkeypatch):
    import flowstore
    db = tmp_path / "flows.db"
    s = FlowStore(db)
    s.ingest(batch([ev(0, "nav")]))
    s.db.execute("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00+00:00'")
    s.db.commit()
    s.close()
    FlowStore(db, prune_days=30).close()               # first open prunes
    s = FlowStore(db)
    assert s.stats()["sessions"] == 0
    s.ingest(batch([ev(0, "nav")], sid="bbbbbbbb00000000"))
    s.db.execute("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00+00:00'")
    s.db.commit()
    s.close()
    FlowStore(db, prune_days=30).close()               # within the interval: no prune
    s = FlowStore(db)
    assert s.stats()["sessions"] == 1
    s.close()
    monkeypatch.setitem(flowstore._last_prune, str(db), -10 * flowstore.PRUNE_INTERVAL_S)
    FlowStore(db, prune_days=30).close()               # interval elapsed: prunes again
    s = FlowStore(db)
    assert s.stats()["sessions"] == 0
    s.close()


def test_server_strips_query_values_even_if_client_did_not(store):
    store.ingest(batch([ev(0, "nav", path="/search?q=my+secret&page=2"), ev(1, "nav", path="/a?")]))
    assert [e["path"] for e in store.session_events(SID)] == ["/search?q=&page=", "/a"]


@pytest.mark.parametrize("path,want", [
    ("/a#/b?x=1", "/a#/b?x="),            # hash-routed: the query after the fragment is stripped too
    ("/p?a=1&b", "/p?a=&b="),
])
def test_clean_path_edge_cases(store, path, want):
    store.ingest(batch([ev(0, "nav", path=path)]))
    assert store.session_events(SID)[0]["path"] == want


def test_store_wide_ceiling_refuses_new_sessions(store, monkeypatch):
    import flowstore
    monkeypatch.setattr(flowstore, "MAX_SESSIONS", 1)
    assert store.ingest(batch([ev(0, "nav")])) == 1
    assert store.ingest(batch([ev(0, "nav")], sid="cccccccc00000000")) == 0
    assert store.last_ingest["capped"] is True
    assert store.ingest(batch([ev(1, "click")])) == 1       # the existing session still records


def test_store_wide_event_ceiling_is_shared_across_sessions(store, monkeypatch):
    import flowstore
    monkeypatch.setattr(flowstore, "MAX_EVENTS", 4)
    assert store.ingest(batch([ev(i, "click") for i in range(3)])) == 3                       # session A
    assert store.ingest(batch([ev(i, "click") for i in range(3)], sid="bbbbbbbb00000000")) == 1  # B gets the room left
    assert store.last_ingest["capped"] is True
    assert store.ingest(batch([ev(0, "click")], sid="cccccccc00000000")) == 0                  # full: no new sessions


def test_event_count_is_cached_not_rescanned_per_ingest(store, monkeypatch):
    import flowstore
    store.ingest(batch([ev(0, "nav")]))
    scans = []
    real = store.db
    class Spy:
        def __getattr__(self, name):
            return getattr(real, name)
        def execute(self, sql, *a):
            if "COUNT(*) FROM events" in sql:
                scans.append(sql)
            return real.execute(sql, *a)
        def __enter__(self):
            return real.__enter__()
        def __exit__(self, *exc):
            return real.__exit__(*exc)
    monkeypatch.setattr(store, "db", Spy())
    for i in range(1, 6):
        store.ingest(batch([ev(i, "click")]))
    assert scans == []                                   # served from the per-process cache
    assert flowstore._event_count[store.path][0] == 6


def test_store_wide_event_ceiling_applies_to_existing_sessions(store, monkeypatch):
    import flowstore
    monkeypatch.setattr(flowstore, "MAX_EVENTS", 3)
    assert store.ingest(batch([ev(0, "nav"), ev(1, "click")])) == 2
    assert store.ingest(batch([ev(2, "click"), ev(3, "click"), ev(4, "click")])) == 1   # same session
    assert store.last_ingest["capped"] is True


def test_concurrent_first_batches_of_one_session_do_not_race(tmp_path):
    """Recorder flushes on a timer AND on pagehide: two first batches of one session can hit
    two connections at once. Both must be stored, neither may raise IntegrityError."""
    import threading
    db = tmp_path / "race.db"
    FlowStore(db).close()
    errors, barrier = [], threading.Barrier(8)

    def worker(i):
        s = FlowStore(db)
        try:
            barrier.wait()
            s.ingest(batch([ev(i, "click")], sid="racerace00000000"))
        except Exception as e:  # noqa: BLE001 — the point is that nothing escapes
            errors.append(repr(e))
        finally:
            s.close()
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    s = FlowStore(db)
    try:
        assert errors == []
        assert len(s.session_events("racerace00000000")) == 8
    finally:
        s.close()


def test_lazy_prune_exposes_how_many_sessions_it_removed(tmp_path):
    db = tmp_path / "flows.db"
    s = FlowStore(db)
    s.ingest(batch([ev(0, "nav")]))
    s.db.execute("UPDATE sessions SET last_seen_at = '2000-01-01T00:00:00+00:00'")
    s.db.commit()
    s.close()
    s = FlowStore(db, prune_days=30)
    assert s.last_prune_count == 1
    s.close()
    assert FlowStore(db).last_prune_count is None       # no prune requested


def test_event_count_cache_is_not_bumped_by_a_rolled_back_ingest(store, monkeypatch):
    import sqlite3

    import flowstore
    store.ingest(batch([ev(0, "nav")]))
    before = flowstore._event_count[store.path][0]
    real = store.db

    class FailingUpdate:
        def __getattr__(self, name):
            return getattr(real, name)

        def __enter__(self):
            return real.__enter__()

        def __exit__(self, *exc):
            return real.__exit__(*exc)

        def execute(self, sql, *a):
            if sql.startswith("UPDATE sessions"):
                raise sqlite3.OperationalError("disk I/O error")
            return real.execute(sql, *a)
    monkeypatch.setattr(store, "db", FailingUpdate())
    with pytest.raises(sqlite3.OperationalError):
        store.ingest(batch([ev(1, "click"), ev(2, "click")]))
    assert flowstore._event_count[store.path][0] == before          # rolled back: cache untouched
    monkeypatch.undo()
    assert store.stats()["events"] == 1                                # and nothing was stored
