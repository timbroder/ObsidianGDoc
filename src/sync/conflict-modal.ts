import { App, Modal } from "obsidian";
import { ConflictResolution } from "@/types";

export class ConflictResolutionModal extends Modal {
  private localContent: string;
  private remoteContent: string;
  private filePath: string;
  private resolvePromise: ((value: ConflictResolution) => void) | null = null;

  constructor(
    app: App,
    localContent: string,
    remoteContent: string,
    filePath: string
  ) {
    super(app);
    this.localContent = localContent;
    this.remoteContent = remoteContent;
    this.filePath = filePath;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("gdocs-sync-conflict-modal");

    contentEl.createEl("h2", { text: `Conflict: ${this.filePath}` });
    contentEl.createEl("p", {
      text: "Both the local file and Google Doc were modified. Choose how to resolve:",
    });

    // Side by side diff
    const diffContainer = contentEl.createDiv({ cls: "gdocs-sync-diff-container" });
    diffContainer.style.display = "flex";
    diffContainer.style.gap = "8px";

    const localPane = diffContainer.createDiv();
    localPane.style.flex = "1";
    localPane.createEl("h3", { text: "Obsidian (local)" });
    const localPre = localPane.createEl("pre", { cls: "gdocs-sync-diff-view" });
    localPre.textContent = this.localContent.substring(0, 5000);
    if (this.localContent.length > 5000) {
      localPre.textContent += "\n... (truncated)";
    }

    const remotePane = diffContainer.createDiv();
    remotePane.style.flex = "1";
    remotePane.createEl("h3", { text: "Google Docs (remote)" });
    const remotePre = remotePane.createEl("pre", { cls: "gdocs-sync-diff-view" });
    remotePre.textContent = this.remoteContent.substring(0, 5000);
    if (this.remoteContent.length > 5000) {
      remotePre.textContent += "\n... (truncated)";
    }

    // Buttons
    const buttonContainer = contentEl.createDiv();
    buttonContainer.style.display = "flex";
    buttonContainer.style.gap = "8px";
    buttonContainer.style.marginTop = "16px";

    const keepLocalBtn = buttonContainer.createEl("button", {
      text: "Keep Obsidian Version",
    });
    keepLocalBtn.addEventListener("click", () => {
      this.resolve("keep-local");
    });

    const keepRemoteBtn = buttonContainer.createEl("button", {
      text: "Keep Google Docs Version",
    });
    keepRemoteBtn.addEventListener("click", () => {
      this.resolve("keep-remote");
    });

    const openEditorBtn = buttonContainer.createEl("button", {
      text: "Open in Editor",
    });
    openEditorBtn.addEventListener("click", () => {
      this.resolve("open-in-editor");
    });
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
    // If closed without choosing, default to keep-local
    if (this.resolvePromise) {
      this.resolvePromise("keep-local");
      this.resolvePromise = null;
    }
  }

  waitForResolution(): Promise<ConflictResolution> {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  private resolve(resolution: ConflictResolution): void {
    if (this.resolvePromise) {
      this.resolvePromise(resolution);
      this.resolvePromise = null;
    }
    this.close();
  }
}
