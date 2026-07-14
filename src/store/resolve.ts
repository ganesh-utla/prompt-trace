import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { STORE_DIR_NAME } from "../util/paths";

/**
 * Resolve the on-disk root of the trace store for a given workspace.
 *
 * `workspace` mode → `<workspace>/.prompt-trace/` (cwd-relative, so the
 * hook-launched capture CLI and the extension agree on the same path).
 *
 * `global` mode → `~/.prompt-trace/<project>-<hash8>/`: stored under the home
 * directory (not the workspace) so the project folder stays clean, and keyed by
 * the project's basename plus a short hash of its absolute path. The basename
 * keeps the folder human-readable (`project1-…`); the hash disambiguates two
 * different projects that happen to share a name, so their stores never
 * cross-contaminate. The CLI resolves the store from `cwd` the same way the
 * extension does, so both bundles agree.
 *
 * `path.resolve` normalizes the path (trailing slashes, `.`/`..`) before it's
 * hashed and basename'd, so the extension and the CLI produce the same key even
 * if they pass slightly different string forms of the same absolute path.
 */
export function resolveStoreRoot(
  workspacePath: string,
  location: "workspace" | "global"
): string {
  if (location === "global") {
    const ws = path.resolve(workspacePath);
    const base = path.basename(ws) || "workspace";
    const hash = crypto.createHash("sha256").update(ws).digest("hex").slice(0, 8);
    return path.join(os.homedir(), ".prompt-trace", `${base}-${hash}`);
  }
  return path.join(workspacePath, STORE_DIR_NAME);
}
