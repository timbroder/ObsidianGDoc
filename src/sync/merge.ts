import { CONTENT_LOSS_THRESHOLD } from "@/constants";
import { ConflictResolution } from "@/types";

// diff3 exports a single function: diff3Merge(localLines, ancestorLines, remoteLines)
// Returns array of {ok: string[]} or {conflict: {a: string[], o: string[], b: string[]}}
const diff3Merge = require("diff3");

export interface MergeResult {
  success: boolean;
  merged?: string;
  conflicts?: ConflictRegion[];
  contentLossWarning?: boolean;
}

export interface ConflictRegion {
  ancestor: string;
  local: string;
  remote: string;
  startLine: number;
  endLine: number;
}

export function threeWayMerge(
  ancestor: string,
  local: string,
  remote: string
): MergeResult {
  // If ancestor is empty or missing, entire file is a conflict
  if (!ancestor) {
    if (local === remote) {
      return { success: true, merged: local };
    }
    return {
      success: false,
      conflicts: [
        {
          ancestor: "",
          local,
          remote,
          startLine: 0,
          endLine: Math.max(
            local.split("\n").length,
            remote.split("\n").length
          ),
        },
      ],
    };
  }

  // If only one side changed, use that version
  if (ancestor === local) {
    return { success: true, merged: remote };
  }
  if (ancestor === remote) {
    return { success: true, merged: local };
  }

  // If both made identical changes
  if (local === remote) {
    return { success: true, merged: local };
  }

  // Perform three-way merge
  const ancestorLines = ancestor.split("\n");
  const localLines = local.split("\n");
  const remoteLines = remote.split("\n");

  try {
    const result = diff3Merge(localLines, ancestorLines, remoteLines);

    let hasConflict = false;
    const conflicts: ConflictRegion[] = [];
    const mergedLines: string[] = [];
    let lineNum = 0;

    for (const hunk of result) {
      if (hunk.ok) {
        mergedLines.push(...hunk.ok);
        lineNum += hunk.ok.length;
      } else if (hunk.conflict) {
        hasConflict = true;
        const a = hunk.conflict.a || [];
        const o = hunk.conflict.o || [];
        const b = hunk.conflict.b || [];

        conflicts.push({
          local: a.join("\n"),
          ancestor: o.join("\n"),
          remote: b.join("\n"),
          startLine: lineNum,
          endLine: lineNum + Math.max(a.length, o.length, b.length),
        });
        lineNum += Math.max(a.length, o.length, b.length);
      }
    }

    if (hasConflict) {
      return { success: false, conflicts };
    }

    // Clean merge
    const merged = mergedLines.join("\n");

    // Check content loss threshold
    const longerInput = Math.max(local.length, remote.length);
    if (longerInput > 0 && merged.length < longerInput * CONTENT_LOSS_THRESHOLD) {
      return {
        success: true,
        merged,
        contentLossWarning: true,
      };
    }

    return { success: true, merged };
  } catch {
    // If diff3 fails, treat as full conflict
    return {
      success: false,
      conflicts: [
        {
          ancestor,
          local,
          remote,
          startLine: 0,
          endLine: Math.max(localLines.length, remoteLines.length),
        },
      ],
    };
  }
}

export function applyResolution(
  resolution: ConflictResolution,
  local: string,
  remote: string
): string | null {
  switch (resolution) {
    case "keep-local":
      return local;
    case "keep-remote":
      return remote;
    case "open-in-editor":
      return null; // Signal to caller to open editor
  }
}
