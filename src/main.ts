import { FileSystemAdapter, Notice, Plugin, TFile } from "obsidian";
import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { GDocsSyncSettings, DEFAULT_SETTINGS, SyncStatus } from "./types";
import { GDocsSyncSettingTab } from "./settings";
import { GoogleAuth, generatePkcePair } from "./google/auth";
import { OAuthLoopbackServer } from "./google/oauth-server";
import { DriveAPI } from "./google/drive";
import { DocsAPI } from "./google/docs";
import { RateLimiter } from "./google/rate-limiter";
import { IndexManager } from "./sync/index-manager";
import { ChangeDetector } from "./sync/change-detector";
import { DirtyTracker } from "./sync/dirty-tracker";
import { SyncEngine, SyncMode } from "./sync/engine";
import { SyncLog } from "./sync/sync-log";
import { ConflictResolutionModal } from "./sync/conflict-modal";
import { RemoteDeleteModal } from "./ui/remote-delete-modal";
import { SyncLogModal } from "./ui/sync-log-modal";
import { InitialSyncModal } from "./ui/initial-sync-modal";
import { StatusBarManager } from "./ui/status-bar";
import { RibbonManager } from "./ui/ribbon";
import { getEffectiveExclusions, isExcluded } from "./utils/glob";
import {
  DRIVE_API_RATE_LIMIT,
  DOCS_API_RATE_LIMIT,
  SYNC_DIR,
  AUTH_FILE,
  INDEX_FILE,
  DELETED_FOLDER_NAME,
  GOOGLE_DOC_MIME_TYPE,
} from "./constants";

export default class GDocsSyncPlugin extends Plugin {
  settings!: GDocsSyncSettings;

  private auth: GoogleAuth | null = null;
  private driveApi: DriveAPI | null = null;
  private docsApi: DocsAPI | null = null;
  private driveLimiter: RateLimiter | null = null;
  private docsLimiter: RateLimiter | null = null;
  private indexManager: IndexManager | null = null;
  private dirtyTracker: DirtyTracker | null = null;
  private syncLog: SyncLog | null = null;
  private engine: SyncEngine | null = null;
  private statusBar: StatusBarManager | null = null;
  private ribbonManager: RibbonManager | null = null;
  private vaultPath = "";
  private pushDebounceTimer: number | null = null;
  private syncIntervalId: number | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new GDocsSyncSettingTab(this.app, this));

    this.statusBar = new StatusBarManager(this.addStatusBarItem());

    const ribbonEl = this.addRibbonIcon("refresh-cw", "Sync with Google Docs", () => {
      void this.runSync("full", true);
    });
    this.ribbonManager = new RibbonManager(ribbonEl);

    this.addCommand({
      id: "sync-now",
      name: "Sync Now",
      callback: () => void this.runSync("full", true),
    });

    this.addCommand({
      id: "push-to-google",
      name: "Push to Google",
      callback: () => void this.runSync("push", true),
    });

    this.addCommand({
      id: "pull-from-google",
      name: "Pull from Google",
      callback: () => void this.runSync("pull", true),
    });

    this.addCommand({
      id: "view-sync-log",
      name: "View Sync Log",
      callback: () => {
        new SyncLogModal(this.app, this.syncLog?.getEntries() ?? []).open();
      },
    });

    // Defer the heavyweight setup (and vault event registration) until the
    // workspace is ready, so startup file-create events don't mark the whole
    // vault dirty.
    this.app.workspace.onLayoutReady(() => {
      void this.initialize();
    });
  }

  onunload() {
    this.dirtyTracker?.unload();
    this.driveLimiter?.cancel();
    this.docsLimiter?.cancel();
    if (this.pushDebounceTimer !== null) {
      window.clearTimeout(this.pushDebounceTimer);
      this.pushDebounceTimer = null;
    }
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ============================================================
  // Initialization
  // ============================================================

  private async initialize(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      new Notice("Google Docs Sync requires the desktop app.");
      return;
    }
    this.vaultPath = adapter.getBasePath();

    this.driveLimiter = new RateLimiter(DRIVE_API_RATE_LIMIT);
    this.docsLimiter = new RateLimiter(DOCS_API_RATE_LIMIT);
    this.auth = new GoogleAuth(this.settings.clientId, this.settings.clientSecret, "");
    this.driveApi = new DriveAPI(() => this.auth!.getAccessToken(), this.driveLimiter);
    this.docsApi = new DocsAPI(() => this.auth!.getAccessToken(), this.docsLimiter);

    this.indexManager = new IndexManager(this.vaultPath);
    try {
      await this.indexManager.load();
    } catch {
      // Corrupted index: move it aside and start fresh. The next sync will
      // re-scan; sync IDs stored on the docs prevent duplicate creation.
      const indexPath = path.join(this.vaultPath, SYNC_DIR, INDEX_FILE);
      await fs
        .rename(indexPath, `${indexPath}.corrupt-${Date.now()}`)
        .catch(() => {});
      await this.indexManager.load();
      new Notice(
        "GDocs Sync: the sync index was corrupted and has been reset. The next sync will re-scan."
      );
    }

    this.syncLog = new SyncLog(this.vaultPath, this.settings.maxLogEntries);
    await this.syncLog.load();

    this.dirtyTracker = new DirtyTracker(this.app.vault, this.settings.exclusionPatterns);

    this.engine = new SyncEngine({
      vaultPath: this.vaultPath,
      driveApi: this.driveApi,
      docsApi: this.docsApi,
      indexManager: this.indexManager,
      changeDetector: new ChangeDetector(this.indexManager),
      dirtyTracker: this.dirtyTracker,
      syncLog: this.syncLog,
      exclusionPatterns: this.effectiveExclusions(),
      maxFileSizeBytes: this.settings.maxFileSizeMB * 1024 * 1024,
      readFile: (filePath) => this.app.vault.adapter.read(filePath),
      writeFile: (filePath, content) => this.writeVaultFile(filePath, content),
      deleteFile: (filePath) => this.deleteVaultFile(filePath),
      renameFile: (oldPath, newPath) => this.renameVaultFile(oldPath, newPath),
      createFolder: (folderPath) => this.ensureLocalFolder(folderPath),
      getVaultFiles: () => this.collectVaultFiles(),
      promptConflict: (local, remote, filePath) => this.promptConflict(local, remote, filePath),
      promptRemoteDeletion: (filePath) => this.promptRemoteDeletion(filePath),
      onStatusChange: (status) => this.updateStatus(status),
    });

    // Restore the saved session, if any.
    if (this.settings.tokenKey) {
      try {
        await this.auth.loadTokens(this.authFilePath(), this.settings.tokenKey);
        this.debugLog("Restored Google session from disk");
      } catch {
        this.debugLog("No usable saved Google session");
      }
    }
    this.updateStatus(this.isAuthenticated() ? "idle" : "auth-required");

    // Auto-push on save (debounced). Registered for all local mutations so
    // renames and deletes propagate promptly too.
    const schedule = (file: { path: string } | null) => {
      if (!file || !file.path.endsWith(".md")) return;
      if (isExcluded(file.path, this.effectiveExclusions())) return;
      this.scheduleAutoPush();
    };
    this.registerEvent(this.app.vault.on("modify", (f) => schedule(f instanceof TFile ? f : null)));
    this.registerEvent(this.app.vault.on("create", (f) => schedule(f instanceof TFile ? f : null)));
    this.registerEvent(this.app.vault.on("delete", (f) => schedule(f instanceof TFile ? f : null)));
    this.registerEvent(this.app.vault.on("rename", (f) => schedule(f instanceof TFile ? f : null)));

    this.restartSyncInterval();
  }

  // ============================================================
  // Auth
  // ============================================================

  isAuthenticated(): boolean {
    return !!this.auth?.getTokens();
  }

  async signIn(): Promise<void> {
    if (!this.settings.clientId || !this.settings.clientSecret) {
      throw new Error("Enter a Client ID and Client Secret first.");
    }

    const server = new OAuthLoopbackServer();
    try {
      const redirectUri = await server.start();
      const pkce = generatePkcePair();
      const state = crypto.randomBytes(16).toString("hex");

      const flowAuth = new GoogleAuth(
        this.settings.clientId,
        this.settings.clientSecret,
        redirectUri
      );

      window.open(flowAuth.getAuthUrl(state, pkce.challenge));
      new Notice("Complete the Google sign-in in your browser…");

      const code = await server.waitForCode(state);
      await flowAuth.exchangeCode(code, pkce.verifier);

      // Adopt the authenticated client for all future API calls (the API
      // token getters resolve `this.auth` at call time).
      this.auth = flowAuth;

      if (!this.settings.tokenKey) {
        this.settings.tokenKey = crypto.randomBytes(32).toString("hex");
        await this.saveSettings();
      }
      await this.auth.saveTokens(this.authFilePath(), this.settings.tokenKey);

      new Notice("Signed in to Google.");
      this.updateStatus("idle");
    } finally {
      server.stop();
    }
  }

  async signOut(): Promise<void> {
    try {
      await this.auth?.revokeTokens();
    } catch {
      // Best effort — clear local state regardless.
    }
    await fs.unlink(this.authFilePath()).catch(() => {});
    new Notice("Signed out of Google.");
    this.updateStatus("auth-required");
  }

  private authFilePath(): string {
    return path.join(this.vaultPath, SYNC_DIR, AUTH_FILE);
  }

  // ============================================================
  // Sync orchestration
  // ============================================================

  restartSyncInterval(): void {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
    if (this.settings.syncIntervalMinutes > 0) {
      this.syncIntervalId = window.setInterval(
        () => void this.runSync("full", false),
        this.settings.syncIntervalMinutes * 60_000
      );
      this.registerInterval(this.syncIntervalId);
    }
  }

  private scheduleAutoPush(): void {
    if (!this.settings.autoPushOnSave || !this.isAuthenticated()) return;
    if (this.pushDebounceTimer !== null) {
      window.clearTimeout(this.pushDebounceTimer);
    }
    this.pushDebounceTimer = window.setTimeout(() => {
      this.pushDebounceTimer = null;
      void this.runSync("push", false);
    }, this.settings.pushDebounceSeconds * 1000);
  }

  private async runSync(mode: SyncMode, manual: boolean): Promise<void> {
    if (!this.engine || !this.indexManager || !this.driveApi) {
      if (manual) new Notice("GDocs Sync is still initializing — try again in a moment.");
      return;
    }
    if (!this.isAuthenticated()) {
      this.updateStatus("auth-required");
      if (manual) new Notice("Sign in to Google in the plugin settings first.");
      return;
    }
    if (this.engine.isSyncing()) {
      if (manual) new Notice("A sync is already running.");
      return;
    }

    try {
      const firstSyncMode = await this.prepareRootFolder(manual);
      if (firstSyncMode === "cancel") return;
      if (firstSyncMode) mode = firstSyncMode;
    } catch (err: any) {
      this.updateStatus("error");
      new Notice(`GDocs Sync: could not prepare the Drive folder: ${err.message}`);
      return;
    }

    this.debugLog(`Starting ${mode} sync (manual=${manual})`);
    await this.engine.syncAll({ mode, manual });
    this.debugLog(`Sync finished with status ${this.engine.getStatus()}`);
  }

  /**
   * Ensure the Drive root and "_Deleted" folders exist. On the very first
   * sync against a non-empty Drive folder with a non-empty vault, asks the
   * user which side is the source of truth.
   *
   * Returns a forced sync mode ("push"/"pull"), "cancel", or null for the
   * normal path.
   */
  private async prepareRootFolder(manual: boolean): Promise<SyncMode | "cancel" | null> {
    const indexManager = this.indexManager!;
    const driveApi = this.driveApi!;
    const index = indexManager.getIndex();

    if (index.rootFolderId) return null;

    // A manually-pasted folder ID is honored (power users; note that the
    // drive.file scope must be able to see it). Otherwise create a folder.
    let rootId = this.settings.rootFolderId;
    if (!rootId) {
      const name = this.settings.rootFolderName || this.app.vault.getName();
      const folder = await driveApi.createFolder(name, "root");
      rootId = folder.id;
      this.settings.rootFolderId = rootId;
      await this.saveSettings();
    }
    indexManager.setRootFolderId(rootId);

    const deleted = await driveApi.createFolder(DELETED_FOLDER_NAME, rootId);
    indexManager.setDeletedFolderId(deleted.id);
    await indexManager.save();

    // First-sync direction prompt, only when both sides have content.
    if (indexManager.getFileCount() === 0) {
      const remoteFiles = await driveApi.listAllFilesRecursive(rootId);
      const remoteDocCount = remoteFiles.filter(
        (f) => f.mimeType === GOOGLE_DOC_MIME_TYPE && !f.trashed
      ).length;
      const vaultCount = this.app.vault.getMarkdownFiles().length;

      if (remoteDocCount > 0 && vaultCount > 0) {
        if (!manual) return "cancel"; // don't pop modals from background timers
        const modal = new InitialSyncModal(this.app, vaultCount, remoteDocCount);
        const choice = modal.waitForChoice();
        modal.open();
        const direction = await choice;
        if (direction === "cancel") return "cancel";
        return direction;
      }
    }

    return null;
  }

  // ============================================================
  // Vault helpers (engine dependencies)
  // ============================================================

  private effectiveExclusions(): string[] {
    return getEffectiveExclusions(this.settings.exclusionPatterns);
  }

  private async collectVaultFiles(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;
    const exclusions = this.effectiveExclusions();

    for (const file of this.app.vault.getMarkdownFiles()) {
      if (isExcluded(file.path, exclusions)) continue;
      if (file.stat.size > maxBytes) continue;
      result.set(file.path, await this.app.vault.cachedRead(file));
    }
    return result;
  }

  private async ensureLocalFolder(folderPath: string): Promise<void> {
    if (!folderPath) return;
    const parts = folderPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        await this.app.vault.createFolder(current).catch(() => {
          // Folder may have been created concurrently.
        });
      }
    }
  }

  private async writeVaultFile(filePath: string, content: string): Promise<void> {
    const dir = filePath.includes("/")
      ? filePath.substring(0, filePath.lastIndexOf("/"))
      : "";
    if (dir) await this.ensureLocalFolder(dir);

    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(filePath, content);
    }
  }

  private async deleteVaultFile(filePath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (file) {
      await this.app.vault.trash(file, true);
    }
  }

  private async renameVaultFile(oldPath: string, newPath: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(oldPath);
    if (!(file instanceof TFile)) {
      throw new Error(`Cannot rename: ${oldPath} not found in vault`);
    }
    const dir = newPath.includes("/")
      ? newPath.substring(0, newPath.lastIndexOf("/"))
      : "";
    if (dir) await this.ensureLocalFolder(dir);
    await this.app.fileManager.renameFile(file, newPath);
  }

  // ============================================================
  // Prompts & status
  // ============================================================

  private async promptConflict(
    local: string,
    remote: string,
    filePath: string
  ): Promise<"keep-local" | "keep-remote" | "open-in-editor" | "skip"> {
    const modal = new ConflictResolutionModal(this.app, local, remote, filePath);
    const resolutionPromise = modal.waitForResolution();
    modal.open();
    const resolution = await resolutionPromise;

    if (resolution === "open-in-editor") {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (file instanceof TFile) {
        await this.app.workspace.getLeaf(true).openFile(file);
      }
    }
    return resolution;
  }

  private async promptRemoteDeletion(filePath: string): Promise<"yes" | "no" | "ignore"> {
    const modal = new RemoteDeleteModal(this.app, filePath);
    const choicePromise = modal.waitForChoice();
    modal.open();
    return choicePromise;
  }

  private updateStatus(status: SyncStatus): void {
    this.statusBar?.update(status, this.dirtyTracker?.size() ?? 0);
    this.ribbonManager?.update(status);
  }

  private debugLog(message: string): void {
    if (this.settings.enableDebugLogging) {
      console.log(`[gdocs-sync] ${message}`);
    }
  }
}
