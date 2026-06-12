import { SyncExecutor, ExecutorDeps } from "@/sync/executor";
import { IndexManager } from "@/sync/index-manager";
import { SyncLog } from "@/sync/sync-log";
import { DriveAPI, DriveFileNotFoundError } from "@/google/drive";
import { DocsAPI } from "@/google/docs";
import { SyncFileEntry, SyncPlan, DriveFile, GoogleDoc } from "@/types";
import { sha256 } from "@/utils/hash";
import { DOC_PROPERTY_SYNC_ID, DOC_PROPERTY_FRONTMATTER } from "@/constants";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// ============================================================
// Fixtures and harness
// ============================================================

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

function plan(...operations: SyncPlan["operations"]): SyncPlan {
  return { operations, timestamp: new Date().toISOString() };
}

describe("SyncExecutor", () => {
  let tmpDir: string;
  let indexManager: IndexManager;
  let syncLog: SyncLog;
  let files: Map<string, string>;
  let driveApi: jest.Mocked<Pick<DriveAPI, "createFile" | "createFolder" | "getFile" | "updateFileMetadata" | "moveFile" | "deleteFile">>;
  let docsApi: jest.Mocked<Pick<DocsAPI, "getDocument" | "clearAndUpdate" | "batchUpdate">>;
  let deps: ExecutorDeps;
  let executor: SyncExecutor;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gdocs-exec-"));
    indexManager = new IndexManager(tmpDir);
    await indexManager.load();
    indexManager.setRootFolderId("root-id");
    syncLog = new SyncLog(tmpDir);
    files = new Map();

    driveApi = {
      createFile: jest.fn().mockResolvedValue({ id: "new-doc-id", modifiedTime: REMOTE_TIME }),
      createFolder: jest.fn().mockResolvedValue({ id: "new-folder-id", modifiedTime: REMOTE_TIME }),
      getFile: jest.fn().mockResolvedValue({ id: "d1", modifiedTime: REMOTE_TIME, properties: {} }),
      updateFileMetadata: jest.fn().mockResolvedValue({ id: "d1", modifiedTime: REMOTE_TIME }),
      moveFile: jest.fn().mockResolvedValue({ id: "d1", modifiedTime: REMOTE_TIME }),
      deleteFile: jest.fn().mockResolvedValue(undefined),
    };
    docsApi = {
      getDocument: jest.fn().mockResolvedValue(makeDoc("remote")),
      clearAndUpdate: jest.fn().mockResolvedValue(undefined),
      batchUpdate: jest.fn().mockResolvedValue(undefined),
    };

    deps = {
      driveApi: driveApi as unknown as DriveAPI,
      docsApi: docsApi as unknown as DocsAPI,
      indexManager,
      syncLog,
      vaultPath: tmpDir,
      readFile: jest.fn(async (p: string) => {
        const content = files.get(p);
        if (content === undefined) throw new Error(`not found: ${p}`);
        return content;
      }),
      writeFile: jest.fn(async (p: string, content: string) => {
        files.set(p, content);
      }),
      deleteFile: jest.fn(async (p: string) => {
        files.delete(p);
      }),
      renameFile: jest.fn(async (oldPath: string, newPath: string) => {
        files.set(newPath, files.get(oldPath) ?? "");
        files.delete(oldPath);
      }),
      createFolder: jest.fn().mockResolvedValue(undefined),
      markDirty: jest.fn(),
      promptConflict: jest.fn().mockResolvedValue("keep-local"),
      promptRemoteDeletion: jest.fn().mockResolvedValue("yes"),
    };
    executor = new SyncExecutor(deps);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function readAncestor(syncId: string): Promise<string | null> {
    try {
      return await fs.readFile(
        path.join(tmpDir, ".gdocs-sync", "ancestors", `${syncId}.md`),
        "utf-8"
      );
    } catch {
      return null;
    }
  }

  async function writeAncestor(syncId: string, content: string): Promise<void> {
    const dir = path.join(tmpDir, ".gdocs-sync", "ancestors");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${syncId}.md`), content, "utf-8");
  }

  // ----------------------------------------------------------
  // PUSH
  // ----------------------------------------------------------

  describe("PUSH", () => {
    it("pushes content, records hashes, ancestor, and remote modifiedTime", async () => {
      const content = "# Hello\n";
      files.set("a.md", content);
      indexManager.addFile("s1", makeEntry());

      const result = await executor.executePlan(
        plan({ type: "PUSH", syncId: "s1", localPath: "a.md" })
      );

      expect(result.success).toBe(1);
      expect(docsApi.clearAndUpdate).toHaveBeenCalledWith("d1", expect.anything());

      const entry = indexManager.getFile("s1")!;
      expect(entry.localContentHash).toBe(sha256(content));
      expect(entry.remoteContentHash).toBe(sha256(content));
      expect(entry.lastRemoteModifiedTime).toBe(REMOTE_TIME);
      expect(await readAncestor("s1")).toBe(content);
      expect(deps.markDirty).not.toHaveBeenCalled();
    });

    it("stores frontmatter in Drive properties", async () => {
      files.set("a.md", "---\ntitle: T\n---\nBody\n");
      indexManager.addFile("s1", makeEntry());

      await executor.executePlan(
        plan({ type: "PUSH", syncId: "s1", localPath: "a.md" })
      );

      expect(driveApi.updateFileMetadata).toHaveBeenCalledWith("d1", {
        properties: { [DOC_PROPERTY_FRONTMATTER]: "---\ntitle: T\n---\n" },
      });
    });

    it("re-dirties the file when it changes mid-push", async () => {
      indexManager.addFile("s1", makeEntry());
      (deps.readFile as jest.Mock)
        .mockResolvedValueOnce("original\n")
        .mockResolvedValueOnce("changed during push\n");

      await executor.executePlan(
        plan({ type: "PUSH", syncId: "s1", localPath: "a.md" })
      );

      expect(deps.markDirty).toHaveBeenCalledWith("a.md");
      // The recorded hash must match what was pushed, not the newer content,
      // so the next cycle detects the difference.
      expect(indexManager.getFile("s1")!.localContentHash).toBe(
        sha256("original\n")
      );
    });
  });

  // ----------------------------------------------------------
  // PULL
  // ----------------------------------------------------------

  describe("PULL", () => {
    it("writes converted content with restored frontmatter and updates the index", async () => {
      indexManager.addFile("s1", makeEntry());
      driveApi.getFile.mockResolvedValue({
        id: "d1",
        modifiedTime: REMOTE_TIME,
        properties: { [DOC_PROPERTY_FRONTMATTER]: "---\ntitle: T\n---\n" },
      } as DriveFile);

      await executor.executePlan(
        plan({ type: "PULL", syncId: "s1", localPath: "a.md" })
      );

      const written = files.get("a.md")!;
      expect(written).toBe("---\ntitle: T\n---\nremote\n");

      const entry = indexManager.getFile("s1")!;
      expect(entry.localContentHash).toBe(sha256(written));
      expect(entry.lastRemoteModifiedTime).toBe(REMOTE_TIME);
      expect(await readAncestor("s1")).toBe(written);
    });
  });

  // ----------------------------------------------------------
  // MERGE
  // ----------------------------------------------------------

  describe("MERGE", () => {
    it("auto-merges when only the local side changed", async () => {
      indexManager.addFile("s1", makeEntry());
      await writeAncestor("s1", "remote\n");
      files.set("a.md", "remote\nplus local addition\n");
      docsApi.getDocument.mockResolvedValue(makeDoc("remote"));

      await executor.executePlan(
        plan({ type: "MERGE", syncId: "s1", localPath: "a.md" })
      );

      // Ancestor === remote → merged result is the local content.
      expect(files.get("a.md")).toBe("remote\nplus local addition\n");
      expect(docsApi.clearAndUpdate).toHaveBeenCalled();
      expect(deps.promptConflict).not.toHaveBeenCalled();
      expect(indexManager.getFile("s1")!.localContentHash).toBe(
        sha256("remote\nplus local addition\n")
      );
    });

    it("leaves both sides untouched and re-dirties on skip", async () => {
      indexManager.addFile("s1", makeEntry({ localContentHash: "h-local" }));
      await writeAncestor("s1", "base\n");
      files.set("a.md", "local change\n");
      docsApi.getDocument.mockResolvedValue(makeDoc("remote change"));
      (deps.promptConflict as jest.Mock).mockResolvedValue("skip");

      await executor.executePlan(
        plan({ type: "MERGE", syncId: "s1", localPath: "a.md" })
      );

      expect(files.get("a.md")).toBe("local change\n");
      expect(docsApi.clearAndUpdate).not.toHaveBeenCalled();
      expect(deps.markDirty).toHaveBeenCalledWith("a.md");
      expect(indexManager.getFile("s1")!.localContentHash).toBe("h-local");
    });

    it("applies keep-remote to both sides", async () => {
      indexManager.addFile("s1", makeEntry());
      await writeAncestor("s1", "base\n");
      files.set("a.md", "local change\n");
      docsApi.getDocument.mockResolvedValue(makeDoc("remote change"));
      (deps.promptConflict as jest.Mock).mockResolvedValue("keep-remote");

      await executor.executePlan(
        plan({ type: "MERGE", syncId: "s1", localPath: "a.md" })
      );

      expect(files.get("a.md")).toBe("remote change\n");
      expect(docsApi.clearAndUpdate).toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // NEW_LOCAL / NEW_REMOTE
  // ----------------------------------------------------------

  describe("NEW_LOCAL", () => {
    it("creates a Google Doc, stamps the sync ID, and indexes the file", async () => {
      files.set("note.md", "# New note\n");

      await executor.executePlan(
        plan({ type: "NEW_LOCAL", syncId: "s-new", localPath: "note.md" })
      );

      expect(driveApi.createFile).toHaveBeenCalledWith(
        "note",
        "application/vnd.google-apps.document",
        "root-id"
      );
      expect(driveApi.updateFileMetadata).toHaveBeenCalledWith(
        "new-doc-id",
        expect.objectContaining({
          properties: expect.objectContaining({ [DOC_PROPERTY_SYNC_ID]: "s-new" }),
        })
      );
      const entry = indexManager.getFile("s-new")!;
      expect(entry.driveFileId).toBe("new-doc-id");
      expect(entry.localPath).toBe("note.md");
    });

    it("creates missing Drive parent folders for nested files", async () => {
      files.set("dir/sub/note.md", "content\n");
      driveApi.createFolder
        .mockResolvedValueOnce({ id: "f-dir", modifiedTime: REMOTE_TIME } as DriveFile)
        .mockResolvedValueOnce({ id: "f-sub", modifiedTime: REMOTE_TIME } as DriveFile);

      await executor.executePlan(
        plan({ type: "NEW_LOCAL", syncId: "s-new", localPath: "dir/sub/note.md" })
      );

      expect(driveApi.createFolder).toHaveBeenNthCalledWith(1, "dir", "root-id");
      expect(driveApi.createFolder).toHaveBeenNthCalledWith(2, "sub", "f-dir");
      expect(indexManager.getFolder("dir")).toBe("f-dir");
      expect(indexManager.getFolder("dir/sub")).toBe("f-sub");
    });
  });

  describe("NEW_REMOTE", () => {
    const remoteDoc: DriveFile = {
      id: "rd1",
      name: "incoming",
      mimeType: "application/vnd.google-apps.document",
      modifiedTime: REMOTE_TIME,
      properties: {},
    };

    it("pulls a new remote doc into the vault and indexes it", async () => {
      docsApi.getDocument.mockResolvedValue(makeDoc("incoming text"));

      const result = await executor.executePlan(
        plan({
          type: "NEW_REMOTE",
          syncId: "s-gen",
          localPath: "incoming.md",
          driveFile: remoteDoc,
        })
      );

      expect(result.success).toBe(1);
      expect(files.get("incoming.md")).toBe("incoming text\n");
      const entry = indexManager.getFile("s-gen")!;
      expect(entry.driveFileId).toBe("rd1");
      // Our sync ID gets stamped onto the doc.
      expect(driveApi.updateFileMetadata).toHaveBeenCalledWith("rd1", {
        properties: { [DOC_PROPERTY_SYNC_ID]: "s-gen" },
      });
    });

    it("reuses an existing sync ID stored on the doc", async () => {
      docsApi.getDocument.mockResolvedValue(makeDoc("text"));
      const docWithId = {
        ...remoteDoc,
        properties: { [DOC_PROPERTY_SYNC_ID]: "other-vault-id" },
      };

      await executor.executePlan(
        plan({
          type: "NEW_REMOTE",
          syncId: "s-gen",
          localPath: "incoming.md",
          driveFile: docWithId,
        })
      );

      expect(indexManager.getFile("other-vault-id")).toBeDefined();
      expect(indexManager.getFile("s-gen")).toBeUndefined();
      expect(driveApi.updateFileMetadata).not.toHaveBeenCalled();
    });

    it("mirrors a new remote folder locally", async () => {
      const folder: DriveFile = {
        id: "fold1",
        name: "subdir",
        mimeType: "application/vnd.google-apps.folder",
        modifiedTime: REMOTE_TIME,
      };

      await executor.executePlan(
        plan({
          type: "NEW_REMOTE",
          syncId: "s-f",
          localPath: "subdir",
          driveFile: folder,
        })
      );

      expect(deps.createFolder).toHaveBeenCalledWith("subdir");
      expect(indexManager.getFolder("subdir")).toBe("fold1");
    });

    it("fails the operation when Drive metadata is missing", async () => {
      const result = await executor.executePlan(
        plan({ type: "NEW_REMOTE", syncId: "s-x", localPath: "x.md" })
      );

      expect(result.failed).toBe(1);
      expect(result.failedPaths).toEqual(["x.md"]);
    });
  });

  // ----------------------------------------------------------
  // Deletes
  // ----------------------------------------------------------

  describe("LOCAL_DELETE", () => {
    it("moves the Drive file to the deleted folder and removes the index entry", async () => {
      indexManager.setDeletedFolderId("deleted-id");
      indexManager.addFile("s1", makeEntry());

      await executor.executePlan(
        plan({ type: "LOCAL_DELETE", syncId: "s1", localPath: "a.md" })
      );

      expect(driveApi.moveFile).toHaveBeenCalledWith("d1", "deleted-id", "root-id");
      expect(indexManager.getFile("s1")).toBeUndefined();
    });

    it("cleans up the index even when the remote file is already gone", async () => {
      indexManager.setDeletedFolderId("deleted-id");
      indexManager.addFile("s1", makeEntry());
      driveApi.moveFile.mockRejectedValue(new DriveFileNotFoundError("d1"));

      const result = await executor.executePlan(
        plan({ type: "LOCAL_DELETE", syncId: "s1", localPath: "a.md" })
      );

      expect(result.success).toBe(1);
      expect(indexManager.getFile("s1")).toBeUndefined();
    });
  });

  describe("REMOTE_DELETE", () => {
    it("deletes locally when the user confirms", async () => {
      indexManager.addFile("s1", makeEntry());
      files.set("a.md", "content");
      (deps.promptRemoteDeletion as jest.Mock).mockResolvedValue("yes");

      await executor.executePlan(
        plan({ type: "REMOTE_DELETE", syncId: "s1", localPath: "a.md" })
      );

      expect(files.has("a.md")).toBe(false);
      expect(indexManager.getFile("s1")).toBeUndefined();
    });

    it("keeps the file but stops syncing it when declined", async () => {
      indexManager.addFile("s1", makeEntry());
      files.set("a.md", "content");
      (deps.promptRemoteDeletion as jest.Mock).mockResolvedValue("no");

      await executor.executePlan(
        plan({ type: "REMOTE_DELETE", syncId: "s1", localPath: "a.md" })
      );

      expect(files.has("a.md")).toBe(true);
      expect(indexManager.getFile("s1")).toBeUndefined();
    });

    it("does nothing on ignore", async () => {
      indexManager.addFile("s1", makeEntry());
      files.set("a.md", "content");
      (deps.promptRemoteDeletion as jest.Mock).mockResolvedValue("ignore");

      await executor.executePlan(
        plan({ type: "REMOTE_DELETE", syncId: "s1", localPath: "a.md" })
      );

      expect(files.has("a.md")).toBe(true);
      expect(indexManager.getFile("s1")).toBeDefined();
    });
  });

  // ----------------------------------------------------------
  // Renames
  // ----------------------------------------------------------

  describe("renames", () => {
    it("LOCAL_RENAME renames the Drive file and updates the index", async () => {
      indexManager.addFile("s1", makeEntry());

      await executor.executePlan(
        plan({
          type: "LOCAL_RENAME",
          syncId: "s1",
          localPath: "a.md",
          newPath: "b.md",
        })
      );

      expect(driveApi.updateFileMetadata).toHaveBeenCalledWith("d1", { name: "b" });
      expect(driveApi.moveFile).not.toHaveBeenCalled();
      const entry = indexManager.getFile("s1")!;
      expect(entry.localPath).toBe("b.md");
      expect(entry.lastRemoteModifiedTime).toBe(REMOTE_TIME);
    });

    it("LOCAL_RENAME across folders also reparents the Drive file", async () => {
      indexManager.addFile("s1", makeEntry());
      driveApi.createFolder.mockResolvedValue({
        id: "f-dest",
        modifiedTime: REMOTE_TIME,
      } as DriveFile);

      await executor.executePlan(
        plan({
          type: "LOCAL_RENAME",
          syncId: "s1",
          localPath: "a.md",
          newPath: "dest/a.md",
        })
      );

      expect(driveApi.moveFile).toHaveBeenCalledWith("d1", "f-dest", "root-id");
      expect(indexManager.getFile("s1")!.localPath).toBe("dest/a.md");
    });

    it("REMOTE_RENAME renames the local file", async () => {
      indexManager.addFile("s1", makeEntry());
      files.set("a.md", "content");

      await executor.executePlan(
        plan({
          type: "REMOTE_RENAME",
          syncId: "s1",
          localPath: "a.md",
          newPath: "renamed.md",
        })
      );

      expect(deps.renameFile).toHaveBeenCalledWith("a.md", "renamed.md");
      expect(indexManager.getFile("s1")!.localPath).toBe("renamed.md");
    });
  });

  // ----------------------------------------------------------
  // SKIP and error accounting
  // ----------------------------------------------------------

  it("counts SKIP operations and logs the conflict", async () => {
    const result = await executor.executePlan(
      plan({ type: "SKIP", syncId: "s-skip", localPath: "same.md" })
    );

    expect(result.skipped).toBe(1);
    expect(result.success).toBe(0);
    const entries = syncLog.getEntries();
    expect(entries[entries.length - 1].action).toBe("SKIP");
  });

  it("continues past failures and reports failed paths", async () => {
    indexManager.addFile("s1", makeEntry({ localPath: "fails.md" }));
    indexManager.addFile("s2", makeEntry({ localPath: "works.md", driveFileId: "d2" }));
    files.set("works.md", "ok\n");
    // s1 has no local file → readFile throws.

    const result = await executor.executePlan(
      plan(
        { type: "PUSH", syncId: "s1", localPath: "fails.md" },
        { type: "PUSH", syncId: "s2", localPath: "works.md" }
      )
    );

    expect(result.failed).toBe(1);
    expect(result.success).toBe(1);
    expect(result.failedPaths).toEqual(["fails.md"]);
  });
});
