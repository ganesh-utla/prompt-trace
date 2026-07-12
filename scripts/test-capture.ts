/**
 * Integration test: simulates the Claude Code hook flow against a temp
 * workspace by calling the capture engine directly (no real hooks needed).
 *
 *   baseline Stop → (UserPromptSubmit → edit files → Stop) x2 → verify diffs.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveStoreRoot } from "../src/store/resolve";
import { openStore } from "../src/store/db";
import { Repository } from "../src/store/repository";
import { snapshotWorkspace } from "../src/capture/snapshot";
import { computeDiff } from "../src/capture/differ";
import { readBlobText } from "../src/store/blobs";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log("  ok:", msg);
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pt-cap-"));
  const cwd = path.join(tmp, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const storeRoot = resolveStoreRoot(cwd, "workspace");

  // seed a couple of files
  fs.writeFileSync(path.join(cwd, "a.txt"), "line1\n");
  fs.writeFileSync(path.join(cwd, "b.txt"), "hello\n");

  const db = await openStore(storeRoot);
  const repo = new Repository(db, storeRoot);
  const exclude = ["**/node_modules/**", "**/.git/**", "**/.prompt-trace/**"];
  const maxBytes = 10 * 1024 * 1024;

  async function snap() {
    return (await snapshotWorkspace({ workspacePath: cwd, excludePatterns: exclude, maxFileSizeBytes: maxBytes })).entries;
  }

  // --- First Stop: baseline (seed blobs so first diff has before-content) ---
  let entries = await snap();
  assert(repo.getLastState().size === 0, "no baseline yet");
  const baselineContents = new Map<string, Buffer>();
  for (const e of entries) {
    baselineContents.set(e.path, fs.readFileSync(path.join(cwd, e.path)));
  }
  repo.seedBaseline(entries, baselineContents);
  assert(repo.getLastState().size === 2, "baseline has 2 files");

  // --- Prompt 1: add a file + modify a.txt ---
  repo.addPrompt({ id: "s1-1", title: "add c and edit a", text: "x", timestamp: Date.now(), agent: "claude-code", sessionId: "s1", sequence: 0 });
  fs.writeFileSync(path.join(cwd, "c.txt"), "new file\n");
  fs.writeFileSync(path.join(cwd, "a.txt"), "line1\nline2\n");

  entries = await snap();
  const prev1 = repo.getLastState();
  const d1 = await computeDiff(cwd, storeRoot, prev1, entries);
  repo.attachChanges("s1-1", d1.changes, d1.nextSnapshot, d1.afterContents);

  const ch1 = repo.changesForPrompt("s1-1");
  assert(ch1.length === 2, "prompt 1 has 2 file changes");
  const cChange = ch1.find((c) => c.path === "c.txt")!;
  assert(cChange.status === "added", "c.txt is added");
  const aChange = ch1.find((c) => c.path === "a.txt")!;
  assert(aChange.status === "modified", "a.txt is modified");
  assert(aChange.additions === 1, "a.txt has 1 addition");
  // blob was written for a.txt after-content
  assert(readBlobText(storeRoot, aChange.after_hash!) === "line1\nline2\n", "a.txt after-blob stored");

  // --- Prompt 2: delete b.txt ---
  repo.addPrompt({ id: "s1-2", title: "remove b", text: "y", timestamp: Date.now(), agent: "claude-code", sessionId: "s1", sequence: 1 });
  fs.unlinkSync(path.join(cwd, "b.txt"));

  entries = await snap();
  const d2 = await computeDiff(cwd, storeRoot, repo.getLastState(), entries);
  repo.attachChanges("s1-2", d2.changes, d2.nextSnapshot, d2.afterContents);
  const ch2 = repo.changesForPrompt("s1-2");
  assert(ch2.length === 1, "prompt 2 has 1 file change");
  assert(ch2[0].path === "b.txt", "b.txt changed in prompt 2");
  assert(ch2[0].status === "deleted", "b.txt is deleted");

  // --- History for a.txt: only prompt 1 touched it ---
  const hist = repo.historyForFile("a.txt");
  assert(hist.length === 1, "a.txt history has 1 entry");
  assert(hist[0].prompt.id === "s1-1", "a.txt touched by prompt 1");

  // --- Prompts list ---
  assert(repo.listPrompts().length === 2, "2 prompts total");

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nALL CAPTURE TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
