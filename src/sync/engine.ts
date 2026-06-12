import { Notice } from "obsidian";
import { SyncStatus, DriveFile } from "@/types";
import { IndexManager } from "./index-manager";
import { ChangeDetector } from "./change-detector";
import { DirtyTracker } from "./dirty-tracker";
import { SyncPlanner, RemoteState } from "./planner";
import { SyncExecutor } from "./executor";
import { SyncLog } from "./sync-log";
import { DriveAPI } from "@/google/drive";
import { DocsAPI } from "@/google/docs";
import { isOnline } from "@/utils/network";
import { isExcluded } from "@/utils/glob";

export type SyncMode = "full" | "push" | "pull";

export interface SyncOptions {
  mode?: SyncMode;
  manual?: boolean;
}

export interface SyncEngineConfig {
  vaultPath: string;
  driveApi: DriveAPI;
  docsApi: DocsAPI;
  indexManager: IndexManager;
  changeDetector: ChangeDetector;
  dirtyTracker: DirtyTracker;
  syncLog: SyncLog;
  /** Effective exclusion patterns (always-excluded + user patterns). */
  exclusionPatterns: string[];
  maxFileSizeBytes: number;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  deleteFile: (filePath: string) => Promise<void>;
  renameFile: (oldPath: string, newPath: string) => Promise<void>;
  createFolder: (folderPath: string) => Promise<void>;
  getVaultFiles: () => Promise<Map<string, string>>;
  promptConflict: (local: string, remote: string, filePath: string) => Promise<"keep-local" | "keep-remote" | "open-in-editor" | "skip">;
  promptRemoteDeletion: (filePath: string) => Promise<"yes" | "no" | "ignore">;
  onStatusChange: (status: SyncStatus) => void;
}

const PUSH_MODE_OPS = new Set([
  "PUSH",
  "NEW_LOCAL",
  "LOCAL_DELETE",
  "LOCAL_RENAME",
  "LOCAL_MOVE",
  "MERGE",
]);

const PULL_MODE_OPS = new Set([
  "PULL",
  "NEW_REMOTE",
  "REMOTE_DELETE",
  "REMOTE_RENAME",
  "REMOTE_MOVE",
  "MERGE",
  "SKIP",
]);

export class SyncEngine {
  private config: SyncEngineConfig;
  private syncing = false;
  private status: SyncStatus = "idle";

  constructor(config: SyncEngineConfig) {
    this.config = config;
  }

  async syncAll(options: SyncOptions = {}): Promise<void> {
    if (this.syncing) {
      return; // Skip - dirty set preserves changes for next cycle
    }

    const mode = options.mode ?? "full";
    const isManualSync = options.manual ?? false;

    this.syncing = true;
    this.setStatus("syncing");

    // Drained up-front so we can restore it if the sync fails wholesale.
    const dirtyFiles = this.config.dirtyTracker.drain();

    try {
      // Pre-flight: check online
      const online = await isOnline();
      if (!online) {
        this.config.dirtyTracker.restore(dirtyFiles);
        this.setStatus("offline");
        if (isManualSync) {
          new Notice("No internet connection. Changes will sync when connectivity is restored.");
        }
        return;
      }

      // Step 1: Pull remote state. In push mode the change token is NOT
      // advanced — otherwise remote changes whose PULL operations we filter
      // out below would be consumed and lost forever.
      const remoteState = await this.pullRemoteState(mode !== "push");

      // Step 2: Compute local state
      const dirtyPaths = new Set(dirtyFiles.keys());
      const localFiles = this.filterSyncable(await this.config.getVaultFiles());

      // For manual sync or startup, check all files; for timer, only dirty
      const filesToCheck = isManualSync ? undefined : dirtyPaths;
      const localChanges = this.config.changeDetector.detectChanges(
        localFiles,
        filesToCheck
      );

      // Step 3: Build plan
      const planner = new SyncPlanner(this.config.indexManager);
      const plan = planner.buildPlan(localChanges, remoteState, dirtyFiles);

      if (mode !== "full") {
        const allowed = mode === "push" ? PUSH_MODE_OPS : PULL_MODE_OPS;
        plan.operations = plan.operations.filter((op) => allowed.has(op.type));
      }

      if (mode === "pull") {
        // Local-side operations were filtered out; keep their dirty entries
        // so a later push/full sync still picks them up.
        this.config.dirtyTracker.restore(dirtyFiles);
      }

      if (plan.operations.length === 0) {
        this.setStatus("idle");
        return;
      }

      // Step 4: Execute
      const executor = new SyncExecutor({
        driveApi: this.config.driveApi,
        docsApi: this.config.docsApi,
        indexManager: this.config.indexManager,
        syncLog: this.config.syncLog,
        vaultPath: this.config.vaultPath,
        readFile: this.config.readFile,
        writeFile: this.config.writeFile,
        deleteFile: this.config.deleteFile,
        renameFile: this.config.renameFile,
        createFolder: this.config.createFolder,
        markDirty: (filePath) => this.config.dirtyTracker.addToDirtySet(filePath),
        promptConflict: this.config.promptConflict,
        promptRemoteDeletion: this.config.promptRemoteDeletion,
      });

      const result = await executor.executePlan(plan);

      // Failed operations stay dirty so the next cycle retries them.
      for (const failedPath of result.failedPaths) {
        this.config.dirtyTracker.addToDirtySet(failedPath);
      }

      // Step 5: Post-sync
      await this.config.indexManager.save();
      await this.config.syncLog.save();

      if (result.failed > 0) {
        this.setStatus("error");
      } else {
        this.setStatus("idle");
      }
    } catch (err: any) {
      // Whole-sync failure: nothing was consumed, so restore the dirty set.
      this.config.dirtyTracker.restore(dirtyFiles);
      this.config.syncLog.log("ERROR", "", `Sync failed: ${err.message}`);
      this.setStatus("error");
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Drop files that should never sync: non-markdown, excluded by glob, or
   * over the size limit. This is the canonical filter — DirtyTracker also
   * excludes by glob, but manual syncs scan the whole vault and must not
   * bypass it.
   */
  private filterSyncable(files: Map<string, string>): Map<string, string> {
    const filtered = new Map<string, string>();
    for (const [filePath, content] of files) {
      if (!filePath.endsWith(".md")) continue;
      if (isExcluded(filePath, this.config.exclusionPatterns)) continue;
      if (Buffer.byteLength(content, "utf-8") > this.config.maxFileSizeBytes) {
        this.config.syncLog.log("SKIP", filePath, "File exceeds max size");
        continue;
      }
      filtered.set(filePath, content);
    }
    return filtered;
  }

  private async pullRemoteState(advanceToken: boolean): Promise<RemoteState> {
    const changeToken = this.config.indexManager.getDriveChangeToken();
    const changedFiles = new Map<string, DriveFile>();
    const removedFileIds = new Set<string>();

    if (changeToken) {
      // Walk every page of the changes feed. newStartPageToken is only
      // present on the final page.
      let pageToken: string | undefined = changeToken;
      let newStartToken = "";

      while (pageToken) {
        const page = await this.config.driveApi.getChanges(pageToken);
        for (const change of page.changes) {
          if (change.removed || change.file?.trashed) {
            removedFileIds.add(change.fileId);
          } else if (change.file) {
            changedFiles.set(change.fileId, change.file);
          }
        }
        if (page.nextPageToken) {
          pageToken = page.nextPageToken;
        } else {
          newStartToken = page.newStartPageToken;
          pageToken = undefined;
        }
      }

      if (advanceToken && newStartToken) {
        this.config.indexManager.setDriveChangeToken(newStartToken);
      }
      return { changedFiles, removedFileIds };
    }

    // First sync or no token — list the whole tree recursively.
    let allRemoteFiles: Map<string, DriveFile> | undefined;
    const rootFolderId = this.config.indexManager.getIndex().rootFolderId;
    if (rootFolderId) {
      const files = await this.config.driveApi.listAllFilesRecursive(rootFolderId);
      for (const file of files) {
        changedFiles.set(file.id, file);
      }
      allRemoteFiles = new Map(changedFiles);
    }
    // Get initial page token for future incremental syncs
    const token = await this.config.driveApi.getStartPageToken();
    this.config.indexManager.setDriveChangeToken(token);

    return { changedFiles, removedFileIds, allRemoteFiles };
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.config.onStatusChange(status);
  }
}
