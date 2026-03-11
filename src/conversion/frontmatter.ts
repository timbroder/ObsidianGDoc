import matter from "gray-matter";
import {
  DOC_PROPERTY_FRONTMATTER,
  DOC_PROPERTY_FRONTMATTER_PREFIX,
  MAX_FRONTMATTER_PROPERTY_SIZE,
} from "@/constants";

/**
 * Extract YAML frontmatter from a markdown string using `gray-matter`.
 * Returns the raw frontmatter block (including `---` delimiters) and the
 * remaining body. If no frontmatter is present, `frontmatter` is an empty
 * string and `body` is the original input.
 *
 * The raw frontmatter string is preserved verbatim (not re-serialized) so
 * that malformed YAML and formatting quirks survive a round-trip.
 */
export function extractFrontmatter(markdown: string): {
  frontmatter: string;
  body: string;
} {
  // Use gray-matter to detect whether frontmatter is present.
  // We wrap in try/catch because gray-matter may throw on severely
  // malformed YAML; in that case we fall back to manual delimiter scanning.
  let hasFrontmatter = false;
  try {
    const parsed = matter(markdown);
    // gray-matter sets `matter` to the raw YAML between delimiters.
    // When no frontmatter block exists, `matter` is "" and `content`
    // equals the original input.
    hasFrontmatter =
      parsed.matter !== "" || parsed.content !== markdown;
  } catch {
    // gray-matter threw — fall back to manual detection below.
    hasFrontmatter = markdown.startsWith("---\n") || markdown.startsWith("---\r\n");
  }

  if (!hasFrontmatter) {
    return { frontmatter: "", body: markdown };
  }

  // Locate the raw frontmatter block boundaries in the original string so
  // we preserve the verbatim text (including malformed YAML).
  const openDelim = "---\n";
  const closeDelim = "\n---";

  if (!markdown.startsWith(openDelim) && !markdown.startsWith("---\r\n")) {
    return { frontmatter: "", body: markdown };
  }

  const closingIndex = markdown.indexOf(closeDelim, openDelim.length);
  if (closingIndex === -1) {
    return { frontmatter: "", body: markdown };
  }

  let endOfBlock = closingIndex + closeDelim.length;
  // Consume the trailing newline(s) after the closing `---`.
  if (markdown[endOfBlock] === "\n") {
    endOfBlock += 1;
  } else if (
    markdown[endOfBlock] === "\r" &&
    markdown[endOfBlock + 1] === "\n"
  ) {
    endOfBlock += 2;
  }

  const rawFrontmatter = markdown.slice(0, endOfBlock);
  const body = markdown.slice(endOfBlock);

  return { frontmatter: rawFrontmatter, body };
}

/**
 * Prepend a raw frontmatter block to a body string.
 * If `frontmatter` is empty, the body is returned unchanged.
 */
export function prependFrontmatter(body: string, frontmatter: string): string {
  if (!frontmatter) {
    return body;
  }

  // Ensure the frontmatter ends with a newline so the body starts cleanly.
  const separator = frontmatter.endsWith("\n") ? "" : "\n";
  return frontmatter + separator + body;
}

/**
 * Convert a raw frontmatter string into a set of Google Doc custom properties.
 *
 * If the string fits within `MAX_FRONTMATTER_PROPERTY_SIZE` it is stored
 * under a single key (`DOC_PROPERTY_FRONTMATTER`). Otherwise it is split
 * across numbered keys: `DOC_PROPERTY_FRONTMATTER_PREFIX + "0"`, `…_1`, etc.
 */
export function frontmatterToDocProperties(
  frontmatter: string,
): Record<string, string> {
  if (!frontmatter) {
    return {};
  }

  if (frontmatter.length <= MAX_FRONTMATTER_PROPERTY_SIZE) {
    return { [DOC_PROPERTY_FRONTMATTER]: frontmatter };
  }

  const properties: Record<string, string> = {};
  let offset = 0;
  let chunkIndex = 0;

  while (offset < frontmatter.length) {
    const chunk = frontmatter.slice(offset, offset + MAX_FRONTMATTER_PROPERTY_SIZE);
    properties[`${DOC_PROPERTY_FRONTMATTER_PREFIX}${chunkIndex}`] = chunk;
    offset += MAX_FRONTMATTER_PROPERTY_SIZE;
    chunkIndex += 1;
  }

  return properties;
}

/**
 * Reassemble a raw frontmatter string from Google Doc custom properties.
 *
 * Handles both the single-key (`DOC_PROPERTY_FRONTMATTER`) and the split
 * (`DOC_PROPERTY_FRONTMATTER_PREFIX + index`) formats.
 */
export function docPropertiesToFrontmatter(
  properties: Record<string, string>,
): string {
  // Single-key case.
  if (DOC_PROPERTY_FRONTMATTER in properties) {
    return properties[DOC_PROPERTY_FRONTMATTER];
  }

  // Numbered-chunks case. Collect all matching keys and sort by index.
  const chunks: { index: number; value: string }[] = [];

  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith(DOC_PROPERTY_FRONTMATTER_PREFIX)) {
      const suffix = key.slice(DOC_PROPERTY_FRONTMATTER_PREFIX.length);
      const index = parseInt(suffix, 10);
      if (!isNaN(index)) {
        chunks.push({ index, value });
      }
    }
  }

  if (chunks.length === 0) {
    return "";
  }

  chunks.sort((a, b) => a.index - b.index);
  return chunks.map((c) => c.value).join("");
}
