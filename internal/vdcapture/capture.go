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
	"golang.org/x/time/rate"
)

//go:embed recorder.js
var recorderJS []byte

const (
	// EventsPath receives recorder.js batches; RecorderPath serves the script.
	EventsPath   = "/api/_vd/events"
	RecorderPath = "/_vd/recorder.js"
	// MaxBody caps one request. recorder.js flushes at most 50 events per batch
	// (maxBatch), far below this; a full MaxEventsPerBatch of maximal-length
	// strings would not fit and is answered 413.
	MaxBody = 256_000
	// IngestPerSecond / IngestBurst bound the unauthenticated endpoint for the
	// whole process, independent of the optional global [server.rate_limit].
	// A real tab sends about one batch per 5 s.
	IngestPerSecond = 20
	IngestBurst     = 200

	EnvCapture           = "KIWIFS_VD_CAPTURE"        // "0"/"false"/"off"/"no" disables capture
	EnvFlowsDB           = "KIWIFS_VD_FLOWS_DB"       // SQLite path; must be a state path, never under --root
	EnvSample            = "KIWIFS_VD_SAMPLE"         // fraction of browser sessions recorded, 0..1
	EnvRetentionDays     = "KIWIFS_VD_RETENTION_DAYS" // idle-session retention window; <= 0 disables pruning
	DefaultDB            = "/var/lib/kiwifs/flows.db"
	DefaultRetentionDays = 30

	// retentionInterval bounds how often the in-process retention loop can run
	// its best-effort prune: at most once per this period, so the server needs
	// no separate daily host timer for it.
	retentionInterval = 24 * time.Hour
)

// Capture is the process-wide capture switch. A nil or disabled Capture serves
// no script tag and answers every ingest with 204, so the app never notices.
type Capture struct {
	store   *Store
	sample  float64
	limiter *rate.Limiter
	// One log budget per message class, so a flood of one kind can't mute another.
	logRejected, logDropped, logFailed, logLimited atomic.Int64

	retentionMu   sync.Mutex // guards start/stop of the loop below, incl. retentionStop itself
	retentionStop chan struct{}
	retentionOnce sync.Once
	retentionWG   sync.WaitGroup
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
	log.Printf("vdcapture: recording user flows into %s (sample=%g)", path, sample)
	c := New(st, sample)
	c.StartRetention(retentionDaysFromEnv())
	return c
}

// retentionDaysFromEnv reads EnvRetentionDays, defaulting to DefaultRetentionDays
// on an unset or invalid value.
func retentionDaysFromEnv() int {
	v := strings.TrimSpace(os.Getenv(EnvRetentionDays))
	if v == "" {
		return DefaultRetentionDays
	}
	days, err := strconv.Atoi(v)
	if err != nil {
		log.Printf("vdcapture: ignoring invalid %s=%q (want an integer), using default %d", EnvRetentionDays, v, DefaultRetentionDays)
		return DefaultRetentionDays
	}
	return days
}

// New wraps an open store; used by tests and embedders.
func New(st *Store, sample float64) *Capture {
	return &Capture{store: st, sample: sample, limiter: rate.NewLimiter(IngestPerSecond, IngestBurst)}
}

func (c *Capture) Enabled() bool { return c != nil && c.store != nil && c.sample > 0 }

func (c *Capture) Close() error {
	if c == nil {
		return nil
	}
	c.stopRetention()
	if c.store == nil {
		return nil
	}
	return c.store.Close()
}

// StartRetention launches a background loop that best-effort prunes sessions
// idle longer than `days` (see Store.Prune), once immediately and then at
// most once every 24h for as long as the process runs — the whole reason
// kiwifs no longer needs a separate daily host timer for this. days <= 0
// disables it. Safe to call at most once per Capture; a second call is a
// no-op.
func (c *Capture) StartRetention(days int) {
	if c == nil || c.store == nil {
		return
	}
	if days <= 0 {
		log.Printf("vdcapture: retention disabled (%s=%d)", EnvRetentionDays, days)
		return
	}
	c.retentionMu.Lock()
	if c.retentionStop != nil {
		c.retentionMu.Unlock()
		return
	}
	c.retentionStop = make(chan struct{})
	c.retentionMu.Unlock()
	log.Printf("vdcapture: retention enabled, pruning sessions idle > %d day(s), checked at most every %s", days, retentionInterval)
	c.retentionWG.Add(1)
	go func() {
		defer c.retentionWG.Done()
		c.pruneBestEffort(days)
		ticker := time.NewTicker(retentionInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				c.pruneBestEffort(days)
			case <-c.retentionStop:
				return
			}
		}
	}()
}

func (c *Capture) pruneBestEffort(days int) {
	n, err := c.store.Prune(days)
	if err != nil {
		log.Printf("vdcapture: retention prune failed: %v", err)
		return
	}
	if n > 0 {
		log.Printf("vdcapture: retention pruned %d idle session(s) older than %d day(s)", n, days)
	}
}

func (c *Capture) stopRetention() {
	if c == nil {
		return
	}
	c.retentionMu.Lock()
	stop := c.retentionStop
	c.retentionMu.Unlock()
	if stop == nil {
		return
	}
	c.retentionOnce.Do(func() { close(stop) })
	c.retentionWG.Wait()
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
// 413 when oversized, 429 over the process-wide ingest rate. Storage failures
// are logged and swallowed (204): the recorder never surfaces errors, and
// capture must never break the app.
func (c *Capture) HandleEvents(ctx echo.Context) error {
	if !c.Enabled() {
		return ctx.NoContent(http.StatusNoContent)
	}
	if c.limiter != nil && !c.limiter.Allow() {
		c.rateLog(&c.logLimited, "vdcapture: ingest rate limit (%d/s) exceeded, dropping batches", IngestPerSecond)
		return ctx.NoContent(http.StatusTooManyRequests)
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
		c.rateLog(&c.logRejected, "vdcapture: rejected batch: %v", be)
		return ctx.NoContent(http.StatusBadRequest)
	case err != nil:
		c.rateLog(&c.logFailed, "vdcapture: ingest failed: %v", err)
		return ctx.NoContent(http.StatusNoContent)
	}
	if res.Invalid > 0 || res.Capped {
		c.rateLog(&c.logDropped, "vdcapture: dropped %d invalid event(s), capped=%v", res.Invalid, res.Capped)
	}
	return ctx.NoContent(http.StatusNoContent)
}

// rateLog keeps a misbehaving client from flooding the journal: the first 20
// messages of each class are logged, then every 1000th.
func (c *Capture) rateLog(counter *atomic.Int64, format string, a ...any) {
	n := counter.Add(1)
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
