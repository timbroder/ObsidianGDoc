import { App, Modal } from "obsidian";

export type RemoteDeleteChoice = "yes" | "no" | "ignore";

/**
 * Asks the user what to do when a file was deleted on the Google Drive side
 * but still exists locally.
 */
export class RemoteDeleteModal extends Modal {
  private filePath: string;
  private resolvePromise: ((value: RemoteDeleteChoice) => void) | null = null;

  constructor(app: App, filePath: string) {
    super(app);
    this.filePath = filePath;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Deleted in Google Drive" });
    contentEl.createEl("p", {
      text: `"${this.filePath}" was deleted in Google Drive but still exists in your vault. Delete it locally too?`,
    });

    const buttonContainer = contentEl.createDiv({ cls: "gdocs-sync-button-row" });

    const deleteBtn = buttonContainer.createEl("button", {
      text: "Delete locally",
      cls: "mod-warning",
    });
    deleteBtn.addEventListener("click", () => this.resolve("yes"));

    const keepBtn = buttonContainer.createEl("button", {
      text: "Keep file (stop syncing it)",
    });
    keepBtn.addEventListener("click", () => this.resolve("no"));

    const ignoreBtn = buttonContainer.createEl("button", {
      text: "Decide later",
    });
    ignoreBtn.addEventListener("click", () => this.resolve("ignore"));
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    if (this.resolvePromise) {
      this.resolvePromise("ignore");
      this.resolvePromise = null;
    }
  }

  waitForChoice(): Promise<RemoteDeleteChoice> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  private resolve(choice: RemoteDeleteChoice): void {
    if (this.resolvePromise) {
      this.resolvePromise(choice);
      this.resolvePromise = null;
    }
    this.close();
  }
}
