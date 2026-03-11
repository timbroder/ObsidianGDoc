import { App, Modal } from "obsidian";
import { SyncLogEntry } from "@/types";

export class SyncLogModal extends Modal {
  private entries: SyncLogEntry[];

  constructor(app: App, entries: SyncLogEntry[]) {
    super(app);
    this.entries = entries;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Sync Log" });

    if (this.entries.length === 0) {
      contentEl.createEl("p", { text: "No sync activity yet." });
      return;
    }

    const table = contentEl.createEl("table");
    table.style.width = "100%";
    table.style.fontSize = "var(--font-smaller)";

    const header = table.createEl("tr");
    header.createEl("th", { text: "Time" });
    header.createEl("th", { text: "Action" });
    header.createEl("th", { text: "File" });
    header.createEl("th", { text: "Result" });

    // Show most recent first
    const reversed = [...this.entries].reverse();
    for (const entry of reversed.slice(0, 200)) {
      const row = table.createEl("tr");
      const time = new Date(entry.timestamp);
      row.createEl("td", {
        text: time.toLocaleTimeString(),
      });
      row.createEl("td", { text: entry.action });
      row.createEl("td", { text: entry.file });
      row.createEl("td", { text: entry.result });
    }

    if (this.entries.length > 200) {
      contentEl.createEl("p", {
        text: `Showing 200 of ${this.entries.length} entries.`,
      });
    }
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
