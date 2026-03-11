import type { GoogleDocTextStyle } from "@/types";
import {
  HIGHLIGHT_BG_COLOR,
  CODE_BLOCK_BG_COLOR,
  MONOSPACE_FONTS,
} from "@/constants";

/**
 * Convert Google Docs RGB color (0-1 floats) to a hex string like "#FF0000".
 */
export function colorToHex(rgbColor: { red?: number; green?: number; blue?: number }): string {
  const r = Math.round((rgbColor.red ?? 0) * 255);
  const g = Math.round((rgbColor.green ?? 0) * 255);
  const b = Math.round((rgbColor.blue ?? 0) * 255);
  return (
    "#" +
    r.toString(16).toUpperCase().padStart(2, "0") +
    g.toString(16).toUpperCase().padStart(2, "0") +
    b.toString(16).toUpperCase().padStart(2, "0")
  );
}

/**
 * Convert a hex color string like "#FF0000" back to Google Docs RGB floats (0-1).
 */
export function hexToRgbColor(hex: string): { red: number; green: number; blue: number } {
  const cleaned = hex.replace(/^#/, "");
  const r = parseInt(cleaned.substring(0, 2), 16) / 255;
  const g = parseInt(cleaned.substring(2, 4), 16) / 255;
  const b = parseInt(cleaned.substring(4, 6), 16) / 255;
  return {
    red: Math.round(r * 1000) / 1000,
    green: Math.round(g * 1000) / 1000,
    blue: Math.round(b * 1000) / 1000,
  };
}

/**
 * Wrap text in a color span for preserving foreground color in markdown.
 */
export function wrapWithColorSpan(text: string, hexColor: string): string {
  return `<span style="color: ${hexColor}">${text}</span>`;
}

/**
 * Wrap text in a paragraph tag with text-align for preserving alignment in markdown.
 */
export function wrapWithAlignment(text: string, alignment: "center" | "right"): string {
  return `<p style="text-align: ${alignment}">${text}</p>`;
}

/**
 * Create an HTML comment placeholder for a Google Docs inline image.
 */
export function createImagePlaceholder(imageId: string): string {
  return `<!-- gdocs-image: ${imageId} -->`;
}

/**
 * Parse all color span tags from markdown text, returning positions and colors.
 */
export function parseColorSpans(
  markdown: string
): Array<{ text: string; color: string; start: number; end: number }> {
  const results: Array<{ text: string; color: string; start: number; end: number }> = [];
  const regex = /<span style="color: (#[0-9A-Fa-f]{6})">(.*?)<\/span>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    results.push({
      text: match[2],
      color: match[1],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return results;
}

/**
 * Parse alignment blocks from markdown text.
 */
export function parseAlignmentBlocks(
  markdown: string
): Array<{ text: string; alignment: string; start: number; end: number }> {
  const results: Array<{ text: string; alignment: string; start: number; end: number }> = [];
  const regex = /<p style="text-align: (center|right)">(.*?)<\/p>/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    results.push({
      text: match[2],
      alignment: match[1],
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return results;
}

/**
 * Return true if the background color is close to yellow (highlight).
 * Uses HIGHLIGHT_BG_COLOR from constants as the reference.
 */
export function isHighlightColor(rgbColor: { red?: number; green?: number; blue?: number }): boolean {
  const r = rgbColor.red ?? 0;
  const g = rgbColor.green ?? 0;
  const b = rgbColor.blue ?? 0;

  const threshold = 0.15;
  return (
    Math.abs(r - HIGHLIGHT_BG_COLOR.red) <= threshold &&
    Math.abs(g - HIGHLIGHT_BG_COLOR.green) <= threshold &&
    Math.abs(b - HIGHLIGHT_BG_COLOR.blue) <= threshold
  );
}
