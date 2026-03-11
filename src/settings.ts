import { App, PluginSettingTab, Setting } from "obsidian";
import type GDocsSyncPlugin from "./main";

export class GDocsSyncSettingTab extends PluginSettingTab {
  plugin: GDocsSyncPlugin;

  constructor(app: App, plugin: GDocsSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // Auth section
    containerEl.createEl("h2", { text: "Google Cloud Credentials" });

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("OAuth 2.0 Client ID from your Google Cloud project")
      .addText((text) =>
        text
          .setPlaceholder("Enter Client ID")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Client Secret")
      .setDesc("OAuth 2.0 Client Secret from your Google Cloud project")
      .addText((text) =>
        text
          .setPlaceholder("Enter Client Secret")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sign In")
      .setDesc("Authenticate with Google")
      .addButton((button) =>
        button.setButtonText("Sign In").onClick(async () => {
          // TODO: trigger OAuth flow
        })
      );

    // Sync root
    containerEl.createEl("h2", { text: "Sync Settings" });

    new Setting(containerEl)
      .setName("Google Drive Root Folder")
      .setDesc("Folder ID of the Google Drive folder to sync with")
      .addText((text) =>
        text
          .setPlaceholder("Folder ID or use picker")
          .setValue(this.plugin.settings.rootFolderId)
          .onChange(async (value) => {
            this.plugin.settings.rootFolderId = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync Interval (minutes)")
      .setDesc("How often to pull changes from Google Drive (0 = disabled)")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.syncIntervalMinutes = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Auto-push on save")
      .setDesc("Automatically push changes when you save a file")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoPushOnSave)
          .onChange(async (value) => {
            this.plugin.settings.autoPushOnSave = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Push debounce (seconds)")
      .setDesc("Wait this long after the last save before pushing")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.pushDebounceSeconds))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 1) {
              this.plugin.settings.pushDebounceSeconds = num;
              await this.plugin.saveSettings();
            }
          })
      );

    // Exclusions
    containerEl.createEl("h2", { text: "Exclusions" });

    new Setting(containerEl)
      .setName("Exclusion patterns")
      .setDesc("Glob patterns for files to exclude (one per line)")
      .addTextArea((area) =>
        area
          .setPlaceholder("*.excalidraw.md\n*.canvas")
          .setValue(this.plugin.settings.exclusionPatterns.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.exclusionPatterns = value
              .split("\n")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);
            await this.plugin.saveSettings();
          })
      );

    // Advanced
    containerEl.createEl("h2", { text: "Advanced" });

    new Setting(containerEl)
      .setName("Max file size (MB)")
      .setDesc("Files larger than this will be skipped")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.maxFileSizeMB))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 1) {
              this.plugin.settings.maxFileSizeMB = num;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Enable verbose debug logging")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDebugLogging)
          .onChange(async (value) => {
            this.plugin.settings.enableDebugLogging = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
