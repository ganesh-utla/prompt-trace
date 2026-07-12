import * as path from "path";

/**
 * Compute the workspace-relative, POSIX-normalized path for a document URI —
 * the exact form stored in `file_changes.path` and `last_state` (see
 * `snapshot.ts`'s `toPosix`). Returns null if the document is not a `file:`
 * URI or lives outside the workspace, so callers can show an empty state
 * instead of a bogus history lookup.
 */
export function toWorkspaceRel(
  workspacePath: string,
  uri: { scheme: string; fsPath: string }
): string | null {
  if (uri.scheme !== "file") return null;
  const rel = path.relative(workspacePath, uri.fsPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}
