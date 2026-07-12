import * as fs from "fs";
import * as path from "path";
import { diffLines, createPatch } from "diff";
import { log } from "../util/log";
import { readBlobText } from "../store/blobs";
import type { PathHash, FileChangeInput } from "../store/repository";

export interface DiffResult {
  changes: FileChangeInput[];
  afterContents: Map<string, Buffer>; // path -> current content for changed files
  nextSnapshot: PathHash[];
}

/**
 * Diff a new snapshot against the previous state cursor, producing per-file
 * changes (status + patch + counts) and the content to persist as blobs.
 *
 * - `prev`: path -> hash (the last Stop state; missing path = was absent).
 * - `next`: the freshly-captured snapshot.
 * - Contents are read from disk for "after" and from blobs for "before".
 */
export async function computeDiff(
  workspacePath: string,
  storeRoot: string,
  prev: Map<string, string | null>,
  next: PathHash[]
): Promise<DiffResult> {
  const nextMap = new Map(next.map((e) => [e.path, e.hash]));
  const changes: FileChangeInput[] = [];
  const afterContents = new Map<string, Buffer>();

  const allPaths = new Set<string>([...prev.keys(), ...nextMap.keys()]);

  for (const rel of allPaths) {
    const beforeHash = prev.has(rel) ? (prev.get(rel) ?? null) : null;
    let afterHash = nextMap.has(rel) ? (nextMap.get(rel) ?? null) : null;

    if (beforeHash === afterHash) continue; // unchanged

    let status: FileChangeInput["status"];
    if (beforeHash === null && afterHash !== null) status = "added";
    else if (beforeHash !== null && afterHash === null) status = "deleted";
    else status = "modified";

    const abs = path.join(workspacePath, rel);
    let afterText: string | null = null;
    let afterBuf: Buffer | null = null;
    if (status !== "deleted") {
      try {
        afterBuf = await fs.promises.readFile(abs);
        afterText = afterBuf.toString("utf8");
        afterContents.set(rel, afterBuf);
      } catch (err) {
        // File vanished between snapshot and diff read — treat as deleted.
        log.warn(`differ: could not read after ${rel}: ${err}`);
        status = "deleted";
        afterHash = null;
      }
    }

    const beforeText = beforeHash ? readBlobText(storeRoot, beforeHash) : null;

    const patch =
      status === "deleted"
        ? removalPatch(rel, beforeText ?? "")
        : createTwoWayPatch(rel, beforeText ?? "", afterText ?? "");

    const { additions, deletions } = countChanges(beforeText ?? "", afterText ?? "");

    changes.push({
      path: rel,
      beforeHash,
      afterHash,
      patch,
      additions,
      deletions,
      status,
    });
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  return { changes, afterContents, nextSnapshot: next };
}

function createTwoWayPatch(fileName: string, before: string, after: string): string {
  // createPatch yields a unified diff with a header; good for storage + display.
  try {
    return createPatch(fileName, before, after, "", "", { context: 3 });
  } catch {
    // Fallback to a minimal header + line diff if createPatch misbehaves.
    return `--- ${fileName}\n+++ ${fileName}\n` + diffLines(before, after).map((p) => p.value).join("");
  }
}

function removalPatch(fileName: string, before: string): string {
  return `--- ${fileName}\n+++ ${fileName}\n` + before.split(/\r?\n/).map((l) => `-${l}`).join("\n");
}

function countChanges(before: string, after: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(before, after)) {
    if (part.added) additions += part.count ?? 0;
    else if (part.removed) deletions += part.count ?? 0;
  }
  return { additions, deletions };
}
