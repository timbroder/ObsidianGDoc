import * as fs from "fs/promises";
import * as path from "path";
import { SyncLogEntry, SyncLogAction } from "@/types";
import { SYNC_DIR, SYNC_LOG_FILE, DEFAULT_MAX_LOG_ENTRIES } from "@/constants";
import { atomicWriteFile } from "@/utils/atomic-write";

export class SyncLog {
  private logPath: string;
  private maxEntries: number;
  private entries: SyncLogEntry[] = [];

  constructor(vaultPath: string, maxEntries: number = DEFAULT_MAX_LOG_ENTRIES) {
    this.logPath = path.join(vaultPath, SYNC_DIR, SYNC_LOG_FILE);
    this.maxEntries = maxEntries;
  }

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.logPath, "utf-8");
      const lines = data.trim().split("\n").filter(Boolean);
      // Parse line-by-line so one corrupt line doesn't lose the whole history.
      this.entries = [];
      for (const line of lines) {
        try {
          this.entries.push(JSON.parse(line));
        } catch {
          // Skip malformed line.
        }
      }
    } catch {
      this.entries = [];
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.logPath), { recursive: true });
    const data = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await atomicWriteFile(this.logPath, data);
  }

  log(action: SyncLogAction, file: string, result: string, details?: string): void {
    const entry: SyncLogEntry = {
      timestamp: new Date().toISOString(),
      action,
      file,
      result,
      details,
    };

    this.entries.push(entry);

    // FIFO cap
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
  }

  getEntries(): SyncLogEntry[] {
    return [...this.entries];
  }

  getRecentEntries(count: number): SyncLogEntry[] {
    return this.entries.slice(-count);
  }

  clear(): void {
    this.entries = [];
  }
}
