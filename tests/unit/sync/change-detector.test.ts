import { ChangeDetector } from "@/sync/change-detector";
import { IndexManager } from "@/sync/index-manager";
import { SyncFileEntry } from "@/types";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { sha256 } from "@/utils/hash";

describe("ChangeDetector", () => {
  let tmpDir: string;
  let indexManager: IndexManager;
  let detector: ChangeDetector;

  const makeEntry = (overrides: Partial<SyncFileEntry> = {}): SyncFileEntry => ({
    localPath: "test.md",
    driveFileId: "drive-123",
    googleDocId: "doc-123",
    lastSyncTimestamp: "2025-01-01T00:00:00Z",
    localContentHash: sha256("original content"),
    remoteContentHash: "abc",
    isDirectory: false,
    mimeType: "application/vnd.google-apps.document",
    conversionFailed: false,
    fileSizeBytes: 100,
    ...overrides,
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-test-"));
    await fs.mkdir(path.join(tmpDir, ".gdocs-sync"), { recursive: true });
    indexManager = new IndexManager(tmpDir);
    await indexManager.load();
    detector = new ChangeDetector(indexManager);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("file unchanged (hash matches) → no change", () => {
    const content = "original content";
    indexManager.addFile("s1", makeEntry({ localPath: "a.md", localContentHash: sha256(content) }));

    const localFiles = new Map([["a.md", content]]);
    const result = detector.detectChanges(localFiles);

    expect(result.changed).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.newFiles).toHaveLength(0);
  });

  test("file content modified → change detected", () => {
    indexManager.addFile("s1", makeEntry({ localPath: "a.md", localContentHash: sha256("old") }));

    const localFiles = new Map([["a.md", "new content"]]);
    const result = detector.detectChanges(localFiles);

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].syncId).toBe("s1");
    expect(result.changed[0].newHash).toBe(sha256("new content"));
  });

  test("file deleted from disk → detected as deleted", () => {
    indexManager.addFile("s1", makeEntry({ localPath: "a.md" }));

    const localFiles = new Map<string, string>(); // empty - file gone
    const result = detector.detectChanges(localFiles);

    expect(result.deleted).toHaveLength(1);
    expect(result.deleted[0].syncId).toBe("s1");
  });

  test("new file not in index → detected as new", () => {
    const localFiles = new Map([["new-file.md", "hello"]]);
    const result = detector.detectChanges(localFiles);

    expect(result.newFiles).toHaveLength(1);
    expect(result.newFiles[0].path).toBe("new-file.md");
    expect(result.newFiles[0].hash).toBe(sha256("hello"));
  });

  test("empty file → valid hash, no false positive", () => {
    const emptyHash = sha256("");
    indexManager.addFile("s1", makeEntry({ localPath: "a.md", localContentHash: emptyHash }));

    const localFiles = new Map([["a.md", ""]]);
    const result = detector.detectChanges(localFiles);

    expect(result.changed).toHaveLength(0);
  });

  test("with filesToCheck set, only checks dirty files", () => {
    const content = "same";
    indexManager.addFile("s1", makeEntry({ localPath: "a.md", localContentHash: sha256("old-a") }));
    indexManager.addFile("s2", makeEntry({ localPath: "b.md", localContentHash: sha256(content) }));

    const localFiles = new Map([
      ["a.md", "modified"],
      ["b.md", content],
    ]);

    // Only check a.md
    const dirtySet = new Set(["a.md"]);
    const result = detector.detectChanges(localFiles, dirtySet);

    expect(result.changed).toHaveLength(1);
    expect(result.changed[0].syncId).toBe("s1");
  });

  test("mixed changes: modified, deleted, new", () => {
    indexManager.addFile("s1", makeEntry({ localPath: "modified.md", localContentHash: sha256("old") }));
    indexManager.addFile("s2", makeEntry({ localPath: "deleted.md" }));
    indexManager.addFile("s3", makeEntry({ localPath: "unchanged.md", localContentHash: sha256("same") }));

    const localFiles = new Map([
      ["modified.md", "new content"],
      ["unchanged.md", "same"],
      ["brand-new.md", "new file"],
    ]);

    const result = detector.detectChanges(localFiles);

    expect(result.changed).toHaveLength(1);
    expect(result.deleted).toHaveLength(1);
    expect(result.newFiles).toHaveLength(1);
  });

  test("computeHash returns consistent SHA-256", () => {
    const h1 = detector.computeHash("hello");
    const h2 = detector.computeHash("hello");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // hex SHA-256
  });
});
