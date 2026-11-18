package bugreport

import (
	"bytes"
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/labstack/echo/v4"
)

const (
	EnvDB         = "KIWIFS_BUG_REPORTS_DB"
	EnvPublicURL  = "KIWIFS_PUBLIC_URL"
	EnvAllow      = "KIWIFS_BUG_INTERNAL_ALLOW"
	DefaultPublic = "https://mind.local.thedante.net"

	// maxBody leaves room for MaxAttachments full images plus form overhead.
	maxBody = MaxAttachments*MaxImageBytes + 256<<10
)

// Reporter is the process-wide handle. A nil Reporter means the feature is off.
type Reporter struct {
	store     *Store
	version   string
	publicURL string
	allow     []*net.IPNet
}

func New(st *Store, version, publicURL string, allow []*net.IPNet) *Reporter {
	if publicURL == "" {
		publicURL = DefaultPublic
	}
	return &Reporter{store: st, version: version, publicURL: strings.TrimRight(publicURL, "/"), allow: allow}
}

// FromEnv opens the store per the env vars. Empty KIWIFS_BUG_REPORTS_DB, a db
// inside the served root, or an unopenable db all disable the feature without
// failing startup.
func FromEnv(servedRoot, version string) *Reporter {
	path := strings.TrimSpace(os.Getenv(EnvDB))
	if path == "" {
		return nil
	}
	if insideRoot(path, servedRoot) {
		log.Printf("bugreport: disabled, %s is inside the served root (it would be public via /raw); use a state path", EnvDB)
		return nil
	}
	st, err := Open(path)
	if err != nil {
		log.Printf("bugreport: disabled, cannot open db: %v", err)
		return nil
	}
	var allow []*net.IPNet
	for _, c := range strings.Split(os.Getenv(EnvAllow), ",") {
		if c = strings.TrimSpace(c); c == "" {
			continue
		}
		if _, n, err := net.ParseCIDR(c); err == nil {
			allow = append(allow, n)
		} else {
			log.Printf("bugreport: ignoring invalid %s entry", EnvAllow)
		}
	}
	log.Printf("bugreport: saving reports into %s", path)
	return New(st, version, os.Getenv(EnvPublicURL), allow)
}

func insideRoot(path, root string) bool {
	if root == "" {
		return false
	}
	ap, err1 := filepath.Abs(path)
	ar, err2 := filepath.Abs(root)
	if err1 != nil || err2 != nil {
		return false
	}
	rel, err := filepath.Rel(ar, ap)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

var (
	defMu  sync.RWMutex
	defRep *Reporter
)

func SetDefault(r *Reporter) { defMu.Lock(); defRep = r; defMu.Unlock() }
func Default() *Reporter     { defMu.RLock(); defer defMu.RUnlock(); return defRep }

func (r *Reporter) Enabled() bool { return r != nil && r.store != nil }

func (r *Reporter) Close() error {
	if r == nil || r.store == nil {
		return nil
	}
	return r.store.Close()
}

// Register mounts every route. Safe on a nil/disabled Reporter: config then
// answers available:false and the rest 404.
func (r *Reporter) Register(e *echo.Echo) {
	e.GET("/api/bug-report/config", r.handleConfig)
	e.POST("/api/bug-report", r.guard(r.handleCreate))
	e.GET("/api/bug-reports", r.guard(r.handleList))
	e.GET("/api/bug-reports/:id/status", r.guard(r.handleStatus))
	e.GET("/api/bug-reports/:id/images/:n", r.guard(r.handleImage))
	e.GET("/bug-reports/:id", r.guard(r.handlePage))

	in := e.Group("/api/_bug", r.internalOnly)
	in.GET("/pending", r.guard(r.handlePending))
	in.GET("/queued", r.guard(r.handleQueued))
	in.POST("/:id/sync", r.guard(r.handleSync))
	in.GET("/:id", r.guard(r.handleFull))
}

func (r *Reporter) guard(h echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		if !r.Enabled() {
			return fail(c, http.StatusNotFound, "bug reports are not enabled")
		}
		return h(c)
	}
}

func fail(c echo.Context, code int, msg string) error {
	return c.JSON(code, map[string]string{"error": msg})
}

func serverError(c echo.Context, id int64, category string) error {
	log.Printf("bugreport: id=%d category=%s", id, category)
	return fail(c, http.StatusInternalServerError, "internal error")
}

// internalOnly admits only direct loopback callers. nginx always adds
// X-Forwarded-For/X-Real-IP, so a proxied request is refused even though its
// RemoteAddr is loopback.
func (r *Reporter) internalOnly(next echo.HandlerFunc) echo.HandlerFunc {
	return func(c echo.Context) error {
		req := c.Request()
		for _, h := range []string{"X-Forwarded-For", "X-Real-IP", "Forwarded"} {
			if req.Header.Get(h) != "" {
				return fail(c, http.StatusForbidden, "forbidden")
			}
		}
		host, _, err := net.SplitHostPort(req.RemoteAddr)
		if err != nil {
			host = req.RemoteAddr
		}
		ip := net.ParseIP(host)
		if ip == nil {
			return fail(c, http.StatusForbidden, "forbidden")
		}
		ok := ip.IsLoopback()
		if r != nil {
			for _, n := range r.allow {
				if n.Contains(ip) {
					ok = true
				}
			}
		}
		if !ok {
			return fail(c, http.StatusForbidden, "forbidden")
		}
		return next(c)
	}
}

func (r *Reporter) handleConfig(c echo.Context) error {
	return c.JSON(http.StatusOK, map[string]bool{"available": r.Enabled()})
}

func (r *Reporter) handleCreate(c echo.Context) error {
	req := c.Request()
	req.Body = http.MaxBytesReader(c.Response(), req.Body, maxBody)
	if err := req.ParseMultipartForm(1 << 20); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return fail(c, http.StatusRequestEntityTooLarge, "request too large")
		}
		return fail(c, http.StatusBadRequest, "expected multipart form")
	}
	defer req.MultipartForm.RemoveAll()

	desc := strings.TrimSpace(strings.ReplaceAll(req.FormValue("description"), "\x00", ""))
	if n := utf8.RuneCountInString(desc); n < MinDescription || n > MaxDescription {
		return fail(c, http.StatusBadRequest, "description must be 10 to 8000 characters")
	}
	key := strings.TrimSpace(req.FormValue("idempotency_key"))
	if !uuidRe.MatchString(key) {
		return fail(c, http.StatusBadRequest, "idempotency_key must be a UUID")
	}
	var rawCtx map[string]any
	if cs := req.FormValue("context"); cs != "" {
		if len(cs) > 32<<10 || json.Unmarshal([]byte(cs), &rawCtx) != nil {
			return fail(c, http.StatusBadRequest, "context must be a JSON object")
		}
	}
	ctx := SanitizeContext(rawCtx, r.version)
	if ua := cleanValue(req.UserAgent()); ua != "" {
		ctx["user_agent"] = ua
	}
	ctx["reported_at"] = isoNow(r.store.now())
	ctx["server_version"] = cleanValue(r.version)

	files := req.MultipartForm.File["attachments"]
	if len(files) > MaxAttachments {
		return fail(c, http.StatusRequestEntityTooLarge, "up to 3 screenshots per report")
	}
	images := make([]Image, 0, len(files))
	for _, fh := range files {
		if fh.Size > MaxImageBytes {
			return fail(c, http.StatusRequestEntityTooLarge, "image too large")
		}
		f, err := fh.Open()
		if err != nil {
			return fail(c, http.StatusBadRequest, "unreadable attachment")
		}
		data, err := io.ReadAll(io.LimitReader(f, MaxImageBytes+1))
		f.Close()
		if err != nil {
			return fail(c, http.StatusBadRequest, "unreadable attachment")
		}
		if len(data) > MaxImageBytes {
			return fail(c, http.StatusRequestEntityTooLarge, "image too large")
		}
		mime := SniffImage(data)
		if mime == "" {
			return fail(c, http.StatusUnsupportedMediaType, "attachments must be jpeg, png, webp or gif")
		}
		images = append(images, Image{Mime: mime, Data: data})
	}

	id, _, err := r.store.Create(key, desc, ctx, images)
	if err != nil {
		return serverError(c, 0, "save_failed")
	}
	return c.JSON(http.StatusAccepted, map[string]any{"status": "saved", "id": id, "key": strings.ToLower(key)})
}

// SniffImage identifies an allowed image type from its magic bytes.
func SniffImage(b []byte) string {
	switch {
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case len(b) >= 12 && string(b[0:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return "image/webp"
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return "image/gif"
	}
	return ""
}

func idParam(c echo.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	return id, err == nil && id > 0
}

func (r *Reporter) handleList(c echo.Context) error {
	limit := 3
	if v := c.QueryParam("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return fail(c, http.StatusBadRequest, "bad limit")
		}
		limit = min(n, 100)
	}
	rows, err := r.store.Recent(limit, c.QueryParam("path"))
	if err != nil {
		return serverError(c, 0, "list_failed")
	}
	return c.JSON(http.StatusOK, rows)
}

func (r *Reporter) handleStatus(c echo.Context) error {
	id, ok := idParam(c)
	if !ok {
		return fail(c, http.StatusNotFound, "not found")
	}
	st, err := r.store.Status(id)
	if err != nil {
		return serverError(c, id, "status_failed")
	}
	if st == nil {
		return fail(c, http.StatusNotFound, "not found")
	}
	return c.JSON(http.StatusOK, st)
}

func (r *Reporter) handleImage(c echo.Context) error {
	id, ok := idParam(c)
	n, err := strconv.Atoi(c.Param("n"))
	if !ok || err != nil {
		return fail(c, http.StatusNotFound, "not found")
	}
	im, err := r.store.Image(id, n)
	if err != nil {
		return serverError(c, id, "image_failed")
	}
	if im == nil {
		return fail(c, http.StatusNotFound, "not found")
	}
	h := c.Response().Header()
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "default-src 'none'")
	h.Set("Cache-Control", "private, max-age=3600")
	return c.Blob(http.StatusOK, im.Mime, im.Data)
}

func (r *Reporter) handlePending(c echo.Context) error {
	rows, err := r.store.Pending()
	if err != nil {
		return serverError(c, 0, "pending_failed")
	}
	return c.JSON(http.StatusOK, rows)
}

func (r *Reporter) handleQueued(c echo.Context) error {
	rows, err := r.store.Queued()
	if err != nil {
		return serverError(c, 0, "queued_failed")
	}
	return c.JSON(http.StatusOK, rows)
}

func (r *Reporter) handleSync(c echo.Context) error {
	id, ok := idParam(c)
	if !ok {
		return fail(c, http.StatusNotFound, "not found")
	}
	var u SyncUpdate
	body, err := io.ReadAll(io.LimitReader(c.Request().Body, 16<<10))
	if err != nil || json.Unmarshal(body, &u) != nil {
		return fail(c, http.StatusBadRequest, "bad json")
	}
	found, err := r.store.ApplySync(id, u)
	switch {
	case errors.Is(err, ErrInvalid):
		return fail(c, http.StatusBadRequest, err.Error())
	case err != nil:
		return serverError(c, id, "sync_failed")
	case !found:
		return fail(c, http.StatusNotFound, "not found")
	}
	return c.JSON(http.StatusOK, map[string]any{"id": id, "sync_status": u.SyncStatus})
}

func (r *Reporter) handleFull(c echo.Context) error {
	id, ok := idParam(c)
	if !ok {
		return fail(c, http.StatusNotFound, "not found")
	}
	rep, err := r.store.Get(id)
	if err != nil {
		return serverError(c, id, "get_failed")
	}
	if rep == nil {
		return fail(c, http.StatusNotFound, "not found")
	}
	return c.JSON(http.StatusOK, rep)
}

var pageTmpl = template.Must(template.New("p").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bug report #{{.R.ID}}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#222}
pre{white-space:pre-wrap;background:#f5f5f5;padding:1rem;border-radius:6px}
dt{font-weight:600;margin-top:.5rem}dd{margin:0;word-break:break-word}img{max-width:100%;border:1px solid #ccc;margin:.5rem 0}</style>
</head><body>
<h1>Bug report #{{.R.ID}}</h1>
<p>{{.R.CreatedAt}} &middot; status: {{.R.SyncStatus}}{{if .R.IssueURL}} &middot; <a href="{{.R.IssueURL}}">GitHub issue</a>{{end}}</p>
<h2>Description</h2><pre>{{.R.Description}}</pre>
<h2>Context</h2><dl>{{range .Keys}}<dt>{{.}}</dt><dd>{{index $.R.Context .}}</dd>{{end}}</dl>
{{if .R.Images}}<h2>Screenshots</h2>{{range .R.Images}}<a href="{{.URL}}"><img src="{{.URL}}" alt="screenshot {{.N}}"></a>{{end}}{{end}}
</body></html>`))

// handlePage renders the read-only LAN triage view the redacted GitHub issue
// links to. html/template escapes every user-controlled value.
func (r *Reporter) handlePage(c echo.Context) error {
	id, ok := idParam(c)
	if !ok {
		return fail(c, http.StatusNotFound, "not found")
	}
	rep, err := r.store.Get(id)
	if err != nil {
		return serverError(c, id, "get_failed")
	}
	if rep == nil {
		return fail(c, http.StatusNotFound, "not found")
	}
	keys := make([]string, 0, len(rep.Context))
	for k := range rep.Context {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var buf bytes.Buffer
	if err := pageTmpl.Execute(&buf, map[string]any{"R": rep, "Keys": keys}); err != nil {
		return serverError(c, id, "render_failed")
	}
	h := c.Response().Header()
	h.Set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	return c.HTMLBlob(http.StatusOK, buf.Bytes())
}

// PublicLink is the LAN triage URL for a report id.
func (r *Reporter) PublicLink(id int64) string {
	u, _ := url.JoinPath(r.publicURL, "bug-reports", strconv.FormatInt(id, 10))
	return u
}
