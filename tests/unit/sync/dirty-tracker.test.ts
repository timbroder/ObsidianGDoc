import { DirtyTracker } from "@/sync/dirty-tracker";
import { Vault, TFile } from "obsidian";

describe("DirtyTracker", () => {
  let vault: Vault;
  let tracker: DirtyTracker;

  beforeEach(() => {
    vault = new Vault();
    tracker = new DirtyTracker(vault, []);
  });

  afterEach(() => {
    tracker.unload();
  });

  test("vault modify event → file added to dirty set", () => {
    const file = new TFile("notes/test.md");
    vault.trigger("modify", file);

    expect(tracker.isDirty("notes/test.md")).toBe(true);
    expect(tracker.size()).toBe(1);
  });

  test("vault create event → file added to dirty set", () => {
    const file = new TFile("new-file.md");
    vault.trigger("create", file);

    expect(tracker.isDirty("new-file.md")).toBe(true);
  });

  test("vault delete event → file added to dirty set", () => {
    const file = new TFile("deleted.md");
    vault.trigger("delete", file);

    const dirty = tracker.drain();
    expect(dirty.get("deleted.md")?.type).toBe("delete");
  });

  test("vault rename event → old path deleted, new path dirty", () => {
    const file = new TFile("new-name.md");
    vault.trigger("rename", file, "old-name.md");

    const dirty = tracker.drain();
    expect(dirty.has("old-name.md")).toBe(true);
    expect(dirty.get("old-name.md")?.type).toBe("delete");
    expect(dirty.has("new-name.md")).toBe(true);
    expect(dirty.get("new-name.md")?.type).toBe("rename");
  });

  test("multiple edits to same file → only one entry", () => {
    const file = new TFile("test.md");
    vault.trigger("modify", file);
    vault.trigger("modify", file);
    vault.trigger("modify", file);

    expect(tracker.size()).toBe(1);
  });

  test("drain returns all dirty paths and clears", () => {
    vault.trigger("modify", new TFile("a.md"));
    vault.trigger("modify", new TFile("b.md"));

    expect(tracker.size()).toBe(2);
    const drained = tracker.drain();
    expect(drained.size).toBe(2);
    expect(tracker.size()).toBe(0);
  });

  test("drain returns empty when nothing changed", () => {
    const drained = tracker.drain();
    expect(drained.size).toBe(0);
  });

  test("excluded files are ignored", () => {
    const excludeTracker = new DirtyTracker(vault, ["*.excalidraw.md"]);
    vault.trigger("modify", new TFile("note.excalidraw.md"));

    expect(excludeTracker.size()).toBe(0);
    excludeTracker.unload();
  });

  test("dotfiles are ignored", () => {
    vault.trigger("modify", new TFile(".obsidian/config.json"));

    expect(tracker.size()).toBe(0);
  });

  test("canvas files are ignored", () => {
    vault.trigger("modify", new TFile("board.canvas"));

    expect(tracker.size()).toBe(0);
  });

  test("getDirtyPaths returns set of paths", () => {
    vault.trigger("modify", new TFile("a.md"));
    vault.trigger("modify", new TFile("b.md"));

    const paths = tracker.getDirtyPaths();
    expect(paths.has("a.md")).toBe(true);
    expect(paths.has("b.md")).toBe(true);
  });

  test("addToDirtySet manually adds file", () => {
    tracker.addToDirtySet("manual.md");
    expect(tracker.isDirty("manual.md")).toBe(true);
  });

  test("unload clears everything", () => {
    vault.trigger("modify", new TFile("test.md"));
    tracker.unload();

    expect(tracker.size()).toBe(0);
    // After unload, new events shouldn't be tracked
    vault.trigger("modify", new TFile("after-unload.md"));
    expect(tracker.size()).toBe(0);
  });
});
