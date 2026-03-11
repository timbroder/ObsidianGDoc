// Mock Obsidian API for testing

export class Notice {
  message: string;
  constructor(message: string, _timeout?: number) {
    this.message = message;
  }
}

export class Modal {
  app: App;
  constructor(app: App) {
    this.app = app;
  }
  open() {}
  close() {}
  onOpen() {}
  onClose() {}
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl: HTMLElement;
  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
    this.containerEl = document.createElement("div");
  }
  display() {}
  hide() {}
}

export class Setting {
  settingEl: HTMLElement;
  nameEl: HTMLElement;
  descEl: HTMLElement;
  controlEl: HTMLElement;

  constructor(_containerEl: HTMLElement) {
    this.settingEl = document.createElement("div");
    this.nameEl = document.createElement("div");
    this.descEl = document.createElement("div");
    this.controlEl = document.createElement("div");
  }
  setName(_name: string) { return this; }
  setDesc(_desc: string) { return this; }
  addText(_cb: (text: any) => any) { return this; }
  addToggle(_cb: (toggle: any) => any) { return this; }
  addDropdown(_cb: (dropdown: any) => any) { return this; }
  addButton(_cb: (button: any) => any) { return this; }
  addTextArea(_cb: (area: any) => any) { return this; }
}

export class TFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
  stat: { mtime: number; ctime: number; size: number };
  vault: Vault;
  parent: TFolder | null;

  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() || path;
    const dotIndex = this.name.lastIndexOf(".");
    this.basename = dotIndex > 0 ? this.name.substring(0, dotIndex) : this.name;
    this.extension = dotIndex > 0 ? this.name.substring(dotIndex + 1) : "";
    this.stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
    this.vault = null as any;
    this.parent = null;
  }
}

export class TFolder {
  path: string;
  name: string;
  children: (TFile | TFolder)[];
  parent: TFolder | null;
  vault: Vault;

  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() || path;
    this.children = [];
    this.parent = null;
    this.vault = null as any;
  }

  isRoot(): boolean {
    return this.path === "/";
  }
}

export type TAbstractFile = TFile | TFolder;

export class Vault {
  private files: Map<string, string> = new Map();
  private eventHandlers: Map<string, ((...args: any[]) => void)[]> = new Map();

  async read(file: TFile): Promise<string> {
    return this.files.get(file.path) || "";
  }

  async create(path: string, data: string): Promise<TFile> {
    this.files.set(path, data);
    const file = new TFile(path);
    this.trigger("create", file);
    return file;
  }

  async modify(file: TFile, data: string): Promise<void> {
    this.files.set(file.path, data);
    this.trigger("modify", file);
  }

  async delete(file: TFile): Promise<void> {
    this.files.delete(file.path);
    this.trigger("delete", file);
  }

  async rename(file: TFile, newPath: string): Promise<void> {
    const data = this.files.get(file.path) || "";
    this.files.delete(file.path);
    this.files.set(newPath, data);
    this.trigger("rename", file, file.path);
    file.path = newPath;
  }

  getMarkdownFiles(): TFile[] {
    return Array.from(this.files.keys())
      .filter((p) => p.endsWith(".md"))
      .map((p) => new TFile(p));
  }

  getAbstractFileByPath(path: string): TAbstractFile | null {
    if (this.files.has(path)) return new TFile(path);
    return null;
  }

  getFiles(): TFile[] {
    return Array.from(this.files.keys()).map((p) => new TFile(p));
  }

  on(event: string, callback: (...args: any[]) => void): { unload: () => void } {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event)!.push(callback);
    return {
      unload: () => {
        const handlers = this.eventHandlers.get(event);
        if (handlers) {
          const idx = handlers.indexOf(callback);
          if (idx >= 0) handlers.splice(idx, 1);
        }
      },
    };
  }

  trigger(event: string, ...args: any[]) {
    const handlers = this.eventHandlers.get(event) || [];
    for (const handler of handlers) {
      handler(...args);
    }
  }

  // Test helper
  _setFile(path: string, content: string) {
    this.files.set(path, content);
  }

  _getFile(path: string): string | undefined {
    return this.files.get(path);
  }
}

export class App {
  vault: Vault;
  constructor() {
    this.vault = new Vault();
  }
}

export class Plugin {
  app: App;
  manifest: any;

  constructor(app: App, manifest: any) {
    this.app = app;
    this.manifest = manifest;
  }

  addRibbonIcon(_icon: string, _title: string, _callback: () => void) {
    return document.createElement("div");
  }

  addCommand(_command: any) {}
  addSettingTab(_tab: any) {}
  registerEvent(_event: any) {}

  async loadData(): Promise<any> {
    return {};
  }

  async saveData(_data: any): Promise<void> {}
}

export function requestUrl(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  contentType?: string;
}): Promise<{
  status: number;
  headers: Record<string, string>;
  json: any;
  text: string;
  arrayBuffer: ArrayBuffer;
}> {
  throw new Error("requestUrl must be mocked in tests");
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}
