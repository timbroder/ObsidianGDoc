# Obsidian Google Docs Sync Plugin — Implementation Spec

## Plugin Name
`obsidian-gdocs-sync`

## Overview
An Obsidian community plugin that provides seamless two-way synchronization between an Obsidian vault and Google Docs. Every markdown note in the vault is mirrored as a native Google Doc with rich formatting, and edits on either side flow back automatically. The goal is to let users write in Obsidian while sharing polished, collaborative Google Docs with non-Obsidian users.

---

## Architecture Summary

```
┌─────────────┐       ┌──────────────────┐       ┌──────────────┐
│  Obsidian    │◄─────►│  Sync Engine     │◄─────►│ Google APIs  │
│  Vault (.md) │       │  (plugin core)   │       │ Drive + Docs │
└─────────────┘       └──────────────────┘       └──────────────┘
                              │
                       ┌──────┴──────┐
                       │ .gdocs-sync │
                       │  (metadata) │
                       └─────────────┘
```

---

## Risk Register & Key Concerns

This section documents the highest-risk areas of the project, ordered by severity. Implementers should read this before writing any code.

### RISK 1: Markdown ↔ Google Docs Conversion Fidelity (CRITICAL)
- **Problem:** Google Docs API uses a structured document model (paragraphs, text runs, named styles) that maps imperfectly to markdown. Round-tripping (md → gdoc → md) will introduce drift if not handled carefully.
- **Specific dangers:**
  - Whitespace and line break semantics differ (markdown uses double-newline for paragraph breaks; Google Docs uses paragraph elements).
  - Nested lists in Google Docs use `nestingLevel` which doesn't map 1:1 to markdown indent levels.
  - Code blocks have no first-class Google Docs equivalent — we're faking them with monospace + background color, which means we can't reliably detect them on the way back.
  - Tables: Google Docs tables have cell-level formatting; markdown tables are plain text with pipes. Complex tables will lose formatting on round-trip.
  - Google Docs formatting without markdown equivalents (colored text, font changes, text alignment, inline images added by collaborators) must be preserved as best-effort markdown. Use HTML spans/comments where no markdown equivalent exists.
- **Mitigation:** Build the conversion module first. Write exhaustive round-trip tests before integrating with the sync engine. Accept that some drift is inevitable and document known lossy conversions.

### RISK 2: Three-Way Merge Complexity (HIGH)
- **Problem:** Merging at the markdown level means both sides must be converted to markdown before diffing. Conversion drift (Risk 1) can cause phantom conflicts — lines that look different but are semantically identical.
- **Mitigation:** Normalize whitespace and formatting before diffing. Consider merging on a per-paragraph basis rather than per-line to reduce noise. Test with realistic editing patterns (not just synthetic diffs).

### RISK 3: Google Docs API Rate Limits (HIGH)
- **Problem:** Docs API allows only 300 requests/min per user. A vault with 500 notes would need 500 API calls just to check for changes, plus more to read/write content.
- **Mitigation:** Use Drive API `changes.list` with `startPageToken` for incremental change detection (much cheaper). Only call Docs API for files that actually changed. Batch Drive API calls. Implement request queuing with rate limit awareness.

### RISK 4: Initial Sync on Large Vaults (HIGH)
- **Problem:** First sync of a 1000+ file vault could take 30+ minutes and hit API quotas.
- **Mitigation:** Implement chunked initial sync with progress reporting. Process files in batches of 50. Show a progress modal during initial sync. Allow cancellation and resumption.

### RISK 5: Data Loss Vectors (CRITICAL)
- **Problem:** Any sync tool can lose data. Our specific vectors:
  - Mid-sync crash leaves index.json inconsistent with actual state.
  - Conversion bug silently drops content.
  - Conflict resolution chooses wrong version.
  - Race condition between user edit and sync push.
- **Mitigation:**
  - Write index.json atomically (write to temp file, then rename).
  - Validate conversion output length — if output is significantly shorter than input, warn before writing.
  - Always keep ancestor snapshots — never delete until the next successful sync creates a new one.
  - Snapshot + compare strategy for mid-sync edits (see Edge Cases below).
  - Never auto-resolve a conflict that would delete more than 20% of a file's content (measured against the longer of the two inputs) — always prompt.
  - Push updates to existing Google Docs as a single atomic `batchUpdate` request (delete range + insert) rather than separate clear-then-rebuild calls, to avoid a window where the doc is empty if the plugin crashes mid-operation.

### RISK 6: OAuth Token Security (MEDIUM)
- **Problem:** Refresh tokens stored on disk could be extracted by malware or other plugins.
- **Mitigation:** Encrypt auth.json at rest. For MVP, use a derived key from a user-provided passphrase. Document the risk. OS keychain integration is a future enhancement.

### RISK 7: Frontmatter Size Limits (MEDIUM)
- **Problem:** Google Docs document properties have size limits (~30KB). Extremely large frontmatter blocks could exceed this.
- **Mitigation:** If frontmatter exceeds the property size limit, split across multiple properties with a continuation scheme. Log a warning. In practice, frontmatter rarely exceeds a few KB.

### RISK 8: `drive.file` Scope Limits Visibility (MEDIUM)
- **Problem:** The `drive.file` OAuth scope only grants access to files the plugin itself created. If a collaborator or another app places a Google Doc in the synced Drive folder, the plugin cannot see or sync it. Similarly, if a user manually creates a Doc in the folder via the Drive web UI, it won't appear.
- **Decision:** This is the correct trade-off — broader scopes (e.g., full `drive` scope) would expose the user's entire Drive to the plugin, which is unacceptable for trust. Document this limitation clearly in user-facing docs: only files created by the plugin are synced. Users who want to import an existing Google Doc into the sync should copy it into the synced folder using the plugin's UI (future enhancement) or recreate it from markdown.

### RISK 9: Multi-Device Sync (OUT OF SCOPE — MVP)
- **Problem:** Two Obsidian instances (e.g., laptop and phone) syncing to the same Drive folder creates a distributed consensus problem. Each device has its own index.json with its own state. Conflicting ancestor snapshots, duplicate pushes, and split-brain scenarios are likely.
- **Decision:** Multi-device via this plugin is **explicitly unsupported in MVP**. Document this clearly. Users who need multi-device should use Obsidian Sync or a separate Drive sync solution for the vault itself, with only one device running this plugin.

---

## Core Design Decisions

### 1. Sync Scope
- **Entire vault syncs automatically.** Every `.md` file in the vault gets a corresponding Google Doc.
- Non-markdown files (images, PDFs, etc.) are uploaded to Google Drive as-is without conversion.
- Non-markdown text files (.txt, .csv, .json, .yaml) are synced as raw files to Drive without conversion.
- `.canvas` files are **always skipped** (not synced).

### 2. Sync Direction
- **True two-way sync.** Both Obsidian and Google Docs are equal peers. Edits on either side propagate to the other.

### 3. Conflict Resolution
- **Three-way merge with user prompts for true conflicts.**
- The plugin stores a "common ancestor" snapshot of each file after every successful sync.
- On sync, the plugin compares: (a) the current Obsidian version, (b) the current Google Doc version, and (c) the ancestor snapshot.
- If only one side changed → apply that change to the other side.
- If both sides changed in non-overlapping regions → auto-merge.
- If both sides changed the same region → prompt the user with a diff view to choose or manually merge.
- Merge operations happen at the **markdown level** — the Google Doc is exported to markdown for diffing, then the resolved markdown is converted back and pushed.
- **Safety rule:** If the merged result is less than 80% of the length of the **longer** of the two inputs (local and remote), always prompt the user instead of auto-applying. (This is the "20% content-loss threshold" referenced elsewhere in this spec.)

### 4. Sync Timing
- **Hybrid:**
  - **Auto-push on file save** in Obsidian (debounced, e.g., 5-second delay after last keystroke).
  - **Configurable periodic pull** from Google Drive (default: every 5 minutes, user-configurable).
  - **Manual sync** available via ribbon button and command palette (`Sync Now`, `Pull from Google`, `Push to Google`).

### 5. Folder Structure
- **Mirrors vault folder structure in Google Drive.**
- User configures which Google Drive folder serves as the root (via folder picker in settings).
- Subfolders are created/maintained automatically to match the vault hierarchy.
- Empty folders in the vault are also synced to Drive.

### 6. Markdown ↔ Google Docs Conversion
- **Body content** is converted to native Google Docs formatting:
  - `# Heading` → Google Docs Heading 1, `## Heading` → Heading 2, etc.
  - `**bold**` → bold, `*italic*` → italic, `~~strikethrough~~` → strikethrough
  - `[link](url)` → hyperlink
  - `- item` / `1. item` → native bullet/numbered lists (nested supported)
  - `` `inline code` `` → monospace font
  - Code blocks (```) → monospace font with light gray background
  - `> blockquote` → indented paragraph with left border or indent styling
  - `---` → horizontal rule
  - Tables → Google Docs tables
  
- **Frontmatter** is preserved separately:
  - Stored as a **Google Docs document property** (custom metadata key: `obsidian_frontmatter`).
  - If frontmatter exceeds the property size limit (30KB), overflow is stored in continuation properties (`obsidian_frontmatter_1`, `obsidian_frontmatter_2`, etc.).
  - Frontmatter is **never visible** in the Google Doc body and **cannot be edited from Google Docs**. Document properties are not exposed in the Google Docs UI. Frontmatter (tags, aliases, dates, custom fields) is only editable in Obsidian. This must be documented clearly for users who collaborate with non-Obsidian users.
  - On sync back to Obsidian, frontmatter is restored from the document property.

- **Obsidian-specific syntax** is converted to best-effort equivalents:
  - `[[wikilink]]` → plain text "wikilink" (or a hyperlink if the target doc exists in Drive)
  - `[[wikilink|display text]]` → plain text "display text"
  - `![[embed]]` → plain text "(embedded: embed)"
  - `==highlight==` → highlighted text (yellow background) in Google Docs
  - `> [!note] Title` (callouts) → bold "Note: Title" followed by indented content
  - `> [!warning]`, `> [!tip]`, etc. → same pattern with appropriate label
  - Tags (`#tag`) → preserved as plain text

- **Reverse conversion** (Google Docs → Markdown):
  - Google Docs headings → `#` headings
  - Bold/italic/strikethrough → markdown equivalents
  - Hyperlinks → `[text](url)`
  - Bullet/numbered lists → `- ` / `1. ` with proper nesting
  - Tables → markdown tables
  - Monospace text → inline code or code blocks
  - Google Docs formatting without markdown equivalents (colored text, font changes, text alignment, inline images) → preserved as best-effort markdown. Use HTML `<span>` tags with inline styles where no markdown equivalent exists. Inline images added in Google Docs are represented as `<!-- gdocs-image: [image description] -->` comment placeholders.
  - Any content that cannot be cleanly round-tripped is preserved as-is in plain text.

- **Conversion failure handling:**
  - If conversion from markdown to Google Docs fails for a file, the raw markdown source is pushed as plain text content in the Google Doc.
  - The user is warned via a notice: "Conversion failed for 'Note Name' — synced as plain text."
  - The sync log records the failure with the error details.
  - The file is flagged in index.json (`conversionFailed: true`) so subsequent syncs can retry.

### 7. Authentication
- **Users create their own Google Cloud project.**
- Required APIs: Google Drive API v3, Google Docs API v1.
- OAuth 2.0 with scopes:
  - `https://www.googleapis.com/auth/drive.file` (manage files created by the app)
  - `https://www.googleapis.com/auth/documents` (read/write Google Docs)
- Plugin settings fields: `Client ID`, `Client Secret`.
- Auth flow: Plugin opens a browser window for Google consent → redirect to `http://localhost:<port>/callback` → plugin captures the auth code → exchanges for refresh + access tokens.
- Refresh token stored in `.gdocs-sync/auth.json` (encrypted at rest with a user-provided passphrase). OS keychain integration is a future enhancement.

### 8. File Lifecycle

#### Deletion
- **Note deleted in Obsidian** → corresponding Google Doc is moved to a `_Deleted from Obsidian` folder in the configured Drive root. The sync metadata entry is marked as deleted.
- **Google Doc deleted from Drive** → on next pull, the user is prompted with a notice: "The Google Doc for 'Note Name' was deleted from Drive. Delete the local note too?" with options: Yes / No / Ignore.

#### Renames & Moves
- **Synced automatically in both directions.**
- File identity is tracked by an internal UUID stored in `.gdocs-sync/index.json` and as a Google Doc property (`obsidian_sync_id`), not by file path.
- Rename in Obsidian → Google Doc title updated + Drive file renamed.
- Rename in Google Docs → local file renamed on next pull.
- Folder move in Obsidian → Drive file moved to corresponding folder.
- Folder move in Drive → local file moved to corresponding vault path.

### 9. Exclusions
The following are **never synced**:
- `.obsidian/` configuration folder
- Template folders (detected from Obsidian core plugin settings for Templates and Templater). If no template plugin is active, no template folder is excluded — do not fall back to a default folder name.
- Hidden files and folders (any path component starting with `.`)
- `.canvas` files (always excluded)
- User-defined exclusion patterns (glob syntax, configured in plugin settings)
  - Default exclusions: `*.excalidraw.md`, `*.canvas`
  - Setting: array of glob patterns in the plugin settings tab

### 10. Metadata Storage
All sync metadata lives in **`.gdocs-sync/`** at the vault root (a hidden folder, excluded from sync by the dotfile rule).

```
.gdocs-sync/
├── auth.json              # OAuth tokens (encrypted)
├── index.json             # Master mapping: sync_id → {localPath, driveFileId, googleDocId, lastSyncTimestamp, contentHash}
├── ancestors/             # Common ancestor snapshots for three-way merge
│   ├── <sync_id_1>.md
│   ├── <sync_id_2>.md
│   └── ...
└── sync.log               # Rolling sync log (last 1000 entries)
```

**`index.json` schema:**
```json
{
  "version": 1,
  "rootFolderId": "<google-drive-folder-id>",
  "deletedFolderId": "<google-drive-deleted-folder-id>",
  "driveChangeToken": "<startPageToken for incremental sync>",
  "files": {
    "<sync-uuid>": {
      "localPath": "folder/note.md",
      "driveFileId": "<drive-file-id>",
      "googleDocId": "<google-doc-id>",
      "lastSyncTimestamp": "2025-03-10T12:00:00Z",
      "localContentHash": "<sha256>",
      "remoteContentHash": "<sha256>",
      "isDirectory": false,
      "mimeType": "application/vnd.google-apps.document",
      "conversionFailed": false,
      "fileSizeBytes": 12345
    }
  },
  "folders": {
    "folder/subfolder": "<drive-folder-id>"
  }
}
```

### 11. UI

#### Ribbon Icon
- Sync icon (circular arrows) in the left ribbon.
- Click to trigger a full sync (push + pull).
- Visual states: idle (gray), syncing (spinning/animated), error (red dot badge), conflict (yellow dot badge), offline (dimmed).

#### Status Bar
- Bottom status bar item showing sync state:
  - "GDocs: Synced ✓" (idle, all synced)
  - "GDocs: Syncing..." (active sync)
  - "GDocs: 3 pending" (dirty files awaiting next sync)
  - "GDocs: 1 conflict" (needs user attention)
  - "GDocs: Error" (last sync failed)
  - "GDocs: Offline (5 pending)" (no internet, dirty files tracked in memory)

#### Sync Log
- Accessible from the command palette: `GDocs Sync: View Sync Log`
- Opens a modal or leaf panel showing the rolling log with timestamps, actions, and any errors.
- Log entries: `[timestamp] [action] [file] [result]`
  - Actions: PUSH, PULL, MERGE, CONFLICT, DELETE, RENAME, MOVE, ERROR, SKIP, CONVERSION_FAIL
- Log is stored in `.gdocs-sync/sync.log`, capped at 1000 entries (FIFO).

#### Conflict Resolution Modal
- When a true conflict is detected (both sides edited the same region):
  - Modal displays a side-by-side or unified diff.
  - Options: "Keep Obsidian Version", "Keep Google Docs Version", "Open in Editor" (dumps both versions for manual merge).
  - Selected resolution is applied and a new ancestor snapshot is saved.

#### Initial Sync Modal
- Shown on first plugin activation when vault already contains files.
- Options: "Push vault to Google Drive" / "Pull from Google Drive" / "Cancel".
- Includes file count and estimated time.
- Progress bar during initial sync with per-file status and cancel button.

#### Settings Tab
- **Google Cloud Credentials:** Client ID, Client Secret, Sign In / Sign Out button, auth status indicator.
- **Sync Root Folder:** Folder picker (browse Drive) or text input for folder ID.
- **Sync Interval:** Dropdown or number input for periodic pull interval (1, 2, 5, 10, 15, 30 minutes; or disabled).
- **Auto-push on save:** Toggle (default: on).
- **Push debounce delay:** Number input in seconds (default: 5).
- **Exclusion patterns:** Text area, one glob pattern per line.
- **Template folder detection:** Auto-detect from Obsidian settings or manual override.
- **Max file size:** Number input in MB (default: 5).
- **Advanced:** Debug logging toggle, max log entries, reset sync data button.

---

## Edge Cases & Behavioral Rules

### Offline Behavior
- When no internet connection is detected, sync attempts during polling intervals are silently skipped.
- Changes made locally while offline are tracked via the in-memory dirty-files set (populated by Obsidian vault events) and verified by hash comparison on the next successful sync cycle. No separate offline queue file is needed.
- If a manual sync is triggered while offline, display a notice: "No internet connection. Changes will sync when connectivity is restored."
- The status bar shows "GDocs: Offline" when the network is unavailable.

### First-Time Setup with Existing Vault
- On first activation, the plugin detects whether the vault contains existing files AND whether the configured Drive root folder contains existing Google Docs.
- Cases:
  - **Vault has files, Drive is empty:** Prompt "Push vault to Google Drive?" → yes initiates a full push.
  - **Vault is empty, Drive has files:** Prompt "Pull from Google Drive?" → yes initiates a full pull.
  - **Both have files:** Prompt user to choose direction: "Your vault and Google Drive both contain files. Which should be the source of truth for this initial sync?" Options: "Vault (push to Drive)" / "Google Drive (pull to vault)" / "Cancel".
  - **Both empty:** No prompt needed, plugin is ready.
- Initial sync is processed in batches of 50 files with a progress modal.

### Large File Handling
- Files larger than 5 MB (configurable) are skipped with a warning in the sync log and a notice to the user.
- The threshold is checked on both push and pull operations.
- Skipped files are recorded in index.json with `skippedReason: "size_exceeded"`.

### Rapid Successive Edits
- Only the final state is synced on the next sync cycle. Intermediate states are never captured.
- The debounce timer (default 5s) prevents rapid auto-pushes. Each new save resets the timer.
- If a file is renamed and then edited within the debounce window, both the rename and the content change are applied as a single sync operation.
- If a file is created and deleted within the debounce window, no sync operation occurs.

### Local Change Detection
- The plugin listens to Obsidian vault events (`vault.on('modify')`, `vault.on('create')`, `vault.on('delete')`, `vault.on('rename')`) and maintains an in-memory **dirty-files set** of paths that have changed since the last sync.
- On each periodic sync cycle, only files in the dirty set are hashed and compared — not the entire vault. This makes periodic sync O(changed files) instead of O(all files).
- A **full vault hash scan** is performed in these cases only:
  - On plugin startup (to catch changes made while the plugin was not running, e.g., via git, scripts, or other editors).
  - On manual sync (belt-and-suspenders — ensures nothing is missed).
- If a full scan finds a hash mismatch for a file not in the dirty set, the file is treated as locally modified and synced accordingly.

### Mid-Sync Race Condition
- Before pushing a file, the plugin takes a SHA-256 hash of the file contents ("pre-push snapshot").
- After the push completes successfully, the plugin re-hashes the file.
- If the hash has changed (user edited during push), the file is added to the dirty set for the next sync cycle.
- This avoids both file locking (bad UX) and optimistic concurrency (data loss risk).

### Google Docs Formatting Without Markdown Equivalents
- When a collaborator adds formatting in Google Docs that has no markdown equivalent (colored text, font changes, text alignment, inline images), the plugin preserves it as best-effort markdown:
  - Colored text → `<span style="color: #FF0000">text</span>` (HTML in markdown)
  - Text alignment (center/right) → HTML `<div>` or `<p>` with alignment
  - Font changes → generally discarded (markdown has no font concept) but logged
  - Inline images added in Google Docs → `<!-- gdocs-image: [image-id] -->` placeholder comment
- On the next push back to Google Docs, HTML spans are converted back to their Google Docs formatting equivalents.
- This is inherently lossy — document this clearly in user-facing docs.

### Rename Conflicts
- If a file is renamed on both sides to different names since the last sync:
  - The Google Docs **filename** takes precedence (since collaborators may have shared the link with the new name).
  - The user is notified: "Note 'old-name' was renamed to 'gdoc-name' (renamed in Google Docs). Your local name 'local-name' was overridden."
  - This is a pragmatic choice — revisit if users report issues.
- **Rename + move conflict:** If one side renames the file and the other side moves it to a different folder, both operations are applied independently. The result uses the remote filename and the local folder path (or vice versa, depending on which side did which). For example: local moves `notes/foo.md` → `archive/foo.md`, remote renames to "bar" → result is `archive/bar.md`.

### Folder Deletion
- If a vault folder is deleted and it contained synced files:
  - Each file in the folder is treated as individually deleted.
  - Corresponding Google Docs are moved to the `_Deleted from Obsidian` folder.
  - The Drive folder itself is also deleted (if empty after file moves).
- If a Drive folder is deleted:
  - All files that were in that folder are treated as individually deleted.
  - User is prompted for each file (batched into a single prompt if multiple files).

### Index Corruption Recovery
- If `index.json` is missing, corrupted, or unparseable:
  - The plugin rebuilds the index by scanning Drive for files with the `obsidian_sync_id` property.
  - Local files are matched by path and content hash.
  - Unmatched files are treated as new (prompted for direction).
  - A notice is shown: "Sync index was rebuilt. Please verify your files are in sync."

### Token Expiry and Re-authentication
- Access tokens are refreshed automatically using the refresh token before they expire.
- If the refresh token itself is revoked or expired (user revoked access in Google account):
  - All sync operations halt.
  - Status bar shows "GDocs: Auth Required".
  - A notice prompts the user to re-authenticate in settings.
  - Dirty files are tracked in memory and will sync after re-authentication.

---

## Technical Implementation Notes

### Platform
- **Language:** TypeScript
- **Build:** esbuild (standard Obsidian plugin toolchain)
- **Runtime:** Obsidian's Electron/Node.js environment
- **Google API client:** `requestUrl` (Obsidian's built-in HTTP client, preferred for cross-platform compatibility). Avoid `googleapis` npm package — it's large and designed for Node.js, not Electron.

### Key Dependencies
- `diff3` or `node-diff3` — three-way merge algorithm
- `unified` / `remark` / `rehype` — markdown parsing and AST manipulation for conversion
- `crypto` (Node built-in) — SHA-256 hashing for content change detection
- `micromatch` or `minimatch` — glob pattern matching for exclusions
- `gray-matter` — frontmatter parsing and serialization

### Sync Algorithm (Detailed)

```
function syncAll():
  0. Pre-flight checks:
     - Verify auth tokens are valid (refresh if needed)
     - Check network connectivity
     - If offline → skip (for timer-based sync) or notify (for manual sync)
     - Acquire sync lock (prevent concurrent syncs)

  1. Pull remote state:
     - Use Drive changes.list with stored startPageToken for incremental detection
     - For each changed file, fetch metadata (title, modifiedTime, properties)
     - Update driveChangeToken in index.json
     - Fallback: if no startPageToken, list all files in root folder (recursive)

  2. Compute local state:
     - Drain the in-memory dirty-files set (populated by vault events since last sync)
     - For timer-based sync: only hash files in the dirty set + check for deleted tracked files
     - For manual sync or startup: full vault hash scan (all tracked files)
     - For each file to check:
       a. Check if file still exists on disk
       b. Compute SHA-256 hash of current contents
       c. Compare hash to stored localContentHash → local changed?
     - Scan vault for new files not in index.json
     - Apply exclusion patterns to filter out ignored files

  3. Build operation plan (do NOT execute yet):
     For each file, determine action:
     - No changes on either side → SKIP
     - Only local changed → PUSH
     - Only remote changed → PULL
     - Both changed → MERGE
     - Local exists, not in index → NEW_LOCAL (create Google Doc)
     - Remote exists, not in index → NEW_REMOTE (create local file)
     - In index, not on disk → LOCAL_DELETE (move Google Doc to deleted folder)
     - In index, not in Drive → REMOTE_DELETE (prompt user)
     - Path changed locally (same sync_id) → LOCAL_RENAME
     - Title changed remotely (same sync_id) → REMOTE_RENAME

  4. Execute operations (in order):
     a. Folder operations first (create/rename/move/delete folders)
     b. File renames and moves
     c. New files (create)
     d. Content syncs (push/pull/merge)
     e. Deletions last

  5. For each PUSH operation:
     a. Snapshot file hash (pre-push hash)
     b. Read .md file, extract frontmatter
     c. Convert markdown → Google Docs format
     d. If conversion fails → push as plain text, flag as conversionFailed
     e. If existing doc: send a single atomic batchUpdate that deletes all content then inserts new content (no separate clear step — avoids empty-doc window on crash)
     f. If new doc: create via Drive API, then apply batchUpdate
     g. Store frontmatter as document property
     h. Re-hash local file (post-push hash)
     i. If post-push hash ≠ pre-push hash → add to dirty set for next sync cycle
     j. Update ancestor snapshot
     k. Update index.json entry

  6. For each PULL operation:
     a. Fetch Google Doc content via Docs API
     b. Convert Google Docs format → markdown
     c. Retrieve frontmatter from document property → prepend
     d. Write to .md file via Obsidian Vault API
     e. Update ancestor snapshot
     f. Update index.json entry

  7. For each MERGE operation:
     a. Export current Google Doc to markdown
     b. Load ancestor snapshot from .gdocs-sync/ancestors/
     c. If ancestor missing → treat entire file as conflict, prompt user
     d. Run three-way merge (ancestor, local, remote)
     e. If clean merge:
        - Validate: apply the 20% content-loss threshold (see Conflict Resolution safety rule) — if merged result is <80% length of the longer of the two inputs, prompt instead
        - Apply merged result to both sides (write local, push to Google Doc)
     f. If conflict → show conflict resolution modal, wait for user
     g. Update ancestor snapshot with resolved version
     h. Update index.json entry

  8. Post-sync:
     - Write index.json atomically (write temp, rename)
     - Write sync log entries
     - Update status bar
     - Release sync lock
```

### Markdown ↔ Google Docs Conversion Pipeline

```
PUSH (Obsidian → Google Docs):
  1. Read .md file
  2. Extract and remove frontmatter (gray-matter) → store separately
  3. Parse markdown to AST (remark/unified)
  4. Transform Obsidian-specific nodes:
     - Wikilinks → plain text or hyperlinks
     - Callouts → bold label + indented content
     - Embeds → placeholder text
     - Highlights → marked for highlight formatting
     - Tags → plain text
  5. Convert AST to Google Docs API batchUpdate request body:
     - Each AST node maps to insertText + updateTextStyle + updateParagraphStyle calls
     - Build requests in document order with correct indexing
  6. If new doc: create via Drive API, then apply batchUpdate
  7. If existing doc: send a single batchUpdate that deletes all body content (except the required trailing newline) then inserts the new content. This is atomic — no window where the doc is empty.
  8. Set document properties (frontmatter, sync_id)

PULL (Google Docs → Obsidian):
  1. Fetch Google Doc via Docs API (documents.get with full content)
  2. Walk the document body structure:
     - Paragraphs → check namedStyleType for heading level
     - TextRuns → check bold, italic, strikethrough, link, font
     - Lists → check bullet/listId/nestingLevel
     - Tables → iterate rows and cells
     - InlineObjectElements → image placeholders
  3. Convert to markdown AST (or build markdown string directly)
  4. Attempt to reconstruct Obsidian syntax:
     - Plain text matching wikilink patterns → restore [[wikilinks]] if target exists in vault
     - Highlighted text → ==highlight==
     - Callout-like patterns → restore > [!type] syntax
  5. Retrieve frontmatter from doc properties → prepend as YAML block
  6. Serialize to markdown string
  7. Write to .md file
```

### Rate Limiting & Performance
- Batch Drive API calls where possible (batch endpoint supports up to 100 calls per batch).
- Debounce rapid saves (configurable, default 5s).
- Serialize sync operations — never run concurrent syncs. Use a mutex/lock.
- Respect Google API quotas: Drive API (12,000 requests/min), Docs API (300 requests/min per user).
- For large vaults (1000+ files), use incremental sync via Drive change tokens (`changes.list` API with `startPageToken`).
- Hash computation for change detection: SHA-256 on all tracked files. For a 1000-file vault of text files, this takes well under 1 second.
- Initial sync: process in batches of 50 files with 1-second delay between batches to stay within rate limits.

### Error Handling
- Network errors → retry with exponential backoff (3 attempts: 1s, 4s, 16s), then skip file (dirty set preserves it for next cycle).
- Auth token expired → auto-refresh using refresh token. If refresh fails, halt sync and prompt re-auth.
- API quota exceeded → back off for 60 seconds, notify user via status bar, retry.
- HTTP 429 (rate limited) → respect Retry-After header.
- HTTP 5xx (server error) → retry with backoff.
- HTTP 404 (file not found) → treat as remote deletion.
- Corrupted index.json → rebuild from Drive file properties (`obsidian_sync_id`).
- Missing ancestor snapshot → fall back to prompting user for all conflicting regions.
- Conversion failure → push raw markdown as plain text, flag file, warn user.
- File write failure (disk full, permissions) → log error, skip file, continue with other files.
- index.json write → always atomic (write to `.gdocs-sync/index.json.tmp`, then rename).

---

## File Structure (Plugin Source)

```
obsidian-gdocs-sync/
├── manifest.json
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
├── jest.config.ts                   # Test configuration
├── src/
│   ├── main.ts                      # Plugin entry point, lifecycle hooks
│   ├── settings.ts                  # Settings tab UI and schema
│   ├── types.ts                     # Shared TypeScript interfaces and types
│   ├── constants.ts                 # Magic numbers, defaults, API URLs
│   ├── sync/
│   │   ├── engine.ts                # Core sync orchestrator
│   │   ├── planner.ts               # Builds operation plan from local + remote state
│   │   ├── executor.ts              # Executes planned operations in correct order
│   │   ├── index-manager.ts         # index.json read/write/query (atomic writes)
│   │   ├── change-detector.ts       # Hash-based local change detection
│   │   ├── merge.ts                 # Three-way merge logic
│   │   ├── dirty-tracker.ts          # In-memory dirty-files set (vault event listener)
│   │   ├── conflict-modal.ts        # Conflict resolution UI
│   │   └── sync-log.ts              # Sync log manager
│   ├── google/
│   │   ├── auth.ts                  # OAuth 2.0 flow, token management, encryption
│   │   ├── drive.ts                 # Drive API wrapper (CRUD files/folders, changes.list)
│   │   ├── docs.ts                  # Docs API wrapper (read/write doc content)
│   │   └── rate-limiter.ts          # Request queue with rate limit awareness
│   ├── conversion/
│   │   ├── md-to-gdoc.ts            # Markdown → Google Docs API request builder
│   │   ├── gdoc-to-md.ts            # Google Docs document → Markdown converter
│   │   ├── frontmatter.ts           # Frontmatter extraction/restoration via doc properties
│   │   ├── obsidian-syntax.ts       # Wikilink, callout, embed, highlight transformers
│   │   └── gdoc-formatting.ts       # Google Docs-only formatting → HTML-in-markdown preservation
│   ├── utils/
│   │   ├── hash.ts                  # SHA-256 hashing utility
│   │   ├── glob.ts                  # Glob pattern matching for exclusions
│   │   ├── atomic-write.ts          # Atomic file write (temp + rename)
│   │   └── network.ts               # Connectivity detection
│   └── ui/
│       ├── ribbon.ts                # Ribbon icon and states
│       ├── status-bar.ts            # Status bar item
│       ├── sync-log-modal.ts        # Sync log viewer modal
│       └── initial-sync-modal.ts    # First-time setup direction chooser + progress
├── tests/
│   ├── unit/
│   │   ├── conversion/
│   │   │   ├── md-to-gdoc.test.ts
│   │   │   ├── gdoc-to-md.test.ts
│   │   │   ├── frontmatter.test.ts
│   │   │   ├── obsidian-syntax.test.ts
│   │   │   ├── gdoc-formatting.test.ts
│   │   │   └── roundtrip.test.ts
│   │   ├── sync/
│   │   │   ├── planner.test.ts
│   │   │   ├── change-detector.test.ts
│   │   │   ├── merge.test.ts
│   │   │   ├── index-manager.test.ts
│   │   │   └── dirty-tracker.test.ts
│   │   ├── google/
│   │   │   ├── auth.test.ts
│   │   │   ├── rate-limiter.test.ts
│   │   │   └── drive.test.ts
│   │   └── utils/
│   │       ├── hash.test.ts
│   │       ├── glob.test.ts
│   │       └── atomic-write.test.ts
│   ├── integration/
│   │   ├── sync-engine.test.ts
│   │   ├── push-pull-cycle.test.ts
│   │   ├── conflict-resolution.test.ts
│   │   ├── deletion-lifecycle.test.ts
│   │   ├── rename-move.test.ts
│   │   └── initial-sync.test.ts
│   ├── fixtures/
│   │   ├── markdown/                # Sample .md files for conversion testing
│   │   │   ├── simple-note.md
│   │   │   ├── complex-formatting.md
│   │   │   ├── frontmatter-heavy.md
│   │   │   ├── wikilinks-and-embeds.md
│   │   │   ├── callouts.md
│   │   │   ├── code-blocks.md
│   │   │   ├── tables.md
│   │   │   ├── nested-lists.md
│   │   │   ├── mixed-content.md
│   │   │   ├── large-file.md
│   │   │   ├── unicode-and-emoji.md
│   │   │   ├── html-in-markdown.md
│   │   │   └── empty-file.md
│   │   ├── gdoc-responses/          # Sample Google Docs API response JSON
│   │   │   ├── simple-doc.json
│   │   │   ├── formatted-doc.json
│   │   │   ├── doc-with-images.json
│   │   │   ├── doc-with-colored-text.json
│   │   │   └── doc-with-tables.json
│   │   └── index/                   # Sample index.json states
│   │       ├── empty-index.json
│   │       ├── populated-index.json
│   │       └── corrupted-index.json
│   └── mocks/
│       ├── google-api.ts            # Mock Google Drive + Docs API responses
│       ├── obsidian-api.ts          # Mock Obsidian Vault, App, and Plugin APIs
│       └── filesystem.ts            # Mock file system for hash testing
├── styles.css                       # Plugin styles (conflict modal, etc.)
└── docs/
    ├── google-cloud-setup.md        # User-facing setup guide for GCP project
    ├── known-limitations.md         # Documented lossy conversions and unsupported features
    └── troubleshooting.md           # Common issues and recovery procedures
```

---

## Settings Schema

```typescript
interface GDocsSyncSettings {
  // Auth
  clientId: string;
  clientSecret: string;
  
  // Sync root
  rootFolderId: string;
  rootFolderName: string; // display only
  
  // Sync behavior
  syncIntervalMinutes: number;     // 0 = disabled, default: 5
  autoPushOnSave: boolean;         // default: true
  pushDebounceSeconds: number;     // default: 5
  
  // Exclusions
  exclusionPatterns: string[];     // glob patterns, default: ["*.excalidraw.md", "*.canvas"]
  
  // Limits
  maxFileSizeMB: number;           // default: 5
  
  // Advanced
  maxLogEntries: number;           // default: 1000
  enableDebugLogging: boolean;     // default: false
}
```

---

## Testing Strategy

### Philosophy
- **Conversion is the highest-risk module** — it gets the most exhaustive test coverage.
- **All tests must be runnable without Google API credentials** — mock all API calls.
- **Integration tests simulate full sync cycles** using an in-memory fake filesystem and mock API.
- **No tests should depend on network access or real Google accounts.**

### Test Framework
- **Jest** with TypeScript support via `ts-jest`.
- **Test structure:** mirrors `src/` directory structure under `tests/unit/`.
- **Mocking:** custom mocks for Obsidian API (`App`, `Vault`, `TFile`, `Notice`, etc.) and Google APIs.

### Unit Tests — Conversion Module

These are the most critical tests. Every conversion function must be tested for correctness AND round-trip stability.

#### `md-to-gdoc.test.ts`
```
Test cases:
- Empty document → empty Google Doc body
- Single paragraph of plain text
- Multiple paragraphs separated by blank lines
- Heading levels 1-6
- Bold text (**bold**)
- Italic text (*italic*)
- Bold + italic (***both***)
- Strikethrough (~~text~~)
- Inline code (`code`)
- Code block with language specifier (```js ... ```)
- Code block without language
- Unordered list (single level)
- Unordered list (nested 3 levels)
- Ordered list (single level)
- Ordered list (nested)
- Mixed ordered/unordered nested lists
- Hyperlink [text](url)
- Image reference ![alt](url) → plain text fallback
- Blockquote (single line)
- Blockquote (multi-line)
- Nested blockquote
- Horizontal rule (---)
- Simple table (2x2)
- Complex table (with formatting inside cells)
- Table with uneven columns
- Inline HTML tags preserved
- Unicode content (CJK, emoji, RTL text)
- Escaped markdown characters (\* \[ \] etc.)
- Very long paragraph (>10,000 characters)
- Document with only frontmatter and no body
- Document with empty lines between every element
```

#### `gdoc-to-md.test.ts`
```
Test cases:
- Empty Google Doc → empty markdown (or just frontmatter)
- Single paragraph plain text
- Paragraph with HEADING_1 through HEADING_6 named styles
- Text run with bold=true
- Text run with italic=true
- Text run with both bold and italic
- Text run with strikethrough=true
- Text run with monospace font (Courier New) → inline code
- Multiple consecutive monospace runs → code block detection
- Bulleted list (LIST_BULLET_1 through LIST_BULLET_3)
- Numbered list (LIST_NUMBER_1 through LIST_NUMBER_3)
- Mixed list types
- Hyperlink text run → [text](url)
- Table with headers
- Table with formatting inside cells
- Text with foreground color → <span style="color: ...">
- Text with highlight/background color → ==highlight== or <mark>
- Text with custom font (non-monospace) → discarded with log
- Center-aligned paragraph → <p style="text-align: center">
- Right-aligned paragraph → <p style="text-align: right">
- Inline image object → <!-- gdocs-image: [id] --> placeholder
- Page break element
- Footnotes
- Google Docs comments (should be stripped or preserved as HTML comments)
- Document with mixed formatting in a single paragraph
```

#### `roundtrip.test.ts`
```
For each fixture in fixtures/markdown/:
  1. Parse original markdown
  2. Convert to Google Docs format (md-to-gdoc)
  3. Convert back to markdown (gdoc-to-md)
  4. Assert:
     - Semantic equivalence (headings, bold, italic, links, lists match)
     - Acceptable drift documented (whitespace normalization, etc.)
     - No content loss (all text present in output)
     - Output length within 10% of input length (catch catastrophic drift)

Specific round-trip stability tests:
- Consecutive round-trips: md → gdoc → md → gdoc → md should stabilize (3rd round-trip = 2nd)
- Frontmatter survives round-trip intact (byte-for-byte)
- Wikilinks survive as plain text and don't accumulate extra formatting
- Code blocks survive (language specifier may be lost — documented)
- Tables survive (column alignment may drift — documented)
- Empty lines between elements are preserved (within tolerance)
```

#### `frontmatter.test.ts`
```
Test cases:
- Extract simple frontmatter (title, tags, date)
- Extract complex frontmatter (nested objects, arrays)
- Extract frontmatter with special characters (colons, quotes, unicode)
- Frontmatter with --- delimiters inside code blocks (should not confuse parser)
- Very large frontmatter (>30KB) → split across properties
- No frontmatter → empty string stored
- Frontmatter-only document (no body)
- Restore frontmatter from document property → exact match
- Restore split frontmatter (multiple properties) → exact match
- Malformed YAML in frontmatter → preserve raw string, warn
```

#### `obsidian-syntax.test.ts`
```
Test cases:
- [[simple-wikilink]] → "simple-wikilink"
- [[wikilink|display text]] → "display text"
- [[folder/nested-link]] → "nested-link"
- ![[embedded-note]] → "(embedded: embedded-note)"
- ![[image.png]] → "(embedded: image.png)"
- ==highlighted text== → highlighted text (with formatting)
- #tag → "#tag" plain text
- #nested/tag → "#nested/tag" plain text
- > [!note] Title\n> Content → "Note: Title\nContent" (bold label)
- > [!warning] → "Warning:" label
- > [!tip] → "Tip:" label
- > [!info] without title → "Info:" label
- > [!custom-type] → "Custom-type:" label
- Multiple wikilinks in one paragraph
- Wikilink inside bold/italic
- Callout with nested content (lists, code, etc.)
```

#### `gdoc-formatting.test.ts`
```
Test cases:
- Colored text → <span style="color: ...">text</span>
- Multiple colors in one paragraph
- Center-aligned text → appropriate HTML
- Right-aligned text → appropriate HTML
- Custom font text → discarded (logged)
- Inline image → <!-- gdocs-image: ... --> comment
- Combined: colored + bold + italic text
- Reverse: HTML span with color → Google Docs colored text run
- Reverse: HTML comment image placeholder → ignored (not converted back to image)
```

### Unit Tests — Sync Module

#### `planner.test.ts`
```
Test cases:
- All files unchanged → empty plan
- One file changed locally only → single PUSH operation
- One file changed remotely only → single PULL operation
- One file changed on both sides → MERGE operation
- New local file not in index → NEW_LOCAL operation
- New remote file not in index → NEW_REMOTE operation
- File in index but not on disk → LOCAL_DELETE operation
- File in index but not in Drive → REMOTE_DELETE operation
- File renamed locally (same sync_id, different path) → LOCAL_RENAME
- File renamed remotely (same sync_id, different title) → REMOTE_RENAME
- File renamed on both sides to different names → REMOTE_RENAME wins
- File moved to different folder locally → LOCAL_MOVE
- File moved to different folder in Drive → REMOTE_MOVE
- Mix of 10 different operations in one sync → correct plan
- Excluded file (matches glob) → SKIP
- .canvas file → SKIP
- Hidden file/folder → SKIP
- File > 5 MB → SKIP with size_exceeded reason
- Operation ordering: folders before files, renames before content, deletes last
```

#### `change-detector.test.ts`
```
Test cases:
- File unchanged (hash matches) → no change
- File content modified → change detected
- File modified outside Obsidian (same result — hash-based)
- File permissions changed but content same → no change
- New file not in index → detected as new
- File deleted from disk → detected as deleted
- File with same content but different mtime → no change (hash-based, not time-based)
- Empty file → valid hash, no false positive
- Binary file → valid hash
- Hash computation on large file (5 MB) → completes in reasonable time
- Concurrent hash computation (many files) → all correct
```

#### `merge.test.ts`
```
Test cases:
- Only local changed → local version wins (no merge needed)
- Only remote changed → remote version wins (no merge needed)
- Both changed, non-overlapping regions → clean auto-merge
- Both changed, same line → conflict detected
- Both made identical change → clean merge (no conflict)
- Local added lines, remote deleted different lines → clean merge
- Local deleted lines, remote added lines in deleted region → conflict
- Both added content at end of file → clean merge (appended)
- Both added content at same position → conflict
- Ancestor is empty (new file synced, then both edited) → full conflict
- Ancestor is missing → all regions treated as conflict
- Merge result is <80% length of larger input → flagged for user review
- Merge preserves frontmatter from local (frontmatter is never merged line-by-line)
- Very large file merge (>5000 lines) → completes in reasonable time
- Merge with unicode content → correct
- Merge with trailing newline differences → handled gracefully
```

#### `index-manager.test.ts`
```
Test cases:
- Create new index (first run)
- Add file entry
- Update file entry
- Remove file entry
- Look up file by sync_id
- Look up file by localPath
- Look up file by driveFileId
- Update driveChangeToken
- Atomic write: verify temp file is created then renamed
- Atomic write: original preserved if write fails mid-way
- Load corrupted index → error thrown, triggering rebuild
- Load v1 index → correct parsing
- Index with 10,000 entries → read/write performance acceptable (<100ms)
- Concurrent read during write → no partial reads (atomic)
- Add folder mapping
- Remove folder mapping
- Query: find all files in a specific folder
- Query: find all files with conversionFailed=true
```

#### `dirty-tracker.test.ts`
```
Test cases:
- Vault modify event → file added to dirty set
- Vault create event → file added to dirty set
- Vault delete event → file added to dirty set (with deleted flag)
- Vault rename event → old path marked deleted, new path marked dirty
- Multiple edits to same file → only one entry in dirty set
- Drain dirty set → returns all dirty paths and clears the set
- Drain returns empty set when nothing changed
- Exclusion patterns respected — excluded file events are ignored
- Hidden files (dotfiles) events are ignored
```

### Unit Tests — Google Module

#### `auth.test.ts`
```
Test cases:
- Generate auth URL with correct scopes and redirect
- Exchange auth code for tokens (mock HTTP)
- Refresh expired access token
- Handle refresh token revocation → throw specific error
- Encrypt tokens at rest
- Decrypt tokens from disk
- Invalid passphrase → decryption fails gracefully
- Token file missing → throw specific error
- Token file corrupted → throw specific error
```

#### `rate-limiter.test.ts`
```
Test cases:
- Single request → passes through immediately
- Burst of 300 requests → queued and throttled to respect limit
- HTTP 429 response → retry after specified delay
- HTTP 429 with Retry-After header → respect the header value
- Concurrent requests from different sync operations → properly serialized
- Queue drain: all requests eventually complete
- Cancel pending requests → cancelled requests don't execute
```

#### `drive.test.ts` (with mocked HTTP)
```
Test cases:
- Create file → correct API call, returns file ID
- Create folder → correct API call with folder MIME type
- List files in folder → paginated response handling
- Get file metadata → correct fields requested
- Update file metadata (rename) → correct API call
- Move file to different folder → correct parent update
- Delete file (move to trash) → correct API call
- Get changes since token → correct startPageToken usage
- Handle paginated changes response (multiple pages)
- Batch API call → correct multipart request format
- Handle 404 → throw FileNotFound
- Handle 403 → throw PermissionDenied
```

### Unit Tests — Utils

#### `hash.test.ts`
```
Test cases:
- Hash empty string → known SHA-256 value
- Hash simple string → correct hash
- Hash unicode content → correct hash
- Hash large content (5 MB) → completes in <100ms
- Same content → same hash (deterministic)
- Different content → different hash
```

#### `glob.test.ts`
```
Test cases:
- *.excalidraw.md matches "note.excalidraw.md"
- *.excalidraw.md does not match "note.md"
- *.canvas matches "board.canvas"
- drafts/* matches "drafts/note.md"
- drafts/* does not match "published/note.md"
- **/*.tmp matches "deep/nested/file.tmp"
- Multiple patterns: match if any pattern matches
- Empty patterns array → nothing excluded
- Pattern with special characters
```

#### `atomic-write.test.ts`
```
Test cases:
- Write succeeds → file contains correct content, no temp file remains
- Write fails mid-stream → original file preserved, temp file cleaned up
- Target directory does not exist → error thrown
- Concurrent writes → last writer wins, no corruption
```

### Integration Tests

These tests use a mock filesystem and mock Google API to simulate complete sync cycles.

#### `sync-engine.test.ts`
```
Scenarios:
- Fresh install, empty vault, empty Drive → no operations
- Fresh install, vault with 5 files, empty Drive → 5 PUSH operations
- Fresh install, empty vault, Drive with 5 docs → 5 PULL operations
- Fresh install, both have files → prompt for direction
- Steady-state: no changes → no operations, quick return
- Steady-state: one local edit → one PUSH
- Steady-state: one remote edit → one PULL
- Steady-state: different files changed on each side → parallel PUSH + PULL
- Steady-state: same file changed on both sides, non-overlapping → auto-merge
- Steady-state: same file changed on both sides, conflicting → conflict modal shown
- Sync lock: second sync attempt while first is running → skipped (dirty set preserves changes for next cycle)
- Error during sync: one file fails, others succeed → partial sync, error logged
- Network failure mid-sync → dirty set preserved, status bar updated
```

#### `push-pull-cycle.test.ts`
```
Scenarios:
- Push a simple note → verify Google Doc has correct content and formatting
- Pull a simple doc → verify .md file has correct content
- Push then pull same file → file is unchanged (round-trip)
- Push note with frontmatter → frontmatter in doc property, not in body
- Pull doc with frontmatter property → frontmatter prepended to .md
- Push note with wikilinks → converted to plain text in doc
- Push note with code blocks → monospace in doc
- Pull doc with colored text → HTML spans in markdown
- Push file > 5 MB → skipped with warning
- Push .canvas file → skipped (excluded)
```

#### `conflict-resolution.test.ts`
```
Scenarios:
- Auto-merge succeeds → both sides updated, no modal
- Auto-merge would delete >20% → modal shown instead
- User chooses "Keep Obsidian Version" → remote overwritten
- User chooses "Keep Google Docs Version" → local overwritten
- User chooses "Open in Editor" → both versions dumped to temp files
- Conflict on file with no ancestor → full file treated as conflict
- Conflict resolution updates ancestor snapshot
- Multiple files in conflict → modal shown for each sequentially
```

#### `deletion-lifecycle.test.ts`
```
Scenarios:
- Delete note in Obsidian → Google Doc moved to _Deleted folder
- Delete Google Doc → user prompted, says Yes → local note deleted
- Delete Google Doc → user prompted, says No → local note kept, index entry removed
- Delete Google Doc → user prompted, says Ignore → no action, won't prompt again
- Delete entire folder in Obsidian → all files moved, Drive folder deleted
- Delete folder in Drive → user prompted for each file (batched)
- Delete file that was already flagged as conversionFailed → normal deletion
- Re-create file with same name after deletion → treated as new file (new sync_id)
```

#### `rename-move.test.ts`
```
Scenarios:
- Rename note in Obsidian → Google Doc title updated
- Rename Google Doc → local file renamed
- Move note to subfolder in Obsidian → Drive file moved
- Move file in Drive → local file moved
- Rename on both sides to same name → no conflict
- Rename on both sides to different names → remote wins, user notified
- Move to folder that doesn't exist yet in Drive → folder created first
- Rename + edit in same sync cycle → both applied
- Move + edit in same sync cycle → both applied
```

#### `initial-sync.test.ts`
```
Scenarios:
- User chooses "Push vault" → all local files pushed, progress bar shown
- User chooses "Pull from Drive" → all remote files pulled
- User cancels initial sync → no changes made
- Initial sync interrupted (network failure at file 25 of 100) → partial sync, can resume
- Resume interrupted initial sync → picks up where it left off
- Initial sync of vault with 1000 files → batched correctly, rate limits respected
```

### Testing Utilities & Mocks

#### `mocks/google-api.ts`
```typescript
// Provides:
// - MockDriveAPI: simulates Drive file/folder CRUD with in-memory state
//   - Tracks files, folders, metadata, properties
//   - Simulates changes.list with page tokens
//   - Configurable error injection (network, rate limit, 404, 403)
//   - Request counting for rate limit testing
// - MockDocsAPI: simulates Docs read/write with in-memory documents
//   - Stores document structure matching real API response format
//   - Supports batchUpdate simulation
//   - Supports documents.get with full body
//   - Configurable error injection
```

#### `mocks/obsidian-api.ts`
```typescript
// Provides:
// - MockApp: minimal App interface
// - MockVault: in-memory vault with file CRUD
//   - read(), create(), modify(), delete(), rename()
//   - getMarkdownFiles(), getAbstractFileByPath()
//   - Event emission for file changes
// - MockTFile, MockTFolder: file/folder stubs
// - MockNotice: captures notice messages for assertion
// - MockPlugin: minimal plugin lifecycle
// - MockPluginSettingTab: settings mock
```

#### `mocks/filesystem.ts`
```typescript
// Provides:
// - MockFileSystem: in-memory filesystem for .gdocs-sync/ operations
//   - read, write, exists, delete, rename
//   - Supports atomic write simulation
//   - Can simulate disk errors (full, permission denied)
```

### Test Fixtures

Each fixture file in `tests/fixtures/markdown/` represents a specific testing scenario:

- `simple-note.md`: Plain paragraphs, one heading, one bold word. Baseline sanity test.
- `complex-formatting.md`: Every markdown formatting feature combined in one file.
- `frontmatter-heavy.md`: Large YAML frontmatter with nested objects, arrays, and special characters.
- `wikilinks-and-embeds.md`: Dense wikilinks, display-text links, image embeds, note embeds.
- `callouts.md`: Every callout type (note, warning, tip, info, custom) with nested content.
- `code-blocks.md`: Multiple languages, nested code in lists, inline code edge cases.
- `tables.md`: Simple table, wide table, table with formatting in cells, table with empty cells.
- `nested-lists.md`: 4-level deep nesting, mixed ordered/unordered, list with paragraphs between items.
- `mixed-content.md`: Realistic note with headings, text, lists, code, tables, links, callouts combined.
- `large-file.md`: ~4 MB file for performance testing.
- `unicode-and-emoji.md`: CJK characters, emoji, RTL text, accented characters, mathematical symbols.
- `html-in-markdown.md`: Inline HTML tags, <details> blocks, HTML comments.
- `empty-file.md`: Completely empty file (0 bytes).

---

## Google Cloud Project Setup (User Guide Summary)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g., "Obsidian GDocs Sync")
3. Enable APIs: Google Drive API, Google Docs API
4. Configure OAuth consent screen (External, testing mode is fine for personal use)
   - Add scopes: `drive.file` and `documents`
   - Add your own email as a test user
5. Create OAuth 2.0 credentials (Desktop application type)
6. Copy Client ID and Client Secret into the plugin settings
7. Click "Sign In" in the plugin — browser opens for Google consent
8. Grant permissions and return to Obsidian

**Note:** In "testing" mode, Google limits to 100 test users and tokens expire every 7 days. For personal use this is fine — just re-authenticate when prompted. To avoid this, publish the app (requires Google verification for sensitive scopes).

---

## Implementation Priority & Build Order

The modules should be built and tested in this order. Each phase produces a testable deliverable before the next phase begins.

### Phase 1: Foundation (Week 1-2)
**Goal:** Plugin skeleton, auth, and basic Drive operations.

1. **Plugin scaffold:** manifest.json, package.json, esbuild config, tsconfig, Jest setup
2. **Types and constants:** All shared interfaces, API URLs, defaults
3. **Settings UI:** Settings tab with credential fields and basic toggles
4. **OAuth flow (auth.ts):** Login, token exchange, refresh, encrypted storage
5. **Drive API wrapper (drive.ts):** Create/list/update/delete files and folders
6. **Rate limiter (rate-limiter.ts):** Request queue with throttling

**Tests:** auth.test.ts, rate-limiter.test.ts, drive.test.ts
**Deliverable:** Plugin that can authenticate and list files in a Drive folder.

### Phase 2: Conversion Engine (Week 3-5)
**Goal:** Reliable markdown ↔ Google Docs conversion. This is the hardest phase.

1. **Frontmatter handling (frontmatter.ts):** Extract, store, restore
2. **Obsidian syntax transforms (obsidian-syntax.ts):** Wikilinks, callouts, embeds, highlights
3. **Markdown → Google Docs (md-to-gdoc.ts):** Full conversion pipeline
4. **Docs API wrapper (docs.ts):** Read and write document content
5. **Google Docs → Markdown (gdoc-to-md.ts):** Full reverse pipeline
6. **Google Docs formatting preservation (gdoc-formatting.ts):** Colored text, alignment → HTML

**Tests:** All conversion unit tests, round-trip tests
**Deliverable:** Standalone conversion functions that pass all round-trip tests.

### Phase 3: Core Sync (Week 6-8)
**Goal:** One-way push and pull working end-to-end.

1. **Hash utility (hash.ts):** SHA-256 for change detection
2. **Glob utility (glob.ts):** Exclusion pattern matching
3. **Index manager (index-manager.ts):** CRUD operations with atomic writes
4. **Change detector (change-detector.ts):** Local hash comparison
5. **Dirty tracker (dirty-tracker.ts):** Vault event listener, in-memory dirty-files set
6. **Sync planner (planner.ts):** Build operation plan from state comparison
7. **Sync executor (executor.ts):** Execute planned operations in correct order
8. **Sync engine (engine.ts):** Orchestrate full sync cycle (push + pull)
9. **Ribbon icon and status bar:** Basic UI feedback

**Tests:** planner.test.ts, change-detector.test.ts, dirty-tracker.test.ts, index-manager.test.ts, push-pull-cycle.test.ts
**Deliverable:** Working one-directional sync (push local changes, pull remote changes, but not yet handling conflicts).

### Phase 4: Two-Way Sync & Conflict Resolution (Week 9-11)
**Goal:** Full two-way sync with three-way merge.

1. **Merge module (merge.ts):** Three-way diff and merge algorithm
2. **Conflict resolution modal (conflict-modal.ts):** Side-by-side diff UI
3. **Ancestor snapshot management:** Save/load/cleanup ancestor files
4. **Mid-sync race condition handling:** Snapshot + compare pattern
5. **Sync engine updates:** Integrate merge into sync cycle

**Tests:** merge.test.ts, conflict-resolution.test.ts, sync-engine.test.ts
**Deliverable:** Full two-way sync with auto-merge and conflict prompts.

### Phase 5: File Lifecycle & Edge Cases (Week 12-13)
**Goal:** Deletion, renames, moves, and all edge case handling.

1. **Deletion handling:** Move to deleted folder, prompt on remote deletion
2. **Rename/move sync:** UUID-based identity tracking, both directions
3. **Initial sync modal:** Direction chooser, progress bar, batch processing
4. **Offline handling:** Network detection, dirty-set preservation
5. **Large file skip logic:** Size threshold check
6. **Conversion failure fallback:** Plain text push with warning
7. **Index recovery:** Rebuild from Drive properties

**Tests:** deletion-lifecycle.test.ts, rename-move.test.ts, initial-sync.test.ts, dirty-tracker.test.ts
**Deliverable:** Complete, production-ready sync with all edge cases handled.

### Phase 6: Polish & Documentation (Week 14)
**Goal:** Sync log, docs, and final hardening.

1. **Sync log (sync-log.ts):** Rolling log with FIFO cap
2. **Sync log modal (sync-log-modal.ts):** Viewer UI
3. **Atomic write utility (atomic-write.ts):** Harden all file writes
4. **Network utility (network.ts):** Connectivity detection
5. **User documentation:** Google Cloud setup guide, known limitations, troubleshooting
6. **Final integration testing:** Full sync-engine.test.ts suite

**Deliverable:** v0.1 release candidate.

### Timeline Note
The above timeline is aspirational. Phase 2 (conversion engine) is identified as the highest-risk module in the risk register and may take significantly longer than 3 weeks due to round-trip fidelity challenges. Plan conservatively — 18-22 weeks total is more realistic for a solo developer.

---

## MVP Scope vs Future Enhancements

### MVP (v0.1)
- Google OAuth setup and token management
- Full vault sync (push and pull)
- Markdown → Google Docs native formatting conversion
- Google Docs → Markdown reverse conversion
- Frontmatter preservation via document properties
- Folder structure mirroring (including empty folders)
- Auto-push on save (debounced)
- Periodic pull on configurable timer
- Manual sync via ribbon button and command palette
- Three-way merge with conflict detection
- Conflict resolution modal (keep local / keep remote / open in editor)
- File deletion handling (move to deleted folder / prompt)
- Rename/move sync via UUID tracking
- Exclusion patterns (glob-based)
- .canvas file exclusion
- Non-markdown file upload to Drive (raw, no conversion)
- Status bar indicator with all states
- Sync log (accessible from command palette)
- Initial sync direction chooser with progress bar
- Event-driven local change detection with full hash scan on startup
- Large file skip with configurable threshold
- Conversion failure fallback (plain text push)
- Index corruption recovery
- Mid-sync edit protection (snapshot + compare)
- Google Docs-only formatting preserved as HTML in markdown

### Explicitly Out of Scope for MVP
- Multi-device Obsidian sync via this plugin (document as unsupported)
- OS keychain integration for token storage
- Shared/bundled OAuth credentials
- Real-time collaborative awareness
- Bidirectional image embedding
- Google Doc comments ↔ Obsidian integration

### Future (v0.2+)
- Wikilinks converted to actual Drive hyperlinks between synced docs
- Image embedding in Google Docs (inline images from vault)
- Real-time collaborative awareness (show when a Doc is being edited)
- Selective sync (per-folder or per-tag opt-out)
- Shared plugin credentials option for easier onboarding
- OS keychain integration for token storage (macOS Keychain, Windows Credential Manager)
- Multi-device support with distributed index via Drive
- Google Doc comments ↔ Obsidian comments plugin integration
- Support for Google Workspace shared drives
- Dataview query results rendering in Google Docs
- Community plugin marketplace listing
