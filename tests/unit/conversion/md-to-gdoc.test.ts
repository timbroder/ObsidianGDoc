import {
  markdownToGoogleDoc,
  parseInlineFormatting,
  headingLevel,
  isListItem,
  isCodeBlockFence,
  isBlockquote,
  isHorizontalRule,
  isTableRow,
  isTableSeparator,
} from "@/conversion/md-to-gdoc";
import type { DocRequest } from "@/types";
import {
  MONOSPACE_FONTS,
  CODE_BLOCK_BG_COLOR,
  HIGHLIGHT_BG_COLOR,
} from "@/constants";
import { HIGHLIGHT_START, HIGHLIGHT_END } from "@/conversion/obsidian-syntax";

// ---------------------------------------------------------------------------
// Helpers to inspect generated requests
// ---------------------------------------------------------------------------

function findRequests<K extends keyof UnwrappedRequests>(
  requests: DocRequest[],
  type: K,
): UnwrappedRequests[K][] {
  return requests
    .filter((r) => type in r)
    .map((r) => (r as any)[type]) as UnwrappedRequests[K][];
}

type UnwrappedRequests = {
  insertText: { text: string; location: { index: number } };
  updateTextStyle: {
    textStyle: any;
    range: { startIndex: number; endIndex: number };
    fields: string;
  };
  updateParagraphStyle: {
    paragraphStyle: any;
    range: { startIndex: number; endIndex: number };
    fields: string;
  };
  createParagraphBullets: {
    range: { startIndex: number; endIndex: number };
    bulletPreset: string;
  };
  insertTable: {
    rows: number;
    columns: number;
    location: { index: number };
  };
  deleteContentRange: {
    range: { startIndex: number; endIndex: number };
  };
};

// ---------------------------------------------------------------------------
// Helper line parsers
// ---------------------------------------------------------------------------

describe("headingLevel", () => {
  it("returns 0 for non-heading lines", () => {
    expect(headingLevel("Hello world")).toBe(0);
    expect(headingLevel("")).toBe(0);
    expect(headingLevel("##nospace")).toBe(0);
  });

  it.each([
    ["# H1", 1],
    ["## H2", 2],
    ["### H3", 3],
    ["#### H4", 4],
    ["##### H5", 5],
    ["###### H6", 6],
  ] as const)("returns correct level for %s", (line, expected) => {
    expect(headingLevel(line)).toBe(expected);
  });
});

describe("isListItem", () => {
  it("parses unordered list items", () => {
    const result = isListItem("- Item text");
    expect(result).toEqual({ ordered: false, indent: 0, content: "Item text" });
  });

  it("parses ordered list items", () => {
    const result = isListItem("1. Item text");
    expect(result).toEqual({ ordered: true, indent: 0, content: "Item text" });
  });

  it("parses indented items", () => {
    const result = isListItem("  - Nested item");
    expect(result).toEqual({ ordered: false, indent: 1, content: "Nested item" });
  });

  it("returns null for non-list lines", () => {
    expect(isListItem("Hello world")).toBeNull();
    expect(isListItem("")).toBeNull();
  });
});

describe("isCodeBlockFence", () => {
  it("detects opening fence with language", () => {
    expect(isCodeBlockFence("```typescript")).toEqual({
      language: "typescript",
    });
  });

  it("detects opening fence without language", () => {
    expect(isCodeBlockFence("```")).toEqual({ language: undefined });
  });

  it("detects tilde fences", () => {
    expect(isCodeBlockFence("~~~python")).toEqual({ language: "python" });
  });

  it("returns null for non-fence lines", () => {
    expect(isCodeBlockFence("Hello")).toBeNull();
  });
});

describe("isBlockquote", () => {
  it("returns content after >", () => {
    expect(isBlockquote("> Some quote")).toBe("Some quote");
  });

  it("handles > without space", () => {
    expect(isBlockquote(">content")).toBe("content");
  });

  it("returns null for non-blockquote lines", () => {
    expect(isBlockquote("Hello")).toBeNull();
  });
});

describe("isHorizontalRule", () => {
  it("detects dashes", () => {
    expect(isHorizontalRule("---")).toBe(true);
    expect(isHorizontalRule("-----")).toBe(true);
  });

  it("detects asterisks", () => {
    expect(isHorizontalRule("***")).toBe(true);
  });

  it("detects underscores", () => {
    expect(isHorizontalRule("___")).toBe(true);
  });

  it("rejects non-rules", () => {
    expect(isHorizontalRule("Hello")).toBe(false);
    expect(isHorizontalRule("--")).toBe(false);
  });
});

describe("isTableRow", () => {
  it("returns cells for valid table row", () => {
    expect(isTableRow("| A | B | C |")).toEqual(["A", "B", "C"]);
  });

  it("returns null for non-table lines", () => {
    expect(isTableRow("Hello")).toBeNull();
    expect(isTableRow("| no closing")).toBeNull();
  });
});

describe("isTableSeparator", () => {
  it("detects separator rows", () => {
    expect(isTableSeparator("| --- | --- |")).toBe(true);
    expect(isTableSeparator("| :---: | ---: |")).toBe(true);
  });

  it("rejects non-separator rows", () => {
    expect(isTableSeparator("| A | B |")).toBe(false);
    expect(isTableSeparator("Hello")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseInlineFormatting
// ---------------------------------------------------------------------------

describe("parseInlineFormatting", () => {
  it("returns a single run for plain text", () => {
    const runs = parseInlineFormatting("Hello world");
    expect(runs).toEqual([{ text: "Hello world" }]);
  });

  it("parses bold text", () => {
    const runs = parseInlineFormatting("**bold**");
    expect(runs).toEqual([{ text: "bold", bold: true }]);
  });

  it("parses italic text", () => {
    const runs = parseInlineFormatting("*italic*");
    expect(runs).toEqual([{ text: "italic", italic: true }]);
  });

  it("parses bold + italic text", () => {
    const runs = parseInlineFormatting("***both***");
    expect(runs).toEqual([{ text: "both", bold: true, italic: true }]);
  });

  it("parses strikethrough text", () => {
    const runs = parseInlineFormatting("~~deleted~~");
    expect(runs).toEqual([{ text: "deleted", strikethrough: true }]);
  });

  it("parses inline code", () => {
    const runs = parseInlineFormatting("`code`");
    expect(runs).toEqual([{ text: "code", code: true }]);
  });

  it("parses links", () => {
    const runs = parseInlineFormatting("[Click](https://example.com)");
    expect(runs).toEqual([{ text: "Click", link: "https://example.com" }]);
  });

  it("parses highlight sentinels", () => {
    const runs = parseInlineFormatting(
      `${HIGHLIGHT_START}highlighted${HIGHLIGHT_END}`,
    );
    expect(runs).toEqual([{ text: "highlighted", highlight: true }]);
  });

  it("parses mixed formatting", () => {
    const runs = parseInlineFormatting("Hello **bold** and *italic* text");
    expect(runs).toHaveLength(5);
    expect(runs[0]).toEqual({ text: "Hello " });
    expect(runs[1]).toEqual({ text: "bold", bold: true });
    expect(runs[2]).toEqual({ text: " and " });
    expect(runs[3]).toEqual({ text: "italic", italic: true });
    expect(runs[4]).toEqual({ text: " text" });
  });
});

// ---------------------------------------------------------------------------
// markdownToGoogleDoc
// ---------------------------------------------------------------------------

describe("markdownToGoogleDoc", () => {
  describe("empty / whitespace input", () => {
    it("returns empty requests for empty string", () => {
      const result = markdownToGoogleDoc("");
      expect(result.requests).toEqual([]);
    });

    it("returns empty requests for whitespace-only string", () => {
      const result = markdownToGoogleDoc("   \n  \n  ");
      expect(result.requests).toEqual([]);
    });
  });

  describe("plain text paragraphs", () => {
    it("creates insertText for a single paragraph", () => {
      const result = markdownToGoogleDoc("Hello world");
      const inserts = findRequests(result.requests, "insertText");
      expect(inserts.length).toBe(1);
      expect(inserts[0].text).toBe("Hello world\n");
      expect(inserts[0].location.index).toBe(1);
    });

    it("creates separate paragraphs for double-newline-separated text", () => {
      const result = markdownToGoogleDoc("First paragraph\n\nSecond paragraph");
      const inserts = findRequests(result.requests, "insertText");
      expect(inserts.length).toBe(2);
      expect(inserts[0].text).toBe("First paragraph\n");
      expect(inserts[1].text).toBe("Second paragraph\n");
      // Second insert starts after the first
      expect(inserts[1].location.index).toBe(1 + "First paragraph\n".length);
    });
  });

  describe("headings", () => {
    it.each([1, 2, 3, 4, 5, 6])("handles heading level %i", (level) => {
      const hashes = "#".repeat(level);
      const result = markdownToGoogleDoc(`${hashes} My Heading`);

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts.length).toBe(1);
      expect(inserts[0].text).toBe("My Heading\n");

      const paraStyles = findRequests(result.requests, "updateParagraphStyle");
      expect(paraStyles.length).toBe(1);
      expect(paraStyles[0].paragraphStyle.namedStyleType).toBe(
        `HEADING_${level}`,
      );
    });
  });

  describe("bold text", () => {
    it("applies bold style", () => {
      const result = markdownToGoogleDoc("**bold text**");
      const inserts = findRequests(result.requests, "insertText");
      expect(inserts[0].text).toBe("bold text\n");

      const textStyles = findRequests(result.requests, "updateTextStyle");
      const boldStyles = textStyles.filter((s) => s.fields === "bold");
      expect(boldStyles.length).toBe(1);
      expect(boldStyles[0].textStyle.bold).toBe(true);
      expect(boldStyles[0].range).toEqual({ startIndex: 1, endIndex: 10 });
    });
  });

  describe("italic text", () => {
    it("applies italic style", () => {
      const result = markdownToGoogleDoc("*italic text*");
      const inserts = findRequests(result.requests, "insertText");
      expect(inserts[0].text).toBe("italic text\n");

      const textStyles = findRequests(result.requests, "updateTextStyle");
      const italicStyles = textStyles.filter((s) => s.fields === "italic");
      expect(italicStyles.length).toBe(1);
      expect(italicStyles[0].textStyle.italic).toBe(true);
    });
  });

  describe("bold + italic text", () => {
    it("applies both bold and italic style", () => {
      const result = markdownToGoogleDoc("***both***");
      const inserts = findRequests(result.requests, "insertText");
      expect(inserts[0].text).toBe("both\n");

      const textStyles = findRequests(result.requests, "updateTextStyle");
      const boldStyles = textStyles.filter((s) => s.fields === "bold");
      const italicStyles = textStyles.filter((s) => s.fields === "italic");
      expect(boldStyles.length).toBe(1);
      expect(italicStyles.length).toBe(1);
    });
  });

  describe("strikethrough text", () => {
    it("applies strikethrough style", () => {
      const result = markdownToGoogleDoc("~~deleted~~");
      const inserts = findRequests(result.requests, "insertText");
      expect(inserts[0].text).toBe("deleted\n");

      const textStyles = findRequests(result.requests, "updateTextStyle");
      const strikeStyles = textStyles.filter(
        (s) => s.fields === "strikethrough",
      );
      expect(strikeStyles.length).toBe(1);
      expect(strikeStyles[0].textStyle.strikethrough).toBe(true);
    });
  });

  describe("inline code", () => {
    it("applies monospace font style", () => {
      const result = markdownToGoogleDoc("Use `console.log` here");
      const inserts = findRequests(result.requests, "insertText");
      expect(inserts[0].text).toBe("Use console.log here\n");

      const textStyles = findRequests(result.requests, "updateTextStyle");
      const monoStyles = textStyles.filter(
        (s) => s.fields === "weightedFontFamily",
      );
      expect(monoStyles.length).toBe(1);
      expect(monoStyles[0].textStyle.weightedFontFamily.fontFamily).toBe(
        MONOSPACE_FONTS[0],
      );
      // "Use " is 4 chars, starting at index 1 -> code starts at 5
      expect(monoStyles[0].range.startIndex).toBe(5);
      expect(monoStyles[0].range.endIndex).toBe(5 + "console.log".length);
    });
  });

  describe("code block", () => {
    it("applies monospace font and background color", () => {
      const result = markdownToGoogleDoc(
        "```javascript\nconst x = 1;\n```",
      );

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts.length).toBe(1);
      expect(inserts[0].text).toBe("const x = 1;\n");

      const textStyles = findRequests(result.requests, "updateTextStyle");
      const monoStyles = textStyles.filter(
        (s) => s.fields === "weightedFontFamily",
      );
      expect(monoStyles.length).toBe(1);
      expect(monoStyles[0].textStyle.weightedFontFamily.fontFamily).toBe(
        MONOSPACE_FONTS[0],
      );

      const bgStyles = textStyles.filter(
        (s) => s.fields === "backgroundColor",
      );
      expect(bgStyles.length).toBe(1);
      expect(bgStyles[0].textStyle.backgroundColor.color.rgbColor).toEqual(
        CODE_BLOCK_BG_COLOR,
      );
    });
  });

  describe("unordered list", () => {
    it("creates paragraph bullets with disc preset", () => {
      const result = markdownToGoogleDoc("- Item one\n- Item two");

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts.length).toBe(2);
      expect(inserts[0].text).toBe("Item one\n");
      expect(inserts[1].text).toBe("Item two\n");

      const bullets = findRequests(result.requests, "createParagraphBullets");
      expect(bullets.length).toBe(2);
      expect(bullets[0].bulletPreset).toBe("BULLET_DISC_CIRCLE_SQUARE");
      expect(bullets[1].bulletPreset).toBe("BULLET_DISC_CIRCLE_SQUARE");
    });
  });

  describe("ordered list", () => {
    it("creates paragraph bullets with numbered preset", () => {
      const result = markdownToGoogleDoc("1. First\n2. Second");

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts.length).toBe(2);
      expect(inserts[0].text).toBe("First\n");
      expect(inserts[1].text).toBe("Second\n");

      const bullets = findRequests(result.requests, "createParagraphBullets");
      expect(bullets.length).toBe(2);
      expect(bullets[0].bulletPreset).toBe("NUMBERED_DECIMAL_ALPHA_ROMAN");
    });
  });

  describe("hyperlink", () => {
    it("inserts link text and applies link style", () => {
      const result = markdownToGoogleDoc("[Google](https://google.com)");

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts[0].text).toBe("Google\n");

      const textStyles = findRequests(result.requests, "updateTextStyle");
      const linkStyles = textStyles.filter((s) => s.fields === "link");
      expect(linkStyles.length).toBe(1);
      expect(linkStyles[0].textStyle.link.url).toBe("https://google.com");
    });
  });

  describe("blockquote", () => {
    it("applies indented paragraph style", () => {
      const result = markdownToGoogleDoc("> This is a quote");

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts[0].text).toBe("This is a quote\n");

      const paraStyles = findRequests(result.requests, "updateParagraphStyle");
      expect(paraStyles.length).toBe(1);
      expect(paraStyles[0].paragraphStyle.indentStart).toEqual({
        magnitude: 36,
        unit: "PT",
      });
      expect(paraStyles[0].paragraphStyle.indentFirstLine).toEqual({
        magnitude: 36,
        unit: "PT",
      });
    });
  });

  describe("horizontal rule", () => {
    it("inserts a visual separator and centers it", () => {
      const result = markdownToGoogleDoc("---");

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts.length).toBe(1);
      // Should contain the box-drawing character
      expect(inserts[0].text).toContain("\u2501");
      expect(inserts[0].text.endsWith("\n")).toBe(true);

      const paraStyles = findRequests(result.requests, "updateParagraphStyle");
      expect(paraStyles.length).toBe(1);
      expect(paraStyles[0].paragraphStyle.alignment).toBe("CENTER");
    });
  });

  describe("simple table", () => {
    it("creates insertTable and populates cell content", () => {
      const md = "| A | B |\n| --- | --- |\n| 1 | 2 |";
      const result = markdownToGoogleDoc(md);

      const tables = findRequests(result.requests, "insertTable");
      expect(tables.length).toBe(1);
      expect(tables[0].rows).toBe(2); // header + 1 data row
      expect(tables[0].columns).toBe(2);

      // Cell text insertions (in reverse order for index stability).
      const inserts = findRequests(result.requests, "insertText");
      const cellTexts = inserts.map((i) => i.text).sort();
      expect(cellTexts).toEqual(["1", "2", "A", "B"]);
    });
  });

  describe("highlight sentinel", () => {
    it("applies yellow background style", () => {
      const md = `${HIGHLIGHT_START}important${HIGHLIGHT_END}`;
      const result = markdownToGoogleDoc(md);

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts[0].text).toBe("important\n");

      const textStyles = findRequests(result.requests, "updateTextStyle");
      const bgStyles = textStyles.filter(
        (s) => s.fields === "backgroundColor",
      );
      expect(bgStyles.length).toBe(1);
      expect(bgStyles[0].textStyle.backgroundColor.color.rgbColor).toEqual(
        HIGHLIGHT_BG_COLOR,
      );
    });
  });

  describe("unicode content", () => {
    it("handles unicode text correctly", () => {
      const result = markdownToGoogleDoc(
        "\u{1F600} emoji and \u00FC\u00F1\u00EE\u00E7\u00F6de",
      );
      const inserts = findRequests(result.requests, "insertText");
      expect(inserts.length).toBe(1);
      expect(inserts[0].text).toBe(
        "\u{1F600} emoji and \u00FC\u00F1\u00EE\u00E7\u00F6de\n",
      );
    });
  });

  describe("mixed formatting in one paragraph", () => {
    it("handles bold and italic in one line", () => {
      const result = markdownToGoogleDoc(
        "Hello **bold** and *italic* text",
      );

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts.length).toBe(1);
      expect(inserts[0].text).toBe("Hello bold and italic text\n");

      const textStyles = findRequests(result.requests, "updateTextStyle");
      const boldStyles = textStyles.filter((s) => s.fields === "bold");
      const italicStyles = textStyles.filter((s) => s.fields === "italic");

      expect(boldStyles.length).toBe(1);
      expect(boldStyles[0].textStyle.bold).toBe(true);
      // "Hello " = 6 chars, starting at index 1 -> bold starts at 7
      expect(boldStyles[0].range.startIndex).toBe(7);
      expect(boldStyles[0].range.endIndex).toBe(7 + "bold".length);

      expect(italicStyles.length).toBe(1);
      expect(italicStyles[0].textStyle.italic).toBe(true);
      // "Hello bold and " = 15 chars, starting at index 1 -> italic starts at 16
      expect(italicStyles[0].range.startIndex).toBe(16);
      expect(italicStyles[0].range.endIndex).toBe(16 + "italic".length);
    });
  });

  describe("heading with inline formatting", () => {
    it("strips markdown markers and applies styles", () => {
      const result = markdownToGoogleDoc("## **Bold Heading**");

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts[0].text).toBe("Bold Heading\n");

      const paraStyles = findRequests(result.requests, "updateParagraphStyle");
      expect(paraStyles[0].paragraphStyle.namedStyleType).toBe("HEADING_2");

      const textStyles = findRequests(result.requests, "updateTextStyle");
      const boldStyles = textStyles.filter((s) => s.fields === "bold");
      expect(boldStyles.length).toBe(1);
    });
  });

  describe("multi-line code block", () => {
    it("preserves internal newlines", () => {
      const md = "```\nline1\nline2\nline3\n```";
      const result = markdownToGoogleDoc(md);

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts[0].text).toBe("line1\nline2\nline3\n");
    });
  });

  describe("list with inline formatting", () => {
    it("applies styles to list item content", () => {
      const result = markdownToGoogleDoc("- **bold item**");

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts[0].text).toBe("bold item\n");

      const bullets = findRequests(result.requests, "createParagraphBullets");
      expect(bullets.length).toBe(1);

      const textStyles = findRequests(result.requests, "updateTextStyle");
      const boldStyles = textStyles.filter((s) => s.fields === "bold");
      expect(boldStyles.length).toBe(1);
    });
  });

  describe("index tracking across blocks", () => {
    it("correctly advances indices through multiple blocks", () => {
      const md = "# Title\n\nParagraph text\n\n- List item";
      const result = markdownToGoogleDoc(md);

      const inserts = findRequests(result.requests, "insertText");
      expect(inserts.length).toBe(3);

      // Title starts at index 1
      expect(inserts[0].location.index).toBe(1);
      expect(inserts[0].text).toBe("Title\n");

      // Paragraph starts after "Title\n" (6 chars) at index 7
      expect(inserts[1].location.index).toBe(7);
      expect(inserts[1].text).toBe("Paragraph text\n");

      // List item starts after "Title\nParagraph text\n" at index 22
      expect(inserts[2].location.index).toBe(22);
      expect(inserts[2].text).toBe("List item\n");
    });
  });
});
