import {
  colorToHex,
  hexToRgbColor,
  wrapWithColorSpan,
  wrapWithAlignment,
  createImagePlaceholder,
  parseColorSpans,
  parseAlignmentBlocks,
  isHighlightColor,
} from "@/conversion/gdoc-formatting";

describe("colorToHex", () => {
  it("converts pure red to #FF0000", () => {
    expect(colorToHex({ red: 1, green: 0, blue: 0 })).toBe("#FF0000");
  });

  it("converts mixed color {red: 0, green: 0.5, blue: 1} to #0080FF", () => {
    expect(colorToHex({ red: 0, green: 0.5, blue: 1 })).toBe("#0080FF");
  });

  it("treats undefined values as 0, returning #000000", () => {
    expect(colorToHex({})).toBe("#000000");
  });

  it("converts pure white correctly", () => {
    expect(colorToHex({ red: 1, green: 1, blue: 1 })).toBe("#FFFFFF");
  });
});

describe("hexToRgbColor", () => {
  it("converts #FF0000 to {red: 1, green: 0, blue: 0}", () => {
    expect(hexToRgbColor("#FF0000")).toEqual({ red: 1, green: 0, blue: 0 });
  });

  it("converts #000000 to {red: 0, green: 0, blue: 0}", () => {
    expect(hexToRgbColor("#000000")).toEqual({ red: 0, green: 0, blue: 0 });
  });

  it("converts #FFFFFF to {red: 1, green: 1, blue: 1}", () => {
    expect(hexToRgbColor("#FFFFFF")).toEqual({ red: 1, green: 1, blue: 1 });
  });
});

describe("colorToHex / hexToRgbColor round-trip", () => {
  it("round-trips #FF0000", () => {
    const hex = "#FF0000";
    expect(colorToHex(hexToRgbColor(hex))).toBe(hex);
  });

  it("round-trips #00FF00", () => {
    const hex = "#00FF00";
    expect(colorToHex(hexToRgbColor(hex))).toBe(hex);
  });

  it("round-trips #0000FF", () => {
    const hex = "#0000FF";
    expect(colorToHex(hexToRgbColor(hex))).toBe(hex);
  });

  it("round-trips #808080", () => {
    const hex = "#808080";
    expect(colorToHex(hexToRgbColor(hex))).toBe(hex);
  });
});

describe("wrapWithColorSpan", () => {
  it("produces correct HTML span with color", () => {
    expect(wrapWithColorSpan("hello", "#FF0000")).toBe(
      '<span style="color: #FF0000">hello</span>'
    );
  });

  it("handles empty text", () => {
    expect(wrapWithColorSpan("", "#00FF00")).toBe(
      '<span style="color: #00FF00"></span>'
    );
  });
});

describe("wrapWithAlignment", () => {
  it("produces correct HTML for center alignment", () => {
    expect(wrapWithAlignment("centered text", "center")).toBe(
      '<p style="text-align: center">centered text</p>'
    );
  });

  it("produces correct HTML for right alignment", () => {
    expect(wrapWithAlignment("right text", "right")).toBe(
      '<p style="text-align: right">right text</p>'
    );
  });
});

describe("createImagePlaceholder", () => {
  it("produces correct comment format", () => {
    expect(createImagePlaceholder("kix.abc123")).toBe(
      "<!-- gdocs-image: kix.abc123 -->"
    );
  });

  it("handles arbitrary image IDs", () => {
    expect(createImagePlaceholder("img-42")).toBe(
      "<!-- gdocs-image: img-42 -->"
    );
  });
});

describe("parseColorSpans", () => {
  it("extracts a single color span from markdown", () => {
    const md = 'Some text <span style="color: #FF0000">red words</span> more text';
    const spans = parseColorSpans(md);
    expect(spans).toHaveLength(1);
    expect(spans[0].text).toBe("red words");
    expect(spans[0].color).toBe("#FF0000");
    expect(spans[0].start).toBe(10);
    expect(spans[0].end).toBe(10 + '<span style="color: #FF0000">red words</span>'.length);
  });

  it("extracts multiple color spans from one paragraph", () => {
    const md =
      '<span style="color: #FF0000">red</span> and <span style="color: #0000FF">blue</span>';
    const spans = parseColorSpans(md);
    expect(spans).toHaveLength(2);
    expect(spans[0].text).toBe("red");
    expect(spans[0].color).toBe("#FF0000");
    expect(spans[1].text).toBe("blue");
    expect(spans[1].color).toBe("#0000FF");
  });

  it("returns empty array when no spans are present", () => {
    expect(parseColorSpans("plain text")).toEqual([]);
  });
});

describe("parseAlignmentBlocks", () => {
  it("extracts center alignment block", () => {
    const md = '<p style="text-align: center">centered</p>';
    const blocks = parseAlignmentBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("centered");
    expect(blocks[0].alignment).toBe("center");
    expect(blocks[0].start).toBe(0);
    expect(blocks[0].end).toBe(md.length);
  });

  it("extracts right alignment block", () => {
    const md = '<p style="text-align: right">right-aligned</p>';
    const blocks = parseAlignmentBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("right-aligned");
    expect(blocks[0].alignment).toBe("right");
  });

  it("returns empty array when no alignment blocks are present", () => {
    expect(parseAlignmentBlocks("plain text")).toEqual([]);
  });
});

describe("isHighlightColor", () => {
  it("returns true for exact yellow highlight", () => {
    expect(isHighlightColor({ red: 1, green: 1, blue: 0 })).toBe(true);
  });

  it("returns true for near-yellow highlight", () => {
    expect(isHighlightColor({ red: 0.95, green: 0.9, blue: 0.1 })).toBe(true);
  });

  it("returns false for pure red", () => {
    expect(isHighlightColor({ red: 1, green: 0, blue: 0 })).toBe(false);
  });

  it("returns false for blue", () => {
    expect(isHighlightColor({ red: 0, green: 0, blue: 1 })).toBe(false);
  });

  it("returns false for white", () => {
    expect(isHighlightColor({ red: 1, green: 1, blue: 1 })).toBe(false);
  });

  it("returns false for black (all undefined)", () => {
    expect(isHighlightColor({})).toBe(false);
  });
});
