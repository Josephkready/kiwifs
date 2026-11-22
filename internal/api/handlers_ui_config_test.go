package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/kiwifs/kiwifs/internal/config"
)

func TestUIConfig_DefaultStartPage(t *testing.T) {
	s := buildTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/kiwi/ui-config", nil)
	rec := httptest.NewRecorder()
	s.echo.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		ThemeLocked bool   `json:"themeLocked"`
		StartPage   string `json:"startPage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.StartPage != "welcome" {
		t.Fatalf("startPage = %q, want welcome", res.StartPage)
	}
}

func TestUIConfig_StartPageFromConfig(t *testing.T) {
	dir, pipe, cstore := buildTestPipeline(t)
	cfg := &config.Config{}
	cfg.Storage.Root = dir
	cfg.UI.StartPage = "index.md"
	s := NewServer(cfg, pipe, nil, cstore, nil, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/kiwi/ui-config", nil)
	rec := httptest.NewRecorder()
	s.echo.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		StartPage string `json:"startPage"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.StartPage != "index.md" {
		t.Fatalf("startPage = %q, want index.md", res.StartPage)
	}
}

func TestUIConfig_ToolbarViewsFromConfig(t *testing.T) {
	dir, pipe, cstore := buildTestPipeline(t)
	cfg := &config.Config{}
	cfg.Storage.Root = dir
	cfg.UI.Toolbar.Views = []string{"kanban", "graph", "bases"}
	s := NewServer(cfg, pipe, nil, cstore, nil, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/kiwi/ui-config", nil)
	rec := httptest.NewRecorder()
	s.echo.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		ToolbarViews []string `json:"toolbarViews"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	want := []string{"kanban", "graph", "bases"}
	if len(res.ToolbarViews) != len(want) {
		t.Fatalf("toolbarViews = %+v, want %+v", res.ToolbarViews, want)
	}
	for i, v := range want {
		if res.ToolbarViews[i] != v {
			t.Fatalf("toolbarViews[%d] = %q, want %q", i, res.ToolbarViews[i], v)
		}
	}
}

func TestUIConfig_ToolbarViewsUnset(t *testing.T) {
	s := buildTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/kiwi/ui-config", nil)
	rec := httptest.NewRecorder()
	s.echo.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	raw, ok := res["toolbarViews"]
	if !ok {
		t.Fatal("toolbarViews key missing")
	}
	if string(raw) != "null" {
		t.Fatalf("toolbarViews = %s, want null", string(raw))
	}
}

func TestUIConfig_BrandingFromConfig(t *testing.T) {
	dir, pipe, cstore := buildTestPipeline(t)
	cfg := &config.Config{}
	cfg.Storage.Root = dir
	cfg.UI.Branding = config.BrandingConfig{
		Name:           "Acme Knowledge Base",
		LogoURL:        ".kiwi/assets/logo.png",
		FaviconURL:     ".kiwi/assets/favicon.svg",
		WelcomeTitle:   "Welcome to Acme KB",
		WelcomeMessage: "Search or create a page to get started.",
	}
	s := NewServer(cfg, pipe, nil, cstore, nil, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/kiwi/ui-config", nil)
	rec := httptest.NewRecorder()
	s.echo.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Branding struct {
			Name           string `json:"name"`
			LogoURL        string `json:"logoUrl"`
			FaviconURL     string `json:"faviconUrl"`
			WelcomeTitle   string `json:"welcomeTitle"`
			WelcomeMessage string `json:"welcomeMessage"`
		} `json:"branding"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Branding.Name != "Acme Knowledge Base" {
		t.Fatalf("name = %q", res.Branding.Name)
	}
	if res.Branding.LogoURL != ".kiwi/assets/logo.png" {
		t.Fatalf("logoUrl = %q", res.Branding.LogoURL)
	}
	if res.Branding.FaviconURL != ".kiwi/assets/favicon.svg" {
		t.Fatalf("faviconUrl = %q", res.Branding.FaviconURL)
	}
	if res.Branding.WelcomeTitle != "Welcome to Acme KB" {
		t.Fatalf("welcomeTitle = %q", res.Branding.WelcomeTitle)
	}
	if res.Branding.WelcomeMessage != "Search or create a page to get started." {
		t.Fatalf("welcomeMessage = %q", res.Branding.WelcomeMessage)
	}
}

func TestUIConfig_BrandingDefaultsEmpty(t *testing.T) {
	s := buildTestServer(t)

	req := httptest.NewRequest(http.MethodGet, "/api/kiwi/ui-config", nil)
	rec := httptest.NewRecorder()
	s.echo.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Branding struct {
			Name           string `json:"name"`
			LogoURL        string `json:"logoUrl"`
			FaviconURL     string `json:"faviconUrl"`
			WelcomeTitle   string `json:"welcomeTitle"`
			WelcomeMessage string `json:"welcomeMessage"`
		} `json:"branding"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if res.Branding.Name != "" ||
		res.Branding.LogoURL != "" ||
		res.Branding.FaviconURL != "" ||
		res.Branding.WelcomeTitle != "" ||
		res.Branding.WelcomeMessage != "" {
		t.Fatalf("expected empty raw branding fields, got %+v", res.Branding)
	}
}

func TestUIConfig_SidebarFromConfig(t *testing.T) {
	dir, pipe, cstore := buildTestPipeline(t)
	cfg := &config.Config{}
	cfg.Storage.Root = dir
	cfg.UI.Sidebar.Pinned = []string{"index.md", "getting-started.md"}
	cfg.UI.Sidebar.Hidden = []string{".kiwi", "templates"}
	cfg.UI.Sidebar.Sections = []config.UISidebarSectionConfig{
		{Label: "Core", Paths: []string{"architecture/", "api/"}},
		{Label: "", Paths: []string{"skip-me/"}},
	}
	s := NewServer(cfg, pipe, nil, cstore, nil, nil, nil)

	req := httptest.NewRequest(http.MethodGet, "/api/kiwi/ui-config", nil)
	rec := httptest.NewRecorder()
	s.echo.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	var res struct {
		Sidebar struct {
			Pinned   []string `json:"pinned"`
			Hidden   []string `json:"hidden"`
			Sections []struct {
				Label string   `json:"label"`
				Paths []string `json:"paths"`
			} `json:"sections"`
		} `json:"sidebar"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
		t.Fatal(err)
	}
	if len(res.Sidebar.Pinned) != 2 || res.Sidebar.Pinned[0] != "index.md" {
		t.Fatalf("pinned = %+v", res.Sidebar.Pinned)
	}
	if len(res.Sidebar.Hidden) != 2 {
		t.Fatalf("hidden = %+v", res.Sidebar.Hidden)
	}
	if len(res.Sidebar.Sections) != 1 || res.Sidebar.Sections[0].Label != "Core" {
		t.Fatalf("sections = %+v", res.Sidebar.Sections)
	}
}

func TestUIConfig_TTSFlagAndSpeechEndpoint(t *testing.T) {
	get := func(s *Server) (bool, string) {
		req := httptest.NewRequest(http.MethodGet, "/api/kiwi/ui-config", nil)
		rec := httptest.NewRecorder()
		s.echo.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
		var res struct {
			Features map[string]bool `json:"features"`
			Speech   struct {
				Endpoint string `json:"endpoint"`
			} `json:"speech"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
			t.Fatal(err)
		}
		return res.Features["tts"], res.Speech.Endpoint
	}
	tts, ep := get(buildTestServer(t))
	if tts || ep != "/api/speech" {
		t.Fatalf("defaults: tts=%v endpoint=%q", tts, ep)
	}

	dir, pipe, cstore := buildTestPipeline(t)
	cfg := &config.Config{}
	cfg.Storage.Root = dir
	on := true
	cfg.UI.Features.TTS = &on
	cfg.Speech.Endpoint = "/speech"
	tts, ep = get(NewServer(cfg, pipe, nil, cstore, nil, nil, nil))
	if !tts || ep != "/speech" {
		t.Fatalf("configured: tts=%v endpoint=%q", tts, ep)
	}
}

func TestUIConfig_SpeechModeRoundTrip(t *testing.T) {
	mode := func(s *Server) (string, bool) {
		req := httptest.NewRequest(http.MethodGet, "/api/kiwi/ui-config", nil)
		rec := httptest.NewRecorder()
		s.echo.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("status %d", rec.Code)
		}
		var res struct {
			Speech map[string]any `json:"speech"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &res); err != nil {
			t.Fatal(err)
		}
		v, ok := res.Speech["mode"].(string)
		return v, ok
	}
	if m, ok := mode(buildTestServer(t)); ok || m != "" {
		t.Fatalf("default should omit mode, got %q (present=%v)", m, ok)
	}
	dir, pipe, cstore := buildTestPipeline(t)
	cfg := &config.Config{}
	cfg.Storage.Root = dir
	cfg.Speech.Mode = " fast "
	if m, _ := mode(NewServer(cfg, pipe, nil, cstore, nil, nil, nil)); m != "fast" {
		t.Fatalf("configured mode = %q, want fast", m)
	}
}
