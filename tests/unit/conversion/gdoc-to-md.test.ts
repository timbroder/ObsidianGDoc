import {
  googleDocToMarkdown,
  isMonospaceFont,
  textRunToMarkdown,
  paragraphToMarkdown,
  tableToMarkdown,
  getListPrefix,
} from "@/conversion/gdoc-to-md";
import {
  GoogleDoc,
  GoogleDocParagraph,
  GoogleDocParagraphElement,
  GoogleDocParagraphStyle,
  GoogleDocStructuralElement,
  GoogleDocTable,
  GoogleDocTextRun,
  GoogleDocTextStyle,
  GoogleDocBullet,
  GoogleDocList,
} from "@/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTextRun(
  content: string,
  style: Partial<GoogleDocTextStyle> = {},
): GoogleDocTextRun {
  return {
    content,
    textStyle: style as GoogleDocTextStyle,
  };
}

function makeParagraphElement(
  textRun?: GoogleDocTextRun,
  inlineObjectId?: string,
): GoogleDocParagraphElement {
  const el: GoogleDocParagraphElement = {
    startIndex: 0,
    endIndex: 0,
  };
  if (textRun) el.textRun = textRun;
  if (inlineObjectId) el.inlineObjectElement = { inlineObjectId };
  return el;
}

function makeParagraph(
  elements: GoogleDocParagraphElement[],
  style: Partial<GoogleDocParagraphStyle> = {},
  bullet?: GoogleDocBullet,
): GoogleDocParagraph {
  return {
    elements,
    paragraphStyle: {
      namedStyleType: "NORMAL_TEXT",
      ...style,
    } as GoogleDocParagraphStyle,
    ...(bullet ? { bullet } : {}),
  };
}

function makeStructuralElement(
  paragraph?: GoogleDocParagraph,
  table?: GoogleDocTable,
): GoogleDocStructuralElement {
  return {
    startIndex: 0,
    endIndex: 0,
    ...(paragraph ? { paragraph } : {}),
    ...(table ? { table } : {}),
  };
}

function makeDoc(
  elements: GoogleDocStructuralElement[],
  lists?: Record<string, GoogleDocList>,
): GoogleDoc {
  return {
    documentId: "test-doc-id",
    title: "Test Document",
    body: { content: elements },
    ...(lists ? { lists } : {}),
  };
}

/** Shorthand: build a doc from simple text paragraphs. */
function makeSimpleDoc(
  ...texts: string[]
): GoogleDoc {
  const elements = texts.map((text) =>
    makeStructuralElement(
      makeParagraph([
        makeParagraphElement(makeTextRun(text + "\n")),
      ]),
    ),
  );
  return makeDoc(elements);
}

// ---------------------------------------------------------------------------
// isMonospaceFont
// ---------------------------------------------------------------------------

describe("isMonospaceFont", () => {
  it("returns false for undefined", () => {
    expect(isMonospaceFont(undefined)).toBe(false);
  });

  it("returns true for Courier New", () => {
    expect(isMonospaceFont("Courier New")).toBe(true);
  });

  it("returns true for Consolas (case-insensitive)", () => {
    expect(isMonospaceFont("consolas")).toBe(true);
  });

  it("returns false for Arial", () => {
    expect(isMonospaceFont("Arial")).toBe(false);
  });

  it("returns true for Monaco", () => {
    expect(isMonospaceFont("Monaco")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// textRunToMarkdown
// ---------------------------------------------------------------------------

describe("textRunToMarkdown", () => {
  it("converts plain text", () => {
    const run = makeTextRun("Hello world\n");
    expect(textRunToMarkdown(run)).toBe("Hello world");
  });

  it("converts bold text", () => {
    const run = makeTextRun("bold\n", { bold: true });
    expect(textRunToMarkdown(run)).toBe("**bold**");
  });

  it("converts italic text", () => {
    const run = makeTextRun("italic\n", { italic: true });
    expect(textRunToMarkdown(run)).toBe("*italic*");
  });

  it("converts bold + italic text", () => {
    const run = makeTextRun("both\n", { bold: true, italic: true });
    expect(textRunToMarkdown(run)).toBe("***both***");
  });

  it("converts strikethrough text", () => {
    const run = makeTextRun("deleted\n", { strikethrough: true });
    expect(textRunToMarkdown(run)).toBe("~~deleted~~");
  });

  it("converts monospace font to inline code", () => {
    const run = makeTextRun("code\n", {
      weightedFontFamily: { fontFamily: "Courier New" },
    });
    expect(textRunToMarkdown(run)).toBe("`code`");
  });

  it("converts hyperlink", () => {
    const run = makeTextRun("click here\n", {
      link: { url: "https://example.com" },
    });
    expect(textRunToMarkdown(run)).toBe("[click here](https://example.com)");
  });

  it("converts colored text to HTML span", () => {
    const run = makeTextRun("red text\n", {
      foregroundColor: {
        color: { rgbColor: { red: 1, green: 0, blue: 0 } },
      },
    });
    expect(textRunToMarkdown(run)).toBe(
      '<span style="color: #FF0000">red text</span>',
    );
  });

  it("ignores default black foreground color", () => {
    const run = makeTextRun("black text\n", {
      foregroundColor: {
        color: { rgbColor: { red: 0, green: 0, blue: 0 } },
      },
    });
    expect(textRunToMarkdown(run)).toBe("black text");
  });

  it("converts highlighted text to == syntax", () => {
    const run = makeTextRun("important\n", {
      backgroundColor: {
        color: { rgbColor: { red: 1, green: 1, blue: 0 } },
      },
    });
    expect(textRunToMarkdown(run)).toBe("==important==");
  });

  it("returns empty string for newline-only content", () => {
    const run = makeTextRun("\n");
    expect(textRunToMarkdown(run)).toBe("");
  });

  it("combines bold + italic + strikethrough", () => {
    const run = makeTextRun("all\n", {
      bold: true,
      italic: true,
      strikethrough: true,
    });
    expect(textRunToMarkdown(run)).toBe("~~***all***~~");
  });
});

// ---------------------------------------------------------------------------
// paragraphToMarkdown
// ---------------------------------------------------------------------------

describe("paragraphToMarkdown", () => {
  const emptyDoc = makeDoc([]);

  it("converts a plain text paragraph", () => {
    const para = makeParagraph([
      makeParagraphElement(makeTextRun("Hello world\n")),
    ]);
    expect(paragraphToMarkdown(para, emptyDoc)).toBe("Hello world");
  });

  it("converts HEADING_1", () => {
    const para = makeParagraph(
      [makeParagraphElement(makeTextRun("Title\n"))],
      { namedStyleType: "HEADING_1" },
    );
    expect(paragraphToMarkdown(para, emptyDoc)).toBe("# Title");
  });

  it("converts HEADING_2", () => {
    const para = makeParagraph(
      [makeParagraphElement(makeTextRun("Subtitle\n"))],
      { namedStyleType: "HEADING_2" },
    );
    expect(paragraphToMarkdown(para, emptyDoc)).toBe("## Subtitle");
  });

  it("converts HEADING_3", () => {
    const para = makeParagraph(
      [makeParagraphElement(makeTextRun("Section\n"))],
      { namedStyleType: "HEADING_3" },
    );
    expect(paragraphToMarkdown(para, emptyDoc)).toBe("### Section");
  });

  it("converts HEADING_4", () => {
    const para = makeParagraph(
      [makeParagraphElement(makeTextRun("Sub-section\n"))],
      { namedStyleType: "HEADING_4" },
    );
    expect(paragraphToMarkdown(para, emptyDoc)).toBe("#### Sub-section");
  });

  it("converts HEADING_5", () => {
    const para = makeParagraph(
      [makeParagraphElement(makeTextRun("Deep\n"))],
      { namedStyleType: "HEADING_5" },
    );
    expect(paragraphToMarkdown(para, emptyDoc)).toBe("##### Deep");
  });

  it("converts HEADING_6", () => {
    const para = makeParagraph(
      [makeParagraphElement(makeTextRun("Deepest\n"))],
      { namedStyleType: "HEADING_6" },
    );
    expect(paragraphToMarkdown(para, emptyDoc)).toBe("###### Deepest");
  });

  it("returns empty string for empty paragraph", () => {
    const para = makeParagraph([
      makeParagraphElement(makeTextRun("\n")),
    ]);
    expect(paragraphToMarkdown(para, emptyDoc)).toBe("");
  });

  it("handles inline object elements as image placeholders", () => {
    const para = makeParagraph([
      makeParagraphElement(undefined, "image123"),
    ]);
    expect(paragraphToMarkdown(para, emptyDoc)).toBe(
      "<!-- gdocs-image: image123 -->",
    );
  });

  it("handles mixed text runs in a single paragraph", () => {
    const para = makeParagraph([
      makeParagraphElement(makeTextRun("Hello ")),
      makeParagraphElement(makeTextRun("bold", { bold: true })),
      makeParagraphElement(makeTextRun(" world\n")),
    ]);
    expect(paragraphToMarkdown(para, emptyDoc)).toBe(
      "Hello **bold** world",
    );
  });

  it("handles center alignment", () => {
    const para = makeParagraph(
      [makeParagraphElement(makeTextRun("centered\n"))],
      { namedStyleType: "NORMAL_TEXT", alignment: "CENTER" },
    );
    expect(paragraphToMarkdown(para, emptyDoc)).toBe(
      '<p style="text-align: center">centered</p>',
    );
  });

  it("handles right alignment (END)", () => {
    const para = makeParagraph(
      [makeParagraphElement(makeTextRun("right\n"))],
      { namedStyleType: "NORMAL_TEXT", alignment: "END" },
    );
    expect(paragraphToMarkdown(para, emptyDoc)).toBe(
      '<p style="text-align: right">right</p>',
    );
  });
});

// ---------------------------------------------------------------------------
// getListPrefix
// ---------------------------------------------------------------------------

describe("getListPrefix", () => {
  it("returns '- ' for an unordered list at level 0", () => {
    const doc = makeDoc([], {
      "list1": {
        listProperties: {
          nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }],
        },
      },
    });
    const prefix = getListPrefix({ listId: "list1", nestingLevel: 0 }, doc);
    expect(prefix).toBe("- ");
  });

  it("returns '1. ' for an ordered list at level 0", () => {
    const doc = makeDoc([], {
      "list1": {
        listProperties: {
          nestingLevels: [{ glyphType: "DECIMAL" }],
        },
      },
    });
    const prefix = getListPrefix({ listId: "list1", nestingLevel: 0 }, doc);
    expect(prefix).toBe("1. ");
  });

  it("returns indented prefix for nested list items", () => {
    const doc = makeDoc([], {
      "list1": {
        listProperties: {
          nestingLevels: [
            { glyphType: "GLYPH_TYPE_UNSPECIFIED" },
            { glyphType: "GLYPH_TYPE_UNSPECIFIED" },
          ],
        },
      },
    });
    const prefix = getListPrefix({ listId: "list1", nestingLevel: 1 }, doc);
    expect(prefix).toBe("  - ");
  });

  it("returns double-indented prefix for level 2", () => {
    const doc = makeDoc([], {
      "list1": {
        listProperties: {
          nestingLevels: [
            { glyphType: "GLYPH_TYPE_UNSPECIFIED" },
            { glyphType: "GLYPH_TYPE_UNSPECIFIED" },
            { glyphType: "DECIMAL" },
          ],
        },
      },
    });
    const prefix = getListPrefix({ listId: "list1", nestingLevel: 2 }, doc);
    expect(prefix).toBe("    1. ");
  });

  it("falls back to '- ' when list is not found", () => {
    const doc = makeDoc([]);
    const prefix = getListPrefix(
      { listId: "nonexistent", nestingLevel: 0 },
      doc,
    );
    expect(prefix).toBe("- ");
  });
});

// ---------------------------------------------------------------------------
// tableToMarkdown
// ---------------------------------------------------------------------------

describe("tableToMarkdown", () => {
  it("converts a simple 2x2 table", () => {
    const table: GoogleDocTable = {
      rows: 2,
      columns: 2,
      tableRows: [
        {
          startIndex: 0,
          endIndex: 0,
          tableCells: [
            {
              startIndex: 0,
              endIndex: 0,
              content: [
                makeStructuralElement(
                  makeParagraph([
                    makeParagraphElement(makeTextRun("Header 1\n")),
                  ]),
                ),
              ],
            },
            {
              startIndex: 0,
              endIndex: 0,
              content: [
                makeStructuralElement(
                  makeParagraph([
                    makeParagraphElement(makeTextRun("Header 2\n")),
                  ]),
                ),
              ],
            },
          ],
        },
        {
          startIndex: 0,
          endIndex: 0,
          tableCells: [
            {
              startIndex: 0,
              endIndex: 0,
              content: [
                makeStructuralElement(
                  makeParagraph([
                    makeParagraphElement(makeTextRun("Cell 1\n")),
                  ]),
                ),
              ],
            },
            {
              startIndex: 0,
              endIndex: 0,
              content: [
                makeStructuralElement(
                  makeParagraph([
                    makeParagraphElement(makeTextRun("Cell 2\n")),
                  ]),
                ),
              ],
            },
          ],
        },
      ],
    };

    const doc = makeDoc([]);
    const result = tableToMarkdown(table, doc);
    expect(result).toBe(
      "| Header 1 | Header 2 |\n" +
      "| --- | --- |\n" +
      "| Cell 1 | Cell 2 |",
    );
  });

  it("returns empty string for table with no rows", () => {
    const table: GoogleDocTable = {
      rows: 0,
      columns: 0,
      tableRows: [],
    };
    expect(tableToMarkdown(table, makeDoc([]))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// googleDocToMarkdown (full integration)
// ---------------------------------------------------------------------------

describe("googleDocToMarkdown", () => {
  it("returns empty string for empty doc", () => {
    const doc = makeDoc([]);
    expect(googleDocToMarkdown(doc)).toBe("");
  });

  it("returns empty string for doc with empty body content array", () => {
    const doc: GoogleDoc = {
      documentId: "id",
      title: "Title",
      body: { content: [] },
    };
    expect(googleDocToMarkdown(doc)).toBe("");
  });

  it("converts a single plain text paragraph", () => {
    const doc = makeSimpleDoc("Hello world");
    expect(googleDocToMarkdown(doc)).toBe("Hello world\n");
  });

  it("converts HEADING_1 paragraph", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph(
          [makeParagraphElement(makeTextRun("Title\n"))],
          { namedStyleType: "HEADING_1" },
        ),
      ),
    ]);
    expect(googleDocToMarkdown(doc)).toBe("# Title\n");
  });

  it("converts all heading levels", () => {
    const headings = [
      "HEADING_1",
      "HEADING_2",
      "HEADING_3",
      "HEADING_4",
      "HEADING_5",
      "HEADING_6",
    ];
    const elements = headings.map((h, i) =>
      makeStructuralElement(
        makeParagraph(
          [makeParagraphElement(makeTextRun(`Level ${i + 1}\n`))],
          { namedStyleType: h },
        ),
      ),
    );
    const doc = makeDoc(elements);
    const result = googleDocToMarkdown(doc);
    expect(result).toContain("# Level 1");
    expect(result).toContain("## Level 2");
    expect(result).toContain("### Level 3");
    expect(result).toContain("#### Level 4");
    expect(result).toContain("##### Level 5");
    expect(result).toContain("###### Level 6");
  });

  it("converts bold text run", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(makeTextRun("bold\n", { bold: true })),
        ]),
      ),
    ]);
    expect(googleDocToMarkdown(doc)).toBe("**bold**\n");
  });

  it("converts italic text run", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(makeTextRun("italic\n", { italic: true })),
        ]),
      ),
    ]);
    expect(googleDocToMarkdown(doc)).toBe("*italic*\n");
  });

  it("converts bold + italic text run", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(
            makeTextRun("both\n", { bold: true, italic: true }),
          ),
        ]),
      ),
    ]);
    expect(googleDocToMarkdown(doc)).toBe("***both***\n");
  });

  it("converts strikethrough text run", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(
            makeTextRun("struck\n", { strikethrough: true }),
          ),
        ]),
      ),
    ]);
    expect(googleDocToMarkdown(doc)).toBe("~~struck~~\n");
  });

  it("converts monospace font to backtick", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(
            makeTextRun("code\n", {
              weightedFontFamily: { fontFamily: "Courier New" },
            }),
          ),
        ]),
      ),
    ]);
    // Single monospace paragraph becomes a code block.
    expect(googleDocToMarkdown(doc)).toContain("code");
  });

  it("converts hyperlink", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(
            makeTextRun("click\n", {
              link: { url: "https://example.com" },
            }),
          ),
        ]),
      ),
    ]);
    expect(googleDocToMarkdown(doc)).toBe(
      "[click](https://example.com)\n",
    );
  });

  it("converts colored text to HTML span", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(
            makeTextRun("red\n", {
              foregroundColor: {
                color: { rgbColor: { red: 1, green: 0, blue: 0 } },
              },
            }),
          ),
        ]),
      ),
    ]);
    expect(googleDocToMarkdown(doc)).toBe(
      '<span style="color: #FF0000">red</span>\n',
    );
  });

  it("converts highlighted text to == syntax", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(
            makeTextRun("highlight\n", {
              backgroundColor: {
                color: { rgbColor: { red: 1, green: 1, blue: 0 } },
              },
            }),
          ),
        ]),
      ),
    ]);
    expect(googleDocToMarkdown(doc)).toBe("==highlight==\n");
  });

  it("converts inline image to placeholder comment", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([makeParagraphElement(undefined, "img-abc-123")]),
      ),
    ]);
    expect(googleDocToMarkdown(doc)).toBe(
      "<!-- gdocs-image: img-abc-123 -->\n",
    );
  });

  it("converts unordered bullet list", () => {
    const lists: Record<string, GoogleDocList> = {
      "list-1": {
        listProperties: {
          nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }],
        },
      },
    };

    const doc = makeDoc(
      [
        makeStructuralElement(
          makeParagraph(
            [makeParagraphElement(makeTextRun("Item 1\n"))],
            {},
            { listId: "list-1", nestingLevel: 0 },
          ),
        ),
        makeStructuralElement(
          makeParagraph(
            [makeParagraphElement(makeTextRun("Item 2\n"))],
            {},
            { listId: "list-1", nestingLevel: 0 },
          ),
        ),
      ],
      lists,
    );

    const result = googleDocToMarkdown(doc);
    expect(result).toBe("- Item 1\n- Item 2\n");
  });

  it("converts nested bullet list with proper indentation", () => {
    const lists: Record<string, GoogleDocList> = {
      "list-1": {
        listProperties: {
          nestingLevels: [
            { glyphType: "GLYPH_TYPE_UNSPECIFIED" },
            { glyphType: "GLYPH_TYPE_UNSPECIFIED" },
          ],
        },
      },
    };

    const doc = makeDoc(
      [
        makeStructuralElement(
          makeParagraph(
            [makeParagraphElement(makeTextRun("Parent\n"))],
            {},
            { listId: "list-1", nestingLevel: 0 },
          ),
        ),
        makeStructuralElement(
          makeParagraph(
            [makeParagraphElement(makeTextRun("Child\n"))],
            {},
            { listId: "list-1", nestingLevel: 1 },
          ),
        ),
      ],
      lists,
    );

    const result = googleDocToMarkdown(doc);
    expect(result).toBe("- Parent\n  - Child\n");
  });

  it("converts ordered (numbered) list", () => {
    const lists: Record<string, GoogleDocList> = {
      "list-1": {
        listProperties: {
          nestingLevels: [{ glyphType: "DECIMAL" }],
        },
      },
    };

    const doc = makeDoc(
      [
        makeStructuralElement(
          makeParagraph(
            [makeParagraphElement(makeTextRun("First\n"))],
            {},
            { listId: "list-1", nestingLevel: 0 },
          ),
        ),
        makeStructuralElement(
          makeParagraph(
            [makeParagraphElement(makeTextRun("Second\n"))],
            {},
            { listId: "list-1", nestingLevel: 0 },
          ),
        ),
      ],
      lists,
    );

    const result = googleDocToMarkdown(doc);
    expect(result).toBe("1. First\n1. Second\n");
  });

  it("converts a table", () => {
    const table: GoogleDocTable = {
      rows: 2,
      columns: 2,
      tableRows: [
        {
          startIndex: 0,
          endIndex: 0,
          tableCells: [
            {
              startIndex: 0,
              endIndex: 0,
              content: [
                makeStructuralElement(
                  makeParagraph([
                    makeParagraphElement(makeTextRun("A\n")),
                  ]),
                ),
              ],
            },
            {
              startIndex: 0,
              endIndex: 0,
              content: [
                makeStructuralElement(
                  makeParagraph([
                    makeParagraphElement(makeTextRun("B\n")),
                  ]),
                ),
              ],
            },
          ],
        },
        {
          startIndex: 0,
          endIndex: 0,
          tableCells: [
            {
              startIndex: 0,
              endIndex: 0,
              content: [
                makeStructuralElement(
                  makeParagraph([
                    makeParagraphElement(makeTextRun("1\n")),
                  ]),
                ),
              ],
            },
            {
              startIndex: 0,
              endIndex: 0,
              content: [
                makeStructuralElement(
                  makeParagraph([
                    makeParagraphElement(makeTextRun("2\n")),
                  ]),
                ),
              ],
            },
          ],
        },
      ],
    };

    const doc = makeDoc([makeStructuralElement(undefined, table)]);
    const result = googleDocToMarkdown(doc);
    expect(result).toBe(
      "| A | B |\n| --- | --- |\n| 1 | 2 |\n",
    );
  });

  it("handles mixed formatting in a single paragraph", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(makeTextRun("Normal ")),
          makeParagraphElement(makeTextRun("bold", { bold: true })),
          makeParagraphElement(makeTextRun(" and ")),
          makeParagraphElement(makeTextRun("italic", { italic: true })),
          makeParagraphElement(makeTextRun(" text\n")),
        ]),
      ),
    ]);
    expect(googleDocToMarkdown(doc)).toBe(
      "Normal **bold** and *italic* text\n",
    );
  });

  it("handles multiple paragraphs with blank lines between them", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(makeTextRun("First paragraph\n")),
        ]),
      ),
      makeStructuralElement(
        makeParagraph([makeParagraphElement(makeTextRun("\n"))]),
      ),
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(makeTextRun("Second paragraph\n")),
        ]),
      ),
    ]);
    const result = googleDocToMarkdown(doc);
    expect(result).toBe("First paragraph\n\nSecond paragraph\n");
  });

  it("collapses multiple consecutive blank lines into one", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(makeTextRun("Para 1\n")),
        ]),
      ),
      makeStructuralElement(
        makeParagraph([makeParagraphElement(makeTextRun("\n"))]),
      ),
      makeStructuralElement(
        makeParagraph([makeParagraphElement(makeTextRun("\n"))]),
      ),
      makeStructuralElement(
        makeParagraph([makeParagraphElement(makeTextRun("\n"))]),
      ),
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(makeTextRun("Para 2\n")),
        ]),
      ),
    ]);
    const result = googleDocToMarkdown(doc);
    expect(result).toBe("Para 1\n\nPara 2\n");
  });

  it("skips section break elements", () => {
    const doc = makeDoc([
      {
        startIndex: 0,
        endIndex: 0,
        sectionBreak: {},
      },
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(makeTextRun("Content\n")),
        ]),
      ),
    ]);
    expect(googleDocToMarkdown(doc)).toBe("Content\n");
  });

  it("wraps consecutive monospace paragraphs in code block fences", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(
            makeTextRun("const x = 1;\n", {
              weightedFontFamily: { fontFamily: "Courier New" },
            }),
          ),
        ]),
      ),
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(
            makeTextRun("const y = 2;\n", {
              weightedFontFamily: { fontFamily: "Courier New" },
            }),
          ),
        ]),
      ),
    ]);
    const result = googleDocToMarkdown(doc);
    expect(result).toBe("```\nconst x = 1;\nconst y = 2;\n```\n");
  });

  it("does not merge non-consecutive monospace paragraphs into a code block", () => {
    const doc = makeDoc([
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(
            makeTextRun("line 1\n", {
              weightedFontFamily: { fontFamily: "Courier New" },
            }),
          ),
        ]),
      ),
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(makeTextRun("Normal text\n")),
        ]),
      ),
      makeStructuralElement(
        makeParagraph([
          makeParagraphElement(
            makeTextRun("line 2\n", {
              weightedFontFamily: { fontFamily: "Courier New" },
            }),
          ),
        ]),
      ),
    ]);
    const result = googleDocToMarkdown(doc);
    // Each monospace paragraph should be its own code block.
    expect(result).toContain("```\nline 1\n```");
    expect(result).toContain("Normal text");
    expect(result).toContain("```\nline 2\n```");
  });

  it("handles a document with heading, text, list, and table", () => {
    const lists: Record<string, GoogleDocList> = {
      "list-1": {
        listProperties: {
          nestingLevels: [{ glyphType: "GLYPH_TYPE_UNSPECIFIED" }],
        },
      },
    };

    const table: GoogleDocTable = {
      rows: 2,
      columns: 1,
      tableRows: [
        {
          startIndex: 0,
          endIndex: 0,
          tableCells: [
            {
              startIndex: 0,
              endIndex: 0,
              content: [
                makeStructuralElement(
                  makeParagraph([
                    makeParagraphElement(makeTextRun("Col\n")),
                  ]),
                ),
              ],
            },
          ],
        },
        {
          startIndex: 0,
          endIndex: 0,
          tableCells: [
            {
              startIndex: 0,
              endIndex: 0,
              content: [
                makeStructuralElement(
                  makeParagraph([
                    makeParagraphElement(makeTextRun("Val\n")),
                  ]),
                ),
              ],
            },
          ],
        },
      ],
    };

    const doc = makeDoc(
      [
        makeStructuralElement(
          makeParagraph(
            [makeParagraphElement(makeTextRun("My Title\n"))],
            { namedStyleType: "HEADING_1" },
          ),
        ),
        makeStructuralElement(
          makeParagraph([
            makeParagraphElement(makeTextRun("A paragraph\n")),
          ]),
        ),
        makeStructuralElement(
          makeParagraph(
            [makeParagraphElement(makeTextRun("Item A\n"))],
            {},
            { listId: "list-1", nestingLevel: 0 },
          ),
        ),
        makeStructuralElement(undefined, table),
      ],
      lists,
    );

    const result = googleDocToMarkdown(doc);
    expect(result).toContain("# My Title");
    expect(result).toContain("A paragraph");
    expect(result).toContain("- Item A");
    expect(result).toContain("| Col |");
    expect(result).toContain("| Val |");
  });
});
