package webui

import (
	"strings"
	"testing"

	"github.com/kiwifs/kiwifs/internal/config"
)

func TestInjectBranding_Defaults(t *testing.T) {
	SetBranding(config.BrandingConfig{})
	html := []byte(`<!doctype html><head><title>KiwiFS</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" /></head>`)

	out := string(injectBranding(html))
	if !strings.Contains(out, "<title>KiwiFS</title>") {
		t.Fatalf("expected default title, got: %s", out)
	}
	if !strings.Contains(out, `href="/favicon.svg"`) {
		t.Fatalf("expected default favicon, got: %s", out)
	}
}

func TestInjectBranding_Custom(t *testing.T) {
	SetBranding(config.BrandingConfig{
		Name:       "Acme KB",
		FaviconURL: ".kiwi/assets/favicon.svg",
	})
	html := []byte(`<!doctype html><head><title>KiwiFS</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg" /></head>`)

	out := string(injectBranding(html))
	if !strings.Contains(out, "<title>Acme KB</title>") {
		t.Fatalf("expected custom title, got: %s", out)
	}
	if !strings.Contains(out, `href="/raw/.kiwi/assets/favicon.svg"`) {
		t.Fatalf("expected custom favicon URL, got: %s", out)
	}
	if !strings.Contains(out, `type="image/svg+xml"`) {
		t.Fatalf("expected svg mime type, got: %s", out)
	}
}

func TestFaviconLinkTag_PNG(t *testing.T) {
	tag := faviconLinkTag("/raw/.kiwi/assets/logo.png")
	if !strings.Contains(tag, `type="image/png"`) {
		t.Fatalf("unexpected tag: %s", tag)
	}
}

func TestInjectBranding_HeadInjection(t *testing.T) {
	SetBranding(config.BrandingConfig{})
	t.Cleanup(func() { SetHeadInjection("") })
	html := []byte(`<!doctype html><head><title>KiwiFS</title></head><body></body>`)

	if out := string(injectBranding(html)); strings.Contains(out, "vd") {
		t.Fatalf("no injection expected by default, got: %s", out)
	}
	SetHeadInjection(`<script src="/_vd/recorder.js" defer></script>`)
	out := string(injectBranding(html))
	if !strings.Contains(out, `<script src="/_vd/recorder.js" defer></script></head>`) {
		t.Fatalf("expected recorder tag before </head>, got: %s", out)
	}
}
