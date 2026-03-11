import { SyncOperation, SyncOperationType, SyncPlan, SyncFileEntry, DriveFile } from "@/types";
import { IndexManager } from "./index-manager";
import { ChangeDetectionResult } from "./change-detector";

export interface RemoteState {
  changedFiles: Map<string, DriveFile>;
  allRemoteFiles?: Map<string, DriveFile>;
}

export class SyncPlanner {
  private indexManager: IndexManager;

  constructor(indexManager: IndexManager) {
    this.indexManager = indexManager;
  }

  buildPlan(
    localChanges: ChangeDetectionResult,
    remoteState: RemoteState
  ): SyncPlan {
    const operations: SyncOperation[] = [];
    const processedSyncIds = new Set<string>();

    // Handle locally changed files
    for (const { syncId, entry, newHash } of localChanges.changed) {
      processedSyncIds.add(syncId);
      const remoteChanged = remoteState.changedFiles.has(entry.driveFileId);

      if (remoteChanged) {
        operations.push({
          type: "MERGE",
          syncId,
          localPath: entry.localPath,
        });
      } else {
        // Check for rename/move
        const currentPath = entry.localPath;
        operations.push({
          type: "PUSH",
          syncId,
          localPath: currentPath,
        });
      }
    }

    // Handle locally deleted files
    for (const { syncId, entry } of localChanges.deleted) {
      processedSyncIds.add(syncId);
      operations.push({
        type: "LOCAL_DELETE",
        syncId,
        localPath: entry.localPath,
      });
    }

    // Handle new local files
    for (const { path: filePath } of localChanges.newFiles) {
      const syncId = crypto.randomUUID();
      operations.push({
        type: "NEW_LOCAL",
        syncId,
        localPath: filePath,
      });
    }

    // Handle remote changes not already processed
    for (const [driveFileId, driveFile] of remoteState.changedFiles) {
      const tracked = this.indexManager.getFileByDriveId(driveFileId);

      if (!tracked) {
        // New remote file
        operations.push({
          type: "NEW_REMOTE",
          syncId: crypto.randomUUID(),
          localPath: driveFile.name,
          remotePath: driveFile.name,
        });
        continue;
      }

      if (processedSyncIds.has(tracked.syncId)) {
        continue; // Already handled as MERGE above
      }

      // Check for remote rename
      const currentTitle = driveFile.name.replace(/\.md$/, "");
      const storedBasename = tracked.entry.localPath
        .split("/")
        .pop()
        ?.replace(/\.md$/, "");

      if (currentTitle !== storedBasename) {
        operations.push({
          type: "REMOTE_RENAME",
          syncId: tracked.syncId,
          localPath: tracked.entry.localPath,
          newPath: this.computeRenamedPath(
            tracked.entry.localPath,
            driveFile.name
          ),
        });
      } else {
        operations.push({
          type: "PULL",
          syncId: tracked.syncId,
          localPath: tracked.entry.localPath,
        });
      }
    }

    // Handle remote deletions: files in index but not in remote
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

  private sortOperations(operations: SyncOperation[]): SyncOperation[] {
    const priority: Record<SyncOperationType, number> = {
      LOCAL_MOVE: 0,
      REMOTE_MOVE: 0,
      LOCAL_RENAME: 1,
      REMOTE_RENAME: 1,
      NEW_LOCAL: 2,
      NEW_REMOTE: 2,
      PUSH: 3,
      PULL: 3,
      MERGE: 3,
      SKIP: 4,
      LOCAL_DELETE: 5,
      REMOTE_DELETE: 5,
    };

    return [...operations].sort(
      (a, b) => (priority[a.type] ?? 4) - (priority[b.type] ?? 4)
    );
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
