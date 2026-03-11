import { Notice } from "obsidian";
import { SyncStatus, SyncPlan } from "@/types";
import { IndexManager } from "./index-manager";
import { ChangeDetector } from "./change-detector";
import { DirtyTracker } from "./dirty-tracker";
import { SyncPlanner, RemoteState } from "./planner";
import { SyncExecutor, ExecutorDeps } from "./executor";
import { SyncLog } from "./sync-log";
import { DriveAPI } from "@/google/drive";
import { DocsAPI } from "@/google/docs";
import { isOnline } from "@/utils/network";
import { SYNC_DIR } from "@/constants";
import * as path from "path";

export interface SyncEngineConfig {
  vaultPath: string;
  driveApi: DriveAPI;
  docsApi: DocsAPI;
  indexManager: IndexManager;
  changeDetector: ChangeDetector;
  dirtyTracker: DirtyTracker;
  syncLog: SyncLog;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  deleteFile: (filePath: string) => Promise<void>;
  renameFile: (oldPath: string, newPath: string) => Promise<void>;
  getVaultFiles: () => Map<string, string>;
  promptConflict: (local: string, remote: string, filePath: string) => Promise<"keep-local" | "keep-remote" | "open-in-editor">;
  promptRemoteDeletion: (filePath: string) => Promise<"yes" | "no" | "ignore">;
  onStatusChange: (status: SyncStatus) => void;
}

export class SyncEngine {
  private config: SyncEngineConfig;
  private syncing = false;
  private status: SyncStatus = "idle";

  constructor(config: SyncEngineConfig) {
    this.config = config;
  }

  async syncAll(isManualSync: boolean = false): Promise<void> {
    if (this.syncing) {
      return; // Skip - dirty set preserves changes for next cycle
    }

    this.syncing = true;
    this.setStatus("syncing");

    try {
      // Pre-flight: check online
      const online = await isOnline();
      if (!online) {
        this.setStatus("offline");
        if (isManualSync) {
          new Notice("No internet connection. Changes will sync when connectivity is restored.");
        }
        return;
      }

      // Step 1: Pull remote state
      const remoteState = await this.pullRemoteState();

      // Step 2: Compute local state
      const dirtyFiles = this.config.dirtyTracker.drain();
      const dirtyPaths = new Set(dirtyFiles.keys());
      const localFiles = this.config.getVaultFiles();

      // For manual sync or startup, check all files; for timer, only dirty
      const filesToCheck = isManualSync ? undefined : dirtyPaths;
      const localChanges = this.config.changeDetector.detectChanges(
        localFiles,
        filesToCheck
      );

      // Step 3: Build plan
      const planner = new SyncPlanner(this.config.indexManager);
      const plan = planner.buildPlan(localChanges, remoteState);

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
        promptConflict: this.config.promptConflict,
        promptRemoteDeletion: this.config.promptRemoteDeletion,
      });

      const result = await executor.executePlan(plan);

      // Step 5: Post-sync
      await this.config.indexManager.save();
      await this.config.syncLog.save();

      if (result.failed > 0) {
        this.setStatus("error");
      } else {
        this.setStatus("idle");
      }
    } catch (err: any) {
      this.config.syncLog.log("ERROR", "", `Sync failed: ${err.message}`);
      this.setStatus("error");
    } finally {
      this.syncing = false;
    }
  }

  private async pullRemoteState(): Promise<RemoteState> {
    const changeToken = this.config.indexManager.getDriveChangeToken();
    const changedFiles = new Map();

    if (changeToken) {
      const changes = await this.config.driveApi.getChanges(changeToken);
      for (const change of changes.changes) {
        if (change.file && !change.removed) {
          changedFiles.set(change.fileId, change.file);
        }
      }
      this.config.indexManager.setDriveChangeToken(changes.newStartPageToken);
    } else {
      // First sync or no token — list all files
      const rootFolderId = this.config.indexManager.getIndex().rootFolderId;
      if (rootFolderId) {
        const files = await this.config.driveApi.listAllFiles(rootFolderId);
        for (const file of files) {
          changedFiles.set(file.id, file);
        }
      }
      // Get initial page token for future incremental syncs
      const token = await this.config.driveApi.getStartPageToken();
      this.config.indexManager.setDriveChangeToken(token);
    }

    return { changedFiles };
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
