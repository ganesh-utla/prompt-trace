import * as fs from "fs";
import * as path from "path";
import { blobsDirPath } from "../util/paths";
import { sha256 } from "../util/hash";

/**
 * Content-addressed blob store. File contents are written once under their
 * sha256 hash and shared across snapshots/prompts — unchanged files cost
 * nothing to store repeatedly.
 */

export function blobPath(storeRoot: string, hash: string): string {
  // Sharded by first 2 hex chars to avoid a single huge directory.
  return path.join(blobsDirPath(storeRoot), hash.slice(0, 2), hash);
}

/** Write a blob (idempotent — no-op if it already exists). Returns the hash. */
export function writeBlob(storeRoot: string, content: Buffer): string {
  const hash = sha256(content);
  const p = blobPath(storeRoot, hash);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return hash;
}

/** Read a blob; returns null if missing. */
export function readBlob(storeRoot: string, hash: string): Buffer | null {
  if (!hash) return null;
  const p = blobPath(storeRoot, hash);
  try {
    return fs.readFileSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Read a blob as UTF-8 string; null if missing. */
export function readBlobText(storeRoot: string, hash: string): string | null {
  const buf = readBlob(storeRoot, hash);
  return buf ? buf.toString("utf8") : null;
}

/**
 * Delete any blob whose hash is not in `referenced`. Callers must include
 * every hash that must survive: both file_changes before/after hashes AND
 * last_state hashes (the current on-disk content of unchanged files, needed
 * as the "before" of the next diff). Returns the number of blobs removed.
 */
export function reclaimUnreferencedBlobs(
  storeRoot: string,
  referenced: Set<string>
): number {
  const dir = blobsDirPath(storeRoot);
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  const walk = (d: string) => {
    let entries: string[];
    try {
      entries = fs.readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = path.join(d, name);
      let s: fs.Stats;
      try {
        s = fs.statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(p);
        continue;
      }
      // Blob files are named by their full hash.
      if (!referenced.has(name)) {
        try {
          fs.unlinkSync(p);
          removed++;
        } catch {
          // best-effort; a concurrent reader is fine
        }
      }
    }
  };
  walk(dir);
  return removed;
}
