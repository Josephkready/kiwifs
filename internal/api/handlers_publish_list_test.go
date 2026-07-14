package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPublishedPagesListsNestedMarkdownInStableOrder(t *testing.T) {
	server := buildTestServer(t)
	mustPutFile(t, server, "nested/newer.md", "---\npublished: true\npublished_at: 2026-07-13T12:00:00Z\n---\n# Newer\n")
	mustPutFile(t, server, "alpha.markdown", "---\npublished: true\npublished_at: 2026-07-12T12:00:00Z\n---\n# Alpha\n")
	mustPutFile(t, server, "beta.md", "---\npublished: true\npublished_at: 2026-07-12T12:00:00Z\n---\n# Beta\n")
	mustPutFile(t, server, "draft.md", "---\npublished: false\n---\n# Draft\n")
	mustPutFile(t, server, "asset.txt", "not markdown")

	req := httptest.NewRequest(http.MethodGet, "/api/kiwi/publish/list", nil)
	rec := httptest.NewRecorder()
	server.echo.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET publish list: %d %s", rec.Code, rec.Body.String())
	}

	var response publishedPagesResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if response.Count != 3 {
		t.Fatalf("count = %d, want 3: %+v", response.Count, response.Pages)
	}
	want := []string{"nested/newer.md", "alpha.markdown", "beta.md"}
	for i, path := range want {
		if response.Pages[i].Path != path {
			t.Fatalf("pages[%d].path = %q, want %q", i, response.Pages[i].Path, path)
		}
		if response.Pages[i].PublicURL != "/p/"+path {
			t.Fatalf("pages[%d].public_url = %q", i, response.Pages[i].PublicURL)
		}
	}
}
