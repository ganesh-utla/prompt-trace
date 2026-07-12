/**
 * Tests for Reindex: scope-only reconcile (auto) + full re-baseline (manual).
 *
 * Proves the core guarantees:
 *  - scope-only reconcile preserves manual edits (cursor hash unchanged) →
 *    next prompt attributes them, not the rule change.
 *  - scope-only drops files that left scope (no phantom deletion).
 *  - scope-only preserves in-scope on-disk deletions (kept for attribution).
 *  - scope-only adds newly-in-scope files (no phantom addition).
 *  - full reindex absorbs drift into the baseline (next prompt not blamed).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveStoreRoot } from "../src/store/resolve";
import { openStore } from "../src/store/db";
import { Repository } from "../src/store/repository";
import type { PathHash } from "../src/store/repository";
import { snapshotWorkspace } from "../src/capture/snapshot";
import { computeDiff } from "../src/capture/differ";
import { planScopeReconcile, planFullReindex } from "../src/capture/reconcile";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log("  ok:", msg);
}

async function snap(cwd: string, exclude: string[]) {
  return (
    await snapshotWorkspace({
      workspacePath: cwd,
      excludePatterns: exclude,
      maxFileSizeBytes: 10 * 1024 * 1024,
    })
  ).entries;
}

async function readContents(
  cwd: string,
  paths: PathHash[]
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const e of paths) {
    out.set(e.path, await fs.promises.readFile(path.join(cwd, e.path)));
  }
  return out;
}

function findChange(changes: { path: string; status: string }[], p: string) {
  return changes.find((c) => c.path === p);
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pt-reindex-"));
  const cwd = path.join(tmp, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const storeRoot = resolveStoreRoot(cwd, "workspace");

  const baseExclude = ["**/node_modules/**", "**/.git/**", "**/.prompt-trace/**"];

  // seed 3 files
  fs.writeFileSync(path.join(cwd, "app.ts"), "line1\n");
  fs.mkdirSync(path.join(cwd, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "vendor", "lib.ts"), "vendor line\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "hello\n");

  const db = await openStore(storeRoot);
  const repo = new Repository(db, storeRoot);

  // --- Baseline (vendor NOT excluded) ---
  let entries = await snap(cwd, baseExclude);
  const baselineContents = new Map<string, Buffer>();
  for (const e of entries) {
    baselineContents.set(e.path, fs.readFileSync(path.join(cwd, e.path)));
  }
  repo.seedBaseline(entries, baselineContents);
  assert(repo.getLastState().size === 3, "baseline has 3 files (incl vendor)");

  // --- Prompt A: modify app.ts ---
  repo.addPrompt({ id: "s1-1", title: "edit app", text: "x", timestamp: Date.now(), agent: "claude-code", sessionId: "s1", sequence: 0 });
  fs.writeFileSync(path.join(cwd, "app.ts"), "line1\nline2\n");
  entries = await snap(cwd, baseExclude);
  const d1 = await computeDiff(cwd, storeRoot, repo.getLastState(), entries);
  repo.attachChanges("s1-1", d1.changes, d1.nextSnapshot, d1.afterContents);
  const Ha1 = entries.find((e) => e.path === "app.ts")!.hash;
  assert(repo.getLastState().get("app.ts") === Ha1, "cursor has app.ts H_a1 after prompt A");

  // --- Manual edit to app.ts (H_a1 -> H_a2), no prompt ---
  fs.writeFileSync(path.join(cwd, "app.ts"), "line1\nline2\nline3\n");
  assert(repo.getLastState().get("app.ts") === Ha1, "manual edit does not move cursor (still H_a1)");

  // --- Scope reconcile: add vendor/** to excludes ---
  const vendorExclude = [...baseExclude, "**/vendor/**"];
  entries = await snap(cwd, vendorExclude); // vendor now excluded; app.ts on disk is H_a2
  const prev = repo.getLastState();
  const scopePlan = planScopeReconcile(prev, entries, cwd);
  assert(!scopePlan.newCursor.some((e) => e.path === "vendor/lib.ts"), "scope reconcile DROPS vendor (left scope)");
  const appInCursor = scopePlan.newCursor.find((e) => e.path === "app.ts");
  assert(appInCursor?.hash === Ha1, "scope reconcile KEEPS app.ts at H_a1 (manual edit preserved, NOT H_a2)");
  assert(scopePlan.needContent.length === 0, "no newly-in-scope files to add");
  const contents = await readContents(cwd, scopePlan.needContent);
  repo.reindex(scopePlan.newCursor, contents);
  assert(repo.getLastState().get("app.ts") === Ha1, "after scope reconcile, cursor app.ts still H_a1");
  assert(!repo.getLastState().has("vendor/lib.ts"), "after scope reconcile, vendor gone from cursor");

  // --- Prompt B: no edit. The manual edit (H_a1->H_a2) should be ATTRIBUTED to B. No vendor phantom. ---
  repo.addPrompt({ id: "s1-2", title: "tweak", text: "y", timestamp: Date.now(), agent: "claude-code", sessionId: "s1", sequence: 1 });
  entries = await snap(cwd, vendorExclude); // app.ts is H_a2, vendor excluded
  const d2 = await computeDiff(cwd, storeRoot, repo.getLastState(), entries);
  repo.attachChanges("s1-2", d2.changes, d2.nextSnapshot, d2.afterContents);
  const ch2 = repo.changesForPrompt("s1-2");
  assert(!!findChange(ch2, "app.ts") && findChange(ch2, "app.ts")!.status === "modified", "manual edit attributed to prompt B (modified)");
  assert(!findChange(ch2, "vendor/lib.ts"), "no phantom vendor deletion on prompt B");

  // --- Full reindex absorbs drift ---
  fs.writeFileSync(path.join(cwd, "app.ts"), "line1\nline2\nline3\nline4\n"); // manual H_a3
  entries = await snap(cwd, vendorExclude); // app.ts = H_a3
  const fullPlan = planFullReindex(repo.getLastState(), entries);
  assert(fullPlan.newCursor.find((e) => e.path === "app.ts")?.hash === entries.find((e) => e.path === "app.ts")!.hash, "full reindex sets cursor to current disk hash");
  const fc = await readContents(cwd, fullPlan.needContent);
  repo.reindex(fullPlan.newCursor, fc);

  // Prompt C: no edit. app.ts manual edit was absorbed -> C shows nothing.
  repo.addPrompt({ id: "s1-3", title: "noop", text: "z", timestamp: Date.now(), agent: "claude-code", sessionId: "s1", sequence: 2 });
  entries = await snap(cwd, vendorExclude);
  const d3 = await computeDiff(cwd, storeRoot, repo.getLastState(), entries);
  repo.attachChanges("s1-3", d3.changes, d3.nextSnapshot, d3.afterContents);
  assert(repo.changesForPrompt("s1-3").length === 0, "full reindex absorbed manual edit (prompt C shows no change)");

  // --- Scope reconcile preserves in-scope DELETIONS (kept for attribution) ---
  fs.unlinkSync(path.join(cwd, "README.md")); // delete an in-scope file
  entries = await snap(cwd, vendorExclude); // README gone
  const delPlan = planScopeReconcile(repo.getLastState(), entries, cwd);
  assert(!!delPlan.newCursor.find((e) => e.path === "README.md"), "scope reconcile KEEPS deleted README in cursor (preserve for attribution)");
  repo.reindex(delPlan.newCursor, await readContents(cwd, delPlan.needContent));
  assert(!!repo.getLastState().has("README.md"), "cursor still holds README after deletion reconcile");

  // Prompt D: no edit. README deletion should be attributed to D.
  repo.addPrompt({ id: "s1-4", title: "delcheck", text: "w", timestamp: Date.now(), agent: "claude-code", sessionId: "s1", sequence: 3 });
  entries = await snap(cwd, vendorExclude);
  const d4 = await computeDiff(cwd, storeRoot, repo.getLastState(), entries);
  repo.attachChanges("s1-4", d4.changes, d4.nextSnapshot, d4.afterContents);
  assert(!!findChange(repo.changesForPrompt("s1-4"), "README.md") && findChange(repo.changesForPrompt("s1-4"), "README.md")!.status === "deleted", "README deletion attributed to prompt D");

  // --- Scope reconcile ADDS newly-in-scope files (no phantom addition) ---
  // Remove vendor exclude -> vendor back in scope (still on disk, H_v0).
  entries = await snap(cwd, baseExclude); // vendor included again
  const addPlan = planScopeReconcile(repo.getLastState(), entries, cwd);
  assert(!!addPlan.newCursor.find((e) => e.path === "vendor/lib.ts"), "scope reconcile ADDS vendor back to cursor");
  assert(!!addPlan.needContent.find((e) => e.path === "vendor/lib.ts"), "vendor flagged for blob write (newly in scope)");
  repo.reindex(addPlan.newCursor, await readContents(cwd, addPlan.needContent));
  assert(!!repo.getLastState().has("vendor/lib.ts"), "vendor back in cursor");

  // Prompt E: no edit. Vendor must NOT show as a phantom addition.
  repo.addPrompt({ id: "s1-5", title: "vendorcheck", text: "v", timestamp: Date.now(), agent: "claude-code", sessionId: "s1", sequence: 4 });
  entries = await snap(cwd, baseExclude);
  const d5 = await computeDiff(cwd, storeRoot, repo.getLastState(), entries);
  repo.attachChanges("s1-5", d5.changes, d5.nextSnapshot, d5.afterContents);
  assert(!findChange(repo.changesForPrompt("s1-5"), "vendor/lib.ts"), "no phantom vendor addition on prompt E");

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nALL REINDEX TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
