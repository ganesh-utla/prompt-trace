import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveStoreRoot } from "../src/store/resolve";
import { openStore } from "../src/store/db";
import { Repository } from "../src/store/repository";
import { snapshotWorkspace } from "../src/capture/snapshot";
import { computeDiff } from "../src/capture/differ";

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pt-"));
  const cwd = path.join(tmp, "p");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, "a.txt"), "line1\n");
  const storeRoot = resolveStoreRoot(cwd, "workspace");
  const db = openStore(storeRoot);
  const repo = new Repository(db, storeRoot);
  const excl = ["**/.git/**", "**/.prompt-trace/**"];
  const maxB = 10 * 1024 * 1024;
  let e = (await snapshotWorkspace({ workspacePath: cwd, excludePatterns: excl, maxFileSizeBytes: maxB })).entries;
  repo.setLastState(e);
  repo.addPrompt({ id: "p1", title: "t", text: "x", timestamp: Date.now(), agent: "a", sessionId: "s", sequence: 0 });
  fs.writeFileSync(path.join(cwd, "a.txt"), "line1\nline2\n");
  e = (await snapshotWorkspace({ workspacePath: cwd, excludePatterns: excl, maxFileSizeBytes: maxB })).entries;
  const d = await computeDiff(cwd, storeRoot, repo.getLastState(), e);
  console.log("changes", JSON.stringify(d.changes.map((c) => ({ path: c.path, status: c.status, additions: c.additions, deletions: c.deletions, patch: c.patch })), null, 2));
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
main();
