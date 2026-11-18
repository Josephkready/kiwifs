package bugreport

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

const goodKey = "3f2a1c9e-1b2d-4e5f-8a9b-0c1d2e3f4a5b"

var png = append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)

func setup(t *testing.T) (*echo.Echo, *Reporter) {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "bugs.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	r := New(st, "v9.9.9", "", nil)
	e := echo.New()
	r.Register(e)
	return e, r
}

type part struct {
	name string
	data []byte
}

func post(e *echo.Echo, fields map[string]string, files []part) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	for k, v := range fields {
		w.WriteField(k, v)
	}
	for _, f := range files {
		h := textproto.MIMEHeader{}
		h.Set("Content-Disposition", `form-data; name="attachments"; filename="`+f.name+`"`)
		h.Set("Content-Type", "image/png") // declared type is untrusted
		pw, _ := w.CreatePart(h)
		pw.Write(f.data)
	}
	w.Close()
	req := httptest.NewRequest(http.MethodPost, "/api/bug-report", &buf)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("User-Agent", "TestAgent/1 <script>")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func fields(desc string) map[string]string {
	return map[string]string{"description": desc, "idempotency_key": goodKey, "context": `{"path":"notes/a.md","route":"/page/x"}`}
}

func TestDescriptionBounds(t *testing.T) {
	e, _ := setup(t)
	for _, tc := range []struct {
		desc string
		code int
	}{
		{"too short", 400},
		{strings.Repeat("a", 10), 202},
		{strings.Repeat("é", 8000), 202},
		{strings.Repeat("a", 8001), 400},
	} {
		f := fields(tc.desc)
		f["idempotency_key"] = fmt.Sprintf("3f2a1c9e-1b2d-4e5f-8a9b-%012d", len(tc.desc))
		if rec := post(e, f, nil); rec.Code != tc.code {
			t.Errorf("len %d: got %d want %d (%s)", len(tc.desc), rec.Code, tc.code, rec.Body)
		}
	}
	f := fields("long enough description")
	f["idempotency_key"] = "not-a-uuid"
	if rec := post(e, f, nil); rec.Code != 400 {
		t.Errorf("bad key: %d", rec.Code)
	}
}

func TestAttachmentLimits(t *testing.T) {
	e, _ := setup(t)
	img := part{"a.png", png}
	if rec := post(e, fields("a real description"), []part{img, img, img}); rec.Code != 202 {
		t.Fatalf("3 images: %d %s", rec.Code, rec.Body)
	}
	f := fields("a real description")
	f["idempotency_key"] = "3f2a1c9e-1b2d-4e5f-8a9b-000000000001"
	if rec := post(e, f, []part{img, img, img, img}); rec.Code != 413 {
		t.Errorf("4 images: %d", rec.Code)
	}
	big := part{"big.png", append(append([]byte{}, png...), make([]byte, MaxImageBytes)...)}
	if rec := post(e, f, []part{big}); rec.Code != 413 {
		t.Errorf("oversize: %d", rec.Code)
	}
	exact := part{"ok.png", append(append([]byte{}, png...), make([]byte, MaxImageBytes-len(png))...)}
	f["idempotency_key"] = "3f2a1c9e-1b2d-4e5f-8a9b-000000000002"
	if rec := post(e, f, []part{exact}); rec.Code != 202 {
		t.Errorf("exactly 2MB: %d", rec.Code)
	}
	if rec := post(e, f, []part{{"x.png", []byte("<html>not an image</html>")}}); rec.Code != 415 {
		t.Errorf("sniff: %d", rec.Code)
	}
}

func TestSniffImage(t *testing.T) {
	for want, b := range map[string][]byte{
		"image/jpeg": {0xFF, 0xD8, 0xFF, 0xE0},
		"image/png":  png,
		"image/webp": []byte("RIFF\x00\x00\x00\x00WEBPVP8 "),
		"image/gif":  []byte("GIF89a...."),
		"":           []byte("%PDF-1.7"),
	} {
		if got := SniffImage(b); got != want {
			t.Errorf("%q: got %q want %q", b[:4], got, want)
		}
	}
}

func TestIdempotencyAndImages(t *testing.T) {
	e, _ := setup(t)
	r1 := post(e, fields("first submit text"), []part{{"a.png", png}})
	r2 := post(e, fields("first submit text"), []part{{"a.png", png}})
	var a, b map[string]any
	json.Unmarshal(r1.Body.Bytes(), &a)
	json.Unmarshal(r2.Body.Bytes(), &b)
	if r1.Code != 202 || r2.Code != 202 || a["id"] != b["id"] || a["status"] != "saved" || a["key"] != goodKey {
		t.Fatalf("not idempotent: %v %v", a, b)
	}
	list := get(e, "/api/bug-reports?limit=10", nil)
	var rows []map[string]any
	json.Unmarshal(list.Body.Bytes(), &rows)
	if len(rows) != 1 {
		t.Fatalf("want one row, got %d", len(rows))
	}
	img := get(e, fmt.Sprintf("/api/bug-reports/%v/images/1", a["id"]), nil)
	if img.Code != 200 || img.Header().Get("Content-Type") != "image/png" || !bytes.Equal(img.Body.Bytes(), png) {
		t.Errorf("image roundtrip: %d %s", img.Code, img.Header().Get("Content-Type"))
	}
}

func get(e *echo.Echo, path string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func TestSanitizeContextAllowlist(t *testing.T) {
	got := SanitizeContext(map[string]any{
		"path":          "notes/a.md",
		"route":         "/page/<b>x</b>",
		"selected_text": strings.Repeat("z", 900),
		"app_version":   "client-lies",
		"password":      "hunter2",
		"viewport":      1234, // non-string is dropped
	}, "v1")
	if got["app_version"] != "v1" {
		t.Errorf("server must own app_version: %q", got["app_version"])
	}
	if _, ok := got["password"]; ok {
		t.Error("non-allowlisted key kept")
	}
	if _, ok := got["viewport"]; ok {
		t.Error("non-string value kept")
	}
	if strings.ContainsAny(got["route"], "<>") {
		t.Errorf("angle brackets kept: %q", got["route"])
	}
	if n := len([]rune(got["selected_text"])); n != 500 {
		t.Errorf("selected_text len %d", n)
	}
}

func TestServerOwnsHostFacts(t *testing.T) {
	e, r := setup(t)
	f := fields("a real description")
	f["context"] = `{"path":"notes/a.md","user_agent":"spoofed","reported_at":"1999","server_version":"x"}`
	post(e, f, nil)
	rep, _ := r.store.Get(1)
	if rep.Context["user_agent"] != "TestAgent/1 script" || rep.Context["reported_at"] == "1999" || rep.Context["server_version"] != "v9.9.9" {
		t.Errorf("client overrode host facts: %v", rep.Context)
	}
	if rep.Slug != "notes/a" || rep.Path != "notes/a.md" {
		t.Errorf("slug/path: %q %q", rep.Slug, rep.Path)
	}
}

func TestBuildTitle(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"Search is broken\nmore detail", "Bug: Search is broken"},
		{"\n\n  spaced   out  line  ", "Bug: spaced out line"},
		{"The quick brown fox jumps over the lazy dog while the sun is shining bright", "Bug: The quick brown fox jumps over the lazy dog while the sun is…"},
	} {
		got := BuildTitle(tc.in)
		if got != tc.want {
			t.Errorf("got %q want %q", got, tc.want)
		}
		if len([]rune(got)) > MaxTitleLen {
			t.Errorf("too long: %d", len([]rune(got)))
		}
	}
	long := BuildTitle(strings.Repeat("x", 200))
	if len([]rune(long)) > MaxTitleLen || !strings.HasSuffix(long, "…") {
		t.Errorf("unbroken word: %q", long)
	}
}

func TestInternalGuard(t *testing.T) {
	e, r := setup(t)
	post(e, fields("a real description"), nil)
	do := func(remote string, hdr map[string]string) int {
		req := httptest.NewRequest(http.MethodGet, "/api/_bug/pending", nil)
		req.RemoteAddr = remote
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec.Code
	}
	if c := do("127.0.0.1:5000", nil); c != 200 {
		t.Errorf("loopback: %d", c)
	}
	if c := do("[::1]:5000", nil); c != 200 {
		t.Errorf("ipv6 loopback: %d", c)
	}
	if c := do("192.168.1.5:5000", nil); c != 403 {
		t.Errorf("lan: %d", c)
	}
	for _, h := range []string{"X-Forwarded-For", "X-Real-IP"} {
		if c := do("127.0.0.1:5000", map[string]string{h: "192.168.1.5"}); c != 403 {
			t.Errorf("%s via loopback proxy: %d", h, c)
		}
	}
	// Every internal route is guarded, including the full-report one.
	for _, p := range []string{"/api/_bug/queued", "/api/_bug/1"} {
		if rec := get(e, p, nil); rec.Code != 403 { // httptest default RemoteAddr is 192.0.2.1
			t.Errorf("%s: %d", p, rec.Code)
		}
	}
	_, n, _ := net.ParseCIDR("172.17.0.0/16")
	r.allow = []*net.IPNet{n}
	if c := do("172.17.0.1:5000", nil); c != 200 {
		t.Errorf("allow-listed bridge: %d", c)
	}
	if c := do("172.17.0.1:5000", map[string]string{"X-Real-IP": "1.2.3.4"}); c != 403 {
		t.Errorf("allow-listed but proxied: %d", c)
	}
}

func loopbackReq(e *echo.Echo, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:1"
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func TestSyncLifecycleAndIssueURLAllowlist(t *testing.T) {
	e, _ := setup(t)
	post(e, fields("Search is broken\nplease look"), nil)

	var pending []Pending
	json.Unmarshal(loopbackReq(e, "GET", "/api/_bug/pending", "").Body.Bytes(), &pending)
	if len(pending) != 1 || pending[0].Title != "Bug: Search is broken" || pending[0].Slug != "notes/a" || pending[0].AppVersion != "v9.9.9" || pending[0].Key != goodKey {
		t.Fatalf("pending: %+v", pending)
	}

	if rec := loopbackReq(e, "POST", "/api/_bug/1/sync", `{"sync_status":"queued","job_id":"j-1"}`); rec.Code != 200 {
		t.Fatalf("queued: %d %s", rec.Code, rec.Body)
	}
	json.Unmarshal(loopbackReq(e, "GET", "/api/_bug/pending", "").Body.Bytes(), &pending)
	if len(pending) != 0 {
		t.Error("queued row still pending")
	}
	var queued []Queued
	json.Unmarshal(loopbackReq(e, "GET", "/api/_bug/queued", "").Body.Bytes(), &queued)
	if len(queued) != 1 || queued[0].JobID != "j-1" {
		t.Fatalf("queued: %+v", queued)
	}

	for _, bad := range []string{
		`{"sync_status":"filed","issue_url":"https://evil.example/Josephkready/kiwifs/issues/1"}`,
		`{"sync_status":"filed","issue_url":"https://github.com/Josephkready/kiwifs/issues/1/../../x"}`,
		`{"sync_status":"filed","issue_url":"javascript:alert(1)"}`,
		`{"sync_status":"bogus"}`,
		`{"sync_status":"failed","error_category":"has spaces and Secret text"}`,
	} {
		if rec := loopbackReq(e, "POST", "/api/_bug/1/sync", bad); rec.Code != 400 {
			t.Errorf("%s: %d", bad, rec.Code)
		}
	}
	if rec := loopbackReq(e, "POST", "/api/_bug/99/sync", `{"sync_status":"queued"}`); rec.Code != 404 {
		t.Errorf("missing id: %d", rec.Code)
	}

	ok := `{"sync_status":"filed","issue_number":7,"issue_url":"https://github.com/Josephkready/kiwifs/issues/7"}`
	if rec := loopbackReq(e, "POST", "/api/_bug/1/sync", ok); rec.Code != 200 {
		t.Fatalf("filed: %d", rec.Code)
	}
	st := get(e, "/api/bug-reports/1/status", nil)
	var m map[string]any
	json.Unmarshal(st.Body.Bytes(), &m)
	if m["sync_status"] != "filed" || m["issue_number"] != float64(7) || m["issue_url"] != "https://github.com/Josephkready/kiwifs/issues/7" {
		t.Errorf("status: %v", m)
	}
	if len(m) != 4 {
		t.Errorf("status leaks extra fields: %v", m)
	}
	queued = nil
	json.Unmarshal(loopbackReq(e, "GET", "/api/_bug/queued", "").Body.Bytes(), &queued)
	if len(queued) != 0 {
		t.Error("filed row still queued")
	}
}

func TestPublicOutputNeverEmitsUnsafeIssueURL(t *testing.T) {
	e, r := setup(t)
	post(e, fields("a real description"), nil)
	// Simulate a row written by something other than ApplySync.
	r.store.db.Exec(`UPDATE bug_reports SET issue_url='https://evil.example/x', sync_status='filed'`)
	for _, p := range []string{"/api/bug-reports/1/status", "/api/bug-reports"} {
		if body := get(e, p, nil).Body.String(); strings.Contains(body, "evil.example") {
			t.Errorf("%s leaked %s", p, body)
		}
	}
}

func TestListScopedByPath(t *testing.T) {
	e, _ := setup(t)
	for i, p := range []string{"notes/a.md", "notes/b.md", "notes/a.md"} {
		f := fields("report number " + fmt.Sprint(i))
		f["idempotency_key"] = fmt.Sprintf("3f2a1c9e-1b2d-4e5f-8a9b-%012d", i)
		f["context"] = `{"path":"` + p + `"}`
		post(e, f, nil)
	}
	var rows []map[string]any
	json.Unmarshal(get(e, "/api/bug-reports?limit=3&path=notes/a.md", nil).Body.Bytes(), &rows)
	if len(rows) != 2 || rows[0]["id"] != float64(3) {
		t.Errorf("scoped: %v", rows)
	}
	json.Unmarshal(get(e, "/api/bug-reports?limit=3", nil).Body.Bytes(), &rows)
	if len(rows) != 3 {
		t.Errorf("unscoped: %v", rows)
	}
}

func TestTriagePageEscapes(t *testing.T) {
	e, _ := setup(t)
	post(e, fields(`<script>alert(1)</script> and more text`), []part{{"a.png", png}})
	rec := get(e, "/bug-reports/1", nil)
	body := rec.Body.String()
	if rec.Code != 200 || strings.Contains(body, "<script>alert") || !strings.Contains(body, "&lt;script&gt;") || !strings.Contains(body, "/api/bug-reports/1/images/1") {
		t.Errorf("triage page: %d %s", rec.Code, body)
	}
}

func TestDisabledFeature(t *testing.T) {
	e := echo.New()
	(*Reporter)(nil).Register(e)
	var m map[string]bool
	rec := get(e, "/api/bug-report/config", nil)
	json.Unmarshal(rec.Body.Bytes(), &m)
	if rec.Code != 200 || m["available"] {
		t.Errorf("config: %s", rec.Body)
	}
	if rec := get(e, "/api/bug-reports", nil); rec.Code != 404 {
		t.Errorf("list when disabled: %d", rec.Code)
	}
}

// Report text must never reach the log, on success or on rejection.
func TestNoContentInLogs(t *testing.T) {
	e, _ := setup(t)
	var logs bytes.Buffer
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	secret := "SUPERSECRETMARKER"
	f := fields(secret + " description text")
	f["context"] = `{"path":"` + secret + `.md","selected_text":"` + secret + `"}`
	post(e, f, []part{{"a.png", png}, {"bad.png", []byte(secret)}})
	post(e, f, nil)
	loopbackReq(e, "GET", "/api/_bug/1", "")
	loopbackReq(e, "POST", "/api/_bug/1/sync", `{"sync_status":"failed","error_category":"`+secret+`"}`)
	if strings.Contains(logs.String(), secret) {
		t.Errorf("content leaked into logs: %s", logs.String())
	}
}
