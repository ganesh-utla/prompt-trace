import * as fs from "fs";
import * as path from "path";
import type { PathHash } from "../store/repository";

export interface ReindexPlan {
  /** The new cursor: path → hash entries to persist via setLastState. */
  newCursor: PathHash[];
  /** Paths whose content must be read + blob-written (newly in scope, or changed). */
  needContent: PathHash[];
}

/**
 * Scope-only reconcile (automatic, on exclude/size-rule changes).
 *
 * Reconciles cursor *membership* without touching content drift:
 *  - in scope both before & after → KEEP the cursor's old hash (preserve manual edits)
 *  - in cursor, not in snapshot, but still on disk → a scope rule removed it → DROP
 *  - in cursor, not in snapshot, gone from disk → real deletion → KEEP (preserve for attribution to the next prompt)
 *  - in snapshot, not in cursor → newly in scope → ADD (with current hash + a new blob)
 *
 * The stat check is what tells "scope rule removed it" (drop) from "deleted from
 * disk" (keep for attribution), so on-disk deletions of in-scope files are NOT
 * absorbed here — they stay attributed to the next prompt.
 */
export function planScopeReconcile(
  prev: Map<string, string | null>,
  next: PathHash[],
  workspacePath: string
): ReindexPlan {
  const snapMap = new Map(next.map((e) => [e.path, e.hash]));
  const newCursor: PathHash[] = [];
  const needContent: PathHash[] = [];

  for (const [p, hash] of prev) {
    if (snapMap.has(p)) {
      // In scope both before & after — keep the cursor's existing hash (preserve drift).
      newCursor.push({ path: p, hash });
    } else if (existsOnDisk(workspacePath, p)) {
      // A scope rule (exclude pattern or size threshold) removed it — drop from cursor.
    } else {
      // Real on-disk deletion — keep in cursor so the next Stop attributes it.
      newCursor.push({ path: p, hash });
    }
  }

  for (const e of next) {
    if (!prev.has(e.path)) {
      // Newly in scope — add with current hash; needs a blob so future diffs have before-content.
      newCursor.push(e);
      needContent.push(e);
    }
  }

  return { newCursor, needContent };
}

/**
 * Full re-baseline (manual `Reindex` command).
 *
 * The new cursor is simply the current snapshot — all on-disk drift (manual
 * edits, branch switch, downtime) is absorbed into the baseline. Only paths
 * whose hash differs from the previous cursor (new + modified) need a blob;
 * unchanged files already have one on disk.
 */
export function planFullReindex(
  prev: Map<string, string | null>,
  next: PathHash[]
): ReindexPlan {
  const needContent: PathHash[] = [];
  for (const e of next) {
    if (prev.get(e.path) !== e.hash) {
      needContent.push(e);
    }
  }
  return { newCursor: next, needContent };
}

function existsOnDisk(workspacePath: string, rel: string): boolean {
  try {
    const abs = path.join(workspacePath, rel);
    return fs.existsSync(abs) && fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}
