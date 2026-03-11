# Google Docs Sync for Obsidian

Two-way sync between your Obsidian vault and Google Docs with rich formatting conversion.

[![CI](https://github.com/timbroder/ObsidianGDoc/actions/workflows/ci.yml/badge.svg)](https://github.com/timbroder/ObsidianGDoc/actions/workflows/ci.yml)

## Features

- **Two-way sync** — push local changes to Google Docs, pull remote edits back to Obsidian
- **Rich formatting conversion** — headings, bold, italic, strikethrough, code blocks, lists, tables, blockquotes, horizontal rules, highlights
- **Obsidian syntax support** — wikilinks, embeds, callouts, and tags are converted to/from Google Docs equivalents
- **Three-way merge** — concurrent edits on both sides are merged automatically when possible, with a side-by-side conflict resolution UI for overlapping changes
- **Frontmatter preservation** — YAML frontmatter is stored in Google Doc properties and restored on pull
- **Folder mirroring** — vault directory structure is mirrored in Google Drive
- **Auto-push on save** — changes are pushed after a configurable debounce (default 5s)
- **Periodic pull** — remote changes are fetched on a configurable interval (default 5 min)
- **Exclusion patterns** — glob syntax to skip files (e.g. `*.excalidraw.md`, `drafts/**`)
- **Encrypted token storage** — OAuth tokens encrypted at rest with AES-256-GCM
- **Desktop only** — uses Node.js crypto and filesystem APIs

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
5. Go to the plugin settings and enter your Google Cloud OAuth Client ID and Client Secret
6. Use the command palette (`Cmd/Ctrl+P`) and search for **GDocs Sync: Sync Now** to start your first sync

### Commands

| Command | Description |
|---------|-------------|
| **GDocs Sync: Sync Now** | Full sync (push + pull) |
| **GDocs Sync: Push to Google** | Push local changes only |
| **GDocs Sync: Pull from Google** | Pull remote changes only |
| **GDocs Sync: View Sync Log** | Open the sync log viewer |

A ribbon icon is also available for quick access to full sync.

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Client ID | — | Google OAuth 2.0 Client ID |
| Client Secret | — | Google OAuth 2.0 Client Secret |
| Root Folder | — | Google Drive folder to sync with |
| Sync Interval | 5 min | How often to pull remote changes (0 = disabled) |
| Auto Push on Save | `true` | Push changes after saving a file |
| Push Debounce | 5 sec | Wait time after last save before pushing |
| Exclusion Patterns | `*.excalidraw.md`, `*.canvas` | Glob patterns for files to skip |
| Max File Size | 5 MB | Skip files larger than this |
| Max Log Entries | 1000 | Rolling sync log cap |
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
```

The test suite includes 340 tests across 17 suites covering:

- **Conversion**: frontmatter, Obsidian syntax, Markdown-to-GDoc, GDoc-to-Markdown, formatting
- **Google API**: OAuth auth, Drive API, rate limiter
- **Sync engine**: index manager, change detector, dirty tracker, three-way merge, planner
- **Utilities**: hashing, glob matching, atomic writes, network detection

Tests use a comprehensive Obsidian API mock (`tests/mocks/obsidian-api.ts`) with an in-memory vault and event system.

### CI

GitHub Actions runs on every push to `main` and on pull requests:

1. Type check (`tsc --noEmit`)
2. Tests (`npm test`)
3. Build (`npm run build`)

Matrix: Node 20 and 22.

### Project Structure

```
src/
  main.ts                  # Plugin entry point
  settings.ts              # Settings tab UI
  types.ts                 # Shared TypeScript interfaces
  constants.ts             # API URLs, limits, defaults
  conversion/
    frontmatter.ts         # YAML frontmatter ↔ Doc properties
    obsidian-syntax.ts     # Wikilinks, embeds, callouts, highlights
    md-to-gdoc.ts          # Markdown → Google Docs batchUpdate
    gdoc-to-md.ts          # Google Docs → Markdown
    gdoc-formatting.ts     # Colors, alignment, image placeholders
  google/
    auth.ts                # OAuth 2.0 flow + encrypted token storage
    drive.ts               # Google Drive API v3 client
    docs.ts                # Google Docs API v1 client
    rate-limiter.ts        # Sliding window rate limiter with 429 retry
  sync/
    engine.ts              # Sync orchestrator
    planner.ts             # Diff local/remote → operation plan
    executor.ts            # Execute sync operations
    change-detector.ts     # SHA-256 content change detection
    dirty-tracker.ts       # Event-driven local file tracking
    merge.ts               # Three-way merge (diff3)
    conflict-modal.ts      # Conflict resolution UI
    index-manager.ts       # Sync metadata index (atomic writes)
    sync-log.ts            # JSONL sync log
  ui/
    status-bar.ts          # Status bar state display
    ribbon.ts              # Ribbon icon state management
    sync-log-modal.ts      # Sync log viewer modal
    initial-sync-modal.ts  # First-sync direction chooser
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

This project uses [Beads](https://github.com/beads-project/beads) (`bd`) for issue tracking. Issues are stored in `.beads/issues.jsonl` and synced via git.

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

### Code Standards

- **TypeScript strict mode** — `noImplicitAny` and `strictNullChecks` enabled
- **Path aliases** — use `@/` to import from `src/` (e.g. `import { sha256 } from "@/utils/hash"`)
- **No default exports** — all exports are named
- **Obsidian API via mock** — tests never depend on the real Obsidian runtime; everything goes through `tests/mocks/obsidian-api.ts`
- **Atomic writes** — all persistent state (index, tokens, log) uses temp-file-then-rename to prevent corruption
- **Rate limiting** — all Google API calls go through `RateLimiter` with sliding window and 429 retry
- **Encrypted secrets** — OAuth tokens are encrypted with AES-256-GCM (PBKDF2-derived key) before writing to disk

## License

[MIT](LICENSE)
