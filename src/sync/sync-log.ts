import * as fs from "fs/promises";
import * as path from "path";
import { SyncLogEntry, SyncLogAction } from "@/types";
import { SYNC_DIR, SYNC_LOG_FILE, DEFAULT_MAX_LOG_ENTRIES } from "@/constants";

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
      this.entries = lines.map((line) => JSON.parse(line));
    } catch {
      this.entries = [];
    }
  }

  async save(): Promise<void> {
    const data = this.entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.writeFile(this.logPath, data, "utf-8");
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
