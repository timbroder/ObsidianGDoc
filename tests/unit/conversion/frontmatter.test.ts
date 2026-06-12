import {
  extractFrontmatter,
  prependFrontmatter,
  frontmatterToDocProperties,
  docPropertiesToFrontmatter,
  FrontmatterTooLargeError,
} from "@/conversion/frontmatter";
import {
  DOC_PROPERTY_FRONTMATTER,
  DOC_PROPERTY_FRONTMATTER_PREFIX,
  DRIVE_PROPERTY_MAX_BYTES,
  MAX_FRONTMATTER_CHUNKS,
} from "@/constants";

// ---------------------------------------------------------------------------
// extractFrontmatter
// ---------------------------------------------------------------------------

describe("extractFrontmatter", () => {
  it("extracts simple frontmatter (title, tags, date)", () => {
    const md = [
      "---",
      "title: Hello World",
      "tags: [a, b, c]",
      "date: 2025-01-01",
      "---",
      "Body text here.",
    ].join("\n");

    const { frontmatter, body } = extractFrontmatter(md);

    expect(frontmatter).toBe(
      "---\ntitle: Hello World\ntags: [a, b, c]\ndate: 2025-01-01\n---\n",
    );
    expect(body).toBe("Body text here.");
  });

  it("extracts complex frontmatter (nested objects, arrays)", () => {
    const md = [
      "---",
      "author:",
      "  name: Alice",
      "  email: alice@example.com",
      "categories:",
      "  - tech",
      "  - science",
      "meta:",
      "  views: 42",
      "---",
      "Content.",
    ].join("\n");

    const { frontmatter, body } = extractFrontmatter(md);

    expect(frontmatter).toContain("author:");
    expect(frontmatter).toContain("  name: Alice");
    expect(frontmatter).toContain("categories:");
    expect(frontmatter).toContain("  - tech");
    expect(frontmatter).toContain("  - science");
    expect(frontmatter).toContain("meta:");
    expect(frontmatter).toContain("  views: 42");
    expect(frontmatter).toMatch(/^---\n/);
    expect(frontmatter).toMatch(/\n---\n$/);
    expect(body).toBe("Content.");
  });

  it("extracts frontmatter with special characters (colons, quotes, unicode)", () => {
    const md = [
      "---",
      'title: "Key: Value"',
      "emoji: \u{1F680}",
      "quote: 'it\\'s fine'",
      "---",
      "Body.",
    ].join("\n");

    const { frontmatter, body } = extractFrontmatter(md);

    expect(frontmatter).toContain('title: "Key: Value"');
    expect(frontmatter).toContain("emoji: \u{1F680}");
    expect(body).toBe("Body.");
  });

  it("returns empty frontmatter when none is present", () => {
    const md = "Just a regular document.\nNo frontmatter here.";
    const { frontmatter, body } = extractFrontmatter(md);

    expect(frontmatter).toBe("");
    expect(body).toBe(md);
  });

  it("handles frontmatter-only document (no body)", () => {
    const md = "---\ntitle: Only FM\n---\n";
    const { frontmatter, body } = extractFrontmatter(md);

    expect(frontmatter).toBe("---\ntitle: Only FM\n---\n");
    expect(body).toBe("");
  });

  it("preserves malformed YAML as raw string", () => {
    const md = "---\ntitle: [unclosed bracket\nfoo: : bar\n---\nBody.";
    const { frontmatter, body } = extractFrontmatter(md);

    // The raw block is still extracted even if the YAML is invalid.
    expect(frontmatter).toBe("---\ntitle: [unclosed bracket\nfoo: : bar\n---\n");
    expect(body).toBe("Body.");
  });

  it("does not treat --- in the middle of the doc as frontmatter", () => {
    const md = "Hello\n---\ntitle: nope\n---\nWorld";
    const { frontmatter, body } = extractFrontmatter(md);

    expect(frontmatter).toBe("");
    expect(body).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// prependFrontmatter
// ---------------------------------------------------------------------------

describe("prependFrontmatter", () => {
  it("prepends frontmatter to body", () => {
    const result = prependFrontmatter("Body.", "---\ntitle: Hi\n---\n");
    expect(result).toBe("---\ntitle: Hi\n---\nBody.");
  });

  it("returns body unchanged when frontmatter is empty", () => {
    const body = "Just body.";
    expect(prependFrontmatter(body, "")).toBe(body);
  });

  it("adds a newline separator if frontmatter does not end with one", () => {
    const result = prependFrontmatter("Body.", "---\ntitle: Hi\n---");
    expect(result).toBe("---\ntitle: Hi\n---\nBody.");
  });
});

// ---------------------------------------------------------------------------
// frontmatterToDocProperties
// ---------------------------------------------------------------------------

describe("frontmatterToDocProperties", () => {
  it("returns empty object for empty frontmatter", () => {
    expect(frontmatterToDocProperties("")).toEqual({});
  });

  it("stores small frontmatter under single key", () => {
    const fm = "---\ntitle: Test\n---\n";
    const props = frontmatterToDocProperties(fm);

    expect(Object.keys(props)).toEqual([DOC_PROPERTY_FRONTMATTER]);
    expect(props[DOC_PROPERTY_FRONTMATTER]).toBe(fm);
  });

  it("splits frontmatter exceeding one property across numbered properties", () => {
    // Drive properties hold at most 124 bytes of key+value, so anything
    // beyond ~100 bytes of frontmatter must be chunked.
    const line = "key: " + "x".repeat(100) + "\n";
    const lines = Array(5).fill(line).join("");
    const fm = "---\n" + lines + "---\n";

    const props = frontmatterToDocProperties(fm);

    // Should NOT have the single key.
    expect(props[DOC_PROPERTY_FRONTMATTER]).toBeUndefined();

    // Should have numbered keys, each within Drive's per-property limit.
    const keys = Object.keys(props).sort();
    expect(keys.length).toBeGreaterThan(1);
    for (const key of keys) {
      expect(key).toMatch(
        new RegExp(`^${DOC_PROPERTY_FRONTMATTER_PREFIX}\\d+$`),
      );
      expect(
        Buffer.byteLength(key, "utf-8") + Buffer.byteLength(props[key], "utf-8"),
      ).toBeLessThanOrEqual(DRIVE_PROPERTY_MAX_BYTES);
    }
  });

  it("keeps every chunk within the byte budget for multi-byte characters", () => {
    const fm = "---\ntitle: " + "héllo wörld 你好 ".repeat(20) + "\n---\n";
    const props = frontmatterToDocProperties(fm);

    for (const [key, value] of Object.entries(props)) {
      expect(
        Buffer.byteLength(key, "utf-8") + Buffer.byteLength(value, "utf-8"),
      ).toBeLessThanOrEqual(DRIVE_PROPERTY_MAX_BYTES);
    }
    expect(docPropertiesToFrontmatter(props)).toBe(fm);
  });

  it("throws FrontmatterTooLargeError when the chunk cap is exceeded", () => {
    const maxTotalBytes = MAX_FRONTMATTER_CHUNKS * DRIVE_PROPERTY_MAX_BYTES;
    const fm = "---\nbig: " + "x".repeat(maxTotalBytes) + "\n---\n";

    expect(() => frontmatterToDocProperties(fm)).toThrow(
      FrontmatterTooLargeError,
    );
  });
});

// ---------------------------------------------------------------------------
// docPropertiesToFrontmatter
// ---------------------------------------------------------------------------

describe("docPropertiesToFrontmatter", () => {
  it("restores frontmatter from single property", () => {
    const fm = "---\ntitle: Test\n---\n";
    const props = { [DOC_PROPERTY_FRONTMATTER]: fm };

    expect(docPropertiesToFrontmatter(props)).toBe(fm);
  });

  it("returns empty string when no matching properties exist", () => {
    expect(docPropertiesToFrontmatter({ unrelated: "value" })).toBe("");
    expect(docPropertiesToFrontmatter({})).toBe("");
  });

  it("reassembles split frontmatter from numbered properties", () => {
    const line = "key: " + "x".repeat(100) + "\n";
    const lines = Array(8).fill(line).join("");
    const fm = "---\n" + lines + "---\n";

    const props = frontmatterToDocProperties(fm);
    const restored = docPropertiesToFrontmatter(props);

    expect(restored).toBe(fm);
  });

  it("handles unordered numbered keys correctly", () => {
    const props: Record<string, string> = {
      [`${DOC_PROPERTY_FRONTMATTER_PREFIX}2`]: "CHUNK2",
      [`${DOC_PROPERTY_FRONTMATTER_PREFIX}0`]: "CHUNK0",
      [`${DOC_PROPERTY_FRONTMATTER_PREFIX}1`]: "CHUNK1",
    };

    expect(docPropertiesToFrontmatter(props)).toBe("CHUNK0CHUNK1CHUNK2");
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe("round-trip: extract -> toDocProperties -> fromDocProperties -> prepend", () => {
  it("produces the original document for simple frontmatter", () => {
    const original = "---\ntitle: Round Trip\ntags: [a]\n---\nHello world.\n";

    const { frontmatter, body } = extractFrontmatter(original);
    const props = frontmatterToDocProperties(frontmatter);
    const restored = docPropertiesToFrontmatter(props);
    const result = prependFrontmatter(body, restored);

    expect(result).toBe(original);
  });

  it("produces the original document for multi-chunk frontmatter", () => {
    const bigValue = "v".repeat(500);
    const original =
      "---\n" +
      `field1: ${bigValue}\n` +
      `field2: ${bigValue}\n` +
      `field3: ${bigValue}\n` +
      `field4: ${bigValue}\n` +
      "---\n" +
      "Body after large frontmatter.\n";

    const { frontmatter, body } = extractFrontmatter(original);
    const props = frontmatterToDocProperties(frontmatter);
    const restored = docPropertiesToFrontmatter(props);
    const result = prependFrontmatter(body, restored);

    expect(result).toBe(original);
  });

  it("produces the original document when there is no frontmatter", () => {
    const original = "No frontmatter here.\nJust text.\n";

    const { frontmatter, body } = extractFrontmatter(original);
    const props = frontmatterToDocProperties(frontmatter);
    const restored = docPropertiesToFrontmatter(props);
    const result = prependFrontmatter(body, restored);

    expect(result).toBe(original);
  });

  it("produces the original document for malformed YAML", () => {
    const original = "---\ntitle: [bad yaml\nfoo:: bar\n---\nBody.\n";

    const { frontmatter, body } = extractFrontmatter(original);
    const props = frontmatterToDocProperties(frontmatter);
    const restored = docPropertiesToFrontmatter(props);
    const result = prependFrontmatter(body, restored);

    expect(result).toBe(original);
  });
});
