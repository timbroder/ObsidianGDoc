import { SyncStatus } from "@/types";

export class RibbonManager {
  private ribbonEl: HTMLElement;

  constructor(ribbonEl: HTMLElement) {
    this.ribbonEl = ribbonEl;
    this.update("idle");
  }

  update(status: SyncStatus): void {
    // Remove all state classes
    this.ribbonEl.classList.remove(
      "gdocs-sync-idle",
      "gdocs-sync-syncing",
      "gdocs-sync-error",
      "gdocs-sync-conflict",
      "gdocs-sync-offline"
    );

    switch (status) {
      case "idle":
        this.ribbonEl.classList.add("gdocs-sync-idle");
        break;
      case "syncing":
        this.ribbonEl.classList.add("gdocs-sync-syncing");
        break;
      case "error":
        this.ribbonEl.classList.add("gdocs-sync-error");
        break;
      case "conflict":
        this.ribbonEl.classList.add("gdocs-sync-conflict");
        break;
      case "offline":
        this.ribbonEl.classList.add("gdocs-sync-offline");
        break;
    }
  }
}
