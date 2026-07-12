import * as fs from "fs";
import * as path from "path";
import { STORE_DIR_NAME } from "./paths";
import { log } from "./log";

/**
 * Ensure the workspace .gitignore lists `.prompt-trace/` so the store is never
 * committed. Idempotent — safe to call on every activation.
 */
export async function ensureGitignoreEntry(workspacePath: string): Promise<void> {
  const gitignorePath = path.join(workspacePath, ".gitignore");
  const entry = `${STORE_DIR_NAME}/`;

  let content = "";
  try {
    content = await fs.promises.readFile(gitignorePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.warn(`could not read .gitignore: ${err}`);
      return;
    }
  }

  const lines = content.split(/\r?\n/);
  if (lines.some((l) => l.trim() === entry)) {
    return; // already ignored
  }

  const next = (content && !content.endsWith("\n") ? content + "\n" : content) + entry + "\n";
  try {
    await fs.promises.writeFile(gitignorePath, next, "utf8");
    log.info(`added ${entry} to .gitignore`);
  } catch (err) {
    log.warn(`could not write .gitignore: ${err}`);
  }
}
