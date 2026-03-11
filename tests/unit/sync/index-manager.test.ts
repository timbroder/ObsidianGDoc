import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { IndexManager, IndexCorruptedError } from "@/sync/index-manager";
import { SyncFileEntry } from "@/types";

describe("IndexManager", () => {
  let tmpDir: string;
  let manager: IndexManager;

  const makeEntry = (overrides: Partial<SyncFileEntry> = {}): SyncFileEntry => ({
    localPath: "test.md",
    driveFileId: "drive-123",
    googleDocId: "doc-123",
    lastSyncTimestamp: "2025-01-01T00:00:00Z",
    localContentHash: "abc123",
    remoteContentHash: "abc123",
    isDirectory: false,
    mimeType: "application/vnd.google-apps.document",
    conversionFailed: false,
    fileSizeBytes: 100,
    ...overrides,
  });

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-test-"));
    await fs.mkdir(path.join(tmpDir, ".gdocs-sync"), { recursive: true });
    manager = new IndexManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("creates new empty index on first load", async () => {
    const index = await manager.load();
    expect(index.version).toBe(1);
    expect(index.files).toEqual({});
    expect(index.folders).toEqual({});
  });

  test("adds and retrieves file entry", () => {
    const entry = makeEntry({ localPath: "notes/hello.md" });
    manager.addFile("sync-1", entry);

    expect(manager.getFile("sync-1")).toEqual(entry);
  });

  test("updates file entry", () => {
    manager.addFile("sync-1", makeEntry());
    manager.updateFile("sync-1", { localContentHash: "new-hash" });

    expect(manager.getFile("sync-1")!.localContentHash).toBe("new-hash");
  });

  test("removes file entry", () => {
    manager.addFile("sync-1", makeEntry());
    manager.removeFile("sync-1");

    expect(manager.getFile("sync-1")).toBeUndefined();
  });

  test("looks up file by localPath", () => {
    manager.addFile("sync-1", makeEntry({ localPath: "folder/note.md" }));

    const result = manager.getFileByLocalPath("folder/note.md");
    expect(result).toBeDefined();
    expect(result!.syncId).toBe("sync-1");
  });

  test("looks up file by driveFileId", () => {
    manager.addFile("sync-1", makeEntry({ driveFileId: "drive-xyz" }));

    const result = manager.getFileByDriveId("drive-xyz");
    expect(result).toBeDefined();
    expect(result!.syncId).toBe("sync-1");
  });

  test("save and load round-trip", async () => {
    manager.addFile("sync-1", makeEntry({ localPath: "a.md" }));
    manager.addFile("sync-2", makeEntry({ localPath: "b.md" }));
    manager.setDriveChangeToken("token-123");
    await manager.save();

    const newManager = new IndexManager(tmpDir);
    const loaded = await newManager.load();

    expect(loaded.files["sync-1"].localPath).toBe("a.md");
    expect(loaded.files["sync-2"].localPath).toBe("b.md");
    expect(loaded.driveChangeToken).toBe("token-123");
  });

  test("atomic write: no temp file remains after save", async () => {
    manager.addFile("sync-1", makeEntry());
    await manager.save();

    const files = await fs.readdir(path.join(tmpDir, ".gdocs-sync"));
    expect(files).not.toContain("index.json.tmp");
    expect(files).toContain("index.json");
  });

  test("throws IndexCorruptedError on corrupted index", async () => {
    await fs.writeFile(
      path.join(tmpDir, ".gdocs-sync", "index.json"),
      "not json",
      "utf-8"
    );

    const newManager = new IndexManager(tmpDir);
    await expect(newManager.load()).rejects.toThrow(IndexCorruptedError);
  });

  test("adds and retrieves folder mapping", () => {
    manager.addFolder("notes/subfolder", "folder-id-123");
    expect(manager.getFolder("notes/subfolder")).toBe("folder-id-123");
  });

  test("removes folder mapping", () => {
    manager.addFolder("notes/subfolder", "folder-id-123");
    manager.removeFolder("notes/subfolder");
    expect(manager.getFolder("notes/subfolder")).toBeUndefined();
  });

  test("finds all files in folder", () => {
    manager.addFile("s1", makeEntry({ localPath: "notes/a.md" }));
    manager.addFile("s2", makeEntry({ localPath: "notes/b.md" }));
    manager.addFile("s3", makeEntry({ localPath: "other/c.md" }));

    const results = manager.getFilesInFolder("notes");
    expect(results).toHaveLength(2);
  });

  test("finds files with conversionFailed", () => {
    manager.addFile("s1", makeEntry({ conversionFailed: true }));
    manager.addFile("s2", makeEntry({ conversionFailed: false }));

    const results = manager.getFailedConversions();
    expect(results).toHaveLength(1);
    expect(results[0].syncId).toBe("s1");
  });

  test("getFileCount returns correct count", () => {
    expect(manager.getFileCount()).toBe(0);
    manager.addFile("s1", makeEntry());
    manager.addFile("s2", makeEntry());
    expect(manager.getFileCount()).toBe(2);
  });

  test("update throws for non-existent file", () => {
    expect(() => manager.updateFile("nonexistent", {})).toThrow();
  });
});
