import {
  GoogleDoc,
  GoogleDocBullet,
  GoogleDocParagraph,
  GoogleDocParagraphElement,
  GoogleDocStructuralElement,
  GoogleDocTable,
  GoogleDocTextRun,
} from "@/types";
import { MONOSPACE_FONTS } from "@/constants";
import {
  colorToHex,
  isHighlightColor,
  wrapWithColorSpan,
  wrapWithAlignment,
  createImagePlaceholder,
} from "@/conversion/gdoc-formatting";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the given font family is a monospace/code font.
 */
export function isMonospaceFont(fontFamily: string | undefined): boolean {
  if (!fontFamily) return false;
  return MONOSPACE_FONTS.some(
    (f) => f.toLowerCase() === fontFamily.toLowerCase(),
  );
}

/**
 * Determine whether a foreground color is effectively "black" (the default)
 * and should be ignored when generating markdown.
 *
 * Google Docs often stores the default text color as either:
 * - `{ red: 0, green: 0, blue: 0 }` (explicit black)
 * - `{}` (all channels undefined/missing, which defaults to 0)
 */
function isDefaultColor(rgbColor: {
  red?: number;
  green?: number;
  blue?: number;
}): boolean {
  const r = rgbColor.red ?? 0;
  const g = rgbColor.green ?? 0;
  const b = rgbColor.blue ?? 0;
  return r === 0 && g === 0 && b === 0;
}

// ---------------------------------------------------------------------------
// Text-run conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single Google Docs text run into markdown text with inline
 * formatting applied.
 */
export function textRunToMarkdown(textRun: GoogleDocTextRun): string {
  const { content, textStyle } = textRun;

  // Google Docs appends a trailing newline to every paragraph's last text run.
  // We strip it here and handle paragraph breaks at a higher level.
  let text = content.replace(/\n$/, "");

  // Empty text run (e.g. just a newline) produces nothing.
  if (text === "") return "";

  // Monospace font → inline code (no further formatting inside backticks).
  if (isMonospaceFont(textStyle.weightedFontFamily?.fontFamily)) {
    return "`" + text + "`";
  }

  // Highlighted background → Obsidian highlight syntax.
  const hasHighlight =
    textStyle.backgroundColor?.color?.rgbColor &&
    isHighlightColor(textStyle.backgroundColor.color.rgbColor);

  // Foreground color (non-default, non-highlight-only).
  const hasFgColor =
    textStyle.foregroundColor?.color?.rgbColor &&
    !isDefaultColor(textStyle.foregroundColor.color.rgbColor);

  // Apply bold/italic/strikethrough wrapping.
  // Order matters: strikethrough outermost, then bold, then italic (innermost).
  if (textStyle.italic) {
    text = `*${text}*`;
  }
  if (textStyle.bold) {
    text = `**${text}**`;
  }
  if (textStyle.strikethrough) {
    text = `~~${text}~~`;
  }

  // Hyperlink.
  if (textStyle.link?.url) {
    // Strip any bold/italic wrapping we just did — links get their own syntax.
    // Actually, markdown supports formatting inside link text, so keep them.
    text = `[${text}](${textStyle.link.url})`;
  }

  // Foreground color → HTML span.
  if (hasFgColor) {
    const hex = colorToHex(textStyle.foregroundColor!.color.rgbColor);
    text = wrapWithColorSpan(text, hex);
  }

  // Highlight → `==text==`.
  if (hasHighlight) {
    text = `==${text}==`;
  }

  return text;
}

// ---------------------------------------------------------------------------
// Paragraph conversion
// ---------------------------------------------------------------------------

const HEADING_MAP: Record<string, number> = {
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
  HEADING_4: 4,
  HEADING_5: 5,
  HEADING_6: 6,
};

/**
 * Get the markdown prefix for a list bullet (unordered or ordered).
 */
export function getListPrefix(
  bullet: GoogleDocBullet,
  doc: GoogleDoc,
): string {
  const indent = "  ".repeat(bullet.nestingLevel);
  const list = doc.lists?.[bullet.listId];
  if (!list) {
    return `${indent}- `;
  }

  const nestingLevel =
    list.listProperties.nestingLevels[bullet.nestingLevel];
  if (!nestingLevel) {
    return `${indent}- `;
  }

  // Ordered list detection: glyphType is one of DECIMAL, ALPHA, ROMAN, etc.
  const orderedTypes = [
    "DECIMAL",
    "ALPHA",
    "UPPER_ALPHA",
    "ROMAN",
    "UPPER_ROMAN",
  ];
  if (
    nestingLevel.glyphType &&
    orderedTypes.includes(nestingLevel.glyphType)
  ) {
    return `${indent}1. `;
  }

  return `${indent}- `;
}

/**
 * Convert a single paragraph element (text run or inline object) to markdown.
 */
function paragraphElementToMarkdown(
  element: GoogleDocParagraphElement,
): string {
  if (element.textRun) {
    return textRunToMarkdown(element.textRun);
  }

  if (element.inlineObjectElement) {
    return createImagePlaceholder(
      element.inlineObjectElement.inlineObjectId,
    );
  }

  return "";
}

/**
 * Convert a Google Docs paragraph to markdown.
 *
 * Returns the converted line(s) for this paragraph. The caller is responsible
 * for joining paragraphs with blank lines.
 */
export function paragraphToMarkdown(
  paragraph: GoogleDocParagraph,
  doc: GoogleDoc,
): string {
  // Build the inline content from all paragraph elements.
  let content = paragraph.elements
    .map((el) => paragraphElementToMarkdown(el))
    .join("");

  // If the paragraph is entirely empty (just a newline in the original doc),
  // return an empty string so the caller can emit a blank line.
  if (content === "") return "";

  // Heading prefix.
  const headingLevel =
    HEADING_MAP[paragraph.paragraphStyle?.namedStyleType];
  if (headingLevel) {
    const hashes = "#".repeat(headingLevel);
    content = `${hashes} ${content}`;
  }

  // List bullet prefix.
  if (paragraph.bullet) {
    const prefix = getListPrefix(paragraph.bullet, doc);
    content = `${prefix}${content}`;
  }

  // Alignment (center / right) — wrap in HTML if not default (START).
  const alignment = paragraph.paragraphStyle?.alignment;
  if (alignment === "CENTER") {
    content = wrapWithAlignment(content, "center");
  } else if (alignment === "END") {
    content = wrapWithAlignment(content, "right");
  }

  return content;
}

// ---------------------------------------------------------------------------
// Table conversion
// ---------------------------------------------------------------------------

/**
 * Extract the text content of a table cell by recursively processing its
 * structural elements as markdown, then joining on a single line (tables
 * don't support multi-line cell content in standard markdown).
 */
function tableCellToMarkdown(
  cellContent: GoogleDocStructuralElement[],
  doc: GoogleDoc,
): string {
  const parts: string[] = [];
  for (const element of cellContent) {
    if (element.paragraph) {
      const text = paragraphToMarkdown(element.paragraph, doc);
      if (text) parts.push(text);
    }
  }
  // Join multi-paragraph cell content with `<br>` for markdown tables.
  return parts.join("<br>").trim();
}

/**
 * Convert a Google Docs table to a markdown table with pipes.
 */
export function tableToMarkdown(
  table: GoogleDocTable,
  doc: GoogleDoc,
): string {
  if (table.tableRows.length === 0) return "";

  const rows: string[][] = [];
  for (const row of table.tableRows) {
    const cells = row.tableCells.map((cell) =>
      tableCellToMarkdown(cell.content, doc),
    );
    rows.push(cells);
  }

  // First row is the header.
  const headerRow = rows[0];
  const lines: string[] = [];

  lines.push("| " + headerRow.join(" | ") + " |");
  // Separator row.
  lines.push(
    "| " + headerRow.map(() => "---").join(" | ") + " |",
  );
  // Data rows.
  for (let i = 1; i < rows.length; i++) {
    lines.push("| " + rows[i].join(" | ") + " |");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Code block detection
// ---------------------------------------------------------------------------

/**
 * Detect whether a paragraph looks like a code block line:
 * all text runs use a monospace font.
 */
function isCodeBlockParagraph(paragraph: GoogleDocParagraph): boolean {
  // Must have at least one text run.
  const textRuns = paragraph.elements.filter((e) => e.textRun);
  if (textRuns.length === 0) return false;

  return textRuns.every((e) =>
    isMonospaceFont(e.textRun!.textStyle.weightedFontFamily?.fontFamily),
  );
}

// ---------------------------------------------------------------------------
// Main conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Google Doc document body into markdown.
 *
 * Takes the full GoogleDoc object (from documents.get API response) and
 * returns a markdown string. Frontmatter is NOT included — that is handled
 * separately by the frontmatter module.
 */
export function googleDocToMarkdown(doc: GoogleDoc): string {
  if (!doc.body?.content || doc.body.content.length === 0) {
    return "";
  }

  const outputLines: string[] = [];
  const elements = doc.body.content;
  let i = 0;

  while (i < elements.length) {
    const element = elements[i];

    // Section break — skip.
    if (element.sectionBreak) {
      i++;
      continue;
    }

    // Table.
    if (element.table) {
      outputLines.push(tableToMarkdown(element.table, doc));
      outputLines.push("");
      i++;
      continue;
    }

    // Paragraph.
    if (element.paragraph) {
      // Detect runs of consecutive monospace paragraphs → code block.
      if (isCodeBlockParagraph(element.paragraph) && !element.paragraph.bullet) {
        const codeLines: string[] = [];
        while (
          i < elements.length &&
          elements[i].paragraph &&
          isCodeBlockParagraph(elements[i].paragraph!) &&
          !elements[i].paragraph!.bullet
        ) {
          // For code blocks, extract raw content without formatting.
          const rawContent = elements[i]
            .paragraph!.elements.map((el) =>
              el.textRun ? el.textRun.content.replace(/\n$/, "") : "",
            )
            .join("");
          codeLines.push(rawContent);
          i++;
        }
        outputLines.push("```");
        outputLines.push(...codeLines);
        outputLines.push("```");
        outputLines.push("");
        continue;
      }

      const mdLine = paragraphToMarkdown(element.paragraph, doc);

      // Empty paragraph → blank line separator.
      if (mdLine === "") {
        outputLines.push("");
      } else {
        outputLines.push(mdLine);
      }
      i++;
      continue;
    }

    // Unknown element type — skip.
    i++;
  }

  // Clean up: collapse multiple consecutive blank lines into one,
  // and trim trailing whitespace.
  let result = outputLines.join("\n");

  // Collapse 3+ consecutive newlines into 2 (one blank line).
  result = result.replace(/\n{3,}/g, "\n\n");

  // Trim leading/trailing whitespace but ensure a final newline.
  result = result.trim();
  if (result.length > 0) {
    result += "\n";
  }

  return result;
}
