# AGENTS.md

Instructions for AI agents (Codex, Claude Code, Cursor, etc.) working in this repository.

## Project Overview

KiwiFS is a single Go binary that turns a folder of markdown files into a searchable, versioned, multi-protocol knowledge server with an embedded React web UI. Files on disk are the source of truth; indexes are rebuildable derivatives.

**Tech stack:** Go 1.25+ (backend), React 19 + TypeScript + Vite + Tailwind 4 + shadcn/ui (frontend), SQLite FTS5 (search), Git (versioning).

## Repository Structure

```
kiwifs/
|-- cmd/              # Cobra CLI commands (serve, init, mcp, query, import, export, ...)
|-- internal/         # All backend packages (~40 subpackages)
|   |-- api/          # REST API handlers (Echo framework)
|   |-- bootstrap/    # Dependency wiring
|   |-- pipeline/     # Write pipeline (storage -> git -> index -> SSE)
|   |-- search/       # grep + SQLite FTS5 + metadata index
|   |-- storage/      # Filesystem abstraction
|   |-- vectorstore/  # Pluggable vector search backends
|   |-- versioning/   # Git, copy-on-write, noop
|   |-- mcpserver/    # MCP server (62 tools)
|   |-- dataview/     # DQL parser and query engine (Pratt parser)
|   |-- workflow/     # Workflow state machine engine
|   |-- claims/       # Task claim system (path-level leases)
|   |-- importer/     # Data import from 19 sources + Airbyte protocol
|   |-- exporter/     # Export to JSONL/CSV/Parquet
|   |-- nfs/          # NFS server
|   |-- s3/           # S3-compatible API
|   |-- webdav/       # WebDAV server
|   |-- fuse/         # FUSE client
|   `-- ...
|-- pkg/kiwi/         # Public Go embed library
|-- ui/               # React frontend (embedded in binary via go:embed)
|   `-- src/
|       |-- components/   # React components
|       |-- lib/          # Utilities and API client
|       `-- App.tsx       # Main app with routing
|-- knowledge/        # Default knowledge base template
|-- docs/             # Project documentation
|-- tests/            # Integration tests
`-- main.go           # Entry point
```

## Build & Run

```bash
# Full build (UI + Go binary)
make build

# Go binary only (when UI hasn't changed)
make go-build

# Run dev server
make dev                # Go backend on :3333
make dev-ui             # Vite dev server (UI HMR)

# Build just the UI
make ui
```

## Testing

```bash
# Run all Go tests
go test ./... -race

# Run Go tests for a specific package
go test ./internal/dataview/... -race

# Run UI tests
cd ui && npm test

# Lint
go vet ./...
```

All PRs must pass the `test` CI check (go vet, go test, UI build) before merge.

## Code Style

- **Go:** `gofmt` formatting, `go vet` linting. No additional linter config.
- **TypeScript:** Prettier defaults. Tailwind for styling. shadcn/ui components.
- **Commits:** short summary, present tense ("Add search endpoint", not "Added search endpoint").
- **No narrating comments.** Don't add comments that just describe what the code does. Comments should explain non-obvious intent, trade-offs, or constraints.

## Architecture Principles

1. **Files are source of truth.** Every artifact is a plain markdown file. Indexes are derivative.
2. **All writes go through the pipeline.** Storage -> Git commit -> Index update -> SSE broadcast. The write pipeline uses a single mutex for serialization.
3. **Optimistic concurrency.** HTTP ETags (git blob hash) for conflict detection. `If-Match` header on writes; 409 on conflict.
4. **Storage-agnostic.** KiwiFS depends on `open()`, `read()`, `write()`, `listdir()`. Works on local disk, NFS, EFS, FUSE-S3.
5. **Search is three-tier.** grep (zero deps) -> FTS5/BM25 (default) -> vector (pluggable embedder + store).

## Key Patterns

- **REST handlers** are in `internal/api/handlers*.go`, registered in `internal/api/server.go`.
- **MCP tools** are registered in `internal/mcpserver/mcpserver.go` (62 tools).
- **DQL queries** go through the Pratt parser in `internal/dataview/parser.go` and evaluator in `internal/dataview/evaluator.go`.
- **Workflows** are JSON state machines in `.kiwi/workflows/*.json`, managed by `internal/workflow/`.
- **UI state** uses React context + localStorage. No global state library.
- The frontend expects the API at the same origin (proxied in dev via Vite config).

## Visual QA (video-debugger)

`vdebug/` records the reader's core journeys as video + checkpoint frames across a real-device
matrix (iPhone 13 Pro, iPad Pro 11", 2K, 4K, half-2K and third-4K windows — the old
mobile/tablet/desktop/ultrawide names still work as aliases), runs DOM layout checks at every
mark, and (with `--judge`) has a multimodal model on OpenRouter review the recording.

```bash
make build                                   # or build ui/ + the Go binary however you like
vdebug/serve_fixture.sh 38417 ./kiwifs       # throwaway copy of vdebug/fixture/ — never a real corpus
python3 vdebug/vdebug.py list
python3 vdebug/vdebug.py record --base-url http://127.0.0.1:38417 --viewports all --judge   # needs OPENROUTER_API_KEY + ffmpeg
# read vdebug-runs/latest/report.md (gitignored)
```

- Flows live in `vdebug/flows/*.py` (helpers in `_helpers.py`); use role/label/testid locators, never CSS classes.
- On `iphone-13-pro` / `ipad-pro-11` vdebug simulates the on-screen keyboard (`vdebug/keyboard.js`): focusing a
  text field shrinks `visualViewport`, draws a keyboard panel (top layer, above modal dialogs) and brings the field
  above it (its own scroller first; the page only when the field isn't in a fixed/sticky container, undone on close);
  `keyboard-covers-focus`, `keyboard-covers-control`, `ios-input-zoom` (on-screen inputs under 16px) and
  `zoom-disabled` (a viewport meta that blocks pinch-zoom) run at each mark. The `search`, `sidebar-filter` and `graph-highlight`
  flows type while it is up; any new text-entry UI needs a flow that clicks the field, types and marks.
  A flow can opt out with `KEYBOARD = False`.
- **After changing anything under `ui/`**, re-record the flows that touch those screens before opening a PR.
- Python tests: `cd vdebug && python3 -m pytest -q` (`-m "not browser"` skips real-browser tests).
- `vdebug/judge_notes.md` lists intentional design (scrollable overflow regions, the sticky
  breadcrumb, the graph's force-layout settle, etc.) the judge must not flag as a bug.

### Flow capture (what the reader collects)

`kiwifs serve` injects `/_vd/recorder.js` into the UI shell; it POSTs semantic intent events
(route changes, clicks, submits, scroll depth, JS errors) to `POST /api/_vd/events`, which
`internal/vdcapture` (a Go port of `vdebug/capture/flowstore.py`'s ingest) validates and stores in SQLite.

- **Never stored:** input values, query values, the raw user agent, any user id, note paths
  (`/page/<path>` is kept as `/page/:path`), document titles, or accessible names inside
  `[data-vd-mask]` regions (the note body, the sidebar tree, search results). Automated
  browsers (`navigator.webdriver`) record nothing.
- `KIWIFS_VD_FLOWS_DB` — db path, default `/var/lib/kiwifs/flows.db`. Must be a state path; a path
  inside `--root` is refused (it would be public via `/raw/*`). If the db can't be opened, capture
  switches itself off and the app runs normally.
- `KIWIFS_VD_CAPTURE=0` disables capture; `KIWIFS_VD_SAMPLE=0..1` sets the fraction of sessions recorded.
- Retention is in-process: `kiwifs serve` prunes sessions idle longer than `KIWIFS_VD_RETENTION_DAYS`
  (default 30) itself — once at startup, then at most once every 24h for as long as the process
  keeps running. Best-effort (a failed prune just logs). No host cron / systemd timer needed;
  set `KIWIFS_VD_RETENTION_DAYS` to 0 or a negative value to disable pruning entirely.
- There's also a hard, store-wide ceiling (20k sessions / 1M events) independent of retention:
  once hit, brand-new sessions are refused (a client minting fresh session ids can't grow the
  store without bound), but sessions already recording keep going.
- Inspect / mine / prune (same schema, `internal/vdcapture/schema.sql`):
  `python3 vdebug/capture/flowstore.py stats|mine|prune --db /var/lib/kiwifs/flows.db`
  (`mine --min-sessions 3 --out mined.json` → write `vdebug/flows/mined_<id>.py` → `promote`;
  `prune` still works standalone for a one-off cleanup, it just isn't required for routine retention).

## What NOT To Do

- Don't bypass the write pipeline. All file mutations must go through `internal/pipeline/`.
- Don't add CGo dependencies. The SQLite driver (`modernc.org/sqlite`) is pure Go by design.
- Don't commit `.kiwi/state/` files — they're derivative and rebuildable via `kiwifs reindex`.
- Don't use `internal/` packages from outside the module. Use `pkg/kiwi/` for embedding.
