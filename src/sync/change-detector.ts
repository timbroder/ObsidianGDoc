import { sha256 } from "@/utils/hash";
import { IndexManager } from "./index-manager";
import { SyncFileEntry } from "@/types";

export interface LocalFileState {
  path: string;
  content: string;
  hash: string;
}

export interface ChangeDetectionResult {
  changed: { syncId: string; entry: SyncFileEntry; newHash: string }[];
  deleted: { syncId: string; entry: SyncFileEntry }[];
  newFiles: { path: string; hash: string }[];
}

export class ChangeDetector {
  private indexManager: IndexManager;

  constructor(indexManager: IndexManager) {
    this.indexManager = indexManager;
  }

  detectChanges(
    localFiles: Map<string, string>,
    filesToCheck?: Set<string>
  ): ChangeDetectionResult {
    const result: ChangeDetectionResult = {
      changed: [],
      deleted: [],
      newFiles: [],
    };

    const trackedFiles = this.indexManager.getAllFiles();
    const trackedPaths = new Set(trackedFiles.map((f) => f.entry.localPath));

    // Check tracked files for changes and deletions
    for (const { syncId, entry } of trackedFiles) {
      // If we have a specific set to check and this file isn't in it,
      // and it still exists, skip it
      if (filesToCheck && !filesToCheck.has(entry.localPath)) {
        if (localFiles.has(entry.localPath)) {
          continue; // file exists and not in dirty set - skip
        }
        // file doesn't exist - could be deleted, fall through
      }

      const content = localFiles.get(entry.localPath);
      if (content === undefined) {
        // File no longer exists on disk
        result.deleted.push({ syncId, entry });
      } else {
        const newHash = sha256(content);
        if (newHash !== entry.localContentHash) {
          result.changed.push({ syncId, entry, newHash });
        }
      }
    }

    // Find new files (exist on disk but not in index)
    for (const [filePath, content] of localFiles) {
      if (!trackedPaths.has(filePath)) {
        result.newFiles.push({ path: filePath, hash: sha256(content) });
      }
    }

    return result;
  }

  computeHash(content: string): string {
    return sha256(content);
  }
}
