import { Notice } from "obsidian";
import { SyncOperation, SyncPlan, BatchUpdateRequest } from "@/types";
import { IndexManager } from "./index-manager";
import { SyncLog } from "./sync-log";
import { threeWayMerge, applyResolution } from "./merge";
import { sha256 } from "@/utils/hash";
import { DriveAPI, DriveFileNotFoundError } from "@/google/drive";
import { DocsAPI } from "@/google/docs";
import { markdownToGoogleDoc } from "@/conversion/md-to-gdoc";
import { googleDocToMarkdown } from "@/conversion/gdoc-to-md";
import {
  extractFrontmatter,
  prependFrontmatter,
  frontmatterToDocProperties,
  docPropertiesToFrontmatter,
  FrontmatterTooLargeError,
} from "@/conversion/frontmatter";
import { transformAllObsidianSyntax } from "@/conversion/obsidian-syntax";
import {
  DOC_PROPERTY_SYNC_ID,
  GOOGLE_DOC_MIME_TYPE,
  GOOGLE_FOLDER_MIME_TYPE,
  ANCESTORS_DIR,
  SYNC_DIR,
} from "@/constants";
import * as fs from "fs/promises";
import * as path from "path";

export interface ExecutorDeps {
  driveApi: DriveAPI;
  docsApi: DocsAPI;
  indexManager: IndexManager;
  syncLog: SyncLog;
  vaultPath: string;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  deleteFile: (filePath: string) => Promise<void>;
  renameFile: (oldPath: string, newPath: string) => Promise<void>;
  createFolder: (folderPath: string) => Promise<void>;
  /** Re-mark a file dirty so it is picked up by the next sync cycle. */
  markDirty: (filePath: string) => void;
  promptConflict: (local: string, remote: string, filePath: string) => Promise<"keep-local" | "keep-remote" | "open-in-editor" | "skip">;
  promptRemoteDeletion: (filePath: string) => Promise<"yes" | "no" | "ignore">;
}

export interface ExecutionResult {
  success: number;
  failed: number;
  skipped: number;
  /** Local paths of failed operations, for re-dirtying. */
  failedPaths: string[];
}

export class SyncExecutor {
  private deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  async executePlan(plan: SyncPlan): Promise<ExecutionResult> {
    const result: ExecutionResult = {
      success: 0,
      failed: 0,
      skipped: 0,
      failedPaths: [],
    };

    for (const op of plan.operations) {
      try {
        if (op.type === "SKIP") {
          result.skipped++;
          this.deps.syncLog.log(
            "SKIP",
            op.localPath,
            "Path conflict: an untracked local file and a new remote doc share this path. Rename one of them."
          );
          continue;
        }
        await this.executeOperation(op);
        result.success++;
      } catch (err: any) {
        result.failed++;
        result.failedPaths.push(op.localPath);
        this.deps.syncLog.log(
          "ERROR",
          op.localPath,
          `Failed: ${err.message}`,
          err.stack
        );
      }
    }

    return result;
  }

  private async executeOperation(op: SyncOperation): Promise<void> {
    switch (op.type) {
      case "PUSH":
        return this.executePush(op);
      case "PULL":
        return this.executePull(op);
      case "MERGE":
        return this.executeMerge(op);
      case "NEW_LOCAL":
        return this.executeNewLocal(op);
      case "NEW_REMOTE":
        return this.executeNewRemote(op);
      case "LOCAL_DELETE":
        return this.executeLocalDelete(op);
      case "REMOTE_DELETE":
        return this.executeRemoteDelete(op);
      case "LOCAL_RENAME":
      case "REMOTE_RENAME":
        return this.executeRename(op);
      case "SKIP":
        return;
    }
  }

  private async executePush(op: SyncOperation): Promise<void> {
    const content = await this.deps.readFile(op.localPath);
    const preHash = sha256(content);

    const { frontmatter, body } = extractFrontmatter(content);
    const transformedBody = transformAllObsidianSyntax(body);

    let batchRequest: BatchUpdateRequest;
    let conversionFailed = false;

    try {
      batchRequest = markdownToGoogleDoc(transformedBody);
    } catch {
      // Conversion failed — push the body as a single plain-text insert.
      batchRequest = this.plainTextRequest(body);
      conversionFailed = true;
      this.deps.syncLog.log("CONVERSION_FAIL", op.localPath, "Pushed as plain text");
      new Notice(`Conversion failed for '${op.localPath}' — synced as plain text.`);
    }

    const entry = this.deps.indexManager.getFile(op.syncId);
    if (!entry) return;

    await this.deps.docsApi.clearAndUpdate(entry.driveFileId, batchRequest);

    // Store frontmatter as doc properties.
    if (frontmatter) {
      await this.pushFrontmatterProperties(op.localPath, entry.driveFileId, frontmatter);
    }

    const remoteModifiedTime = await this.fetchRemoteModifiedTime(entry.driveFileId);

    // Post-push hash check: if the file changed while we were pushing,
    // re-dirty it so the next cycle pushes the newer content.
    const postContent = await this.deps.readFile(op.localPath);
    const postHash = sha256(postContent);

    // The ancestor must reflect what was actually pushed, not the newer
    // local content.
    await this.saveAncestor(op.syncId, content);

    this.deps.indexManager.updateFile(op.syncId, {
      localContentHash: preHash,
      remoteContentHash: preHash,
      lastRemoteModifiedTime: remoteModifiedTime,
      lastSyncTimestamp: new Date().toISOString(),
      conversionFailed,
    });

    this.deps.syncLog.log("PUSH", op.localPath, "OK");

    if (postHash !== preHash) {
      this.deps.markDirty(op.localPath);
      this.deps.syncLog.log("PUSH", op.localPath, "File changed during push, re-queued");
    }
  }

  private async executePull(op: SyncOperation): Promise<void> {
    const entry = this.deps.indexManager.getFile(op.syncId);
    if (!entry) return;

    const doc = await this.deps.docsApi.getDocument(entry.driveFileId);
    const markdown = googleDocToMarkdown(doc);

    // Restore frontmatter from doc properties.
    const driveFile = await this.deps.driveApi.getFile(entry.driveFileId);
    const frontmatter = docPropertiesToFrontmatter(driveFile.properties || {});
    const fullContent = prependFrontmatter(markdown, frontmatter);

    await this.deps.writeFile(op.localPath, fullContent);
    const newHash = sha256(fullContent);

    await this.saveAncestor(op.syncId, fullContent);

    this.deps.indexManager.updateFile(op.syncId, {
      localContentHash: newHash,
      remoteContentHash: newHash,
      lastRemoteModifiedTime: driveFile.modifiedTime,
      lastSyncTimestamp: new Date().toISOString(),
    });

    this.deps.syncLog.log("PULL", op.localPath, "OK");
  }

  private async executeMerge(op: SyncOperation): Promise<void> {
    const entry = this.deps.indexManager.getFile(op.syncId);
    if (!entry) return;

    const localContent = await this.deps.readFile(op.localPath);

    const doc = await this.deps.docsApi.getDocument(entry.driveFileId);
    const remoteMarkdown = googleDocToMarkdown(doc);
    const driveFile = await this.deps.driveApi.getFile(entry.driveFileId);
    const remoteFrontmatter = docPropertiesToFrontmatter(driveFile.properties || {});
    const remoteContent = prependFrontmatter(remoteMarkdown, remoteFrontmatter);

    const ancestor = await this.loadAncestor(op.syncId);

    const mergeResult = threeWayMerge(ancestor || "", localContent, remoteContent);

    let resolvedContent: string;

    if (mergeResult.success && !mergeResult.contentLossWarning) {
      resolvedContent = mergeResult.merged!;
      this.deps.syncLog.log("MERGE", op.localPath, "Auto-merged");
    } else {
      // Prompt user
      const resolution = await this.deps.promptConflict(
        localContent,
        remoteContent,
        op.localPath
      );
      const result = applyResolution(resolution, localContent, remoteContent);
      if (result === null) {
        // "open-in-editor" or "skip": leave both sides untouched. The file
        // stays dirty so the conflict resurfaces next cycle.
        this.deps.markDirty(op.localPath);
        this.deps.syncLog.log(
          "CONFLICT",
          op.localPath,
          resolution === "open-in-editor" ? "Opened in editor" : "Skipped"
        );
        return;
      }
      resolvedContent = result;
      this.deps.syncLog.log("CONFLICT", op.localPath, `Resolved: ${resolution}`);
    }

    // Write resolved content to both sides
    await this.deps.writeFile(op.localPath, resolvedContent);

    const { frontmatter, body } = extractFrontmatter(resolvedContent);
    const transformedBody = transformAllObsidianSyntax(body);
    const batchRequest = markdownToGoogleDoc(transformedBody);
    await this.deps.docsApi.clearAndUpdate(entry.driveFileId, batchRequest);

    if (frontmatter) {
      await this.pushFrontmatterProperties(op.localPath, entry.driveFileId, frontmatter);
    }

    const remoteModifiedTime = await this.fetchRemoteModifiedTime(entry.driveFileId);

    const newHash = sha256(resolvedContent);
    await this.saveAncestor(op.syncId, resolvedContent);

    this.deps.indexManager.updateFile(op.syncId, {
      localContentHash: newHash,
      remoteContentHash: newHash,
      lastRemoteModifiedTime: remoteModifiedTime,
      lastSyncTimestamp: new Date().toISOString(),
    });
  }

  private async executeNewLocal(op: SyncOperation): Promise<void> {
    const content = await this.deps.readFile(op.localPath);
    const { frontmatter, body } = extractFrontmatter(content);
    const transformedBody = transformAllObsidianSyntax(body);

    // Create Google Doc
    const parentFolderId = await this.ensureParentFolder(op.localPath);
    const docName = op.localPath.split("/").pop()?.replace(/\.md$/, "") || "Untitled";

    const driveFile = await this.deps.driveApi.createFile(
      docName,
      GOOGLE_DOC_MIME_TYPE,
      parentFolderId
    );

    // Set sync ID and frontmatter properties
    const properties: Record<string, string> = {
      [DOC_PROPERTY_SYNC_ID]: op.syncId,
    };
    if (frontmatter) {
      try {
        Object.assign(properties, frontmatterToDocProperties(frontmatter));
      } catch (err) {
        if (!(err instanceof FrontmatterTooLargeError)) throw err;
        this.deps.syncLog.log(
          "CONVERSION_FAIL",
          op.localPath,
          "Frontmatter too large for Drive properties; not stored remotely"
        );
      }
    }
    await this.deps.driveApi.updateFileMetadata(driveFile.id, { properties });

    // Write content
    const batchRequest = markdownToGoogleDoc(transformedBody);
    await this.deps.docsApi.clearAndUpdate(driveFile.id, batchRequest);

    const remoteModifiedTime = await this.fetchRemoteModifiedTime(driveFile.id);

    const hash = sha256(content);
    await this.saveAncestor(op.syncId, content);

    this.deps.indexManager.addFile(op.syncId, {
      localPath: op.localPath,
      driveFileId: driveFile.id,
      lastSyncTimestamp: new Date().toISOString(),
      localContentHash: hash,
      remoteContentHash: hash,
      lastRemoteModifiedTime: remoteModifiedTime,
      isDirectory: false,
      mimeType: GOOGLE_DOC_MIME_TYPE,
      conversionFailed: false,
      fileSizeBytes: Buffer.byteLength(content),
    });

    this.deps.syncLog.log("PUSH", op.localPath, "Created new Google Doc");
  }

  private async executeNewRemote(op: SyncOperation): Promise<void> {
    const driveFile = op.driveFile;
    if (!driveFile) {
      throw new Error(`NEW_REMOTE operation for ${op.localPath} is missing Drive metadata`);
    }

    // New remote folder: mirror it locally and register the mapping.
    if (driveFile.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
      await this.deps.createFolder(op.localPath);
      this.deps.indexManager.addFolder(op.localPath, driveFile.id);
      this.deps.syncLog.log("PULL", op.localPath, "Created folder from Drive");
      return;
    }

    const doc = await this.deps.docsApi.getDocument(driveFile.id);
    const markdown = googleDocToMarkdown(doc);
    const frontmatter = docPropertiesToFrontmatter(driveFile.properties || {});
    const fullContent = prependFrontmatter(markdown, frontmatter);

    await this.deps.writeFile(op.localPath, fullContent);

    // Reuse the doc's existing sync ID (e.g. created by another vault) when
    // present; otherwise stamp ours onto the doc.
    const existingSyncId = driveFile.properties?.[DOC_PROPERTY_SYNC_ID];
    const syncId = existingSyncId || op.syncId;
    if (!existingSyncId) {
      await this.deps.driveApi.updateFileMetadata(driveFile.id, {
        properties: { [DOC_PROPERTY_SYNC_ID]: syncId },
      });
    }

    const hash = sha256(fullContent);
    await this.saveAncestor(syncId, fullContent);

    this.deps.indexManager.addFile(syncId, {
      localPath: op.localPath,
      driveFileId: driveFile.id,
      lastSyncTimestamp: new Date().toISOString(),
      localContentHash: hash,
      remoteContentHash: hash,
      lastRemoteModifiedTime: await this.fetchRemoteModifiedTime(driveFile.id),
      isDirectory: false,
      mimeType: GOOGLE_DOC_MIME_TYPE,
      conversionFailed: false,
      fileSizeBytes: Buffer.byteLength(fullContent),
    });

    this.deps.syncLog.log("PULL", op.localPath, "Pulled new file from Drive");
  }

  private async executeLocalDelete(op: SyncOperation): Promise<void> {
    const entry = this.deps.indexManager.getFile(op.syncId);
    if (!entry) return;

    try {
      const deletedFolderId = this.deps.indexManager.getIndex().deletedFolderId;
      if (deletedFolderId) {
        const oldParentId = this.parentFolderIdFor(entry.localPath);
        await this.deps.driveApi.moveFile(entry.driveFileId, deletedFolderId, oldParentId);
      } else {
        await this.deps.driveApi.deleteFile(entry.driveFileId);
      }
    } catch (err) {
      if (err instanceof DriveFileNotFoundError) {
        // Already gone remotely — still clean up our bookkeeping below.
        this.deps.syncLog.log("DELETE", op.localPath, "Remote file already deleted");
      } else {
        throw err;
      }
    }

    this.deps.indexManager.removeFile(op.syncId);
    await this.removeAncestor(op.syncId);

    this.deps.syncLog.log("DELETE", op.localPath, "Moved to deleted folder");
  }

  private async executeRemoteDelete(op: SyncOperation): Promise<void> {
    const response = await this.deps.promptRemoteDeletion(op.localPath);

    if (response === "yes") {
      await this.deps.deleteFile(op.localPath);
      this.deps.indexManager.removeFile(op.syncId);
      await this.removeAncestor(op.syncId);
      this.deps.syncLog.log("DELETE", op.localPath, "Deleted locally (remote was deleted)");
    } else if (response === "no") {
      this.deps.indexManager.removeFile(op.syncId);
      this.deps.syncLog.log("DELETE", op.localPath, "Kept locally, removed from sync");
    }
    // "ignore" → do nothing
  }

  private async executeRename(op: SyncOperation): Promise<void> {
    if (!op.newPath) return;
    const entry = this.deps.indexManager.getFile(op.syncId);
    if (!entry) return;

    let remoteModifiedTime = entry.lastRemoteModifiedTime;

    if (op.type === "LOCAL_RENAME") {
      // Rename in Drive.
      const newName = op.newPath.split("/").pop()?.replace(/\.md$/, "") || "Untitled";
      const updated = await this.deps.driveApi.updateFileMetadata(entry.driveFileId, {
        name: newName,
      });
      remoteModifiedTime = updated.modifiedTime;

      // Moved across folders? Reparent the Drive file too.
      const oldDir = this.dirOf(op.localPath);
      const newDir = this.dirOf(op.newPath);
      if (oldDir !== newDir) {
        const newParentId = await this.ensureParentFolder(op.newPath);
        const oldParentId = this.parentFolderIdFor(op.localPath);
        const moved = await this.deps.driveApi.moveFile(
          entry.driveFileId,
          newParentId,
          oldParentId
        );
        remoteModifiedTime = moved.modifiedTime;
      }
    } else {
      // Rename locally
      await this.deps.renameFile(op.localPath, op.newPath);
      remoteModifiedTime = op.driveFile?.modifiedTime ?? remoteModifiedTime;
    }

    this.deps.indexManager.updateFile(op.syncId, {
      localPath: op.newPath,
      lastRemoteModifiedTime: remoteModifiedTime,
      lastSyncTimestamp: new Date().toISOString(),
    });

    this.deps.syncLog.log("RENAME", op.localPath, `Renamed to ${op.newPath}`);
  }

  // ============================================================
  // Helpers
  // ============================================================

  private plainTextRequest(body: string): BatchUpdateRequest {
    if (!body || body.trim() === "") {
      return { requests: [] };
    }
    return {
      requests: [
        { insertText: { text: body, location: { index: 1 } } },
      ],
    };
  }

  private async pushFrontmatterProperties(
    localPath: string,
    driveFileId: string,
    frontmatter: string
  ): Promise<void> {
    try {
      const props = frontmatterToDocProperties(frontmatter);
      await this.deps.driveApi.updateFileMetadata(driveFileId, {
        properties: props,
      });
    } catch (err) {
      if (!(err instanceof FrontmatterTooLargeError)) throw err;
      this.deps.syncLog.log(
        "CONVERSION_FAIL",
        localPath,
        "Frontmatter too large for Drive properties; not stored remotely"
      );
    }
  }

  private async fetchRemoteModifiedTime(driveFileId: string): Promise<string> {
    const file = await this.deps.driveApi.getFile(driveFileId, "id,modifiedTime");
    return file.modifiedTime;
  }

  private dirOf(filePath: string): string {
    const idx = filePath.lastIndexOf("/");
    return idx === -1 ? "" : filePath.substring(0, idx);
  }

  private parentFolderIdFor(localPath: string): string {
    const dir = this.dirOf(localPath);
    if (!dir) return this.deps.indexManager.getIndex().rootFolderId;
    return (
      this.deps.indexManager.getFolder(dir) ??
      this.deps.indexManager.getIndex().rootFolderId
    );
  }

  private async ensureParentFolder(localPath: string): Promise<string> {
    const parts = localPath.split("/");
    if (parts.length <= 1) {
      return this.deps.indexManager.getIndex().rootFolderId;
    }

    const folderPath = parts.slice(0, -1).join("/");
    const existing = this.deps.indexManager.getFolder(folderPath);
    if (existing) return existing;

    // Create folder hierarchy
    let parentId = this.deps.indexManager.getIndex().rootFolderId;
    let currentPath = "";

    for (let i = 0; i < parts.length - 1; i++) {
      currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
      const folderId = this.deps.indexManager.getFolder(currentPath);

      if (folderId) {
        parentId = folderId;
      } else {
        const folder = await this.deps.driveApi.createFolder(parts[i], parentId);
        this.deps.indexManager.addFolder(currentPath, folder.id);
        parentId = folder.id;
      }
    }

    return parentId;
  }

  private ancestorPath(syncId: string): string {
    return path.join(this.deps.vaultPath, SYNC_DIR, ANCESTORS_DIR, `${syncId}.md`);
  }

  private async saveAncestor(syncId: string, content: string): Promise<void> {
    const dir = path.join(this.deps.vaultPath, SYNC_DIR, ANCESTORS_DIR);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.ancestorPath(syncId), content, "utf-8");
  }

  private async loadAncestor(syncId: string): Promise<string | null> {
    try {
      return await fs.readFile(this.ancestorPath(syncId), "utf-8");
    } catch {
      return null;
    }
  }

  private async removeAncestor(syncId: string): Promise<void> {
    try {
      await fs.unlink(this.ancestorPath(syncId));
    } catch {
      // Ignore if not found
    }
  }
}
