package vdcapture

import (
	_ "embed"
	"errors"
	"html"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/labstack/echo/v4"
)

//go:embed recorder.js
var recorderJS []byte

const (
	// EventsPath receives recorder.js batches; RecorderPath serves the script.
	EventsPath   = "/api/_vd/events"
	RecorderPath = "/_vd/recorder.js"
	// MaxBody caps one batch; 500 events of capped strings fit comfortably.
	MaxBody = 256_000

	EnvCapture = "KIWIFS_VD_CAPTURE"        // "0"/"false"/"off"/"no" disables capture
	EnvFlowsDB = "KIWIFS_VD_FLOWS_DB"       // SQLite path; must be a state path, never under --root
	EnvSample  = "KIWIFS_VD_SAMPLE"         // fraction of browser sessions recorded, 0..1
	EnvDays    = "KIWIFS_VD_RETENTION_DAYS" // sessions idle longer are pruned daily (default 30)
	DefaultDB  = "/var/lib/kiwifs/flows.db"
)

// Capture is the process-wide capture switch. A nil or disabled Capture serves
// no script tag and answers every ingest with 204, so the app never notices.
type Capture struct {
	store  *Store
	sample float64
	logged atomic.Int64
	stop   chan struct{}
}

// FromEnv opens capture per the env vars. Any failure (unwritable state dir,
// bad db) disables capture with a log line instead of failing startup.
// servedRoot is the markdown root: a db inside it would be downloadable via
// /raw/*, so that is refused.
func FromEnv(servedRoot string) *Capture {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(EnvCapture))) {
	case "0", "false", "off", "no":
		log.Printf("vdcapture: disabled by %s", EnvCapture)
		return nil
	}
	path := strings.TrimSpace(os.Getenv(EnvFlowsDB))
	if path == "" {
		path = DefaultDB
	}
	if insideRoot(path, servedRoot) {
		log.Printf("vdcapture: disabled, %s=%s is inside the served root %s (it would be public via /raw); use a state path such as %s", EnvFlowsDB, path, servedRoot, DefaultDB)
		return nil
	}
	sample := 1.0
	if v := strings.TrimSpace(os.Getenv(EnvSample)); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f >= 0 && f <= 1 {
			sample = f
		} else {
			log.Printf("vdcapture: ignoring invalid %s=%q (want 0..1)", EnvSample, v)
		}
	}
	st, err := Open(path)
	if err != nil {
		log.Printf("vdcapture: disabled, cannot open %s: %v (set %s to a writable state path, or %s=0)", path, err, EnvFlowsDB, EnvCapture)
		return nil
	}
	days := 30
	if v := strings.TrimSpace(os.Getenv(EnvDays)); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			days = n
		} else {
			log.Printf("vdcapture: ignoring invalid %s=%q", EnvDays, v)
		}
	}
	log.Printf("vdcapture: recording user flows into %s (sample=%g, retention=%dd)", path, sample, days)
	c := &Capture{store: st, sample: sample, stop: make(chan struct{})}
	go c.pruneLoop(days, 24*time.Hour)
	return c
}

// pruneLoop is the retention the skill otherwise asks a host timer for.
func (c *Capture) pruneLoop(days int, every time.Duration) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		if n, err := c.store.Prune(days); err != nil {
			c.rateLog("vdcapture: prune failed: %v", err)
		} else if n > 0 {
			log.Printf("vdcapture: pruned %d session(s) idle > %dd", n, days)
		}
		select {
		case <-c.stop:
			return
		case <-t.C:
		}
	}
}

// New wraps an open store; used by tests and embedders.
func New(st *Store, sample float64) *Capture { return &Capture{store: st, sample: sample} }

func (c *Capture) Enabled() bool { return c != nil && c.store != nil && c.sample > 0 }

func (c *Capture) Close() error {
	if c == nil || c.store == nil {
		return nil
	}
	if c.stop != nil {
		close(c.stop)
		c.stop = nil
	}
	return c.store.Close()
}

// ScriptTag is injected into index.html's <head>; empty when capture is off.
func (c *Capture) ScriptTag() string {
	if !c.Enabled() {
		return ""
	}
	return `<script src="` + RecorderPath + `" data-endpoint="` + EventsPath +
		`" data-sample="` + html.EscapeString(strconv.FormatFloat(c.sample, 'f', -1, 64)) + `" defer></script>`
}

// ServeRecorder serves recorder.js (served even when disabled: it is inert without the tag).
func ServeRecorder(ctx echo.Context) error {
	ctx.Response().Header().Set("Cache-Control", "public, max-age=3600")
	return ctx.Blob(http.StatusOK, "text/javascript; charset=utf-8", recorderJS)
}

// HandleEvents ingests one batch. 204 on success, 400 on a malformed batch,
// 413 when oversized. Storage failures are logged and swallowed (204): the
// recorder never surfaces errors, and capture must never break the app.
func (c *Capture) HandleEvents(ctx echo.Context) error {
	if !c.Enabled() {
		return ctx.NoContent(http.StatusNoContent)
	}
	req := ctx.Request()
	body, err := io.ReadAll(io.LimitReader(req.Body, MaxBody+1))
	if err != nil {
		return ctx.NoContent(http.StatusBadRequest)
	}
	if len(body) > MaxBody {
		return ctx.NoContent(http.StatusRequestEntityTooLarge)
	}
	res, err := c.store.Ingest(body, req.Header.Get("User-Agent"))
	var be *BatchError
	switch {
	case errors.As(err, &be):
		return ctx.NoContent(http.StatusBadRequest)
	case err != nil:
		c.rateLog("vdcapture: ingest failed: %v", err)
		return ctx.NoContent(http.StatusNoContent)
	}
	if res.Invalid > 0 || res.Capped {
		c.rateLog("vdcapture: dropped %d invalid event(s), capped=%v", res.Invalid, res.Capped)
	}
	return ctx.NoContent(http.StatusNoContent)
}

// rateLog keeps a misbehaving client from flooding the journal: the first 20
// anomalies are logged, then every 1000th.
func (c *Capture) rateLog(format string, a ...any) {
	n := c.logged.Add(1)
	if n <= 20 || n%1000 == 0 {
		log.Printf(format, a...)
	}
}

var (
	defaultMu  sync.RWMutex
	defaultCap *Capture
)

// SetDefault installs the process-wide capture (called once by `kiwifs serve`
// before any server is built). Tests and non-serve commands leave it nil.
func SetDefault(c *Capture) {
	defaultMu.Lock()
	defaultCap = c
	defaultMu.Unlock()
}

func Default() *Capture {
	defaultMu.RLock()
	defer defaultMu.RUnlock()
	return defaultCap
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
