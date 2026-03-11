// Google API endpoints
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

export const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
export const DOCS_API_BASE = "https://docs.googleapis.com/v1";

// OAuth scopes
export const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/documents",
];

export const OAUTH_REDIRECT_PORT_RANGE = { min: 49152, max: 65535 };

// Rate limits
export const DRIVE_API_RATE_LIMIT = 12000; // requests per minute
export const DOCS_API_RATE_LIMIT = 300; // requests per minute per user
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_BACKOFF_MS = 60_000;

// Sync
export const SYNC_BATCH_SIZE = 50;
export const SYNC_BATCH_DELAY_MS = 1000;
export const DEFAULT_DEBOUNCE_MS = 5000;
export const CONTENT_LOSS_THRESHOLD = 0.8; // prompt if merged < 80% of longer input

// Retry
export const MAX_RETRIES = 3;
export const RETRY_DELAYS_MS = [1000, 4000, 16000];

// File limits
export const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_FRONTMATTER_PROPERTY_SIZE = 30_000; // ~30KB per doc property

// Metadata
export const SYNC_DIR = ".gdocs-sync";
export const INDEX_FILE = "index.json";
export const INDEX_TMP_FILE = "index.json.tmp";
export const AUTH_FILE = "auth.json";
export const SYNC_LOG_FILE = "sync.log";
export const ANCESTORS_DIR = "ancestors";
export const DEFAULT_MAX_LOG_ENTRIES = 1000;

// Google Doc properties
export const DOC_PROPERTY_SYNC_ID = "obsidian_sync_id";
export const DOC_PROPERTY_FRONTMATTER = "obsidian_frontmatter";
export const DOC_PROPERTY_FRONTMATTER_PREFIX = "obsidian_frontmatter_";

// Drive
export const DELETED_FOLDER_NAME = "_Deleted from Obsidian";
export const GOOGLE_DOC_MIME_TYPE = "application/vnd.google-apps.document";
export const GOOGLE_FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";

// Exclusions
export const ALWAYS_EXCLUDED_PATTERNS = [
  ".obsidian/**",
  ".*/**",
  ".*",
  "*.canvas",
];

// Conversion
export const MONOSPACE_FONTS = [
  "Courier New",
  "Courier",
  "Consolas",
  "Monaco",
  "Menlo",
  "monospace",
];
export const CODE_BLOCK_BG_COLOR = { red: 0.95, green: 0.95, blue: 0.95 };
export const HIGHLIGHT_BG_COLOR = { red: 1, green: 1, blue: 0 };

// Callout types
export const CALLOUT_TYPES = [
  "note",
  "warning",
  "tip",
  "info",
  "danger",
  "bug",
  "example",
  "quote",
  "abstract",
  "todo",
  "success",
  "question",
  "failure",
  "important",
  "caution",
];
