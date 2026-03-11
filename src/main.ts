import { Plugin } from "obsidian";
import { GDocsSyncSettings, DEFAULT_SETTINGS } from "./types";
import { GDocsSyncSettingTab } from "./settings";

export default class GDocsSyncPlugin extends Plugin {
  settings!: GDocsSyncSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new GDocsSyncSettingTab(this.app, this));

    this.addRibbonIcon("refresh-cw", "Sync with Google Docs", async () => {
      // TODO: trigger full sync
    });

    this.addCommand({
      id: "sync-now",
      name: "Sync Now",
      callback: async () => {
        // TODO: trigger full sync
      },
    });

    this.addCommand({
      id: "push-to-google",
      name: "Push to Google",
      callback: async () => {
        // TODO: push only
      },
    });

    this.addCommand({
      id: "pull-from-google",
      name: "Pull from Google",
      callback: async () => {
        // TODO: pull only
      },
    });

    this.addCommand({
      id: "view-sync-log",
      name: "View Sync Log",
      callback: async () => {
        // TODO: open sync log modal
      },
    });
  }

  onunload() {
    // TODO: clean up timers, event listeners
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
