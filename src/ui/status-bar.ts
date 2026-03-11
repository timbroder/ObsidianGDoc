import { SyncStatus } from "@/types";

export class StatusBarManager {
  private statusBarEl: HTMLElement;

  constructor(statusBarEl: HTMLElement) {
    this.statusBarEl = statusBarEl;
    this.update("idle");
  }

  update(status: SyncStatus, pendingCount: number = 0): void {
    switch (status) {
      case "idle":
        this.statusBarEl.setText("GDocs: Synced \u2713");
        break;
      case "syncing":
        this.statusBarEl.setText("GDocs: Syncing...");
        break;
      case "error":
        this.statusBarEl.setText("GDocs: Error");
        break;
      case "conflict":
        this.statusBarEl.setText("GDocs: 1 conflict");
        break;
      case "offline":
        this.statusBarEl.setText(
          pendingCount > 0
            ? `GDocs: Offline (${pendingCount} pending)`
            : "GDocs: Offline"
        );
        break;
      case "auth-required":
        this.statusBarEl.setText("GDocs: Auth Required");
        break;
    }
  }

  setPending(count: number): void {
    if (count > 0) {
      this.statusBarEl.setText(`GDocs: ${count} pending`);
    }
  }
}
