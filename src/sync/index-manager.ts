import * as fs from "fs/promises";
import * as path from "path";
import { SyncIndex, SyncFileEntry, createEmptyIndex } from "@/types";
import { SYNC_DIR, INDEX_FILE, INDEX_TMP_FILE } from "@/constants";

export class IndexManager {
  private indexPath: string;
  private tmpPath: string;
  private index: SyncIndex;

  constructor(vaultPath: string) {
    const syncDir = path.join(vaultPath, SYNC_DIR);
    this.indexPath = path.join(syncDir, INDEX_FILE);
    this.tmpPath = path.join(syncDir, INDEX_TMP_FILE);
    this.index = createEmptyIndex();
  }

  async load(): Promise<SyncIndex> {
    try {
      const data = await fs.readFile(this.indexPath, "utf-8");
      this.index = JSON.parse(data);
      if (!this.index.version || !this.index.files) {
        throw new Error("Invalid index format");
      }
      return this.index;
    } catch (err: any) {
      if (err.code === "ENOENT") {
        this.index = createEmptyIndex();
        return this.index;
      }
      throw new IndexCorruptedError(
        `Failed to load index: ${err.message}`
      );
    }
  }

  async save(): Promise<void> {
    const data = JSON.stringify(this.index, null, 2);
    await fs.writeFile(this.tmpPath, data, "utf-8");
    await fs.rename(this.tmpPath, this.indexPath);
  }

  getIndex(): SyncIndex {
    return this.index;
  }

  getFile(syncId: string): SyncFileEntry | undefined {
    return this.index.files[syncId];
  }

  getFileBySyncId(syncId: string): SyncFileEntry | undefined {
    return this.index.files[syncId];
  }

  getFileByLocalPath(localPath: string): { syncId: string; entry: SyncFileEntry } | undefined {
    for (const [syncId, entry] of Object.entries(this.index.files)) {
      if (entry.localPath === localPath) {
        return { syncId, entry };
      }
    }
    return undefined;
  }

  getFileByDriveId(driveFileId: string): { syncId: string; entry: SyncFileEntry } | undefined {
    for (const [syncId, entry] of Object.entries(this.index.files)) {
      if (entry.driveFileId === driveFileId) {
        return { syncId, entry };
      }
    }
    return undefined;
  }

  addFile(syncId: string, entry: SyncFileEntry): void {
    this.index.files[syncId] = entry;
  }

  updateFile(syncId: string, updates: Partial<SyncFileEntry>): void {
    const existing = this.index.files[syncId];
    if (!existing) {
      throw new Error(`File not found in index: ${syncId}`);
    }
    this.index.files[syncId] = { ...existing, ...updates };
  }

  removeFile(syncId: string): void {
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
}

export class IndexCorruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IndexCorruptedError";
  }
}
