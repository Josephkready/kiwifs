package vdcapture

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/labstack/echo/v4"
)

func serve(c *Capture, body string) *httptest.ResponseRecorder {
	e := echo.New()
	e.POST(EventsPath, c.HandleEvents)
	e.GET(RecorderPath, ServeRecorder)
	req := httptest.NewRequest(http.MethodPost, EventsPath, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func TestHandleEventsStatusCodes(t *testing.T) {
	st := openStore(t)
	c := New(st, 1)
	good := `{"session_id":"` + sid + `","events":[{"seq":0,"t":0,"type":"nav","path":"/"}]}`
	if rec := serve(c, good); rec.Code != http.StatusNoContent {
		t.Fatalf("good batch: %d", rec.Code)
	}
	if rec := serve(c, `{"session_id":"x"}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad batch: %d", rec.Code)
	}
	if rec := serve(c, strings.Repeat(" ", MaxBody+1)); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized: %d", rec.Code)
	}
	var n int
	st.db.QueryRow("SELECT COUNT(*) FROM events").Scan(&n)
	if n != 1 {
		t.Fatalf("events stored = %d", n)
	}
}

func TestHandleEventsSwallowsStorageFailures(t *testing.T) {
	st := openStore(t)
	c := New(st, 1)
	st.Close() // every write now fails
	good := `{"session_id":"` + sid + `","events":[{"seq":0,"t":0,"type":"nav"}]}`
	if rec := serve(c, good); rec.Code != http.StatusNoContent {
		t.Fatalf("storage failure must not surface: %d", rec.Code)
	}
}

func TestDisabledCaptureIsInert(t *testing.T) {
	var nilCap *Capture
	for _, c := range []*Capture{nilCap, New(openStore(t), 0)} {
		if c.Enabled() || c.ScriptTag() != "" {
			t.Fatalf("disabled capture must not inject the recorder")
		}
		if rec := serve(c, `garbage`); rec.Code != http.StatusNoContent {
			t.Fatalf("disabled ingest: %d", rec.Code)
		}
		if err := c.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

func TestScriptTagAndRecorderServed(t *testing.T) {
	c := New(openStore(t), 0.5)
	tag := c.ScriptTag()
	for _, want := range []string{`src="/_vd/recorder.js"`, `data-endpoint="/api/_vd/events"`, `data-sample="0.5"`, "defer"} {
		if !strings.Contains(tag, want) {
			t.Fatalf("tag %s missing %s", tag, want)
		}
	}
	e := echo.New()
	e.GET(RecorderPath, ServeRecorder)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, RecorderPath, nil))
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "navigator.webdriver") ||
		!strings.HasPrefix(rec.Header().Get("Content-Type"), "text/javascript") {
		t.Fatalf("recorder: %d %s", rec.Code, rec.Header().Get("Content-Type"))
	}
}

func TestFromEnv(t *testing.T) {
	root := t.TempDir()
	state := filepath.Join(t.TempDir(), "state", "flows.db")

	t.Setenv(EnvCapture, "off")
	t.Setenv(EnvFlowsDB, state)
	if FromEnv(root) != nil {
		t.Fatal("KIWIFS_VD_CAPTURE=off must disable")
	}

	t.Setenv(EnvCapture, "")
	t.Setenv(EnvFlowsDB, filepath.Join(root, ".kiwi", "state", "flows.db"))
	if FromEnv(root) != nil {
		t.Fatal("a db inside the served root must be refused")
	}
	if _, err := os.Stat(filepath.Join(root, ".kiwi")); err == nil {
		t.Fatal("refused path must not be created")
	}

	blocker := filepath.Join(t.TempDir(), "file")
	os.WriteFile(blocker, nil, 0o644)
	t.Setenv(EnvFlowsDB, filepath.Join(blocker, "flows.db"))
	if FromEnv(root) != nil {
		t.Fatal("unopenable db must disable, not fail")
	}

	t.Setenv(EnvFlowsDB, state)
	t.Setenv(EnvSample, "0.25")
	c := FromEnv(root)
	if c == nil || !c.Enabled() || !strings.Contains(c.ScriptTag(), `data-sample="0.25"`) {
		t.Fatalf("expected enabled capture, got %+v", c)
	}
	c.Close()
	if _, err := os.Stat(state); err != nil {
		t.Fatalf("db not created at state path: %v", err)
	}
}

func TestInsideRoot(t *testing.T) {
	cases := []struct {
		path, root string
		want       bool
	}{
		{"/data/.kiwi/flows.db", "/data", true},
		{"/data", "/data", true},
		{"/var/lib/kiwifs/flows.db", "/data", false},
		{"/data2/flows.db", "/data", false},
		{"/x/flows.db", "", false},
	}
	for _, c := range cases {
		if got := insideRoot(c.path, c.root); got != c.want {
			t.Errorf("insideRoot(%s, %s) = %v", c.path, c.root, got)
		}
	}
}
