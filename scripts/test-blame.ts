/**
 * Tests for the blame algorithm (computeBlame). Pure logic exercised against a
 * real store + blobs, driven through the real capture flow (seedBaseline +
 * snapshot + computeDiff + attachChanges) so before/after hashes + blobs match
 * exactly what production produces.
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
import { computeBlame, attachPrompts } from "../src/blame/blame";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log("  ok:", msg);
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pt-blame-"));
  const cwd = path.join(tmp, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const storeRoot = resolveStoreRoot(cwd, "workspace");
  const file = path.join(cwd, "app.ts");
  const rel = "app.ts";
  const exclude = ["**/node_modules/**", "**/.git/**", "**/.prompt-trace/**"];

  const db = await openStore(storeRoot);
  const repo = new Repository(db, storeRoot);
  const readBlob = (h: string | null) => (h ? readBlobText(storeRoot, h) ?? "" : "");

  async function snap() {
    return (await snapshotWorkspace({ workspacePath: cwd, excludePatterns: exclude, maxFileSizeBytes: 10 * 1024 * 1024 })).entries;
  }

  async function commitPrompt(id: string, title: string, seq: number) {
    repo.addPrompt({ id, title, text: title, timestamp: Date.now(), agent: "claude-code", sessionId: "s1", sequence: seq });
    const entries = await snap();
    const d = await computeDiff(cwd, storeRoot, repo.getLastState(), entries);
    repo.attachChanges(id, d.changes, d.nextSnapshot, d.afterContents);
  }

  // --- Baseline: a,b,c ---
  fs.writeFileSync(file, "a\nb\nc\n");
  let entries = await snap();
  const baseContents = new Map<string, Buffer>();
  for (const e of entries) baseContents.set(e.path, fs.readFileSync(path.join(cwd, e.path)));
  repo.seedBaseline(entries, baseContents);

  // --- P1: b -> B ; P2: add d ; P3: delete c ---
  fs.writeFileSync(file, "a\nB\nc\n");
  await commitPrompt("s1-1", "b->B", 0);
  fs.writeFileSync(file, "a\nB\nc\nd\n");
  await commitPrompt("s1-2", "add d", 1);
  fs.writeFileSync(file, "a\nB\nd\n");
  await commitPrompt("s1-3", "del c", 2);

  let history = repo.historyForFile(rel);
  assert(history.length === 3, "3 prompts touched app.ts");
  let live = fs.readFileSync(file, "utf8");
  let blame = attachPrompts(computeBlame(history, readBlob, live), history);
  assert(blame.length === 3, "blame covers 3 live lines");
  assert(blame[0].promptId === null, "line 0 'a' = baseline (null)");
  assert(blame[1].promptId === "s1-1", "line 1 'B' = P1 (b->B)");
  assert(blame[2].promptId === "s1-2", "line 2 'd' = P2 (added d, survived del c)");

  // --- Re-add: P4 deletes B ; P5 re-adds B2 at that spot ---
  fs.writeFileSync(file, "a\nd\n");
  await commitPrompt("s1-4", "del B", 3);
  fs.writeFileSync(file, "a\nB2\nd\n");
  await commitPrompt("s1-5", "re-add B2", 4);

  history = repo.historyForFile(rel);
  live = fs.readFileSync(file, "utf8");
  blame = attachPrompts(computeBlame(history, readBlob, live), history);
  assert(blame.length === 3, "blame covers 3 live lines after re-add");
  assert(blame[0].promptId === null, "line 0 'a' still baseline");
  assert(blame[1].promptId === "s1-5", "line 1 'B2' = P5 (re-added, most recent wins over P1)");
  assert(blame[2].promptId === "s1-2", "line 2 'd' = P2 (survived)");

  // --- Un-captured live edit: append E without a prompt ---
  fs.writeFileSync(file, "a\nB2\nd\nE\n");
  live = fs.readFileSync(file, "utf8");
  blame = attachPrompts(computeBlame(history, readBlob, live), history);
  assert(blame.length === 4, "blame covers 4 live lines incl. un-captured E");
  assert(blame[3].promptId === null, "line 3 'E' = null (un-captured edit)");
  assert(blame[1].promptId === "s1-5", "line 1 still P5 after un-captured append");

  // --- Empty history → [] ---
  assert(computeBlame([], readBlob, "x\ny\n").length === 0, "no history → empty blame");

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nALL BLAME TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
