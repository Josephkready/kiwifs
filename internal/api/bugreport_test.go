package api

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/kiwifs/kiwifs/internal/bugreport"
	"github.com/kiwifs/kiwifs/internal/config"
	"github.com/kiwifs/kiwifs/internal/webui"
)

func TestBugReportRoutesBeatSPAFallback(t *testing.T) {
	st, err := bugreport.Open(filepath.Join(t.TempDir(), "b.db"))
	if err != nil {
		t.Fatal(err)
	}
	r := bugreport.New(st, "test", "", nil)
	t.Cleanup(func() { r.Close(); bugreport.SetDefault(nil); webui.SetAssets(nil) })
	bugreport.SetDefault(r)
	webui.SetAssets(fstest.MapFS{"index.html": {Data: []byte(vdIndex)}})
	dir, pipe, cstore := buildTestPipeline(t)
	cfg := &config.Config{}
	cfg.Storage.Root = dir
	s := NewServer(cfg, pipe, nil, cstore, nil, nil, nil)

	if rec := vdDo(s, http.MethodGet, "/api/bug-report/config", ""); !strings.Contains(rec.Body.String(), `"available":true`) {
		t.Errorf("config: %s", rec.Body)
	}
	if rec := vdDo(s, http.MethodGet, "/bug-reports/1", ""); rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), "<title>KiwiFS") {
		t.Errorf("triage route fell through to the SPA: %d", rec.Code)
	}
	if rec := vdDo(s, http.MethodGet, "/api/_bug/pending", ""); rec.Code != http.StatusForbidden {
		t.Errorf("internal route reachable from non-loopback: %d", rec.Code)
	}
}
