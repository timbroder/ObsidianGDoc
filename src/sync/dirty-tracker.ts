import { TFile, TAbstractFile, Vault } from "obsidian";
import { isExcluded, getEffectiveExclusions } from "@/utils/glob";
import { DirtyFileEntry } from "@/types";

export class DirtyTracker {
  private dirtyFiles: Map<string, DirtyFileEntry> = new Map();
  private exclusionPatterns: string[];
  private vault: Vault;
  private eventRefs: any[] = [];

  constructor(vault: Vault, userExclusions: string[]) {
    this.vault = vault;
    this.exclusionPatterns = getEffectiveExclusions(userExclusions);

    const onModify = (file: TAbstractFile) => {
      if (file instanceof TFile) this.markDirty(file.path, "modify");
    };
    const onCreate = (file: TAbstractFile) => {
      if (file instanceof TFile) this.markDirty(file.path, "create");
    };
    const onDelete = (file: TAbstractFile) => {
      if (file instanceof TFile) this.markDirty(file.path, "delete");
    };
    const onRename = (file: TAbstractFile, oldPath: string) => {
      if (file instanceof TFile) {
        this.markDirty(oldPath, "delete");
        this.markDirty(file.path, "rename", oldPath);
      }
    };

    this.eventRefs.push(vault.on("modify", onModify));
    this.eventRefs.push(vault.on("create", onCreate));
    this.eventRefs.push(vault.on("delete", onDelete));
    this.eventRefs.push(vault.on("rename", onRename));
  }

  private markDirty(
    filePath: string,
    type: DirtyFileEntry["type"],
    oldPath?: string
  ): void {
    if (isExcluded(filePath, this.exclusionPatterns)) {
      return;
    }

    this.dirtyFiles.set(filePath, {
      path: filePath,
      type,
      oldPath,
      timestamp: Date.now(),
    });
  }

  drain(): Map<string, DirtyFileEntry> {
    const snapshot = new Map(this.dirtyFiles);
    this.dirtyFiles.clear();
    return snapshot;
  }

  getDirtyPaths(): Set<string> {
    return new Set(this.dirtyFiles.keys());
  }

  isDirty(filePath: string): boolean {
    return this.dirtyFiles.has(filePath);
  }

  size(): number {
    return this.dirtyFiles.size;
  }

  addToDirtySet(filePath: string): void {
    this.markDirty(filePath, "modify");
  }

  unload(): void {
    for (const ref of this.eventRefs) {
      // Support both real Obsidian API (offref) and mock ({unload})
      if (typeof (this.vault as any).offref === "function") {
        (this.vault as any).offref(ref);
      } else if (ref && typeof ref.unload === "function") {
        ref.unload();
      }
    }
    this.eventRefs = [];
    this.dirtyFiles.clear();
  }
}
