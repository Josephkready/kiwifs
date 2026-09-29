// Package vdcapture is the Go port of the video-debugger flowstore ingest
// (Phase 1: capture real user flows into SQLite).
//
// recorder.js (served by the web UI) posts batches of semantic intent events.
// This package validates them like flowstore.py's FlowStore.ingest (narrowing
// where noted: no nav titles, redacted note paths, ASCII session ids) and
// writes them into a SQLite db that shares schema.sql with the Python tool, so
// `python3 vdebug/capture/flowstore.py mine --db <path>` runs on the same file.
//
// The client is untrusted: event types and payload keys are allowlisted, strings
// are capped, and re-sent batches are idempotent via UNIQUE(session_id, seq).
// No input values, query values, raw user agent, or user id are ever stored.
//
// Configuration (environment, read once by `kiwifs serve`):
//
//	KIWIFS_VD_CAPTURE         "0"/"false"/"off"/"no" disables capture (default: on)
//	KIWIFS_VD_FLOWS_DB        SQLite path (default /var/lib/kiwifs/flows.db); refused
//	                          inside --root; unopenable -> capture off, app unaffected
//	KIWIFS_VD_SAMPLE          fraction of browser sessions recorded, 0..1 (default 1)
//	KIWIFS_VD_RETENTION_DAYS  prune sessions idle longer than this, in-process, at most
//	                          once/24h (default 30); 0 or negative disables pruning
//
// A client can mint new session ids, so per-session/time-based limits aren't enough on
// their own: MaxSessions/MaxEvents below are a hard, store-wide ceiling that refuses new
// sessions once hit (existing sessions keep recording).
package vdcapture

import (
	"bytes"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

const (
	MaxEventsPerBatch   = 500
	MaxStr              = 200
	MaxEventsPerSession = 5000
	// A runaway client minting fresh session ids can't grow the store without bound
	// either: store-wide ceilings (new sessions are refused once hit; existing
	// sessions keep recording).
	MaxSessions = 20_000
	MaxEvents   = 1_000_000
)

var eventTypes = map[string]bool{
	"nav": true, "click": true, "input": true, "change": true,
	"submit": true, "scroll": true, "resize": true, "error": true,
}

var targetKeys = []string{"testid", "id", "role", "name", "tag", "css"}

// dataKeys is the per-type payload allowlist. "change" carries a value only for
// elements the app opted in with data-vd-capture-value; text inputs never do.
//
// kiwifs narrows flowstore's contract: nav "title" is dropped because the
// document title is the note's title, i.e. content.
var dataKeys = map[string][]string{
	"nav":    {"kind"},
	"click":  {"x", "y"},
	"input":  {"kind", "length"},
	"change": {"kind", "value"},
	"submit": {},
	"scroll": {"depth_pct"},
	"resize": {"w", "h"},
	"error":  {"message", "source"},
}

// BatchError means the batch is malformed; the endpoint answers 400.
type BatchError struct{ msg string }

func (e *BatchError) Error() string { return e.msg }

func batchErr(format string, a ...any) error { return &BatchError{fmt.Sprintf(format, a...)} }

// Result mirrors flowstore's last_ingest so the endpoint can log anomalies:
// steady Invalid means a broken/tampered client, Capped a runaway one.
type Result struct {
	Stored    int
	Duplicate int
	Invalid   int
	Capped    bool
}

type Store struct {
	db  *sql.DB
	now func() time.Time
	mu  sync.Mutex
}

// Open creates the parent dir if needed and applies schema.sql idempotently.
func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("create flows db dir: %w", err)
		}
	}
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(10000)&_pragma=foreign_keys(1)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open flows db: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply flows schema: %w", err)
	}
	return &Store{db: db, now: time.Now}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Prune deletes sessions (and their events, via ON DELETE CASCADE) not seen
// for `days`, mirroring flowstore.py's FlowStore.prune. It returns the number
// of sessions removed. days <= 0 is a no-op (retention disabled).
func (s *Store) Prune(days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cutoff := s.now().UTC().Add(-time.Duration(days)*24*time.Hour).Format("2006-01-02T15:04:05") + "+00:00"
	res, err := s.db.Exec("DELETE FROM sessions WHERE last_seen_at < ?", cutoff)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// isoNow matches Python's datetime.now(timezone.utc).isoformat(timespec="seconds"),
// so flowstore.py prune's string comparison keeps working on Go-written rows.
func (s *Store) isoNow() string {
	return s.now().UTC().Format("2006-01-02T15:04:05") + "+00:00"
}

// Ingest validates and stores one recorder.js batch (raw JSON body).
func (s *Store) Ingest(body []byte, userAgent string) (Result, error) {
	var res Result
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var raw any
	if err := dec.Decode(&raw); err != nil {
		return res, batchErr("invalid JSON")
	}
	batch, ok := raw.(map[string]any)
	if !ok {
		return res, batchErr("batch must be an object")
	}
	sid, ok := batch["session_id"].(string)
	if !ok || !validSessionID(sid) {
		return res, batchErr("session_id must be 8-64 alphanumerics")
	}
	events, ok := batch["events"].([]any)
	if !ok || len(events) == 0 {
		return res, batchErr("events must be a non-empty list")
	}
	if len(events) > MaxEventsPerBatch {
		return res, batchErr("at most %d events per batch", MaxEventsPerBatch)
	}
	var vw, vh *int64
	if vp, ok := batch["viewport"].(map[string]any); ok {
		vw, vh = toInt(vp["w"]), toInt(vp["h"])
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.isoNow()
	tx, err := s.db.Begin()
	if err != nil {
		return res, err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit

	var count int
	err = tx.QueryRow("SELECT event_count FROM sessions WHERE id = ?", sid).Scan(&count)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		var nSessions, nEvents int64
		if err := tx.QueryRow(
			"SELECT (SELECT COUNT(*) FROM sessions), (SELECT COUNT(*) FROM events)",
		).Scan(&nSessions, &nEvents); err != nil {
			return res, err
		}
		if nSessions >= MaxSessions || nEvents >= MaxEvents {
			res.Capped = true
			return res, tx.Commit() // read-only so far; nothing to roll back
		}
		if _, err := tx.Exec(
			"INSERT INTO sessions (id, started_at, last_seen_at, viewport_w, viewport_h, ua_class) VALUES (?, ?, ?, ?, ?, ?)",
			sid, now, now, nullInt(vw), nullInt(vh), UAClass(userAgent, vw),
		); err != nil {
			return res, err
		}
		count = 0
	case err != nil:
		return res, err
	}

	for _, rawEv := range events {
		if count+res.Stored >= MaxEventsPerSession {
			res.Capped = true
			break
		}
		ev, ok := rawEv.(map[string]any)
		if !ok {
			res.Invalid++
			continue
		}
		etype, _ := ev["type"].(string)
		if !eventTypes[etype] {
			res.Invalid++
			continue
		}
		seq, tms := toInt(ev["seq"]), toInt(ev["t"])
		if seq == nil || tms == nil || *seq < 0 || *tms < 0 {
			res.Invalid++
			continue
		}
		r, err := tx.Exec(
			"INSERT OR IGNORE INTO events (session_id, seq, t_ms, type, path, target, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
			sid, *seq, *tms, etype, nullStr(redactPath(capStr(ev["path"]))), nullStr(cleanTarget(ev["target"])), nullStr(cleanData(etype, ev["data"])),
		)
		if err != nil {
			return res, err
		}
		n, _ := r.RowsAffected()
		res.Stored += int(n)
		res.Duplicate += 1 - int(n)
	}
	if _, err := tx.Exec(
		"UPDATE sessions SET last_seen_at = ?, event_count = event_count + ? WHERE id = ?",
		now, res.Stored, sid,
	); err != nil {
		return res, err
	}
	return res, tx.Commit()
}

// contentRoutes carry a note path after the prefix. The note path is content
// (Mind slugs are descriptive titles), so only the route shape is kept:
// "/page/journal/2026-09-28.md?x=" -> "/page/:path?x=". Query values are
// stripped here too (recorder.js already does; the client is untrusted).
var contentRoutes = []string{"/page/", "/p/", "/raw/", "/api/kiwi/public/"}

func redactPath(p *string) *string {
	if p == nil {
		return nil
	}
	path, query, hasQuery := strings.Cut(*p, "?")
	for _, prefix := range contentRoutes {
		if strings.HasPrefix(path, prefix) {
			path = prefix + ":path"
			break
		}
	}
	if hasQuery {
		keys := strings.Split(query, "&")
		for i, kv := range keys {
			k, _, _ := strings.Cut(kv, "=")
			keys[i] = k + "="
		}
		path += "?" + strings.Join(keys, "&")
	}
	return &path
}

// validSessionID is ASCII-only, stricter than flowstore.py's str.isalnum()
// (which also accepts Unicode letters). recorder.js only emits hex ids.
func validSessionID(s string) bool {
	if len(s) < 8 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// toInt mirrors Python int(): numbers truncate, numeric strings parse, bools are 0/1.
func toInt(v any) *int64 {
	var n int64
	switch x := v.(type) {
	case json.Number:
		if i, err := x.Int64(); err == nil {
			n = i
		} else if f, err := x.Float64(); err == nil && !math.IsInf(f, 0) && !math.IsNaN(f) && math.Abs(f) < 1<<62 {
			n = int64(f)
		} else {
			return nil
		}
	case string:
		i, err := strconv.ParseInt(strings.TrimSpace(x), 10, 64)
		if err != nil {
			return nil
		}
		n = i
	case bool:
		if x {
			n = 1
		}
	default:
		return nil
	}
	return &n
}

// capStr mirrors flowstore's _s: stringify and cap at MaxStr characters.
func capStr(v any) *string {
	if v == nil {
		return nil
	}
	var s string
	switch x := v.(type) {
	case string:
		s = x
	case json.Number:
		s = x.String()
	case bool:
		s = "False"
		if x {
			s = "True"
		}
	default:
		b, _ := json.Marshal(x)
		s = string(b)
	}
	if utf8.RuneCountInString(s) > MaxStr {
		s = string([]rune(s)[:MaxStr])
	}
	return &s
}

func cleanTarget(v any) *string {
	t, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for _, k := range targetKeys {
		val, present := t[k]
		if !present || val == nil || val == "" {
			continue
		}
		out[k] = *capStr(val)
	}
	return marshalNonEmpty(out, len(out))
}

func cleanData(etype string, v any) *string {
	d, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]any{}
	for _, k := range dataKeys[etype] {
		val, present := d[k]
		if !present || val == nil {
			continue
		}
		switch val.(type) {
		case json.Number, bool:
			out[k] = val
		default:
			out[k] = *capStr(val)
		}
	}
	return marshalNonEmpty(out, len(out))
}

func marshalNonEmpty(v any, n int) *string {
	if n == 0 {
		return nil
	}
	b, err := json.Marshal(v) // map keys marshal sorted, like json.dumps(sort_keys=True)
	if err != nil {
		return nil
	}
	s := string(b)
	return &s
}

// UAClass is the coarse device class; the raw user agent is never stored.
func UAClass(userAgent string, viewportW *int64) string {
	ua := strings.ToLower(userAgent)
	switch {
	case strings.Contains(ua, "ipad") || strings.Contains(ua, "tablet"):
		return "tablet"
	case strings.Contains(ua, "mobi") || strings.Contains(ua, "android") || strings.Contains(ua, "iphone"):
		return "mobile"
	}
	if viewportW != nil {
		switch {
		case *viewportW < 600:
			return "mobile"
		case *viewportW < 1024:
			return "tablet"
		}
	}
	return "desktop"
}

func nullInt(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}

func nullStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
