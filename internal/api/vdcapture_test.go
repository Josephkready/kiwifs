package api

import (
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/kiwifs/kiwifs/internal/config"
	"github.com/kiwifs/kiwifs/internal/vdcapture"
	"github.com/kiwifs/kiwifs/internal/webui"
)

const vdIndex = `<!doctype html><html><head><title>KiwiFS</title></head><body></body></html>`

func vdServer(t *testing.T, capture *vdcapture.Capture) *Server {
	t.Helper()
	webui.SetAssets(fstest.MapFS{"index.html": {Data: []byte(vdIndex)}})
	vdcapture.SetDefault(capture)
	t.Cleanup(func() {
		webui.SetAssets(nil)
		webui.SetHeadInjection("")
		vdcapture.SetDefault(nil)
	})
	dir, pipe, cstore := buildTestPipeline(t)
	cfg := &config.Config{}
	cfg.Storage.Root = dir
	return NewServer(cfg, pipe, nil, cstore, nil, nil, nil)
}

func vdDo(s *Server, method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	s.echo.ServeHTTP(rec, req)
	return rec
}

func TestVDCaptureWiredIntoServer(t *testing.T) {
	st, err := vdcapture.Open(filepath.Join(t.TempDir(), "flows.db"))
	if err != nil {
		t.Fatal(err)
	}
	c := vdcapture.New(st, 1)
	t.Cleanup(func() { c.Close() })
	s := vdServer(t, c)

	if rec := vdDo(s, http.MethodGet, "/", ""); !strings.Contains(rec.Body.String(), `src="/_vd/recorder.js"`) {
		t.Fatalf("index.html must carry the recorder tag when capture is on:\n%s", rec.Body.String())
	}
	if rec := vdDo(s, http.MethodGet, vdcapture.RecorderPath, ""); rec.Code != http.StatusOK ||
		!strings.Contains(rec.Body.String(), "navigator.webdriver") {
		t.Fatalf("recorder.js: %d", rec.Code)
	}
	good := `{"session_id":"a1b2c3d4e5f60718","events":[{"seq":0,"t":0,"type":"nav","path":"/"}]}`
	if rec := vdDo(s, http.MethodPost, vdcapture.EventsPath, good); rec.Code != http.StatusNoContent {
		t.Fatalf("ingest: %d %s", rec.Code, rec.Body.String())
	}
	if rec := vdDo(s, http.MethodPost, vdcapture.EventsPath, `{}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("malformed batch: %d", rec.Code)
	}
}

func TestVDCaptureOffByDefaultInServer(t *testing.T) {
	s := vdServer(t, nil)
	if rec := vdDo(s, http.MethodGet, "/", ""); strings.Contains(rec.Body.String(), "_vd") {
		t.Fatalf("no recorder tag without capture:\n%s", rec.Body.String())
	}
	if rec := vdDo(s, http.MethodPost, vdcapture.EventsPath, `garbage`); rec.Code != http.StatusNoContent {
		t.Fatalf("disabled ingest must be a silent 204, got %d", rec.Code)
	}
}
