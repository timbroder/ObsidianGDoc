// ============================================================
// Settings
// ============================================================

export interface GDocsSyncSettings {
  clientId: string;
  clientSecret: string;
  rootFolderId: string;
  rootFolderName: string;
  syncIntervalMinutes: number;
  autoPushOnSave: boolean;
  pushDebounceSeconds: number;
  exclusionPatterns: string[];
  maxFileSizeMB: number;
  maxLogEntries: number;
  enableDebugLogging: boolean;
}

export const DEFAULT_SETTINGS: GDocsSyncSettings = {
  clientId: "",
  clientSecret: "",
  rootFolderId: "",
  rootFolderName: "",
  syncIntervalMinutes: 5,
  autoPushOnSave: true,
  pushDebounceSeconds: 5,
  exclusionPatterns: ["*.excalidraw.md", "*.canvas"],
  maxFileSizeMB: 5,
  maxLogEntries: 1000,
  enableDebugLogging: false,
};

// ============================================================
// Index
// ============================================================

export interface SyncIndex {
  version: number;
  rootFolderId: string;
  deletedFolderId: string;
  driveChangeToken: string;
  files: Record<string, SyncFileEntry>;
  folders: Record<string, string>;
}

export interface SyncFileEntry {
  localPath: string;
  driveFileId: string;
  googleDocId: string;
  lastSyncTimestamp: string;
  localContentHash: string;
  remoteContentHash: string;
  isDirectory: boolean;
  mimeType: string;
  conversionFailed: boolean;
  fileSizeBytes: number;
  skippedReason?: string;
}

export function createEmptyIndex(): SyncIndex {
  return {
    version: 1,
    rootFolderId: "",
    deletedFolderId: "",
    driveChangeToken: "",
    files: {},
    folders: {},
  };
}

// ============================================================
// Sync Operations
// ============================================================

export type SyncOperationType =
  | "SKIP"
  | "PUSH"
  | "PULL"
  | "MERGE"
  | "NEW_LOCAL"
  | "NEW_REMOTE"
  | "LOCAL_DELETE"
  | "REMOTE_DELETE"
  | "LOCAL_RENAME"
  | "REMOTE_RENAME"
  | "LOCAL_MOVE"
  | "REMOTE_MOVE";

export interface SyncOperation {
  type: SyncOperationType;
  syncId: string;
  localPath: string;
  remotePath?: string;
  newPath?: string;
}

export interface SyncPlan {
  operations: SyncOperation[];
  timestamp: string;
}

// ============================================================
// Sync Log
// ============================================================

export type SyncLogAction =
  | "PUSH"
  | "PULL"
  | "MERGE"
  | "CONFLICT"
  | "DELETE"
  | "RENAME"
  | "MOVE"
  | "ERROR"
  | "SKIP"
  | "CONVERSION_FAIL";

export interface SyncLogEntry {
  timestamp: string;
  action: SyncLogAction;
  file: string;
  result: string;
  details?: string;
}

// ============================================================
// Google API types
// ============================================================

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime: string;
  properties?: Record<string, string>;
  size?: string;
}

export interface DriveChangeList {
  changes: DriveChange[];
  newStartPageToken: string;
  nextPageToken?: string;
}

export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveFile;
  time: string;
}

export interface GoogleDocBody {
  content: GoogleDocStructuralElement[];
}

export interface GoogleDoc {
  documentId: string;
  title: string;
  body: GoogleDocBody;
  documentStyle?: any;
  namedStyles?: any;
  lists?: Record<string, GoogleDocList>;
  inlineObjects?: Record<string, any>;
}

export interface GoogleDocStructuralElement {
  startIndex: number;
  endIndex: number;
  paragraph?: GoogleDocParagraph;
  table?: GoogleDocTable;
  sectionBreak?: any;
}

export interface GoogleDocParagraph {
  elements: GoogleDocParagraphElement[];
  paragraphStyle: GoogleDocParagraphStyle;
  bullet?: GoogleDocBullet;
}

export interface GoogleDocParagraphElement {
  startIndex: number;
  endIndex: number;
  textRun?: GoogleDocTextRun;
  inlineObjectElement?: { inlineObjectId: string };
}

export interface GoogleDocTextRun {
  content: string;
  textStyle: GoogleDocTextStyle;
}

export interface GoogleDocTextStyle {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  link?: { url: string };
  weightedFontFamily?: { fontFamily: string };
  foregroundColor?: {
    color: { rgbColor: { red?: number; green?: number; blue?: number } };
  };
  backgroundColor?: {
    color: { rgbColor: { red?: number; green?: number; blue?: number } };
  };
  fontSize?: { magnitude: number; unit: string };
}

export interface GoogleDocParagraphStyle {
  namedStyleType: string;
  alignment?: "START" | "CENTER" | "END" | "JUSTIFIED";
  indentFirstLine?: { magnitude: number; unit: string };
  indentStart?: { magnitude: number; unit: string };
}

export interface GoogleDocBullet {
  listId: string;
  nestingLevel: number;
}

export interface GoogleDocList {
  listProperties: {
    nestingLevels: GoogleDocNestingLevel[];
  };
}

export interface GoogleDocNestingLevel {
  bulletAlignment?: string;
  glyphType?: string;
  glyphFormat?: string;
  indentFirstLine?: { magnitude: number; unit: string };
  indentStart?: { magnitude: number; unit: string };
  startNumber?: number;
}

export interface GoogleDocTable {
  rows: number;
  columns: number;
  tableRows: GoogleDocTableRow[];
}

export interface GoogleDocTableRow {
  startIndex: number;
  endIndex: number;
  tableCells: GoogleDocTableCell[];
}

export interface GoogleDocTableCell {
  startIndex: number;
  endIndex: number;
  content: GoogleDocStructuralElement[];
}

// ============================================================
// Google Docs API Request Types (batchUpdate)
// ============================================================

export interface BatchUpdateRequest {
  requests: DocRequest[];
}

export type DocRequest =
  | { insertText: { text: string; location: { index: number } } }
  | { deleteContentRange: { range: { startIndex: number; endIndex: number } } }
  | {
      updateTextStyle: {
        textStyle: Partial<GoogleDocTextStyle>;
        range: { startIndex: number; endIndex: number };
        fields: string;
      };
    }
  | {
      updateParagraphStyle: {
        paragraphStyle: Partial<GoogleDocParagraphStyle>;
        range: { startIndex: number; endIndex: number };
        fields: string;
      };
    }
  | {
      insertTable: {
        rows: number;
        columns: number;
        location: { index: number };
      };
    }
  | {
      createParagraphBullets: {
        range: { startIndex: number; endIndex: number };
        bulletPreset: string;
      };
    };

// ============================================================
// Dirty Tracker
// ============================================================

export interface DirtyFileEntry {
  path: string;
  type: "modify" | "create" | "delete" | "rename";
  oldPath?: string;
  timestamp: number;
}

// ============================================================
// Conflict Resolution
// ============================================================

export type ConflictResolution =
  | "keep-local"
  | "keep-remote"
  | "open-in-editor";

// ============================================================
// Sync Status
// ============================================================

export type SyncStatus =
  | "idle"
  | "syncing"
  | "error"
  | "conflict"
  | "offline"
  | "auth-required";
