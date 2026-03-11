import { isExcluded, getEffectiveExclusions } from "@/utils/glob";
import { ALWAYS_EXCLUDED_PATTERNS } from "@/constants";

describe("isExcluded", () => {
  it("*.excalidraw.md matches 'note.excalidraw.md'", () => {
    expect(isExcluded("note.excalidraw.md", ["*.excalidraw.md"])).toBe(true);
  });

  it("*.excalidraw.md does not match 'note.md'", () => {
    expect(isExcluded("note.md", ["*.excalidraw.md"])).toBe(false);
  });

  it("*.canvas matches 'board.canvas'", () => {
    expect(isExcluded("board.canvas", ["*.canvas"])).toBe(true);
  });

  it("drafts/* matches 'drafts/note.md'", () => {
    expect(isExcluded("drafts/note.md", ["drafts/*"])).toBe(true);
  });

  it("drafts/* does not match 'published/note.md'", () => {
    expect(isExcluded("published/note.md", ["drafts/*"])).toBe(false);
  });

  it("**/*.tmp matches 'deep/nested/file.tmp'", () => {
    expect(isExcluded("deep/nested/file.tmp", ["**/*.tmp"])).toBe(true);
  });

  it("matches if any pattern in the array matches", () => {
    const patterns = ["*.excalidraw.md", "drafts/*", "**/*.tmp"];
    expect(isExcluded("drafts/note.md", patterns)).toBe(true);
    expect(isExcluded("deep/nested/file.tmp", patterns)).toBe(true);
    expect(isExcluded("note.excalidraw.md", patterns)).toBe(true);
  });

  it("empty patterns array excludes nothing", () => {
    expect(isExcluded("anything.md", [])).toBe(false);
  });

  it(".obsidian paths are always excluded via ALWAYS_EXCLUDED_PATTERNS", () => {
    const effective = getEffectiveExclusions([]);
    expect(isExcluded(".obsidian/config.json", effective)).toBe(true);
    expect(isExcluded(".obsidian/plugins/some-plugin/main.js", effective)).toBe(true);
  });

  it("dotfile paths are always excluded via ALWAYS_EXCLUDED_PATTERNS", () => {
    const effective = getEffectiveExclusions([]);
    // .* matches dotfiles at root
    expect(isExcluded(".gitignore", effective)).toBe(true);
    // .*/** matches paths under dot-directories
    expect(isExcluded(".hidden/secret.md", effective)).toBe(true);
  });
});

describe("getEffectiveExclusions", () => {
  it("includes all ALWAYS_EXCLUDED_PATTERNS", () => {
    const effective = getEffectiveExclusions([]);
    for (const pattern of ALWAYS_EXCLUDED_PATTERNS) {
      expect(effective).toContain(pattern);
    }
  });

  it("includes user patterns alongside always-excluded patterns", () => {
    const userPatterns = ["drafts/*", "**/*.tmp"];
    const effective = getEffectiveExclusions(userPatterns);
    expect(effective).toContain("drafts/*");
    expect(effective).toContain("**/*.tmp");
    for (const pattern of ALWAYS_EXCLUDED_PATTERNS) {
      expect(effective).toContain(pattern);
    }
  });

  it("returns only ALWAYS_EXCLUDED_PATTERNS when user patterns are empty", () => {
    const effective = getEffectiveExclusions([]);
    expect(effective).toEqual(ALWAYS_EXCLUDED_PATTERNS);
  });
});
