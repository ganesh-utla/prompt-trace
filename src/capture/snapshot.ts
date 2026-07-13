import * as fs from "fs";
import * as path from "path";
import { sha256 } from "../util/hash";
import { isExcluded } from "../util/glob";
import { log } from "../util/log";
import type { PathHash } from "../store/repository";

export interface SnapshotOptions {
  workspacePath: string;
  excludePatterns: string[];
  maxFileSizeBytes: number;
}

/**
 * Walk the workspace and return a snapshot: every tracked file's relative
 * path + content hash. Excluded paths and oversized files are skipped (the
 * latter is logged but not snapshotted — large binaries shouldn't bloat blobs).
 *
 * Returns paths POSIX-normalized and relative to the workspace root.
 */
export async function snapshotWorkspace(opts: SnapshotOptions): Promise<{
  entries: PathHash[];
  largeSkipped: string[];
}> {
  const { workspacePath, excludePatterns, maxFileSizeBytes } = opts;
  const entries: PathHash[] = [];
  const largeSkipped: string[] = [];

  const stack: string[] = [workspacePath];
  while (stack.length) {
    const dir = stack.pop()!;
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch (err) {
      // ELOOP (self-referential symlink chains, e.g. Nix flake inputs) is
      // expected on some trees; treat unreadable dirs as "nothing here" rather
      // than aborting the whole snapshot.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code !== "ELOOP") log.warn(`snapshot: cannot read dir ${dir}: ${err}`);
      continue;
    }

    for (const name of names) {
      // Always skip the trace store itself + VCS dirs even if not in excludes.
      if (name === ".prompt-trace" || name === ".git") continue;
      const abs = path.join(dir, name);
      const rel = toPosix(path.relative(workspacePath, abs));

      if (isExcluded(rel, excludePatterns)) continue;

      // lstat, NOT stat: we deliberately do not follow symlinks. Following them
      // makes the walker descend into symlinked external trees (e.g. a Nix
      // flake-input symlink to a store path containing a full nixpkgs checkout),
      // double-count bind mounts, and loop forever on self-referential links
      // (ELOOP). Skipping symlinks entirely keeps the snapshot bounded to
      // files physically inside the workspace.
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(abs);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!stat.isFile()) continue; // sockets, FIFOs, devices, …

      if (stat.size > maxFileSizeBytes) {
        largeSkipped.push(rel);
        continue;
      }

      let content: Buffer;
      try {
        content = await fs.promises.readFile(abs);
      } catch {
        continue;
      }
      entries.push({ path: rel, hash: sha256(content) });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, largeSkipped };
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
