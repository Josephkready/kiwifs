package webui

import (
	"bytes"
	"strings"
	"sync"

	"github.com/kiwifs/kiwifs/internal/config"
)

var (
	brandingMu    sync.RWMutex
	branding      config.BrandingConfig
	headInjection string
)

// SetHeadInjection sets markup appended to index.html's <head> at serve time
// (the video-debugger recorder script tag when flow capture is on).
func SetHeadInjection(markup string) {
	brandingMu.Lock()
	headInjection = markup
	brandingMu.Unlock()
}

// SetBranding wires workspace branding for index.html injection at serve time.
func SetBranding(b config.BrandingConfig) {
	brandingMu.Lock()
	branding = b
	brandingMu.Unlock()
}

func injectBranding(html []byte) []byte {
	brandingMu.RLock()
	b := branding
	inject := headInjection
	brandingMu.RUnlock()

	name := htmlEscape(b.ResolvedName())
	favicon := htmlEscape(b.ResolvedFaviconURL())

	out := bytes.Replace(html, []byte("<title>KiwiFS</title>"), []byte("<title>"+name+"</title>"), 1)

	defaultLink := `<link rel="icon" type="image/svg+xml" href="/favicon.svg" />`
	customLink := faviconLinkTag(favicon)
	out = bytes.Replace(out, []byte(defaultLink), []byte(customLink), 1)
	if inject != "" {
		out = bytes.Replace(out, []byte("</head>"), []byte(inject+"</head>"), 1)
	}

	return out
}

func faviconLinkTag(href string) string {
	ctype := "image/png"
	lower := strings.ToLower(href)
	switch {
	case strings.HasSuffix(lower, ".svg"):
		ctype = "image/svg+xml"
	case strings.HasSuffix(lower, ".ico"):
		ctype = "image/x-icon"
	}
	return `<link rel="icon" type="` + ctype + `" href="` + href + `" />`
}
