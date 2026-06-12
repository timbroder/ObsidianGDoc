import * as fs from "fs/promises";
import * as path from "path";
import { SyncIndex, SyncFileEntry, createEmptyIndex } from "@/types";
import { SYNC_DIR, INDEX_FILE } from "@/constants";
import { atomicWriteFile } from "@/utils/atomic-write";

export class IndexManager {
  private indexPath: string;
  private index: SyncIndex;

  // Reverse lookups, kept in sync with index.files. Maps are rebuilt on
  // load() and maintained incrementally by add/update/remove.
  private syncIdByPath: Map<string, string> = new Map();
  private syncIdByDriveId: Map<string, string> = new Map();

  constructor(vaultPath: string) {
    const syncDir = path.join(vaultPath, SYNC_DIR);
    this.indexPath = path.join(syncDir, INDEX_FILE);
    this.index = createEmptyIndex();
  }

  async load(): Promise<SyncIndex> {
    try {
      const data = await fs.readFile(this.indexPath, "utf-8");
      this.index = JSON.parse(data);
      if (!this.index.version || !this.index.files) {
        throw new Error("Invalid index format");
      }
      this.rebuildLookups();
      return this.index;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        this.index = createEmptyIndex();
        this.rebuildLookups();
        return this.index;
      }
      throw new IndexCorruptedError(
        `Failed to load index: ${err.message}`
      );
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.indexPath), { recursive: true });
    const data = JSON.stringify(this.index, null, 2);
    await atomicWriteFile(this.indexPath, data);
  }

  getIndex(): SyncIndex {
    return this.index;
  }

  getFile(syncId: string): SyncFileEntry | undefined {
    return this.index.files[syncId];
  }

  getFileByLocalPath(localPath: string): { syncId: string; entry: SyncFileEntry } | undefined {
    const syncId = this.syncIdByPath.get(localPath);
    if (syncId === undefined) return undefined;
    return { syncId, entry: this.index.files[syncId] };
  }

  getFileByDriveId(driveFileId: string): { syncId: string; entry: SyncFileEntry } | undefined {
    const syncId = this.syncIdByDriveId.get(driveFileId);
    if (syncId === undefined) return undefined;
    return { syncId, entry: this.index.files[syncId] };
  }

  addFile(syncId: string, entry: SyncFileEntry): void {
    this.index.files[syncId] = entry;
    this.syncIdByPath.set(entry.localPath, syncId);
    this.syncIdByDriveId.set(entry.driveFileId, syncId);
  }

  updateFile(syncId: string, updates: Partial<SyncFileEntry>): void {
    const existing = this.index.files[syncId];
    if (!existing) {
      throw new Error(`File not found in index: ${syncId}`);
    }
    if (updates.localPath !== undefined && updates.localPath !== existing.localPath) {
      this.syncIdByPath.delete(existing.localPath);
      this.syncIdByPath.set(updates.localPath, syncId);
    }
    if (updates.driveFileId !== undefined && updates.driveFileId !== existing.driveFileId) {
      this.syncIdByDriveId.delete(existing.driveFileId);
      this.syncIdByDriveId.set(updates.driveFileId, syncId);
    }
    this.index.files[syncId] = { ...existing, ...updates };
  }

  removeFile(syncId: string): void {
    const existing = this.index.files[syncId];
    if (existing) {
      this.syncIdByPath.delete(existing.localPath);
      this.syncIdByDriveId.delete(existing.driveFileId);
    }
    delete this.index.files[syncId];
  }

  addFolder(folderPath: string, driveFolderId: string): void {
    this.index.folders[folderPath] = driveFolderId;
  }

  removeFolder(folderPath: string): void {
    delete this.index.folders[folderPath];
  }

  getFolder(folderPath: string): string | undefined {
    return this.index.folders[folderPath];
  }

  /** Reverse lookup: Drive folder ID -> local folder path. */
  getFolderPathByDriveId(driveFolderId: string): string | undefined {
    for (const [folderPath, id] of Object.entries(this.index.folders)) {
      if (id === driveFolderId) return folderPath;
    }
    return undefined;
  }

  getFilesInFolder(folderPath: string): { syncId: string; entry: SyncFileEntry }[] {
    const prefix = folderPath.endsWith("/") ? folderPath : folderPath + "/";
    const results: { syncId: string; entry: SyncFileEntry }[] = [];
    for (const [syncId, entry] of Object.entries(this.index.files)) {
      if (entry.localPath.startsWith(prefix) || entry.localPath === folderPath) {
        results.push({ syncId, entry });
      }
    }
    return results;
  }

  getFailedConversions(): { syncId: string; entry: SyncFileEntry }[] {
    return Object.entries(this.index.files)
      .filter(([_, entry]) => entry.conversionFailed)
      .map(([syncId, entry]) => ({ syncId, entry }));
  }

  getAllFiles(): { syncId: string; entry: SyncFileEntry }[] {
    return Object.entries(this.index.files).map(([syncId, entry]) => ({
      syncId,
      entry,
    }));
  }

  setRootFolderId(id: string): void {
    this.index.rootFolderId = id;
  }

  setDeletedFolderId(id: string): void {
    this.index.deletedFolderId = id;
  }

  setDriveChangeToken(token: string): void {
    this.index.driveChangeToken = token;
  }

  getDriveChangeToken(): string {
    return this.index.driveChangeToken;
  }

  getFileCount(): number {
    return Object.keys(this.index.files).length;
  }

  private rebuildLookups(): void {
    this.syncIdByPath.clear();
    this.syncIdByDriveId.clear();
    for (const [syncId, entry] of Object.entries(this.index.files)) {
      this.syncIdByPath.set(entry.localPath, syncId);
      this.syncIdByDriveId.set(entry.driveFileId, syncId);
    }
  }
}

export class IndexCorruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexCorruptedError";
  }
}
