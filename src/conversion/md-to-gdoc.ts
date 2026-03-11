/**
 * Markdown to Google Docs conversion module.
 *
 * Converts a markdown body (frontmatter already extracted) into a Google Docs
 * API `batchUpdate` request body using a pragmatic line-by-line/block parser.
 *
 * Google Docs index convention: index 1 is the start of content (index 0 is
 * before content).
 */

import type { BatchUpdateRequest, DocRequest } from "@/types";
import {
  MONOSPACE_FONTS,
  CODE_BLOCK_BG_COLOR,
  HIGHLIGHT_BG_COLOR,
} from "@/constants";
import { HIGHLIGHT_START, HIGHLIGHT_END } from "@/conversion/obsidian-syntax";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a markdown body into a BatchUpdateRequest that populates a Google Doc.
 *
 * The document is assumed to already exist (e.g. freshly created) with the
 * default trailing newline at index 1. All generated requests insert content
 * starting at index 1.
 */
export function markdownToGoogleDoc(markdown: string): BatchUpdateRequest {
  if (!markdown || markdown.trim() === "") {
    return { requests: [] };
  }

  const blocks = parseBlocks(markdown);
  const { requests } = blocksToRequests(blocks);
  return { requests };
}

// ---------------------------------------------------------------------------
// Inline formatting types
// ---------------------------------------------------------------------------

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  code?: boolean;
  link?: string;
  highlight?: boolean;
}

// ---------------------------------------------------------------------------
// Block types
// ---------------------------------------------------------------------------

type Block =
  | { type: "heading"; level: number; content: string }
  | { type: "paragraph"; content: string }
  | { type: "codeblock"; language?: string; content: string }
  | { type: "list"; items: ListItem[] }
  | { type: "blockquote"; content: string }
  | { type: "hr" }
  | { type: "table"; rows: string[][] };

interface ListItem {
  ordered: boolean;
  indent: number;
  content: string;
}

// ---------------------------------------------------------------------------
// Line-level helpers (exported for testing)
// ---------------------------------------------------------------------------

/** Returns 0 for non-heading, 1-6 for h1-h6. */
export function headingLevel(line: string): number {
  const m = line.match(/^(#{1,6})\s+/);
  return m ? m[1].length : 0;
}

/** Parse a list item line, or return null. */
export function isListItem(
  line: string,
): { ordered: boolean; indent: number; content: string } | null {
  // Matches leading whitespace, then a bullet marker or number marker.
  const m = line.match(/^(\s*)([-*+]|\d+[.)]) (.*)$/);
  if (!m) return null;
  const indent = Math.floor(m[1].length / 2); // each 2-space indent is one nesting level
  const ordered = /\d+[.)]/.test(m[2]);
  return { ordered, indent, content: m[3] };
}

/** Detect a code fence opening/closing. Returns language on open, empty object on close. */
export function isCodeBlockFence(
  line: string,
): { language?: string } | null {
  const m = line.match(/^(`{3,}|~{3,})\s*(\S*)\s*$/);
  if (!m) return null;
  return { language: m[2] || undefined };
}

/** If line is a blockquote, return content after `>`. */
export function isBlockquote(line: string): string | null {
  const m = line.match(/^>\s?(.*)/);
  return m ? m[1] : null;
}

/** Check if a line is a horizontal rule. */
export function isHorizontalRule(line: string): boolean {
  return /^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim());
}

/** Return the cells of a table row, or null. */
export function isTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  // Split on pipes, remove first/last empties from leading/trailing |
  const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
  return cells.length > 0 ? cells : null;
}

/** Detect the separator row in a markdown table (e.g. `| --- | :---: |`). */
export function isTableSeparator(line: string): boolean {
  const cells = isTableRow(line);
  if (!cells) return false;
  return cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

// ---------------------------------------------------------------------------
// Inline formatting parser
// ---------------------------------------------------------------------------

/**
 * Parse inline markdown formatting into styled runs.
 *
 * Handles: **bold**, *italic*, ~~strikethrough~~, `code`,
 * [links](url), and highlight sentinels.
 */
export function parseInlineFormatting(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Find the earliest marker/pattern.
    let earliestIdx = remaining.length;
    let matched: {
      run: InlineRun;
      consumeLength: number;
      startIdx: number;
    } | null = null;

    // Highlight sentinels
    const hlIdx = remaining.indexOf(HIGHLIGHT_START);
    if (hlIdx !== -1 && hlIdx < earliestIdx) {
      const hlEndIdx = remaining.indexOf(
        HIGHLIGHT_END,
        hlIdx + HIGHLIGHT_START.length,
      );
      if (hlEndIdx !== -1) {
        const inner = remaining.slice(
          hlIdx + HIGHLIGHT_START.length,
          hlEndIdx,
        );
        earliestIdx = hlIdx;
        matched = {
          run: { text: inner, highlight: true },
          consumeLength: hlEndIdx + HIGHLIGHT_END.length,
          startIdx: hlIdx,
        };
      }
    }

    // Inline code (backtick) -- checked before bold/italic to avoid conflicts
    const codeMatch = remaining.match(/`([^`]+)`/);
    if (codeMatch && codeMatch.index !== undefined && codeMatch.index < earliestIdx) {
      earliestIdx = codeMatch.index;
      matched = {
        run: { text: codeMatch[1], code: true },
        consumeLength: codeMatch.index + codeMatch[0].length,
        startIdx: codeMatch.index,
      };
    }

    // Link [text](url)
    const linkMatch = remaining.match(/\[([^\]]*)\]\(([^)]+)\)/);
    if (linkMatch && linkMatch.index !== undefined && linkMatch.index < earliestIdx) {
      earliestIdx = linkMatch.index;
      matched = {
        run: { text: linkMatch[1], link: linkMatch[2] },
        consumeLength: linkMatch.index + linkMatch[0].length,
        startIdx: linkMatch.index,
      };
    }

    // Bold+italic (***text*** or ___text___)
    const boldItalicMatch = remaining.match(/(\*{3}|_{3})(.+?)\1/);
    if (
      boldItalicMatch &&
      boldItalicMatch.index !== undefined &&
      boldItalicMatch.index < earliestIdx
    ) {
      earliestIdx = boldItalicMatch.index;
      matched = {
        run: { text: boldItalicMatch[2], bold: true, italic: true },
        consumeLength: boldItalicMatch.index + boldItalicMatch[0].length,
        startIdx: boldItalicMatch.index,
      };
    }

    // Bold (**text** or __text__)
    const boldMatch = remaining.match(/(\*{2}|_{2})(.+?)\1/);
    if (boldMatch && boldMatch.index !== undefined && boldMatch.index < earliestIdx) {
      earliestIdx = boldMatch.index;
      matched = {
        run: { text: boldMatch[2], bold: true },
        consumeLength: boldMatch.index + boldMatch[0].length,
        startIdx: boldMatch.index,
      };
    }

    // Strikethrough (~~text~~)
    const strikeMatch = remaining.match(/~~(.+?)~~/);
    if (
      strikeMatch &&
      strikeMatch.index !== undefined &&
      strikeMatch.index < earliestIdx
    ) {
      earliestIdx = strikeMatch.index;
      matched = {
        run: { text: strikeMatch[1], strikethrough: true },
        consumeLength: strikeMatch.index + strikeMatch[0].length,
        startIdx: strikeMatch.index,
      };
    }

    // Italic (*text* or _text_) -- must be checked after bold
    const italicMatch = remaining.match(
      /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/,
    );
    if (
      italicMatch &&
      italicMatch.index !== undefined &&
      italicMatch.index < earliestIdx
    ) {
      earliestIdx = italicMatch.index;
      const innerText = italicMatch[1] || italicMatch[2];
      matched = {
        run: { text: innerText, italic: true },
        consumeLength: italicMatch.index + italicMatch[0].length,
        startIdx: italicMatch.index,
      };
    }

    if (matched === null) {
      // No more markers -- the rest is plain text.
      if (remaining.length > 0) {
        runs.push({ text: remaining });
      }
      break;
    }

    // Push any plain text before the match.
    if (matched.startIdx > 0) {
      runs.push({ text: remaining.slice(0, matched.startIdx) });
    }

    runs.push(matched.run);
    remaining = remaining.slice(matched.consumeLength);
  }

  return runs;
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank lines are skipped (paragraph separators).
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Horizontal rule (must check before list items since `---` could match).
    if (isHorizontalRule(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    // Code block fence.
    const fence = isCodeBlockFence(line);
    if (fence) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length) {
        if (
          isCodeBlockFence(lines[i]) !== null &&
          lines[i].trim().match(/^(`{3,}|~{3,})\s*$/)
        ) {
          i++; // skip closing fence
          break;
        }
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({
        type: "codeblock",
        language: fence.language,
        content: codeLines.join("\n"),
      });
      continue;
    }

    // Heading.
    const hl = headingLevel(line);
    if (hl > 0) {
      const content = line.replace(/^#{1,6}\s+/, "");
      blocks.push({ type: "heading", level: hl, content });
      i++;
      continue;
    }

    // Table: a table starts with a row, followed by a separator row.
    const firstRow = isTableRow(line);
    if (firstRow && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows: string[][] = [firstRow];
      i += 2; // skip header + separator
      while (i < lines.length) {
        const row = isTableRow(lines[i]);
        if (!row) break;
        rows.push(row);
        i++;
      }
      blocks.push({ type: "table", rows });
      continue;
    }

    // List items (collect contiguous list items into one list block).
    const listItem = isListItem(line);
    if (listItem) {
      const items: ListItem[] = [listItem];
      i++;
      while (i < lines.length) {
        const nextItem = isListItem(lines[i]);
        if (!nextItem) break;
        items.push(nextItem);
        i++;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    // Blockquote (collect contiguous lines starting with `>`).
    const bqContent = isBlockquote(line);
    if (bqContent !== null) {
      const bqLines: string[] = [bqContent];
      i++;
      while (i < lines.length) {
        const nextBq = isBlockquote(lines[i]);
        if (nextBq === null) break;
        bqLines.push(nextBq);
        i++;
      }
      blocks.push({ type: "blockquote", content: bqLines.join("\n") });
      continue;
    }

    // Default: paragraph. Collect contiguous non-blank, non-special lines.
    const paraLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const nl = lines[i];
      if (nl.trim() === "") break;
      if (headingLevel(nl) > 0) break;
      if (isCodeBlockFence(nl)) break;
      if (isListItem(nl)) break;
      if (isBlockquote(nl) !== null) break;
      if (isHorizontalRule(nl)) break;
      if (
        isTableRow(nl) &&
        i + 1 < lines.length &&
        isTableSeparator(lines[i + 1])
      )
        break;
      paraLines.push(nl);
      i++;
    }
    blocks.push({ type: "paragraph", content: paraLines.join(" ") });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Request builder
// ---------------------------------------------------------------------------

interface BuildContext {
  requests: DocRequest[];
  index: number; // current insertion index
}

function blocksToRequests(blocks: Block[]): { requests: DocRequest[] } {
  const ctx: BuildContext = { requests: [], index: 1 };

  for (const block of blocks) {
    switch (block.type) {
      case "heading":
        emitHeading(ctx, block.level, block.content);
        break;
      case "paragraph":
        emitParagraph(ctx, block.content);
        break;
      case "codeblock":
        emitCodeBlock(ctx, block.content, block.language);
        break;
      case "list":
        emitList(ctx, block.items);
        break;
      case "blockquote":
        emitBlockquote(ctx, block.content);
        break;
      case "hr":
        emitHorizontalRule(ctx);
        break;
      case "table":
        emitTable(ctx, block.rows);
        break;
    }
  }

  return { requests: ctx.requests };
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

/**
 * Insert text with inline formatting parsed and stripped, then apply both
 * paragraph-level and inline styles.
 */
function emitStyledText(
  ctx: BuildContext,
  content: string,
  paragraphStyle?: {
    namedStyleType?: string;
    fields: string;
    alignment?: "START" | "CENTER" | "END" | "JUSTIFIED";
    indentStart?: { magnitude: number; unit: string };
    indentFirstLine?: { magnitude: number; unit: string };
  },
): void {
  const runs = parseInlineFormatting(content);
  const plainText = runs.map((r) => r.text).join("") + "\n";
  const startIdx = ctx.index;

  ctx.requests.push({
    insertText: { text: plainText, location: { index: startIdx } },
  });
  ctx.index += plainText.length;

  if (paragraphStyle) {
    const style: Record<string, unknown> = {};
    if (paragraphStyle.namedStyleType) {
      style.namedStyleType = paragraphStyle.namedStyleType;
    }
    if (paragraphStyle.alignment) {
      style.alignment = paragraphStyle.alignment;
    }
    if (paragraphStyle.indentStart) {
      style.indentStart = paragraphStyle.indentStart;
    }
    if (paragraphStyle.indentFirstLine) {
      style.indentFirstLine = paragraphStyle.indentFirstLine;
    }
    ctx.requests.push({
      updateParagraphStyle: {
        paragraphStyle: style as any,
        range: { startIndex: startIdx, endIndex: ctx.index },
        fields: paragraphStyle.fields,
      },
    });
  }

  applyRunStyles(ctx, startIdx, runs);
}

function emitHeading(ctx: BuildContext, level: number, content: string): void {
  emitStyledText(ctx, content, {
    namedStyleType: `HEADING_${level}`,
    fields: "namedStyleType",
  });
}

function emitParagraph(ctx: BuildContext, content: string): void {
  emitStyledText(ctx, content);
}

function emitCodeBlock(
  ctx: BuildContext,
  content: string,
  _language?: string,
): void {
  const text = content + "\n";
  const startIdx = ctx.index;

  ctx.requests.push({
    insertText: { text, location: { index: startIdx } },
  });
  ctx.index += text.length;

  // Monospace font.
  ctx.requests.push({
    updateTextStyle: {
      textStyle: {
        weightedFontFamily: { fontFamily: MONOSPACE_FONTS[0] },
      },
      range: { startIndex: startIdx, endIndex: ctx.index },
      fields: "weightedFontFamily",
    },
  });

  // Background color.
  ctx.requests.push({
    updateTextStyle: {
      textStyle: {
        backgroundColor: { color: { rgbColor: CODE_BLOCK_BG_COLOR } },
      },
      range: { startIndex: startIdx, endIndex: ctx.index },
      fields: "backgroundColor",
    },
  });
}

function emitList(ctx: BuildContext, items: ListItem[]): void {
  for (const item of items) {
    const runs = parseInlineFormatting(item.content);
    const text = runs.map((r) => r.text).join("") + "\n";
    const startIdx = ctx.index;

    ctx.requests.push({
      insertText: { text, location: { index: startIdx } },
    });
    ctx.index += text.length;

    // Apply bullet style.
    const bulletPreset = item.ordered
      ? "NUMBERED_DECIMAL_ALPHA_ROMAN"
      : "BULLET_DISC_CIRCLE_SQUARE";
    ctx.requests.push({
      createParagraphBullets: {
        range: { startIndex: startIdx, endIndex: ctx.index },
        bulletPreset,
      },
    });

    // Apply inline formatting.
    applyRunStyles(ctx, startIdx, runs);
  }
}

function emitBlockquote(ctx: BuildContext, content: string): void {
  emitStyledText(ctx, content, {
    namedStyleType: "NORMAL_TEXT",
    indentStart: { magnitude: 36, unit: "PT" },
    indentFirstLine: { magnitude: 36, unit: "PT" },
    fields: "indentStart,indentFirstLine",
  });
}

function emitHorizontalRule(ctx: BuildContext): void {
  // Google Docs doesn't have a native horizontal rule via batchUpdate.
  // Use the Unicode box-drawing heavy horizontal (U+2501) repeated,
  // which renders nicely as a visual separator.
  const ruler = "\u2501".repeat(40) + "\n";
  const startIdx = ctx.index;

  ctx.requests.push({
    insertText: { text: ruler, location: { index: startIdx } },
  });
  ctx.index += ruler.length;

  // Center the rule.
  ctx.requests.push({
    updateParagraphStyle: {
      paragraphStyle: { namedStyleType: "NORMAL_TEXT", alignment: "CENTER" },
      range: { startIndex: startIdx, endIndex: ctx.index },
      fields: "alignment",
    },
  });
}

function emitTable(ctx: BuildContext, rows: string[][]): void {
  const numRows = rows.length;
  const numCols = rows.length > 0 ? rows[0].length : 0;
  if (numRows === 0 || numCols === 0) return;

  const tableStartIdx = ctx.index;

  ctx.requests.push({
    insertTable: {
      rows: numRows,
      columns: numCols,
      location: { index: tableStartIdx },
    },
  });

  // Google Docs table indexing after insertTable:
  //
  // An empty table with R rows and C columns creates a structure where:
  //   - 1 index for the table element start
  //   - For each row: 1 for the row start
  //   - For each cell: 2 indices (cell start + paragraph newline)
  //   - Plus 1 index for each cell's paragraph start
  //
  // The well-known formula for cell(r, c) text insert position:
  //   tableStart + 2 + r * (1 + numCols * 3) + c * 3
  //
  // Total table size (including trailing newline after table):
  //   1 + R * (1 + C * 3) + 1

  const tableSize = 1 + numRows * (1 + numCols * 3) + 1;

  // Collect cell insertions, then apply in reverse index order so that
  // earlier indices remain stable when later text shifts things.
  const cellOps: Array<{
    index: number;
    text: string;
  }> = [];

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cellText = rows[r][c] || "";
      if (cellText.length === 0) continue;
      const cellContentIdx =
        tableStartIdx + 2 + r * (1 + numCols * 3) + c * 3;
      cellOps.push({ index: cellContentIdx, text: cellText });
    }
  }

  // Insert in reverse index order to keep earlier indices stable.
  cellOps.sort((a, b) => b.index - a.index);

  for (const op of cellOps) {
    ctx.requests.push({
      insertText: { text: op.text, location: { index: op.index } },
    });
  }

  // Advance the context index past the entire table.
  const totalTextInserted = cellOps.reduce(
    (sum, op) => sum + op.text.length,
    0,
  );
  ctx.index = tableStartIdx + tableSize + totalTextInserted;
}

// ---------------------------------------------------------------------------
// Style application helpers
// ---------------------------------------------------------------------------

/**
 * Apply inline styles from parsed runs to already-inserted text.
 * `startIdx` is the document index where the runs begin.
 */
function applyRunStyles(
  ctx: BuildContext,
  startIdx: number,
  runs: InlineRun[],
): void {
  let offset = startIdx;
  for (const run of runs) {
    const runEnd = offset + run.text.length;

    if (run.bold) {
      ctx.requests.push({
        updateTextStyle: {
          textStyle: { bold: true },
          range: { startIndex: offset, endIndex: runEnd },
          fields: "bold",
        },
      });
    }

    if (run.italic) {
      ctx.requests.push({
        updateTextStyle: {
          textStyle: { italic: true },
          range: { startIndex: offset, endIndex: runEnd },
          fields: "italic",
        },
      });
    }

    if (run.strikethrough) {
      ctx.requests.push({
        updateTextStyle: {
          textStyle: { strikethrough: true },
          range: { startIndex: offset, endIndex: runEnd },
          fields: "strikethrough",
        },
      });
    }

    if (run.code) {
      ctx.requests.push({
        updateTextStyle: {
          textStyle: {
            weightedFontFamily: { fontFamily: MONOSPACE_FONTS[0] },
          },
          range: { startIndex: offset, endIndex: runEnd },
          fields: "weightedFontFamily",
        },
      });
    }

    if (run.link) {
      ctx.requests.push({
        updateTextStyle: {
          textStyle: { link: { url: run.link } },
          range: { startIndex: offset, endIndex: runEnd },
          fields: "link",
        },
      });
    }

    if (run.highlight) {
      ctx.requests.push({
        updateTextStyle: {
          textStyle: {
            backgroundColor: { color: { rgbColor: HIGHLIGHT_BG_COLOR } },
          },
          range: { startIndex: offset, endIndex: runEnd },
          fields: "backgroundColor",
        },
      });
    }

    offset = runEnd;
  }
}
