import * as micromatch from "micromatch";
import { ALWAYS_EXCLUDED_PATTERNS } from "@/constants";

/**
 * Returns true if the given file path matches any of the provided glob patterns.
 */
export function isExcluded(filePath: string, patterns: string[]): boolean {
  return micromatch.isMatch(filePath, patterns, { dot: true });
}

/**
 * Combines user-provided exclusion patterns with the always-excluded patterns
 * from constants.
 */
export function getEffectiveExclusions(userPatterns: string[]): string[] {
  return [...ALWAYS_EXCLUDED_PATTERNS, ...userPatterns];
}
