// Package bugreport is the local tier of the in-app "Report a bug" button.
//
// A submit is written to SQLite (description, allowlisted context,
// screenshots) and acknowledged immediately; KiwiFS never calls issue-queue or
// GitHub. A host worker reads /api/_bug/pending over loopback, files a
// redacted issue (ids, versions, slug and a LAN link only) and reports the
// outcome back through /api/_bug/{id}/sync.
//
// Configuration (environment, read once by `kiwifs serve`):
//
//	KIWIFS_BUG_REPORTS_DB      SQLite path; empty disables the feature. Must be a
//	                           state path, never inside --root.
//	KIWIFS_PUBLIC_URL          base URL for links (default https://mind.local.thedante.net)
//	KIWIFS_BUG_INTERNAL_ALLOW  optional comma-separated CIDRs also accepted by the
//	                           internal endpoints (e.g. a docker bridge gateway)
//
// Report text, titles and context values are never logged; only ids and
// content-free categories.
package bugreport

import (
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

const (
	MinDescription = 10
	MaxDescription = 8000
	MaxAttachments = 3
	MaxImageBytes  = 2 << 20
	MaxValueLen    = 500
	MaxTitleLen    = 72
	TitlePrefix    = "Bug: "
)

var syncStatuses = map[string]bool{
	"pending-sync": true, "queued": true, "filed": true,
	"retry": true, "failed": true, "uncertain": true,
}

var issueURLRe = regexp.MustCompile(`^https://github\.com/Josephkready/kiwifs/issues/[0-9]{1,9}$`)
var uuidRe = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var errorCategoryRe = regexp.MustCompile(`^[a-z0-9_-]{1,40}$`)

// contextKeys is the client-context allowlist. Anything else is dropped.
var contextKeys = []string{
	"path", "slug", "route", "view", "viewport", "theme",
	"app_version", "search_query", "selected_text",
}

type Image struct {
	Mime string
	Data []byte
}

type Report struct {
	ID          int64             `json:"id"`
	Key         string            `json:"key"`
	Description string            `json:"description"`
	Context     map[string]string `json:"context"`
	Title       string            `json:"title"`
	Slug        string            `json:"slug"`
	Path        string            `json:"path"`
	AppVersion  string            `json:"app_version"`
	CreatedAt   string            `json:"created_at"`
	SyncStatus  string            `json:"sync_status"`
	JobID       string            `json:"job_id,omitempty"`
	IssueNumber int64             `json:"issue_number,omitempty"`
	IssueURL    string            `json:"issue_url,omitempty"`
	Images      []ImageInfo       `json:"images"`
}

type ImageInfo struct {
	N    int    `json:"n"`
	Mime string `json:"mime"`
	URL  string `json:"url"`
}

type Store struct {
	db  *sql.DB
	now func() time.Time
	mu  sync.Mutex
}

func Open(path string) (*Store, error) {
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, fmt.Errorf("create bug reports db dir: %w", err)
		}
	}
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(10000)&_pragma=foreign_keys(1)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open bug reports db: %w", err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("apply bug reports schema: %w", err)
	}
	_ = os.Chmod(path, 0o600)
	return &Store{db: db, now: time.Now}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func isoNow(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// SanitizeContext keeps only allowlisted string keys, strips angle brackets
// and control characters, and caps every value. appVersion is server-owned
// and overrides whatever the client sent.
func SanitizeContext(raw map[string]any, appVersion string) map[string]string {
	out := map[string]string{}
	for _, k := range contextKeys {
		v, ok := raw[k].(string)
		if !ok {
			continue
		}
		v = cleanValue(v)
		if v != "" {
			out[k] = v
		}
	}
	if appVersion != "" {
		out["app_version"] = cleanValue(appVersion)
	} else {
		delete(out, "app_version")
	}
	return out
}

func cleanValue(v string) string {
	v = strings.Map(func(r rune) rune {
		switch {
		case r == '<' || r == '>':
			return -1
		case r == '\n' || r == '\t':
			return ' '
		case unicode.IsControl(r):
			return -1
		}
		return r
	}, v)
	v = strings.TrimSpace(v)
	if utf8.RuneCountInString(v) > MaxValueLen {
		v = string([]rune(v)[:MaxValueLen])
	}
	return v
}

// BuildTitle is "Bug: " + the first non-empty line, at most MaxTitleLen runes,
// truncated on a word boundary with an ellipsis.
func BuildTitle(description string) string {
	first := ""
	for _, line := range strings.Split(description, "\n") {
		if t := strings.TrimSpace(line); t != "" {
			first = strings.Join(strings.Fields(t), " ")
			break
		}
	}
	title := TitlePrefix + first
	r := []rune(title)
	if len(r) <= MaxTitleLen {
		return title
	}
	cut := r[:MaxTitleLen-1]
	if r[MaxTitleLen-1] != ' ' {
		if i := lastSpace(cut); i > len([]rune(TitlePrefix)) {
			cut = cut[:i]
		}
	}
	return strings.TrimRight(string(cut), " .,;:-") + "…"
}

func lastSpace(r []rune) int {
	for i := len(r) - 1; i >= 0; i-- {
		if r[i] == ' ' {
			return i
		}
	}
	return -1
}

func slugFor(ctx map[string]string) string {
	if s := ctx["slug"]; s != "" {
		return s
	}
	return strings.TrimSuffix(strings.Trim(ctx["path"], "/"), ".md")
}

// Create stores a report; the same key returns the existing row unchanged.
func (s *Store) Create(key, description string, ctx map[string]string, images []Image) (id int64, created bool, err error) {
	ctxJSON, err := json.Marshal(ctx)
	if err != nil {
		return 0, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.db.QueryRow(`SELECT id FROM bug_reports WHERE key = ?`, strings.ToLower(key)).Scan(&id); err == nil {
		return id, false, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, false, err
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, false, err
	}
	defer tx.Rollback()
	now := isoNow(s.now())
	res, err := tx.Exec(`INSERT INTO bug_reports
		(key, description, context_json, slug, path, app_version, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?)`,
		strings.ToLower(key), description, string(ctxJSON), slugFor(ctx), ctx["path"], ctx["app_version"], now, now)
	if err != nil {
		return 0, false, err
	}
	id, err = res.LastInsertId()
	if err != nil {
		return 0, false, err
	}
	for i, im := range images {
		if _, err := tx.Exec(`INSERT INTO bug_report_images (report_id,pos,mime,data) VALUES (?,?,?,?)`, id, i+1, im.Mime, im.Data); err != nil {
			return 0, false, err
		}
	}
	return id, true, tx.Commit()
}

type Row struct {
	ID          int64  `json:"id"`
	CreatedAt   string `json:"created_at"`
	Title       string `json:"title"`
	SyncStatus  string `json:"sync_status"`
	IssueURL    string `json:"issue_url"`
	IssueNumber int64  `json:"-"`
}

// Recent lists newest-first, scoped to a note path when path != "".
func (s *Store) Recent(limit int, path string) ([]Row, error) {
	q := `SELECT id, created_at, description, sync_status, COALESCE(issue_url,'') FROM bug_reports`
	args := []any{}
	if path != "" {
		q += ` WHERE path = ?`
		args = append(args, path)
	}
	q += ` ORDER BY id DESC LIMIT ?`
	args = append(args, limit)
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Row{}
	for rows.Next() {
		var r Row
		var desc string
		if err := rows.Scan(&r.ID, &r.CreatedAt, &desc, &r.SyncStatus, &r.IssueURL); err != nil {
			return nil, err
		}
		r.Title = BuildTitle(desc)
		r.IssueURL = safeIssueURL(r.IssueURL)
		out = append(out, r)
	}
	return out, rows.Err()
}

func safeIssueURL(u string) string {
	if issueURLRe.MatchString(u) {
		return u
	}
	return ""
}

type Status struct {
	ID          int64  `json:"id"`
	SyncStatus  string `json:"sync_status"`
	IssueNumber int64  `json:"issue_number,omitempty"`
	IssueURL    string `json:"issue_url,omitempty"`
}

func (s *Store) Status(id int64) (*Status, error) {
	var st Status
	var num sql.NullInt64
	var url sql.NullString
	err := s.db.QueryRow(`SELECT id, sync_status, issue_number, issue_url FROM bug_reports WHERE id = ?`, id).
		Scan(&st.ID, &st.SyncStatus, &num, &url)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	st.IssueNumber = num.Int64
	st.IssueURL = safeIssueURL(url.String)
	return &st, nil
}

type Pending struct {
	ID         int64  `json:"id"`
	Key        string `json:"key"`
	Title      string `json:"title"`
	Slug       string `json:"slug"`
	Path       string `json:"path"`
	AppVersion string `json:"app_version"`
	CreatedAt  string `json:"created_at"`
}

func (s *Store) Pending() ([]Pending, error) {
	rows, err := s.db.Query(`SELECT id, key, description, slug, path, app_version, created_at
		FROM bug_reports WHERE sync_status IN ('pending-sync','retry') ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Pending{}
	for rows.Next() {
		var p Pending
		var desc string
		if err := rows.Scan(&p.ID, &p.Key, &desc, &p.Slug, &p.Path, &p.AppVersion, &p.CreatedAt); err != nil {
			return nil, err
		}
		p.Title = BuildTitle(desc)
		out = append(out, p)
	}
	return out, rows.Err()
}

type Queued struct {
	ID    int64  `json:"id"`
	JobID string `json:"job_id"`
}

func (s *Store) Queued() ([]Queued, error) {
	rows, err := s.db.Query(`SELECT id, job_id FROM bug_reports
		WHERE sync_status IN ('queued','uncertain') AND job_id IS NOT NULL AND job_id != '' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Queued{}
	for rows.Next() {
		var q Queued
		if err := rows.Scan(&q.ID, &q.JobID); err != nil {
			return nil, err
		}
		out = append(out, q)
	}
	return out, rows.Err()
}

type SyncUpdate struct {
	SyncStatus    string `json:"sync_status"`
	JobID         string `json:"job_id"`
	IssueNumber   int64  `json:"issue_number"`
	IssueURL      string `json:"issue_url"`
	ErrorCategory string `json:"error_category"`
}

var ErrInvalid = errors.New("invalid sync update")

// ApplySync updates the sync columns; false when the id does not exist.
func (s *Store) ApplySync(id int64, u SyncUpdate) (bool, error) {
	if !syncStatuses[u.SyncStatus] {
		return false, fmt.Errorf("%w: sync_status", ErrInvalid)
	}
	if u.IssueURL != "" && !issueURLRe.MatchString(u.IssueURL) {
		return false, fmt.Errorf("%w: issue_url", ErrInvalid)
	}
	if u.ErrorCategory != "" && !errorCategoryRe.MatchString(u.ErrorCategory) {
		return false, fmt.Errorf("%w: error_category", ErrInvalid)
	}
	if len(u.JobID) > 100 || u.IssueNumber < 0 {
		return false, fmt.Errorf("%w: job", ErrInvalid)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`UPDATE bug_reports SET sync_status = ?,
		job_id = COALESCE(NULLIF(?, ''), job_id),
		issue_number = COALESCE(NULLIF(?, 0), issue_number),
		issue_url = COALESCE(NULLIF(?, ''), issue_url),
		error_category = ?, updated_at = ? WHERE id = ?`,
		u.SyncStatus, u.JobID, u.IssueNumber, u.IssueURL, u.ErrorCategory, isoNow(s.now()), id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// Get returns the full local report, or nil when missing.
func (s *Store) Get(id int64) (*Report, error) {
	var r Report
	var ctxJSON string
	var job, url sql.NullString
	var num sql.NullInt64
	err := s.db.QueryRow(`SELECT id, key, description, context_json, slug, path, app_version, created_at,
		sync_status, job_id, issue_number, issue_url FROM bug_reports WHERE id = ?`, id).
		Scan(&r.ID, &r.Key, &r.Description, &ctxJSON, &r.Slug, &r.Path, &r.AppVersion, &r.CreatedAt,
			&r.SyncStatus, &job, &num, &url)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Context = map[string]string{}
	_ = json.Unmarshal([]byte(ctxJSON), &r.Context)
	r.Title = BuildTitle(r.Description)
	r.JobID = job.String
	r.IssueNumber = num.Int64
	r.IssueURL = safeIssueURL(url.String)
	r.Images = []ImageInfo{}
	rows, err := s.db.Query(`SELECT pos, mime FROM bug_report_images WHERE report_id = ? ORDER BY pos`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var im ImageInfo
		if err := rows.Scan(&im.N, &im.Mime); err != nil {
			return nil, err
		}
		im.URL = fmt.Sprintf("/api/bug-reports/%d/images/%d", id, im.N)
		r.Images = append(r.Images, im)
	}
	return &r, rows.Err()
}

func (s *Store) Image(id int64, n int) (*Image, error) {
	var im Image
	err := s.db.QueryRow(`SELECT mime, data FROM bug_report_images WHERE report_id = ? AND pos = ?`, id, n).Scan(&im.Mime, &im.Data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &im, nil
}
