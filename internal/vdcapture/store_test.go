package vdcapture

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

const sid = "a1b2c3d4e5f60718"

func openStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "state", "flows.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func ev(seq int, typ string, extra map[string]any) map[string]any {
	e := map[string]any{"seq": seq, "t": seq * 100, "type": typ, "path": "/"}
	for k, v := range extra {
		e[k] = v
	}
	return e
}

func batchJSON(t *testing.T, events ...map[string]any) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{"session_id": sid, "viewport": map[string]any{"w": 375, "h": 667}, "events": events})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type row struct {
	Seq          int64
	Type         string
	Path         sql.NullString
	Target, Data sql.NullString
}

func rows(t *testing.T, st *Store) []row {
	t.Helper()
	rs, err := st.db.Query("SELECT seq, type, path, target, data FROM events ORDER BY seq")
	if err != nil {
		t.Fatal(err)
	}
	defer rs.Close()
	var out []row
	for rs.Next() {
		var r row
		if err := rs.Scan(&r.Seq, &r.Type, &r.Path, &r.Target, &r.Data); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func dump(t *testing.T, st *Store) string {
	t.Helper()
	var sb strings.Builder
	for _, table := range []string{"sessions", "events"} {
		rs, err := st.db.Query("SELECT * FROM " + table)
		if err != nil {
			t.Fatal(err)
		}
		cols, _ := rs.Columns()
		for rs.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rs.Scan(ptrs...); err != nil {
				t.Fatal(err)
			}
			fmt.Fprintln(&sb, vals...)
		}
		rs.Close()
	}
	return sb.String()
}

func TestIngestRejectsMalformedBatches(t *testing.T) {
	st := openStore(t)
	many := make([]map[string]any, MaxEventsPerBatch+1)
	for i := range many {
		many[i] = ev(i, "click", nil)
	}
	tooMany, _ := json.Marshal(map[string]any{"session_id": sid, "events": many})
	cases := map[string]string{
		"not json":       `{`,
		"not an object":  `[1,2]`,
		"no session":     `{"events":[{"seq":0,"t":0,"type":"click"}]}`,
		"short session":  `{"session_id":"abc","events":[{"seq":0,"t":0,"type":"click"}]}`,
		"long session":   `{"session_id":"` + strings.Repeat("a", 65) + `","events":[{"seq":0,"t":0,"type":"click"}]}`,
		"punct session":  `{"session_id":"abcd-efgh-ijkl","events":[{"seq":0,"t":0,"type":"click"}]}`,
		"numeric sid":    `{"session_id":12345678,"events":[{"seq":0,"t":0,"type":"click"}]}`,
		"no events":      `{"session_id":"` + sid + `"}`,
		"empty events":   `{"session_id":"` + sid + `","events":[]}`,
		"events not arr": `{"session_id":"` + sid + `","events":{"a":1}}`,
		"too many":       string(tooMany),
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := st.Ingest([]byte(body), "")
			var be *BatchError
			if err == nil || !asBatchErr(err, &be) {
				t.Fatalf("want BatchError, got %v", err)
			}
		})
	}
	var n int
	st.db.QueryRow("SELECT COUNT(*) FROM sessions").Scan(&n)
	if n != 0 {
		t.Fatalf("malformed batches created %d session(s)", n)
	}
}

func asBatchErr(err error, target **BatchError) bool {
	be, ok := err.(*BatchError)
	if ok {
		*target = be
	}
	return ok
}

func TestIngestSkipsInvalidEventsAndKeepsValidOnes(t *testing.T) {
	st := openStore(t)
	body := batchJSON(t,
		ev(0, "nav", nil),
		ev(1, "keylog", nil), // unknown type
		map[string]any{"seq": -1, "t": 0, "type": "click"}, // negative seq
		map[string]any{"seq": 3, "type": "click"},          // missing t
		map[string]any{"seq": "x", "t": 1, "type": "click"},
		ev(5, "click", nil),
	)
	res, err := st.Ingest(body, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Stored != 2 || res.Invalid != 4 || res.Duplicate != 0 || res.Capped {
		t.Fatalf("result = %+v", res)
	}
	got := rows(t, st)
	if len(got) != 2 || got[0].Type != "nav" || got[1].Seq != 5 {
		t.Fatalf("rows = %+v", got)
	}
}

func TestIngestIsIdempotentOnResend(t *testing.T) {
	st := openStore(t)
	body := batchJSON(t, ev(0, "nav", nil), ev(1, "click", nil))
	if _, err := st.Ingest(body, ""); err != nil {
		t.Fatal(err)
	}
	res, err := st.Ingest(body, "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Stored != 0 || res.Duplicate != 2 {
		t.Fatalf("resend result = %+v", res)
	}
	var count, stored int
	st.db.QueryRow("SELECT event_count FROM sessions WHERE id = ?", sid).Scan(&count)
	st.db.QueryRow("SELECT COUNT(*) FROM events").Scan(&stored)
	if count != 2 || stored != 2 {
		t.Fatalf("event_count=%d rows=%d, want 2/2", count, stored)
	}
}

func TestIngestNeverStoresInputValuesOrUnknownKeys(t *testing.T) {
	st := openStore(t)
	const secret = "person@example.com"
	body := batchJSON(t,
		ev(0, "input", map[string]any{
			"target": map[string]any{"role": "textbox", "name": "Email", "value": secret, "innerText": secret},
			"data":   map[string]any{"kind": "email", "length": 18, "value": secret},
		}),
		ev(1, "submit", map[string]any{"data": map[string]any{"value": secret, "fields": []any{secret}}}),
		ev(2, "click", map[string]any{"data": map[string]any{"x": 10, "y": 20, "text": secret}, "value": secret}),
		ev(3, "nav", map[string]any{"data": map[string]any{"kind": "load", "title": "Home", "url": "/?q=" + secret}}),
	)
	if _, err := st.Ingest(body, "Mozilla/5.0 (iPhone) secret-ua-token"); err != nil {
		t.Fatal(err)
	}
	all := dump(t, st)
	for _, leak := range []string{secret, "secret-ua-token", "iPhone", "innerText", "fields"} {
		if strings.Contains(all, leak) {
			t.Fatalf("stored %q:\n%s", leak, all)
		}
	}
	got := rows(t, st)
	if got[0].Data.String != `{"kind":"email","length":18}` {
		t.Fatalf("input data = %s", got[0].Data.String)
	}
	if got[0].Target.String != `{"name":"Email","role":"textbox"}` {
		t.Fatalf("input target = %s", got[0].Target.String)
	}
	if got[1].Data.Valid {
		t.Fatalf("submit carries no payload, got %s", got[1].Data.String)
	}
	if got[2].Data.String != `{"x":10,"y":20}` {
		t.Fatalf("click data = %s", got[2].Data.String)
	}
	if got[3].Data.String != `{"kind":"load"}` {
		t.Fatalf("nav must drop the (note) title, got %s", got[3].Data.String)
	}
}

func TestIngestRedactsNotePathsFromRoutes(t *testing.T) {
	st := openStore(t)
	paths := []string{
		"/page/journal/dating-notes.md?q=",
		"/p/some-published-slug",
		"/raw/person/someone.md",
		"/",
		"/?q=secret&page=2",
	}
	var evs []map[string]any
	for i, p := range paths {
		evs = append(evs, ev(i, "nav", map[string]any{"path": p}))
	}
	if _, err := st.Ingest(batchJSON(t, evs...), ""); err != nil {
		t.Fatal(err)
	}
	want := []string{"/page/:path?q=", "/p/:path", "/raw/:path", "/", "/?q=&page="}
	for i, r := range rows(t, st) {
		if r.Path.String != want[i] {
			t.Errorf("path %d = %q, want %q", i, r.Path.String, want[i])
		}
	}
	if all := dump(t, st); strings.Contains(all, "dating") || strings.Contains(all, "someone") || strings.Contains(all, "secret") {
		t.Fatalf("note path leaked:\n%s", all)
	}
}

func TestIngestCapsStrings(t *testing.T) {
	st := openStore(t)
	long := strings.Repeat("é", 500)
	body := batchJSON(t, ev(0, "error", map[string]any{
		"path": "/x" + long,
		"data": map[string]any{"message": long, "source": map[string]any{"nested": true}},
	}))
	if _, err := st.Ingest(body, ""); err != nil {
		t.Fatal(err)
	}
	r := rows(t, st)[0]
	if n := len([]rune(r.Path.String)); n != MaxStr {
		t.Fatalf("path length %d, want %d", n, MaxStr)
	}
	var d map[string]any
	json.Unmarshal([]byte(r.Data.String), &d)
	if n := len([]rune(d["message"].(string))); n != MaxStr {
		t.Fatalf("message length %d", n)
	}
	if d["source"] != `{"nested":true}` {
		t.Fatalf("composite values must be flattened to a capped string, got %#v", d["source"])
	}
}

func TestIngestCapsEventsPerSession(t *testing.T) {
	st := openStore(t)
	if _, err := st.db.Exec(
		"INSERT INTO sessions (id, started_at, last_seen_at, ua_class, event_count) VALUES (?, 'x', 'x', 'desktop', ?)",
		sid, MaxEventsPerSession-1); err != nil {
		t.Fatal(err)
	}
	res, err := st.Ingest(batchJSON(t, ev(0, "click", nil), ev(1, "click", nil)), "")
	if err != nil {
		t.Fatal(err)
	}
	if res.Stored != 1 || !res.Capped {
		t.Fatalf("result = %+v", res)
	}
}

func TestIngestSessionRowUsesServerClockAndCoarseDevice(t *testing.T) {
	st := openStore(t)
	st.now = func() time.Time { return time.Date(2026, 9, 29, 12, 34, 56, 789, time.FixedZone("PDT", -7*3600)) }
	if _, err := st.Ingest(batchJSON(t, ev(0, "nav", nil)), "Mozilla/5.0 (Linux; Android 14) Mobile"); err != nil {
		t.Fatal(err)
	}
	var started, ua string
	var w, h int
	st.db.QueryRow("SELECT started_at, ua_class, viewport_w, viewport_h FROM sessions").Scan(&started, &ua, &w, &h)
	if started != "2026-09-29T19:34:56+00:00" {
		t.Fatalf("started_at %q must match Python isoformat(timespec=seconds) in UTC", started)
	}
	if ua != "mobile" || w != 375 || h != 667 {
		t.Fatalf("ua=%s w=%d h=%d", ua, w, h)
	}
	if !regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00$`).MatchString(started) {
		t.Fatal(started)
	}
}

func TestUAClass(t *testing.T) {
	i := func(n int64) *int64 { return &n }
	cases := []struct {
		ua   string
		w    *int64
		want string
	}{
		{"Mozilla/5.0 (iPad; CPU OS 17)", nil, "tablet"},
		{"Mozilla/5.0 (iPhone; CPU iPhone OS 17) Mobile", nil, "mobile"},
		{"Mozilla/5.0 (Linux; Android 14)", nil, "mobile"},
		{"Mozilla/5.0 (X11; Linux x86_64)", nil, "desktop"},
		{"HeadlessChrome", i(375), "mobile"},
		{"HeadlessChrome", i(800), "tablet"},
		{"HeadlessChrome", i(1440), "desktop"},
		{"", i(0), "mobile"},
	}
	for _, c := range cases {
		if got := UAClass(c.ua, c.w); got != c.want {
			t.Errorf("UAClass(%q, %v) = %s, want %s", c.ua, c.w, got, c.want)
		}
	}
}

func TestToIntMirrorsPythonInt(t *testing.T) {
	cases := []struct {
		in   any
		want *int64
	}{
		{json.Number("7"), ptr(7)},
		{json.Number("7.9"), ptr(7)},
		{" 12 ", ptr(12)},
		{"1.5", nil},
		{true, ptr(1)},
		{nil, nil},
		{map[string]any{}, nil},
		{json.Number("1e400"), nil},
	}
	for _, c := range cases {
		got := toInt(c.in)
		if (got == nil) != (c.want == nil) || (got != nil && *got != *c.want) {
			t.Errorf("toInt(%#v) = %v, want %v", c.in, got, c.want)
		}
	}
}

func ptr(n int64) *int64 { return &n }
