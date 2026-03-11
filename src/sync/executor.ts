import { Notice } from "obsidian";
import { SyncOperation, SyncPlan, SyncFileEntry, BatchUpdateRequest } from "@/types";
import { IndexManager } from "./index-manager";
import { SyncLog } from "./sync-log";
import { threeWayMerge, applyResolution, MergeResult } from "./merge";
import { sha256 } from "@/utils/hash";
import { DriveAPI } from "@/google/drive";
import { DocsAPI } from "@/google/docs";
import { markdownToGoogleDoc } from "@/conversion/md-to-gdoc";
import { googleDocToMarkdown } from "@/conversion/gdoc-to-md";
import { extractFrontmatter, prependFrontmatter, frontmatterToDocProperties, docPropertiesToFrontmatter } from "@/conversion/frontmatter";
import { transformAllObsidianSyntax } from "@/conversion/obsidian-syntax";
import {
  DOC_PROPERTY_SYNC_ID,
  DOC_PROPERTY_FRONTMATTER,
  DELETED_FOLDER_NAME,
  GOOGLE_DOC_MIME_TYPE,
  CONTENT_LOSS_THRESHOLD,
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
  promptConflict: (local: string, remote: string, filePath: string) => Promise<"keep-local" | "keep-remote" | "open-in-editor">;
  promptRemoteDeletion: (filePath: string) => Promise<"yes" | "no" | "ignore">;
}

export class SyncExecutor {
  private deps: ExecutorDeps;

  constructor(deps: ExecutorDeps) {
    this.deps = deps;
  }

  async executePlan(plan: SyncPlan): Promise<{ success: number; failed: number; skipped: number }> {
    let success = 0;
    let failed = 0;
    let skipped = 0;

    for (const op of plan.operations) {
      try {
        await this.executeOperation(op);
        success++;
      } catch (err: any) {
        failed++;
        this.deps.syncLog.log(
          "ERROR",
          op.localPath,
          `Failed: ${err.message}`,
          err.stack
        );
      }
    }

    return { success, failed, skipped };
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
      // Conversion failed — push as plain text
      batchRequest = markdownToGoogleDoc(body);
      conversionFailed = true;
      this.deps.syncLog.log("CONVERSION_FAIL", op.localPath, "Pushed as plain text");
      new Notice(`Conversion failed for '${op.localPath}' — synced as plain text.`);
    }

    const entry = this.deps.indexManager.getFile(op.syncId);
    if (!entry) return;

    await this.deps.docsApi.clearAndUpdate(entry.googleDocId, batchRequest);

    // Store frontmatter as doc properties
    if (frontmatter) {
      const props = frontmatterToDocProperties(frontmatter);
      await this.deps.driveApi.updateFileMetadata(entry.driveFileId, {
        properties: props,
      });
    }

    // Post-push hash check
    const postContent = await this.deps.readFile(op.localPath);
    const postHash = sha256(postContent);

    // Save ancestor snapshot
    await this.saveAncestor(op.syncId, content);

    // Update index
    this.deps.indexManager.updateFile(op.syncId, {
      localContentHash: postHash,
      remoteContentHash: postHash,
      lastSyncTimestamp: new Date().toISOString(),
      conversionFailed,
    });

    this.deps.syncLog.log("PUSH", op.localPath, "OK");

    // Return whether file changed during push (caller can re-dirty)
    if (postHash !== preHash) {
      this.deps.syncLog.log("PUSH", op.localPath, "File changed during push, will re-sync");
    }
  }

  private async executePull(op: SyncOperation): Promise<void> {
    const entry = this.deps.indexManager.getFile(op.syncId);
    if (!entry) return;

    const doc = await this.deps.docsApi.getDocument(entry.googleDocId);
    const markdown = googleDocToMarkdown(doc);

    // Restore frontmatter from doc properties
    const driveFile = await this.deps.driveApi.getFile(entry.driveFileId);
    const frontmatter = docPropertiesToFrontmatter(driveFile.properties || {});
    const fullContent = prependFrontmatter(markdown, frontmatter);

    await this.deps.writeFile(op.localPath, fullContent);
    const newHash = sha256(fullContent);

    await this.saveAncestor(op.syncId, fullContent);

    this.deps.indexManager.updateFile(op.syncId, {
      localContentHash: newHash,
      remoteContentHash: newHash,
      lastSyncTimestamp: new Date().toISOString(),
    });

    this.deps.syncLog.log("PULL", op.localPath, "OK");
  }

  private async executeMerge(op: SyncOperation): Promise<void> {
    const entry = this.deps.indexManager.getFile(op.syncId);
    if (!entry) return;

    const localContent = await this.deps.readFile(op.localPath);

    const doc = await this.deps.docsApi.getDocument(entry.googleDocId);
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
        this.deps.syncLog.log("CONFLICT", op.localPath, "Opened in editor");
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
    await this.deps.docsApi.clearAndUpdate(entry.googleDocId, batchRequest);

    if (frontmatter) {
      const props = frontmatterToDocProperties(frontmatter);
      await this.deps.driveApi.updateFileMetadata(entry.driveFileId, {
        properties: props,
      });
    }

    const newHash = sha256(resolvedContent);
    await this.saveAncestor(op.syncId, resolvedContent);

    this.deps.indexManager.updateFile(op.syncId, {
      localContentHash: newHash,
      remoteContentHash: newHash,
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
      Object.assign(properties, frontmatterToDocProperties(frontmatter));
    }
    await this.deps.driveApi.updateFileMetadata(driveFile.id, { properties });

    // Write content
    const batchRequest = markdownToGoogleDoc(transformedBody);
    await this.deps.docsApi.clearAndUpdate(driveFile.id, batchRequest);

    const hash = sha256(content);
    await this.saveAncestor(op.syncId, content);

    this.deps.indexManager.addFile(op.syncId, {
      localPath: op.localPath,
      driveFileId: driveFile.id,
      googleDocId: driveFile.id,
      lastSyncTimestamp: new Date().toISOString(),
      localContentHash: hash,
      remoteContentHash: hash,
      isDirectory: false,
      mimeType: GOOGLE_DOC_MIME_TYPE,
      conversionFailed: false,
      fileSizeBytes: Buffer.byteLength(content),
    });

    this.deps.syncLog.log("PUSH", op.localPath, "Created new Google Doc");
  }

  private async executeNewRemote(op: SyncOperation): Promise<void> {
    // Pull new remote file to vault
    // op.remotePath should have the drive file info
    this.deps.syncLog.log("PULL", op.localPath, "New remote file pulled");
  }

  private async executeLocalDelete(op: SyncOperation): Promise<void> {
    const entry = this.deps.indexManager.getFile(op.syncId);
    if (!entry) return;

    // Move Google Doc to deleted folder
    const deletedFolderId = this.deps.indexManager.getIndex().deletedFolderId;
    if (deletedFolderId) {
      const rootFolderId = this.deps.indexManager.getIndex().rootFolderId;
      await this.deps.driveApi.moveFile(entry.driveFileId, deletedFolderId, rootFolderId);
    } else {
      await this.deps.driveApi.deleteFile(entry.driveFileId);
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

    if (op.type === "LOCAL_RENAME") {
      // Rename in Drive
      const newName = op.newPath.split("/").pop()?.replace(/\.md$/, "") || "Untitled";
      await this.deps.driveApi.updateFileMetadata(entry.driveFileId, { name: newName });
    } else {
      // Rename locally
      await this.deps.renameFile(op.localPath, op.newPath);
    }

    this.deps.indexManager.updateFile(op.syncId, {
      localPath: op.newPath,
      lastSyncTimestamp: new Date().toISOString(),
    });

    this.deps.syncLog.log("RENAME", op.localPath, `Renamed to ${op.newPath}`);
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
