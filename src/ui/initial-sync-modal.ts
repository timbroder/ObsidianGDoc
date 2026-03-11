import { App, Modal } from "obsidian";

export type InitialSyncDirection = "push" | "pull" | "cancel";

export class InitialSyncModal extends Modal {
  private vaultFileCount: number;
  private driveFileCount: number;
  private resolvePromise: ((value: InitialSyncDirection) => void) | null = null;

  constructor(
    app: App,
    vaultFileCount: number,
    driveFileCount: number
  ) {
    super(app);
    this.vaultFileCount = vaultFileCount;
    this.driveFileCount = driveFileCount;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Google Docs Sync - Initial Setup" });

    if (this.vaultFileCount > 0 && this.driveFileCount > 0) {
      contentEl.createEl("p", {
        text: `Your vault has ${this.vaultFileCount} files and Google Drive has ${this.driveFileCount} files. Which should be the source of truth?`,
      });
    } else if (this.vaultFileCount > 0) {
      contentEl.createEl("p", {
        text: `Your vault has ${this.vaultFileCount} files. Push them to Google Drive?`,
      });
    } else if (this.driveFileCount > 0) {
      contentEl.createEl("p", {
        text: `Google Drive has ${this.driveFileCount} files. Pull them to your vault?`,
      });
    }

    const buttonContainer = contentEl.createDiv();
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "8px";
    buttonContainer.style.marginTop = "16px";

    if (this.vaultFileCount > 0) {
      const pushBtn = buttonContainer.createEl("button", {
        text: "Push vault to Google Drive",
      });
      pushBtn.addEventListener("click", () => this.resolve("push"));
    }

    if (this.driveFileCount > 0) {
      const pullBtn = buttonContainer.createEl("button", {
        text: "Pull from Google Drive",
      });
      pullBtn.addEventListener("click", () => this.resolve("pull"));
    }

    const cancelBtn = buttonContainer.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.resolve("cancel"));
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (this.resolvePromise) {
      this.resolvePromise("cancel");
      this.resolvePromise = null;
    }
  }

  waitForChoice(): Promise<InitialSyncDirection> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  private resolve(direction: InitialSyncDirection): void {
    if (this.resolvePromise) {
      this.resolvePromise(direction);
      this.resolvePromise = null;
    }
    this.close();
  }
}
