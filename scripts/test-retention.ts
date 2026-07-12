/**
 * Tests for Repository.applyRetention (OR-semantics: keep if in last N OR
 * within N days). Uses bare prompts with controlled timestamps + an injected
 * `now`, so no file_changes/blobs are needed.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveStoreRoot } from "../src/store/resolve";
import { openStore } from "../src/store/db";
import { Repository } from "../src/store/repository";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log("  ok:", msg);
}

const DAY = 86_400_000;

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pt-ret-"));
  const storeRoot = path.join(tmp, ".prompt-trace");
  const db = await openStore(storeRoot);
  const repo = new Repository(db, storeRoot);

  const NOW = 30 * DAY; // fixed "today" for the test
  const ts = (daysAgo: number) => NOW - daysAgo * DAY;

  let seq = 0;
  function add(id: string, daysAgo: number): void {
    repo.addPrompt({
      id,
      title: id,
      text: id,
      timestamp: ts(daysAgo),
      agent: "claude-code",
      sessionId: "s1",
      sequence: seq++,
    });
  }

  function ids(): Set<string> {
    return new Set(repo.listPrompts(100000).map((p) => p.id));
  }
  const has = (s: Set<string>, id: string) => s.has(id);

  // --- Case A: 120d old, rank #50 (total 50 <= 100) → KEEP (all in last N) ---
  repo.clearAll();
  for (let i = 0; i < 49; i++) add(`recent${i}`, 5);
  add("old120_rank50", 120);
  let n = repo.applyRetention(100, 90, NOW);
  assert(n === 0, "total <= keepLastPrompts → 0 deleted (all in last N)");
  assert(has(ids(), "old120_rank50"), "120d/rank50 kept (in last N, despite age)");

  // --- Case B+C: mixed 500 — 10d/rank451 KEEP, 120d/rank452+ DELETE ---
  repo.clearAll();
  seq = 0;
  for (let i = 0; i < 450; i++) add(`r5_${i}`, 5); // ranks 1..450 (newest)
  add("r10_rank451", 10); // beyond last 100, within 90d → KEEP
  for (let i = 0; i < 49; i++) add(`r120_${i}`, 120); // beyond last 100, older than 90d → DELETE
  n = repo.applyRetention(100, 90, NOW);
  let s = ids();
  assert(n === 49, "mixed 500 → 49 deleted (the 49 @120d)");
  assert(has(s, "r10_rank451"), "10d/rank451 kept (within 90d, beyond last 100)");
  assert(!has(s, "r120_0"), "120d/rank452 deleted (beyond last 100 AND older than 90d)");
  assert(has(s, "r5_0"), "5d/rank1 kept (in last 100)");
  assert(s.size === 451, "451 survivors (450 @5d + 1 @10d)");

  // --- Case D: keepLastDays=0 → pure count retention ---
  repo.clearAll();
  seq = 0;
  for (let i = 0; i < 100; i++) add(`keep${i}`, 5);
  for (let i = 0; i < 100; i++) add(`drop${i}`, 120);
  n = repo.applyRetention(100, 0, NOW);
  s = ids();
  assert(n === 100, "pure count: 100 deleted (the 120d half)");
  assert(has(s, "keep0") && !has(s, "drop0"), "pure count keeps last 100 (the 5d ones)");

  // --- Case E: keepLastPrompts=0 → pure days retention ---
  repo.clearAll();
  seq = 0;
  for (let i = 0; i < 100; i++) add(`keep${i}`, 5);
  for (let i = 0; i < 100; i++) add(`drop${i}`, 120);
  n = repo.applyRetention(0, 90, NOW);
  s = ids();
  assert(n === 100, "pure days: 100 deleted (older than 90d)");
  assert(has(s, "keep0") && !has(s, "drop0"), "pure days keeps within 90d");

  // --- Case F: both thresholds 0 → nothing deleted ---
  repo.clearAll();
  seq = 0;
  for (let i = 0; i < 10; i++) add(`p${i}`, 200);
  n = repo.applyRetention(0, 0, NOW);
  assert(n === 0, "no applicable threshold → 0 deleted");
  assert(ids().size === 10, "all 10 kept when retention thresholds are 0");

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nALL RETENTION TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
