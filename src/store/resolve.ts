import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { STORE_DIR_NAME } from "../util/paths";

/**
 * Resolve the on-disk root of the trace store for a given workspace.
 *
 * Phase 1: `workspace` mode → `<workspace>/.prompt-trace/` (cwd-relative, so the
 * hook-launched capture CLI and the extension agree on the same path).
 *
 * Phase 2: `global` mode → `~/.prompt-trace/<hash-of-workspace-path>/` (the same
 * path-hash keying Claude Code uses for its transcripts). The CLI resolves the
 * store from `cwd` the same way the extension does, so both bundles agree.
 */
export function resolveStoreRoot(
  workspacePath: string,
  location: "workspace" | "global"
): string {
  if (location === "global") {
    const hash = crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 16);
    return path.join(os.homedir(), ".prompt-trace", hash);
  }
  return path.join(workspacePath, STORE_DIR_NAME);
}
