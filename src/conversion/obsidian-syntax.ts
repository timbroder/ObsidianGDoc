/**
 * Obsidian-specific markdown syntax transforms.
 *
 * "Push" direction: Obsidian -> plain/standard markdown (for Google Docs).
 * "Pull" direction: plain/standard markdown -> Obsidian (best-effort restore).
 */

// ---------------------------------------------------------------------------
// Sentinels used by the conversion pipeline to apply rich formatting later.
// ---------------------------------------------------------------------------
export const HIGHLIGHT_START = "{{HIGHLIGHT_START}}";
export const HIGHLIGHT_END = "{{HIGHLIGHT_END}}";

// ---------------------------------------------------------------------------
// Push transforms (Obsidian -> plain)
// ---------------------------------------------------------------------------

/**
 * Convert Obsidian wikilinks to plain text.
 *
 * - `[[target]]`             -> `target`
 * - `[[target|display text]]` -> `display text`
 * - `[[folder/nested-link]]`  -> `nested-link`  (basename only)
 */
export function transformWikilinks(text: string): string {
  // Match [[ ... ]] but NOT ![[ ... ]] (embeds handled separately).
  return text.replace(/(?<!!)\[\[([^\]]+)\]\]/g, (_match, inner: string) => {
    // If there is an alias (pipe), use the display text.
    const pipeIndex = inner.indexOf("|");
    if (pipeIndex !== -1) {
      return inner.slice(pipeIndex + 1);
    }
    // Otherwise strip any folder path and return the basename.
    const slashIndex = inner.lastIndexOf("/");
    if (slashIndex !== -1) {
      return inner.slice(slashIndex + 1);
    }
    return inner;
  });
}

/**
 * Convert Obsidian embeds to a descriptive placeholder.
 *
 * - `![[embedded-note]]` -> `(embedded: embedded-note)`
 * - `![[image.png]]`     -> `(embedded: image.png)`
 */
export function transformEmbeds(text: string): string {
  return text.replace(/!\[\[([^\]]+)\]\]/g, (_match, inner: string) => {
    return `(embedded: ${inner})`;
  });
}

/**
 * Wrap highlighted text with sentinels so downstream formatting can apply
 * highlight styling.
 *
 * - `==highlighted text==` -> `{{HIGHLIGHT_START}}highlighted text{{HIGHLIGHT_END}}`
 */
export function transformHighlights(text: string): string {
  return text.replace(/==(.+?)==/g, (_match, inner: string) => {
    return `${HIGHLIGHT_START}${inner}${HIGHLIGHT_END}`;
  });
}

/**
 * Convert Obsidian callouts to bolded label + content.
 *
 * Handles:
 * ```
 * > [!note] Title
 * > Content line 1
 * > Content line 2
 * ```
 * becomes:
 * ```
 * **Note: Title**
 * Content line 1
 * Content line 2
 * ```
 *
 * Without a title: `> [!note]` -> `**Note:**`
 *
 * The callout type is capitalized (first letter upper, rest preserved after
 * the first character of each hyphen-separated segment, matching Obsidian
 * conventions for built-in types).
 */
export function transformCallouts(text: string): string {
  // We process line-by-line so we can capture multi-line callout blocks.
  const lines = text.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const calloutMatch = lines[i].match(
      /^>\s*\[!([^\]]+)\]\s*(.*?)\s*$/
    );

    if (calloutMatch) {
      const rawType = calloutMatch[1];
      const title = calloutMatch[2];
      const label = capitalizeCalloutType(rawType);

      if (title) {
        result.push(`**${label}: ${title}**`);
      } else {
        result.push(`**${label}:**`);
      }

      // Consume subsequent `> ` continuation lines.
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        // Strip the leading `> ` or `>`.
        result.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

/**
 * Tags (#tag, #nested/tag) are preserved as-is -- no transformation needed.
 * This function is a documented pass-through for clarity in the pipeline.
 */
export function transformTags(text: string): string {
  return text;
}

/**
 * Apply all Obsidian -> plain transforms in the correct order.
 *
 * Order matters:
 * 1. Embeds first (`![[...]]` before wikilinks `[[...]]` to avoid partial matches).
 * 2. Wikilinks.
 * 3. Callouts.
 * 4. Highlights.
 * 5. Tags (pass-through).
 */
export function transformAllObsidianSyntax(text: string): string {
  let out = text;
  out = transformEmbeds(out);
  out = transformWikilinks(out);
  out = transformCallouts(out);
  out = transformHighlights(out);
  out = transformTags(out);
  return out;
}

// ---------------------------------------------------------------------------
// Pull transforms (plain -> Obsidian, best-effort)
// ---------------------------------------------------------------------------

/**
 * Best-effort restoration of wikilinks from plain text.
 *
 * If a word in `text` matches the basename (without extension) of a file in
 * `vaultFiles`, wrap it in `[[...]]`.
 *
 * This is intentionally conservative: only whole-word, case-sensitive matches
 * are restored.
 */
export function restoreWikilinks(
  text: string,
  vaultFiles: string[]
): string {
  if (vaultFiles.length === 0) return text;

  // Build a set of basenames (without extension) for fast lookup.
  const basenames = new Set(
    vaultFiles.map((f) => {
      const slash = f.lastIndexOf("/");
      const name = slash !== -1 ? f.slice(slash + 1) : f;
      const dot = name.lastIndexOf(".");
      return dot !== -1 ? name.slice(0, dot) : name;
    })
  );

  // Replace whole-word occurrences.
  const escaped = Array.from(basenames)
    .sort((a, b) => b.length - a.length) // longest first to avoid partial matches
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

  if (escaped.length === 0) return text;

  const pattern = new RegExp(`\\b(${escaped.join("|")})\\b`, "g");
  return text.replace(pattern, "[[$1]]");
}

/**
 * Restore highlight sentinels back to Obsidian `==` syntax.
 *
 * `{{HIGHLIGHT_START}}text{{HIGHLIGHT_END}}` -> `==text==`
 */
export function restoreHighlights(text: string): string {
  const startEscaped = HIGHLIGHT_START.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );
  const endEscaped = HIGHLIGHT_END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${startEscaped}(.*?)${endEscaped}`, "g");
  return text.replace(pattern, "==$1==");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Capitalize a callout type string.  `note` -> `Note`, `custom-type` -> `Custom-Type`.
 */
function capitalizeCalloutType(raw: string): string {
  return raw
    .split("-")
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join("-");
}
