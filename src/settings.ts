import { App, Notice, PluginSettingTab, Setting } from "obsidian";
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
    new Setting(containerEl).setName("Google Cloud credentials").setHeading();

    new Setting(containerEl)
      .setName("Client ID")
      .setDesc("OAuth 2.0 Client ID from your Google Cloud project")
      .addText((text) =>
        text
          .setPlaceholder("Enter Client ID")
          .setValue(this.plugin.settings.clientId)
          .onChange(async (value) => {
            this.plugin.settings.clientId = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Client Secret")
      .setDesc("OAuth 2.0 Client Secret from your Google Cloud project")
      .addText((text) => {
        text
          .setPlaceholder("Enter Client Secret")
          .setValue(this.plugin.settings.clientSecret)
          .onChange(async (value) => {
            this.plugin.settings.clientSecret = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Account")
      .setDesc(
        this.plugin.isAuthenticated()
          ? "Signed in to Google."
          : "Not signed in."
      )
      .addButton((button) =>
        button
          .setButtonText(this.plugin.isAuthenticated() ? "Sign Out" : "Sign In")
          .setCta()
          .onClick(async () => {
            try {
              if (this.plugin.isAuthenticated()) {
                await this.plugin.signOut();
              } else {
                await this.plugin.signIn();
              }
            } catch (err: any) {
              new Notice(`Google sign-in failed: ${err.message}`);
            }
            this.display();
          })
      );

    // Sync root
    new Setting(containerEl).setName("Sync").setHeading();

    new Setting(containerEl)
      .setName("Google Drive folder name")
      .setDesc(
        "Name of the Drive folder to sync into. Created automatically on " +
          "first sync (the drive.file scope only allows access to folders " +
          "this plugin creates). Defaults to your vault name."
      )
      .addText((text) =>
        text
          .setPlaceholder(this.app.vault.getName())
          .setValue(this.plugin.settings.rootFolderName)
          .onChange(async (value) => {
            this.plugin.settings.rootFolderName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Sync interval (minutes)")
      .setDesc("How often to sync with Google Drive (0 = disabled)")
      .addText((text) =>
        text
          .setPlaceholder("5")
          .setValue(String(this.plugin.settings.syncIntervalMinutes))
          .onChange(async (value) => {
            const num = parseInt(value, 10);
            if (!isNaN(num) && num >= 0) {
              this.plugin.settings.syncIntervalMinutes = num;
              await this.plugin.saveSettings();
              this.plugin.restartSyncInterval();
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
    new Setting(containerEl).setName("Exclusions").setHeading();

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
    new Setting(containerEl).setName("Advanced").setHeading();

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
