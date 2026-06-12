import { SyncPlanner, RemoteState } from "@/sync/planner";
import { IndexManager } from "@/sync/index-manager";
import { ChangeDetectionResult } from "@/sync/change-detector";
import { SyncFileEntry, DriveFile } from "@/types";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("SyncPlanner", () => {
  let tmpDir: string;
  let indexManager: IndexManager;
  let planner: SyncPlanner;

  const makeEntry = (overrides: Partial<SyncFileEntry> = {}): SyncFileEntry => ({
    localPath: "test.md",
    driveFileId: "drive-123",
    lastSyncTimestamp: "2025-01-01T00:00:00Z",
    localContentHash: "abc",
    remoteContentHash: "abc",
    isDirectory: false,
    mimeType: "application/vnd.google-apps.document",
    conversionFailed: false,
    fileSizeBytes: 100,
    ...overrides,
  });

  const emptyChanges: ChangeDetectionResult = {
    changed: [],
    deleted: [],
    newFiles: [],
  };

  const emptyRemote: RemoteState = {
    changedFiles: new Map(),
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-test-"));
    await fs.mkdir(path.join(tmpDir, ".gdocs-sync"), { recursive: true });
    indexManager = new IndexManager(tmpDir);
    await indexManager.load();
    indexManager.setRootFolderId("root-folder-id");
    planner = new SyncPlanner(indexManager);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test("all files unchanged → empty plan", () => {
    const plan = planner.buildPlan(emptyChanges, emptyRemote);
    expect(plan.operations).toHaveLength(0);
  });

  test("one local change → PUSH operation", () => {
    const entry = makeEntry({ localPath: "a.md" });
    indexManager.addFile("s1", entry);

    const changes: ChangeDetectionResult = {
      changed: [{ syncId: "s1", entry, newHash: "newhash" }],
      deleted: [],
      newFiles: [],
    };

    const plan = planner.buildPlan(changes, emptyRemote);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].type).toBe("PUSH");
    expect(plan.operations[0].localPath).toBe("a.md");
  });

  test("one remote change → PULL operation", () => {
    const entry = makeEntry({ localPath: "a.md", driveFileId: "d1" });
    indexManager.addFile("s1", entry);

    const remoteState: RemoteState = {
      changedFiles: new Map([
        [
          "d1",
          {
            id: "d1",
            name: "a",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2025-01-02T00:00:00Z",
          } as DriveFile,
        ],
      ]),
    };

    const plan = planner.buildPlan(emptyChanges, remoteState);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].type).toBe("PULL");
  });

  test("both sides changed → MERGE operation", () => {
    const entry = makeEntry({ localPath: "a.md", driveFileId: "d1" });
    indexManager.addFile("s1", entry);

    const changes: ChangeDetectionResult = {
      changed: [{ syncId: "s1", entry, newHash: "newhash" }],
      deleted: [],
      newFiles: [],
    };

    const remoteState: RemoteState = {
      changedFiles: new Map([
        [
          "d1",
          {
            id: "d1",
            name: "a",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2025-01-02T00:00:00Z",
          } as DriveFile,
        ],
      ]),
    };

    const plan = planner.buildPlan(changes, remoteState);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].type).toBe("MERGE");
  });

  test("new local file → NEW_LOCAL operation", () => {
    const changes: ChangeDetectionResult = {
      changed: [],
      deleted: [],
      newFiles: [{ path: "brand-new.md", hash: "hash123" }],
    };

    const plan = planner.buildPlan(changes, emptyRemote);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].type).toBe("NEW_LOCAL");
  });

  test("local file deleted → LOCAL_DELETE operation", () => {
    const entry = makeEntry({ localPath: "deleted.md" });
    indexManager.addFile("s1", entry);

    const changes: ChangeDetectionResult = {
      changed: [],
      deleted: [{ syncId: "s1", entry }],
      newFiles: [],
    };

    const plan = planner.buildPlan(changes, emptyRemote);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].type).toBe("LOCAL_DELETE");
  });

  test("new remote file → NEW_REMOTE operation", () => {
    const remoteState: RemoteState = {
      changedFiles: new Map([
        [
          "new-drive-id",
          {
            id: "new-drive-id",
            name: "new-doc",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2025-01-02T00:00:00Z",
            parents: ["root-folder-id"],
          } as DriveFile,
        ],
      ]),
    };

    const plan = planner.buildPlan(emptyChanges, remoteState);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].type).toBe("NEW_REMOTE");
    expect(plan.operations[0].localPath).toBe("new-doc.md");
    expect(plan.operations[0].driveFile?.id).toBe("new-drive-id");
  });

  test("new remote file outside the synced tree is ignored", () => {
    const remoteState: RemoteState = {
      changedFiles: new Map([
        [
          "outside-id",
          {
            id: "outside-id",
            name: "elsewhere",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2025-01-02T00:00:00Z",
            parents: ["some-unrelated-folder"],
          } as DriveFile,
        ],
      ]),
    };

    const plan = planner.buildPlan(emptyChanges, remoteState);
    expect(plan.operations).toHaveLength(0);
  });

  test("remote echo of our own push is suppressed", () => {
    const entry = makeEntry({
      localPath: "a.md",
      driveFileId: "d1",
      lastRemoteModifiedTime: "2025-01-02T00:00:00Z",
    });
    indexManager.addFile("s1", entry);

    const remoteState: RemoteState = {
      changedFiles: new Map([
        [
          "d1",
          {
            id: "d1",
            name: "a",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2025-01-02T00:00:00Z", // not newer than our write
          } as DriveFile,
        ],
      ]),
    };

    const plan = planner.buildPlan(emptyChanges, remoteState);
    expect(plan.operations).toHaveLength(0);
  });

  test("remote change newer than our last write → PULL", () => {
    const entry = makeEntry({
      localPath: "a.md",
      driveFileId: "d1",
      lastRemoteModifiedTime: "2025-01-02T00:00:00Z",
    });
    indexManager.addFile("s1", entry);

    const remoteState: RemoteState = {
      changedFiles: new Map([
        [
          "d1",
          {
            id: "d1",
            name: "a",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2025-01-03T00:00:00Z",
          } as DriveFile,
        ],
      ]),
    };

    const plan = planner.buildPlan(emptyChanges, remoteState);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].type).toBe("PULL");
  });

  test("removed remote file → REMOTE_DELETE", () => {
    const entry = makeEntry({ localPath: "gone.md", driveFileId: "d-gone" });
    indexManager.addFile("s1", entry);

    const remoteState: RemoteState = {
      changedFiles: new Map(),
      removedFileIds: new Set(["d-gone"]),
    };

    const plan = planner.buildPlan(emptyChanges, remoteState);
    expect(plan.operations).toHaveLength(1);
    expect(plan.operations[0].type).toBe("REMOTE_DELETE");
    expect(plan.operations[0].localPath).toBe("gone.md");
  });

  test("local rename dirty metadata → LOCAL_RENAME, not delete+create", () => {
    const entry = makeEntry({
      localPath: "old.md",
      driveFileId: "d1",
      localContentHash: "h1",
    });
    indexManager.addFile("s1", entry);

    const changes: ChangeDetectionResult = {
      changed: [],
      deleted: [{ syncId: "s1", entry }],
      newFiles: [{ path: "new.md", hash: "h1" }],
    };

    const dirtyFiles = new Map([
      [
        "new.md",
        {
          path: "new.md",
          type: "rename" as const,
          oldPath: "old.md",
          timestamp: Date.now(),
        },
      ],
    ]);

    const plan = planner.buildPlan(changes, emptyRemote, dirtyFiles);
    const types = plan.operations.map((o) => o.type);
    expect(types).toEqual(["LOCAL_RENAME"]);
    expect(plan.operations[0].newPath).toBe("new.md");
  });

  test("local rename with content change adds a PUSH at the new path", () => {
    const entry = makeEntry({
      localPath: "old.md",
      driveFileId: "d1",
      localContentHash: "h1",
    });
    indexManager.addFile("s1", entry);

    const changes: ChangeDetectionResult = {
      changed: [],
      deleted: [{ syncId: "s1", entry }],
      newFiles: [{ path: "new.md", hash: "h2-changed" }],
    };

    const dirtyFiles = new Map([
      [
        "new.md",
        {
          path: "new.md",
          type: "rename" as const,
          oldPath: "old.md",
          timestamp: Date.now(),
        },
      ],
    ]);

    const plan = planner.buildPlan(changes, emptyRemote, dirtyFiles);
    const types = plan.operations.map((o) => o.type);
    expect(types).toEqual(["LOCAL_RENAME", "PUSH"]);
    expect(plan.operations[1].localPath).toBe("new.md");
    expect(plan.operations[1].syncId).toBe("s1");
  });

  test("path collision between new local and new remote → SKIP", () => {
    const changes: ChangeDetectionResult = {
      changed: [],
      deleted: [],
      newFiles: [{ path: "same.md", hash: "local-hash" }],
    };

    const remoteState: RemoteState = {
      changedFiles: new Map([
        [
          "remote-id",
          {
            id: "remote-id",
            name: "same",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2025-01-02T00:00:00Z",
            parents: ["root-folder-id"],
          } as DriveFile,
        ],
      ]),
    };

    const plan = planner.buildPlan(changes, remoteState);
    const types = plan.operations.map((o) => o.type);
    expect(types).toEqual(["SKIP"]);
  });

  test("new remote folder is planned before the doc inside it", () => {
    const remoteState: RemoteState = {
      changedFiles: new Map<string, DriveFile>([
        [
          "doc-id",
          {
            id: "doc-id",
            name: "inner",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: "2025-01-02T00:00:00Z",
            parents: ["folder-id"],
          } as DriveFile,
        ],
        [
          "folder-id",
          {
            id: "folder-id",
            name: "subdir",
            mimeType: "application/vnd.google-apps.folder",
            modifiedTime: "2025-01-02T00:00:00Z",
            parents: ["root-folder-id"],
          } as DriveFile,
        ],
      ]),
    };

    const plan = planner.buildPlan(emptyChanges, remoteState);
    expect(plan.operations).toHaveLength(2);
    expect(plan.operations[0].localPath).toBe("subdir");
    expect(plan.operations[0].driveFile?.mimeType).toBe(
      "application/vnd.google-apps.folder",
    );
    expect(plan.operations[1].localPath).toBe("subdir/inner.md");
  });

  test("operations sorted: renames before content, deletes last", () => {
    const e1 = makeEntry({ localPath: "push.md", driveFileId: "d1" });
    const e2 = makeEntry({ localPath: "del.md", driveFileId: "d2" });
    indexManager.addFile("s1", e1);
    indexManager.addFile("s2", e2);

    const changes: ChangeDetectionResult = {
      changed: [{ syncId: "s1", entry: e1, newHash: "h" }],
      deleted: [{ syncId: "s2", entry: e2 }],
      newFiles: [{ path: "new.md", hash: "h" }],
    };

    const plan = planner.buildPlan(changes, emptyRemote);

    const types = plan.operations.map((o) => o.type);
    const newIdx = types.indexOf("NEW_LOCAL");
    const pushIdx = types.indexOf("PUSH");
    const deleteIdx = types.indexOf("LOCAL_DELETE");

    expect(newIdx).toBeLessThan(pushIdx);
    expect(pushIdx).toBeLessThan(deleteIdx);
  });
});
