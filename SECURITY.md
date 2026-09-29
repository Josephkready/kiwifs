# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in KiwiFS, please report it responsibly.

**Email:** [amelia.anh.lam@gmail.com](mailto:amelia.anh.lam@gmail.com)

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to provide a fix or mitigation within 7 days for critical issues. You will be credited in the release notes unless you prefer to remain anonymous.

**Do not** open a public GitHub issue for security vulnerabilities.

---

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.19.x  | Yes       |
| < 0.19  | No        |

We only patch the latest minor release. Upgrade to stay protected.

---

## Security Model

### Authentication

KiwiFS supports pluggable authentication via `.kiwi/config.toml`:

| Mode | Use case |
|------|----------|
| `none` | Local development, trusted networks |
| `apikey` | Server-to-server, agent access |
| `perspace` | Per-workspace API keys |
| `oidc` | Multi-user web apps (OAuth 2.0 / OpenID Connect) |

### Path Safety

All file paths are validated through `GuardPath`, which blocks:

- Directory traversal (`../`, `..\\`)
- Null bytes and control characters
- Path segments exceeding 255 bytes
- Access to internal directories (`.git/`, `.kiwi/state/`)
- Absolute paths and UNC paths

### Write Integrity

- **Atomic writes** use the crash-safe pattern: write to temp file, `fsync`, rename to target, `fsync` directory. No torn writes on crash.
- **Optimistic locking** via ETags (git blob hash). Concurrent writes return HTTP 409 with the current version.
- **Serialized pipeline** ensures all writes (REST, NFS, S3, WebDAV, FUSE, MCP) flow through a single mutex. No race conditions.
- **Single-instance guard** via `flock(2)` on `.kiwi/server.lock` prevents two servers from corrupting shared state.

### Audit Trail

Every write is a git commit with SHA-1 content addressing. The commit chain is tamper-evident: altering any commit breaks the hash chain. Use `git log`, `git blame`, and `git diff` for forensic analysis.

### Frontmatter Protection

- YAML frontmatter blocks exceeding 64KB are silently treated as empty (prevents deserialization bombs)
- File size limit of 64MB enforced across all protocols (returns `EFBIG` / HTTP 413)
- `.gitattributes` writes are blocked by the API to preserve line-ending integrity

### NFS / FUSE Security

- NFS runs in userspace (no root required)
- FUSE symlink targets are validated: absolute paths and traversal targets are rejected
- Internal directories (`.git/`, `.kiwi/`) are hidden from directory listings

### Git Process Safety

- Git subprocesses receive SIGTERM (not SIGKILL) on timeout, allowing lock release
- A background watcher removes stale `index.lock` files older than 60 seconds
- On startup, stale locks are cleaned automatically

---

### Usage flow capture

`kiwifs serve` records how the web UI is used, so UI tests can follow real user paths. The
recorder (`/_vd/recorder.js`) posts intent events (route changes, clicks, submits, scroll depth,
JS errors) to `POST /api/_vd/events`, stored in a separate SQLite db.

- **Never stored:** input values, query-string values, the raw user agent, user ids or cookies,
  note paths (`/page/<path>` becomes `/page/:path`), page titles, or labels inside the note body,
  sidebar tree and search results. Automated browsers record nothing.
- **Where:** `KIWIFS_VD_FLOWS_DB` (default `/var/lib/kiwifs/flows.db`). A path inside `--root` is
  refused, since `/raw/*` would serve it. Prune it daily with
  `python3 vdebug/capture/flowstore.py prune --db <db> --days 30`.
- **Turn it off:** `KIWIFS_VD_CAPTURE=0`, or sample with `KIWIFS_VD_SAMPLE=0..1`. If the db can't
  be opened, capture turns itself off and KiwiFS runs normally.
- The ingest endpoint is unauthenticated and rate-limited to 20 batches/s per process; also cap it
  at your reverse proxy if KiwiFS is internet-facing.

## Dependencies

KiwiFS is built in Go with minimal dependencies. The binary is statically linked. SQLite is pure Go (no CGo). Security-critical dependencies:

| Dependency | Purpose | Maintained by |
|-----------|---------|---------------|
| `modernc.org/sqlite` | FTS5 search index | Jan Mercl |
| `willscott/go-nfs` | Userspace NFS server | Will Scott |
| `hanwen/go-fuse` | FUSE client | Google |
| `golang.org/x/net/webdav` | WebDAV server | Go team |

---

## Best Practices for Production

1. **Enable authentication.** Never run `auth.type = "none"` on a public network.
2. **Use HTTPS.** Put KiwiFS behind a reverse proxy (Caddy, nginx, Traefik) with TLS.
3. **Restrict network access.** Bind to `127.0.0.1` or use firewall rules to limit who can reach the API and protocol ports.
4. **Back up regularly.** Configure `[backup]` in `.kiwi/config.toml` or run `kiwifs backup` in a cron job.
5. **Keep KiwiFS updated.** Run `kiwifs update` to get the latest security fixes.
