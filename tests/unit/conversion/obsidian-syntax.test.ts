import {
  transformWikilinks,
  transformEmbeds,
  transformHighlights,
  transformCallouts,
  transformTags,
  transformAllObsidianSyntax,
  restoreWikilinks,
  restoreHighlights,
  HIGHLIGHT_START,
  HIGHLIGHT_END,
} from "@/conversion/obsidian-syntax";

// ---------------------------------------------------------------------------
// transformWikilinks
// ---------------------------------------------------------------------------
describe("transformWikilinks", () => {
  it("converts a simple wikilink to plain text", () => {
    expect(transformWikilinks("[[simple-wikilink]]")).toBe("simple-wikilink");
  });

  it("uses display text from a piped wikilink", () => {
    expect(transformWikilinks("[[wikilink|display text]]")).toBe(
      "display text"
    );
  });

  it("strips folder path and returns basename for nested links", () => {
    expect(transformWikilinks("[[folder/nested-link]]")).toBe("nested-link");
  });

  it("handles multiple wikilinks in one paragraph", () => {
    const input = "See [[PageA]] and [[PageB|shown text]] for details.";
    expect(transformWikilinks(input)).toBe(
      "See PageA and shown text for details."
    );
  });

  it("does not transform embed syntax (![[...]])", () => {
    expect(transformWikilinks("![[embed]]")).toBe("![[embed]]");
  });

  it("handles a wikilink inside bold markers", () => {
    expect(transformWikilinks("**[[link]]**")).toBe("**link**");
  });
});

// ---------------------------------------------------------------------------
// transformEmbeds
// ---------------------------------------------------------------------------
describe("transformEmbeds", () => {
  it("converts an embedded note to a placeholder", () => {
    expect(transformEmbeds("![[embedded-note]]")).toBe(
      "(embedded: embedded-note)"
    );
  });

  it("converts an embedded image to a placeholder", () => {
    expect(transformEmbeds("![[image.png]]")).toBe("(embedded: image.png)");
  });

  it("leaves regular wikilinks untouched", () => {
    expect(transformEmbeds("[[not-an-embed]]")).toBe("[[not-an-embed]]");
  });
});

// ---------------------------------------------------------------------------
// transformHighlights
// ---------------------------------------------------------------------------
describe("transformHighlights", () => {
  it("wraps highlighted text with sentinel markers", () => {
    expect(transformHighlights("==highlighted text==")).toBe(
      `${HIGHLIGHT_START}highlighted text${HIGHLIGHT_END}`
    );
  });

  it("handles multiple highlights in one line", () => {
    const input = "Some ==first== and ==second== highlights.";
    const expected = `Some ${HIGHLIGHT_START}first${HIGHLIGHT_END} and ${HIGHLIGHT_START}second${HIGHLIGHT_END} highlights.`;
    expect(transformHighlights(input)).toBe(expected);
  });

  it("does not match across line boundaries", () => {
    // The regex is non-greedy and single-line by default, so this should
    // not match a highlight that spans two lines.
    const input = "==start\nend==";
    expect(transformHighlights(input)).toBe("==start\nend==");
  });
});

// ---------------------------------------------------------------------------
// transformCallouts
// ---------------------------------------------------------------------------
describe("transformCallouts", () => {
  it("converts a note callout with title and content", () => {
    const input = "> [!note] Title\n> Content";
    expect(transformCallouts(input)).toBe("**Note: Title**\nContent");
  });

  it("converts a warning callout with title and content", () => {
    const input = "> [!warning] Title\n> Content";
    expect(transformCallouts(input)).toBe("**Warning: Title**\nContent");
  });

  it("handles callout without title", () => {
    expect(transformCallouts("> [!warning]")).toBe("**Warning:**");
  });

  it("handles a tip callout with title only (no content lines)", () => {
    expect(transformCallouts("> [!tip] Title")).toBe("**Tip: Title**");
  });

  it("handles info callout without title", () => {
    expect(transformCallouts("> [!info]")).toBe("**Info:**");
  });

  it("capitalizes a custom-type callout type", () => {
    expect(transformCallouts("> [!custom-type] Title")).toBe(
      "**Custom-Type: Title**"
    );
  });

  it("handles multi-line callout content", () => {
    const input = "> [!note] Title\n> Line 1\n> Line 2\n> Line 3";
    expect(transformCallouts(input)).toBe(
      "**Note: Title**\nLine 1\nLine 2\nLine 3"
    );
  });

  it("stops consuming content at a non-blockquote line", () => {
    const input = "> [!note] Title\n> Content\nNormal paragraph";
    expect(transformCallouts(input)).toBe(
      "**Note: Title**\nContent\nNormal paragraph"
    );
  });
});

// ---------------------------------------------------------------------------
// transformTags
// ---------------------------------------------------------------------------
describe("transformTags", () => {
  it("passes tags through unchanged", () => {
    const input = "Text with #tag and #nested/tag here.";
    expect(transformTags(input)).toBe(input);
  });
});

// ---------------------------------------------------------------------------
// transformAllObsidianSyntax
// ---------------------------------------------------------------------------
describe("transformAllObsidianSyntax", () => {
  it("applies all transforms in the correct order", () => {
    const input = [
      "See [[PageA]] and ![[image.png]].",
      "==highlighted== text here.",
      "> [!note] My Note",
      "> Callout body",
      "Tags: #tag #nested/tag",
    ].join("\n");

    const expected = [
      "See PageA and (embedded: image.png).",
      `${HIGHLIGHT_START}highlighted${HIGHLIGHT_END} text here.`,
      "**Note: My Note**",
      "Callout body",
      "Tags: #tag #nested/tag",
    ].join("\n");

    expect(transformAllObsidianSyntax(input)).toBe(expected);
  });

  it("handles embeds before wikilinks to avoid conflicts", () => {
    // Embeds contain [[ ]] which could match the wikilink regex if order is wrong.
    const input = "![[embed]] and [[link]]";
    const result = transformAllObsidianSyntax(input);
    expect(result).toBe("(embedded: embed) and link");
  });
});

// ---------------------------------------------------------------------------
// restoreHighlights (round-trip)
// ---------------------------------------------------------------------------
describe("restoreHighlights", () => {
  it("restores sentinel markers back to == syntax", () => {
    const input = `${HIGHLIGHT_START}highlighted text${HIGHLIGHT_END}`;
    expect(restoreHighlights(input)).toBe("==highlighted text==");
  });

  it("round-trips correctly with transformHighlights", () => {
    const original = "Some ==highlighted== words.";
    const transformed = transformHighlights(original);
    const restored = restoreHighlights(transformed);
    expect(restored).toBe(original);
  });

  it("handles multiple sentinel pairs", () => {
    const input = `A ${HIGHLIGHT_START}first${HIGHLIGHT_END} and ${HIGHLIGHT_START}second${HIGHLIGHT_END} B`;
    expect(restoreHighlights(input)).toBe("A ==first== and ==second== B");
  });
});

// ---------------------------------------------------------------------------
// restoreWikilinks
// ---------------------------------------------------------------------------
describe("restoreWikilinks", () => {
  it("restores a matching basename to a wikilink", () => {
    const vaultFiles = ["notes/MyPage.md"];
    expect(restoreWikilinks("See MyPage for details.", vaultFiles)).toBe(
      "See [[MyPage]] for details."
    );
  });

  it("does not restore text that does not match any vault file", () => {
    const vaultFiles = ["notes/Other.md"];
    expect(restoreWikilinks("See Missing for details.", vaultFiles)).toBe(
      "See Missing for details."
    );
  });

  it("returns text unchanged when vaultFiles is empty", () => {
    expect(restoreWikilinks("Some text", [])).toBe("Some text");
  });

  it("handles multiple matches", () => {
    const vaultFiles = ["Alpha.md", "Beta.md"];
    expect(restoreWikilinks("Alpha and Beta", vaultFiles)).toBe(
      "[[Alpha]] and [[Beta]]"
    );
  });
});
