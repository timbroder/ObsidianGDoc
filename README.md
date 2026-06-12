# Google Docs Sync for Obsidian

Two-way sync between your Obsidian vault and Google Docs with rich formatting conversion.

[![CI](https://github.com/timbroder/ObsidianGDoc/actions/workflows/ci.yml/badge.svg)](https://github.com/timbroder/ObsidianGDoc/actions/workflows/ci.yml)

> **Status: early alpha.** The full sync pipeline is wired and covered by unit
> tests, but it has not yet been validated against the production Google API
> at scale. Use a test vault (or a vault you back up) until this notice is
> removed.

## Features

- **Two-way sync** — push local changes to Google Docs, pull remote edits back to Obsidian
- **Rich formatting conversion** — headings, bold, italic, strikethrough, code blocks, lists (with nesting), tables, blockquotes, horizontal rules, highlights
- **Obsidian syntax support** — wikilinks, embeds, callouts, and tags are converted to Google Docs-friendly equivalents on push
- **Three-way merge** — concurrent edits on both sides are merged automatically when possible, with a side-by-side conflict resolution UI for overlapping changes
- **Echo suppression** — your own pushes are recognized in the Drive changes feed and not pulled back as lossy round-trips
- **Frontmatter preservation** — YAML frontmatter is stored in Google Doc properties (chunked to respect Drive's 124-byte property limit) and restored on pull
- **Folder mirroring** — vault directory structure is mirrored in Google Drive, and remote folders are mirrored back
- **Rename tracking** — local renames/moves rename the Google Doc (preserving its history and comments) instead of delete-and-recreate
- **Auto-push on save** — changes are pushed after a configurable debounce (default 5s)
- **Periodic sync** — remote changes are fetched on a configurable interval (default 5 min)
- **Exclusion patterns** — glob syntax to skip files (e.g. `*.excalidraw.md`, `drafts/**`)
- **OAuth with PKCE** — sign-in completes via a localhost redirect; tokens are encrypted at rest with AES-256-GCM
- **Desktop only** — uses Node.js crypto, HTTP, and filesystem APIs

### Known limitations

- Wikilinks/embeds/callouts are converted to plain-text equivalents on push and are **not** restored on pull (a pull rewrites them in their plain form).
- Images and non-markdown attachments are not synced.
- The plugin uses the `drive.file` scope, so it can only see Drive files and folders **it created**. The sync root folder is created automatically; pointing it at a pre-existing folder requires that folder to be visible to the app.
- Frontmatter larger than ~6 KB cannot be stored in Drive properties and stays local-only (logged in the sync log).
- The token encryption key is stored in the plugin's `data.json`; this protects the token file when synced or backed up separately, but is not a defense against an attacker with full access to your vault directory.

## Installation (End User)

> **Note**: This plugin is not yet available in the Obsidian Community Plugin directory. Manual installation is required.

### Prerequisites

1. A [Google Cloud project](https://console.cloud.google.com/) with the **Google Drive API** and **Google Docs API** enabled
2. An OAuth 2.0 Client ID (Desktop app type) from your Google Cloud project

### Steps

1. Download the latest release (`main.js`, `manifest.json`, `styles.css`) from the [Releases](https://github.com/timbroder/ObsidianGDoc/releases) page
2. In your vault, create the folder `.obsidian/plugins/obsidian-gdocs-sync/`
3. Copy the three files into that folder
4. Open Obsidian Settings > Community Plugins > enable "Google Docs Sync"
5. Go to the plugin settings, enter your Google Cloud OAuth Client ID and Client Secret, and click **Sign In** (completes in your browser)
6. Use the command palette (`Cmd/Ctrl+P`) and run **GDocs Sync: Sync Now** to start your first sync

On the first sync the plugin creates a Drive folder (named after your vault by
default) plus a `_Deleted from Obsidian` subfolder where remotely-removed docs
are parked instead of being destroyed. If both your vault and the Drive folder
already contain files, you'll be asked which side is the source of truth.

### Commands

| Command | Description |
|---------|-------------|
| **GDocs Sync: Sync Now** | Full sync (push + pull) |
| **GDocs Sync: Push to Google** | Push local changes only |
| **GDocs Sync: Pull from Google** | Pull remote changes only |
| **GDocs Sync: View Sync Log** | Open the sync log viewer |

A ribbon icon is also available for quick access to full sync. The status bar
shows the current sync state.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Client ID | — | Google OAuth 2.0 Client ID |
| Client Secret | — | Google OAuth 2.0 Client Secret |
| Drive folder name | vault name | Name of the Drive folder created for syncing |
| Sync Interval | 5 min | How often to sync with Google Drive (0 = disabled) |
| Auto Push on Save | `true` | Push changes after saving a file |
| Push Debounce | 5 sec | Wait time after last save before pushing |
| Exclusion Patterns | `*.excalidraw.md`, `*.canvas` | Glob patterns for files to skip |
| Max File Size | 5 MB | Skip files larger than this |
| Debug Logging | `false` | Verbose logging for troubleshooting |

## Development

### Prerequisites

- Node.js 20+ (tested on 20 and 22)
- npm

### Setup

```bash
git clone https://github.com/timbroder/ObsidianGDoc.git
cd ObsidianGDoc
npm install
```

### Build

```bash
# Development build (with source maps)
npm run dev

# Production build (minified)
npm run build
```

Output goes to `dist/main.js`.

### Developing in Obsidian

For live development, symlink the dist output into your vault's plugin directory:

```bash
ln -s /path/to/ObsidianGDoc /path/to/your-vault/.obsidian/plugins/obsidian-gdocs-sync
```

Then run `npm run dev` and reload Obsidian to pick up changes.

### Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:coverage

# Lint
npm run lint
```

The test suite covers:

- **Conversion**: frontmatter, Obsidian syntax, Markdown-to-GDoc, GDoc-to-Markdown, formatting
- **Google API**: OAuth auth, Drive API, Docs API, rate limiter
- **Sync engine**: engine orchestration, executor, planner, index manager, change detector, dirty tracker, three-way merge
- **Utilities**: hashing, glob matching, atomic writes, network detection

Tests use a comprehensive Obsidian API mock (`tests/mocks/obsidian-api.ts`) with an in-memory vault and event system.

### CI

GitHub Actions runs on every push to `main` and on pull requests:

1. Type check (`tsc --noEmit`)
2. Lint (`npm run lint`)
3. Tests (`npm test`)
4. Build (`npm run build`)

Matrix: Node 20 and 22.

### Project Structure

```
src/
  main.ts                  # Plugin entry point & wiring
  settings.ts              # Settings tab UI
  types.ts                 # Shared TypeScript interfaces
  constants.ts             # API URLs, limits, defaults
  conversion/
    frontmatter.ts         # YAML frontmatter ↔ Doc properties (124-byte chunked)
    obsidian-syntax.ts     # Wikilinks, embeds, callouts, highlights
    md-to-gdoc.ts          # Markdown → Google Docs batchUpdate
    gdoc-to-md.ts          # Google Docs → Markdown
    gdoc-formatting.ts     # Colors, alignment, image placeholders
  google/
    auth.ts                # OAuth 2.0 + PKCE + encrypted token storage
    oauth-server.ts        # Loopback redirect listener for sign-in
    drive.ts               # Google Drive API v3 client
    docs.ts                # Google Docs API v1 client
    rate-limiter.ts        # Sliding window rate limiter with 429/5xx retry
  sync/
    engine.ts              # Sync orchestrator (modes, pagination, filtering)
    planner.ts             # Diff local/remote → operation plan (echo-aware)
    executor.ts            # Execute sync operations
    change-detector.ts     # SHA-256 content change detection
    dirty-tracker.ts       # Event-driven local file tracking
    merge.ts               # Three-way merge (diff3)
    conflict-modal.ts      # Conflict resolution UI
    index-manager.ts       # Sync metadata index (atomic writes, O(1) lookups)
    sync-log.ts            # JSONL sync log
  ui/
    status-bar.ts          # Status bar state display
    ribbon.ts              # Ribbon icon state management
    sync-log-modal.ts      # Sync log viewer modal
    initial-sync-modal.ts  # First-sync direction chooser
    remote-delete-modal.ts # Remote-deletion confirmation
  utils/
    hash.ts                # SHA-256 hashing
    glob.ts                # Glob pattern matching
    atomic-write.ts        # Atomic file writes (tmp + rename)
    network.ts             # Connectivity detection
tests/
  mocks/obsidian-api.ts    # In-memory Obsidian API mock
  unit/                    # Unit tests mirroring src/ structure
```

### Issue Tracking

This project uses [Beads](https://github.com/beads-project/beads) (`bd`) for issue tracking, synced via git.

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Code Standards

- **TypeScript strict mode** — `noImplicitAny`, `strictNullChecks`, `noUnusedLocals`, `noUnusedParameters`
- **ESLint** — `npm run lint`, enforced in CI
- **Path aliases** — use `@/` to import from `src/` (e.g. `import { sha256 } from "@/utils/hash"`)
- **No default exports** — all exports are named (except the plugin entry point, which Obsidian requires)
- **Obsidian API via mock** — tests never depend on the real Obsidian runtime; everything goes through `tests/mocks/obsidian-api.ts`
- **Atomic writes** — all persistent state (index, tokens, log) uses temp-file-then-rename to prevent corruption
- **Rate limiting** — all Google API calls go through `RateLimiter` (sliding window, 429 Retry-After, 5xx exponential backoff)
- **`requestUrl` with `throw: false`** — Obsidian throws on HTTP ≥ 400 by default; every API call opts out so status codes reach the typed error handling and retry logic
- **Encrypted secrets** — OAuth tokens are encrypted with AES-256-GCM (PBKDF2-derived key) before writing to disk

## License

[MIT](LICENSE)
