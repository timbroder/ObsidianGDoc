import { SyncEngine, SyncEngineConfig } from "@/sync/engine";
import { IndexManager } from "@/sync/index-manager";
import { ChangeDetector } from "@/sync/change-detector";
import { DirtyTracker } from "@/sync/dirty-tracker";
import { SyncLog } from "@/sync/sync-log";
import { DriveAPI } from "@/google/drive";
import { DocsAPI } from "@/google/docs";
import { SyncFileEntry, DriveFile, SyncStatus, GoogleDoc } from "@/types";
import { sha256 } from "@/utils/hash";
import { Vault } from "obsidian";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

jest.mock("@/utils/network", () => ({
  isOnline: jest.fn().mockResolvedValue(true),
}));

import { isOnline } from "@/utils/network";

const mockIsOnline = isOnline as jest.MockedFunction<typeof isOnline>;

const REMOTE_TIME = "2025-06-01T00:00:00.000Z";

function makeEntry(overrides: Partial<SyncFileEntry> = {}): SyncFileEntry {
  return {
    localPath: "a.md",
    driveFileId: "d1",
    lastSyncTimestamp: "2025-01-01T00:00:00Z",
    localContentHash: "stale",
    remoteContentHash: "stale",
    isDirectory: false,
    mimeType: "application/vnd.google-apps.document",
    conversionFailed: false,
    fileSizeBytes: 100,
    ...overrides,
  };
}

function makeDoc(text: string): GoogleDoc {
  return {
    documentId: "d1",
    title: "a",
    body: {
      content: [
        {
          startIndex: 1,
          endIndex: text.length + 2,
          paragraph: {
            elements: [
              {
                startIndex: 1,
                endIndex: text.length + 2,
                textRun: { content: `${text}\n`, textStyle: {} },
              },
            ],
            paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
          },
        },
      ],
    },
  };
}

describe("SyncEngine", () => {
  let tmpDir: string;
  let indexManager: IndexManager;
  let dirtyTracker: DirtyTracker;
  let vaultFiles: Map<string, string>;
  let driveApi: jest.Mocked<
    Pick<
      DriveAPI,
      | "getChanges"
      | "getStartPageToken"
      | "listAllFilesRecursive"
      | "getFile"
      | "createFile"
      | "createFolder"
      | "updateFileMetadata"
      | "moveFile"
      | "deleteFile"
    >
  >;
  let docsApi: jest.Mocked<Pick<DocsAPI, "getDocument" | "clearAndUpdate" | "batchUpdate">>;
  let statuses: SyncStatus[];
  let config: SyncEngineConfig;
  let engine: SyncEngine;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockIsOnline.mockResolvedValue(true);

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-engine-"));
    indexManager = new IndexManager(tmpDir);
    await indexManager.load();
    indexManager.setRootFolderId("root-id");
    dirtyTracker = new DirtyTracker(new Vault() as any, []);
    vaultFiles = new Map();
    statuses = [];

    driveApi = {
      getChanges: jest.fn().mockResolvedValue({
        changes: [],
        newStartPageToken: "next-token",
      }),
      getStartPageToken: jest.fn().mockResolvedValue("start-token"),
      listAllFilesRecursive: jest.fn().mockResolvedValue([]),
      getFile: jest.fn().mockResolvedValue({ id: "d1", modifiedTime: REMOTE_TIME, properties: {} }),
      createFile: jest.fn().mockResolvedValue({ id: "created-id", modifiedTime: REMOTE_TIME }),
      createFolder: jest.fn().mockResolvedValue({ id: "folder-id", modifiedTime: REMOTE_TIME }),
      updateFileMetadata: jest.fn().mockResolvedValue({ id: "d1", modifiedTime: REMOTE_TIME }),
      moveFile: jest.fn().mockResolvedValue({ id: "d1", modifiedTime: REMOTE_TIME }),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };
    docsApi = {
      getDocument: jest.fn().mockResolvedValue(makeDoc("remote")),
      clearAndUpdate: jest.fn().mockResolvedValue(undefined),
      batchUpdate: jest.fn().mockResolvedValue(undefined),
    };

    config = {
      vaultPath: tmpDir,
      driveApi: driveApi as unknown as DriveAPI,
      docsApi: docsApi as unknown as DocsAPI,
      indexManager,
      changeDetector: new ChangeDetector(indexManager),
      dirtyTracker,
      syncLog: new SyncLog(tmpDir),
      exclusionPatterns: ["*.excalidraw.md"],
      maxFileSizeBytes: 1024,
      readFile: async (p) => {
        const c = vaultFiles.get(p);
        if (c === undefined) throw new Error(`not found: ${p}`);
        return c;
      },
      writeFile: async (p, content) => {
        vaultFiles.set(p, content);
      },
      deleteFile: async (p) => {
        vaultFiles.delete(p);
      },
      renameFile: async (oldPath, newPath) => {
        vaultFiles.set(newPath, vaultFiles.get(oldPath) ?? "");
        vaultFiles.delete(oldPath);
      },
      createFolder: async () => {},
      getVaultFiles: async () => new Map(vaultFiles),
      promptConflict: jest.fn().mockResolvedValue("keep-local"),
      promptRemoteDeletion: jest.fn().mockResolvedValue("no"),
      onStatusChange: (s) => statuses.push(s),
    };
    engine = new SyncEngine(config);
  });

  afterEach(async () => {
    dirtyTracker.unload();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("goes offline gracefully and preserves the dirty set", async () => {
    mockIsOnline.mockResolvedValue(false);
    dirtyTracker.addToDirtySet("a.md");

    await engine.syncAll({ manual: true });

    expect(engine.getStatus()).toBe("offline");
    expect(dirtyTracker.isDirty("a.md")).toBe(true);
  });

  it("walks every page of the changes feed before storing the new token", async () => {
    indexManager.setDriveChangeToken("t0");
    driveApi.getChanges
      .mockResolvedValueOnce({
        changes: [],
        newStartPageToken: "",
        nextPageToken: "t0-page2",
      })
      .mockResolvedValueOnce({
        changes: [],
        newStartPageToken: "t-final",
      });

    await engine.syncAll({ manual: true });

    expect(driveApi.getChanges).toHaveBeenNthCalledWith(1, "t0");
    expect(driveApi.getChanges).toHaveBeenNthCalledWith(2, "t0-page2");
    expect(indexManager.getDriveChangeToken()).toBe("t-final");
  });

  it("detects removed remote files and respects 'keep locally'", async () => {
    indexManager.setDriveChangeToken("t0");
    const entry = makeEntry({ localPath: "gone.md", driveFileId: "d-gone" });
    indexManager.addFile("s1", entry);
    vaultFiles.set("gone.md", "content\n");
    driveApi.getChanges.mockResolvedValue({
      changes: [{ fileId: "d-gone", removed: true, time: REMOTE_TIME }],
      newStartPageToken: "t1",
    });

    await engine.syncAll({ manual: true });

    expect(config.promptRemoteDeletion).toHaveBeenCalledWith("gone.md");
    // "no" → keep the local file but stop tracking it.
    expect(vaultFiles.has("gone.md")).toBe(true);
    expect(indexManager.getFile("s1")).toBeUndefined();
  });

  it("lists the Drive tree recursively on first sync and stores a start token", async () => {
    // No change token set → first sync path.
    await engine.syncAll({ manual: true });

    expect(driveApi.listAllFilesRecursive).toHaveBeenCalledWith("root-id");
    expect(driveApi.getStartPageToken).toHaveBeenCalled();
    expect(indexManager.getDriveChangeToken()).toBe("start-token");
  });

  it("filters excluded and oversized files from the sync set", async () => {
    indexManager.setDriveChangeToken("t0");
    vaultFiles.set("normal.md", "fine\n");
    vaultFiles.set("drawing.excalidraw.md", "excluded\n");
    vaultFiles.set("huge.md", "x".repeat(2048));
    vaultFiles.set("binary.canvas", "not markdown");

    await engine.syncAll({ manual: true });

    // Only normal.md should have produced a NEW_LOCAL push.
    expect(driveApi.createFile).toHaveBeenCalledTimes(1);
    expect(driveApi.createFile).toHaveBeenCalledWith(
      "normal",
      expect.any(String),
      "root-id"
    );
  });

  it("pulls a genuinely newer remote change", async () => {
    indexManager.setDriveChangeToken("t0");
    const content = "synced\n";
    indexManager.addFile(
      "s1",
      makeEntry({
        localContentHash: sha256(content),
        lastRemoteModifiedTime: "2025-01-01T00:00:00.000Z",
      })
    );
    vaultFiles.set("a.md", content);
    const remoteFile: DriveFile = {
      id: "d1",
      name: "a",
      mimeType: "application/vnd.google-apps.document",
      modifiedTime: REMOTE_TIME,
    };
    driveApi.getChanges.mockResolvedValue({
      changes: [{ fileId: "d1", removed: false, file: remoteFile, time: REMOTE_TIME }],
      newStartPageToken: "t1",
    });
    docsApi.getDocument.mockResolvedValue(makeDoc("fresh remote content"));

    await engine.syncAll({ manual: true });

    expect(vaultFiles.get("a.md")).toBe("fresh remote content\n");
  });

  it("ignores the echo of our own push", async () => {
    indexManager.setDriveChangeToken("t0");
    const content = "synced\n";
    indexManager.addFile(
      "s1",
      makeEntry({
        localContentHash: sha256(content),
        lastRemoteModifiedTime: REMOTE_TIME,
      })
    );
    vaultFiles.set("a.md", content);
    driveApi.getChanges.mockResolvedValue({
      changes: [
        {
          fileId: "d1",
          removed: false,
          file: {
            id: "d1",
            name: "a",
            mimeType: "application/vnd.google-apps.document",
            modifiedTime: REMOTE_TIME, // same as our recorded write
          },
          time: REMOTE_TIME,
        },
      ],
      newStartPageToken: "t1",
    });

    await engine.syncAll({ manual: true });

    expect(docsApi.getDocument).not.toHaveBeenCalled();
    expect(vaultFiles.get("a.md")).toBe(content);
  });

  it("does not advance the change token in push mode", async () => {
    indexManager.setDriveChangeToken("t0");
    driveApi.getChanges.mockResolvedValue({
      changes: [],
      newStartPageToken: "t-should-not-be-stored",
    });

    await engine.syncAll({ mode: "push", manual: true });

    expect(indexManager.getDriveChangeToken()).toBe("t0");
  });

  it("filters pull operations out in push mode but keeps pushes", async () => {
    indexManager.setDriveChangeToken("t0");
    vaultFiles.set("new-local.md", "to push\n");
    const newRemote: DriveFile = {
      id: "rd1",
      name: "remote-only",
      mimeType: "application/vnd.google-apps.document",
      modifiedTime: REMOTE_TIME,
      parents: ["root-id"],
    };
    driveApi.getChanges.mockResolvedValue({
      changes: [{ fileId: "rd1", removed: false, file: newRemote, time: REMOTE_TIME }],
      newStartPageToken: "t1",
    });

    await engine.syncAll({ mode: "push", manual: true });

    expect(driveApi.createFile).toHaveBeenCalled(); // NEW_LOCAL ran
    expect(vaultFiles.has("remote-only.md")).toBe(false); // NEW_REMOTE filtered
  });

  it("restores the dirty set when the sync fails wholesale", async () => {
    indexManager.setDriveChangeToken("t0");
    dirtyTracker.addToDirtySet("a.md");
    driveApi.getChanges.mockRejectedValue(new Error("network down"));

    await engine.syncAll({ manual: true });

    expect(engine.getStatus()).toBe("error");
    expect(dirtyTracker.isDirty("a.md")).toBe(true);
  });

  it("re-dirties files whose operations failed", async () => {
    indexManager.setDriveChangeToken("t0");
    const entry = makeEntry({ localPath: "fail.md", localContentHash: "old" });
    indexManager.addFile("s1", entry);
    vaultFiles.set("fail.md", "changed content\n");
    docsApi.clearAndUpdate.mockRejectedValue(new Error("docs API down"));

    await engine.syncAll({ manual: true });

    expect(engine.getStatus()).toBe("error");
    expect(dirtyTracker.isDirty("fail.md")).toBe(true);
  });

  it("does not start a second sync while one is running", async () => {
    indexManager.setDriveChangeToken("t0");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    driveApi.getChanges.mockImplementation(async () => {
      await gate;
      return { changes: [], newStartPageToken: "t1" };
    });

    const first = engine.syncAll({ manual: true });
    expect(engine.isSyncing()).toBe(true);
    const second = engine.syncAll({ manual: true }); // returns immediately
    release();
    await Promise.all([first, second]);

    expect(driveApi.getChanges).toHaveBeenCalledTimes(1);
  });
});
