import { SyncOperation, SyncOperationType, SyncPlan, SyncFileEntry, DriveFile, DirtyFileEntry } from "@/types";
import { GOOGLE_DOC_MIME_TYPE, GOOGLE_FOLDER_MIME_TYPE } from "@/constants";
import { IndexManager } from "./index-manager";
import { ChangeDetectionResult } from "./change-detector";

export interface RemoteState {
  /** Files reported changed by the Drive changes feed (or full listing). */
  changedFiles: Map<string, DriveFile>;
  /** File IDs reported removed or trashed by the changes feed. */
  removedFileIds?: Set<string>;
  /** Full remote listing, when available (first sync). */
  allRemoteFiles?: Map<string, DriveFile>;
}

export class SyncPlanner {
  private indexManager: IndexManager;

  constructor(indexManager: IndexManager) {
    this.indexManager = indexManager;
  }

  buildPlan(
    localChanges: ChangeDetectionResult,
    remoteState: RemoteState,
    dirtyFiles?: Map<string, DirtyFileEntry>
  ): SyncPlan {
    const operations: SyncOperation[] = [];
    const processedSyncIds = new Set<string>();
    const index = this.indexManager.getIndex();

    // ------------------------------------------------------------------
    // 1. Local renames, derived from dirty-tracker metadata. These must be
    //    planned explicitly — otherwise a rename degrades into
    //    LOCAL_DELETE + NEW_LOCAL, destroying the Google Doc's history.
    // ------------------------------------------------------------------
    const renamedSyncIds = new Set<string>();
    const renameOpsByNewPath = new Map<string, SyncOperation>();

    if (dirtyFiles) {
      for (const dirty of dirtyFiles.values()) {
        if (dirty.type !== "rename" || !dirty.oldPath) continue;
        const tracked = this.indexManager.getFileByLocalPath(dirty.oldPath);
        if (!tracked) continue;
        const op: SyncOperation = {
          type: "LOCAL_RENAME",
          syncId: tracked.syncId,
          localPath: dirty.oldPath,
          newPath: dirty.path,
        };
        operations.push(op);
        renamedSyncIds.add(tracked.syncId);
        renameOpsByNewPath.set(dirty.path, op);
      }
    }

    // ------------------------------------------------------------------
    // 2. Locally changed tracked files → PUSH, or MERGE when the remote
    //    side also has a genuinely newer change (not an echo of our own
    //    last push).
    // ------------------------------------------------------------------
    for (const { syncId, entry } of localChanges.changed) {
      processedSyncIds.add(syncId);

      // Locally modified but deleted/trashed remotely: pushing would write
      // into a trashed doc. Surface the deletion instead — declining it
      // drops the index entry, so the next sync recreates the doc.
      if (remoteState.removedFileIds?.has(entry.driveFileId)) {
        operations.push({
          type: "REMOTE_DELETE",
          syncId,
          localPath: entry.localPath,
        });
        continue;
      }

      const remoteFile = remoteState.changedFiles.get(entry.driveFileId);
      const remoteChanged =
        remoteFile !== undefined && this.isRemoteNewer(entry, remoteFile);

      operations.push({
        type: remoteChanged ? "MERGE" : "PUSH",
        syncId,
        localPath: entry.localPath,
        driveFile: remoteFile,
      });
    }

    // ------------------------------------------------------------------
    // 3. Locally deleted tracked files (skipping renames, whose old path
    //    also reads as "deleted" to the change detector).
    // ------------------------------------------------------------------
    for (const { syncId, entry } of localChanges.deleted) {
      processedSyncIds.add(syncId);
      if (renamedSyncIds.has(syncId)) continue;
      operations.push({
        type: "LOCAL_DELETE",
        syncId,
        localPath: entry.localPath,
      });
    }

    // ------------------------------------------------------------------
    // 4. Untracked remote files → NEW_REMOTE. Folder paths are resolved
    //    first (new folders may nest inside other new folders); files whose
    //    parents can't be resolved are outside the synced tree and ignored.
    // ------------------------------------------------------------------
    const folderPathById = new Map<string, string>();
    folderPathById.set(index.rootFolderId, "");
    for (const [folderPath, id] of Object.entries(index.folders)) {
      folderPathById.set(id, folderPath);
    }

    const newRemoteFolders: DriveFile[] = [];
    const newRemoteDocs: DriveFile[] = [];
    for (const [driveFileId, driveFile] of remoteState.changedFiles) {
      if (this.indexManager.getFileByDriveId(driveFileId)) continue;
      if (driveFile.mimeType === GOOGLE_FOLDER_MIME_TYPE) {
        if (!folderPathById.has(driveFile.id)) {
          newRemoteFolders.push(driveFile);
        }
      } else if (driveFile.mimeType === GOOGLE_DOC_MIME_TYPE) {
        newRemoteDocs.push(driveFile);
      }
      // Other mime types (uploads, shortcuts, …) are not synced.
    }

    // Resolve folder paths iteratively until no progress is possible.
    const unresolved = [...newRemoteFolders];
    let progress = true;
    while (progress && unresolved.length > 0) {
      progress = false;
      for (let i = unresolved.length - 1; i >= 0; i--) {
        const folder = unresolved[i];
        const parentId = folder.parents?.[0];
        if (!parentId || !folderPathById.has(parentId)) continue;
        const parentPath = folderPathById.get(parentId)!;
        const folderPath = parentPath ? `${parentPath}/${folder.name}` : folder.name;
        folderPathById.set(folder.id, folderPath);
        operations.push({
          type: "NEW_REMOTE",
          syncId: this.generateSyncId(),
          localPath: folderPath,
          driveFile: folder,
        });
        unresolved.splice(i, 1);
        progress = true;
      }
    }

    const newLocalPaths = new Set(localChanges.newFiles.map((f) => f.path));
    const collidedPaths = new Set<string>();

    for (const doc of newRemoteDocs) {
      const parentId = doc.parents?.[0];
      if (!parentId || !folderPathById.has(parentId)) continue; // outside tree
      const dir = folderPathById.get(parentId)!;
      const name = doc.name.endsWith(".md") ? doc.name : `${doc.name}.md`;
      const localPath = dir ? `${dir}/${name}` : name;

      if (newLocalPaths.has(localPath) || renameOpsByNewPath.has(localPath)) {
        // An untracked local file and a new remote doc claim the same path.
        // Don't pick a side automatically — surface it and let the user act.
        collidedPaths.add(localPath);
        operations.push({
          type: "SKIP",
          syncId: this.generateSyncId(),
          localPath,
          driveFile: doc,
        });
        continue;
      }

      operations.push({
        type: "NEW_REMOTE",
        syncId: this.generateSyncId(),
        localPath,
        driveFile: doc,
      });
    }

    // ------------------------------------------------------------------
    // 5. New local files → NEW_LOCAL. Skips rename targets (handled above;
    //    a PUSH is added when the content changed during the rename) and
    //    path collisions with new remote docs.
    // ------------------------------------------------------------------
    for (const { path: filePath, hash } of localChanges.newFiles) {
      if (collidedPaths.has(filePath)) continue;

      const renameOp = renameOpsByNewPath.get(filePath);
      if (renameOp) {
        const entry = this.indexManager.getFile(renameOp.syncId);
        if (entry && hash !== entry.localContentHash) {
          operations.push({
            type: "PUSH",
            syncId: renameOp.syncId,
            localPath: filePath,
          });
        }
        continue;
      }

      operations.push({
        type: "NEW_LOCAL",
        syncId: this.generateSyncId(),
        localPath: filePath,
      });
    }

    // ------------------------------------------------------------------
    // 6. Tracked remote changes not already handled → REMOTE_RENAME / PULL.
    //    Changes not newer than our own last write are echoes and skipped.
    // ------------------------------------------------------------------
    for (const [driveFileId, driveFile] of remoteState.changedFiles) {
      const tracked = this.indexManager.getFileByDriveId(driveFileId);
      if (!tracked) continue;
      if (processedSyncIds.has(tracked.syncId)) continue;
      if (renamedSyncIds.has(tracked.syncId)) continue;
      if (!this.isRemoteNewer(tracked.entry, driveFile)) continue;

      processedSyncIds.add(tracked.syncId);

      const currentTitle = driveFile.name.replace(/\.md$/, "");
      const storedBasename = tracked.entry.localPath
        .split("/")
        .pop()
        ?.replace(/\.md$/, "");

      if (currentTitle !== storedBasename) {
        const newPath = this.computeRenamedPath(
          tracked.entry.localPath,
          driveFile.name
        );
        operations.push({
          type: "REMOTE_RENAME",
          syncId: tracked.syncId,
          localPath: tracked.entry.localPath,
          newPath,
          driveFile,
        });
        // Content may have changed alongside the rename; pull at the new
        // path (a no-op rewrite when the content is unchanged).
        operations.push({
          type: "PULL",
          syncId: tracked.syncId,
          localPath: newPath,
          driveFile,
        });
      } else {
        operations.push({
          type: "PULL",
          syncId: tracked.syncId,
          localPath: tracked.entry.localPath,
          driveFile,
        });
      }
    }

    // ------------------------------------------------------------------
    // 7. Remote deletions: explicit removals/trashes from the changes feed,
    //    plus (on full listings) tracked files absent from the remote.
    // ------------------------------------------------------------------
    if (remoteState.removedFileIds) {
      for (const fileId of remoteState.removedFileIds) {
        const tracked = this.indexManager.getFileByDriveId(fileId);
        if (!tracked || processedSyncIds.has(tracked.syncId)) continue;
        processedSyncIds.add(tracked.syncId);
        operations.push({
          type: "REMOTE_DELETE",
          syncId: tracked.syncId,
          localPath: tracked.entry.localPath,
        });
      }
    }

    if (remoteState.allRemoteFiles) {
      const remoteFileIds = new Set(remoteState.allRemoteFiles.keys());
      for (const { syncId, entry } of this.indexManager.getAllFiles()) {
        if (processedSyncIds.has(syncId)) continue;
        if (!remoteFileIds.has(entry.driveFileId)) {
          operations.push({
            type: "REMOTE_DELETE",
            syncId,
            localPath: entry.localPath,
          });
        }
      }
    }

    // Sort operations: folders first, renames, creates, content, deletes last
    const sortedOps = this.sortOperations(operations);

    return {
      operations: sortedOps,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * True when the remote change is genuinely newer than the last write we
   * made (or observed) ourselves. Guards against the changes feed echoing
   * our own pushes back to us. Missing bookkeeping is treated as "newer"
   * so we err toward a merge rather than silently ignoring an edit.
   */
  private isRemoteNewer(entry: SyncFileEntry, driveFile: DriveFile): boolean {
    if (!entry.lastRemoteModifiedTime) return true;
    return driveFile.modifiedTime > entry.lastRemoteModifiedTime;
  }

  private generateSyncId(): string {
    return crypto.randomUUID();
  }

  private sortOperations(operations: SyncOperation[]): SyncOperation[] {
    const priority: Record<SyncOperationType, number> = {
      LOCAL_MOVE: 0,
      REMOTE_MOVE: 0,
      LOCAL_RENAME: 1,
      REMOTE_RENAME: 1,
      NEW_LOCAL: 3,
      NEW_REMOTE: 3,
      PUSH: 4,
      PULL: 4,
      MERGE: 4,
      SKIP: 5,
      LOCAL_DELETE: 6,
      REMOTE_DELETE: 6,
    };

    // New remote folders must be created before files inside them.
    const opPriority = (op: SyncOperation): number => {
      if (
        op.type === "NEW_REMOTE" &&
        op.driveFile?.mimeType === GOOGLE_FOLDER_MIME_TYPE
      ) {
        return 2;
      }
      return priority[op.type] ?? 5;
    };

    return [...operations].sort((a, b) => opPriority(a) - opPriority(b));
  }

  private computeRenamedPath(
    currentLocalPath: string,
    newRemoteName: string
  ): string {
    const dir = currentLocalPath.includes("/")
      ? currentLocalPath.substring(0, currentLocalPath.lastIndexOf("/"))
      : "";
    const newName = newRemoteName.endsWith(".md")
      ? newRemoteName
      : newRemoteName + ".md";
    return dir ? `${dir}/${newName}` : newName;
  }
}
