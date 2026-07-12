/**
 * Regression test for the "all files as additions" bug.
 *
 * Real Claude Code flow: UserPromptSubmit fires (creates a prompt row) BEFORE
 * the first Stop (which seeds the baseline). The old guard
 *   `hadBaseline = prev.size > 0 || repo.countPrompts() > 0`
 * treated the pending prompt as a baseline, so the first Stop diffed the full
 * snapshot against an EMPTY cursor and marked every file as `added` — blaming
 * the first prompt for adding the entire repo.
 *
 * This test drives that exact sequence against a fresh store and asserts the
 * first prompt gets NO changes (the baseline is established "during" it), and
 * the NEXT prompt that adds a single file shows exactly that one addition.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveStoreRoot } from "../src/store/resolve";
import { openStore } from "../src/store/db";
import { Repository } from "../src/store/repository";
import { snapshotWorkspace } from "../src/capture/snapshot";
import { computeDiff } from "../src/capture/differ";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log("  ok:", msg);
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pt-first-"));
  const cwd = path.join(tmp, "project");
  fs.mkdirSync(cwd, { recursive: true });
  const storeRoot = resolveStoreRoot(cwd, "workspace");

  // A repo with several pre-existing files (the "whole repo" the bug blamed).
  fs.writeFileSync(path.join(cwd, "a.txt"), "line1\n");
  fs.writeFileSync(path.join(cwd, "b.txt"), "hello\n");
  fs.writeFileSync(path.join(cwd, "c.txt"), "third\n");

  const db = await openStore(storeRoot);
  const repo = new Repository(db, storeRoot);
  const exclude = ["**/node_modules/**", "**/.git/**", "**/.prompt-trace/**"];
  const maxBytes = 10 * 1024 * 1024;

  const snap = () =>
    snapshotWorkspace({ workspacePath: cwd, excludePatterns: exclude, maxFileSizeBytes: maxBytes })
      .then((r) => r.entries);

  /** Mirrors cli.ts handleStop: seed baseline if no cursor, else diff + attach. */
  const stopFor = async (sessionId: string) => {
    const entries = await snap();
    const prev = repo.getLastState();
    if (prev.size === 0) {
      const baseline = new Map<string, Buffer>();
      for (const e of entries) {
        try {
          baseline.set(e.path, fs.readFileSync(path.join(cwd, e.path)));
        } catch {
          /* skip */
        }
      }
      repo.seedBaseline(entries, baseline);
      return;
    }
    const pending = repo.latestUnattachedPrompt(sessionId);
    const d = await computeDiff(cwd, storeRoot, prev, entries);
    if (pending) repo.attachChanges(pending.id, d.changes, d.nextSnapshot, d.afterContents);
  };

  const sid = "sess-1";

  // --- Real flow: UserPromptSubmit for the FIRST prompt, then its Stop ---
  repo.addPrompt({ id: `${sid}-0`, title: "first prompt", text: "hi", timestamp: 1, agent: "claude-code", sessionId: sid, sequence: 0 });
  assert(repo.countPrompts() === 1, "prompt row exists before first Stop");
  assert(repo.getLastState().size === 0, "no baseline before first Stop");
  await stopFor(sid);
  // THE BUG: first prompt would have had 3 "added" changes. Fix: 0 (baseline seeded).
  const ch0 = repo.changesForPrompt(`${sid}-0`);
  assert(ch0.length === 0, "first prompt has NO changes (baseline established during it)");
  assert(repo.getLastState().size === 3, "baseline now has all 3 files");

  // --- Second prompt: add exactly one file ---
  repo.addPrompt({ id: `${sid}-1`, title: "add hello.html", text: "add file", timestamp: 2, agent: "claude-code", sessionId: sid, sequence: 1 });
  fs.writeFileSync(path.join(cwd, "hello.html"), "<html></html>\n");
  await stopFor(sid);
  const ch1 = repo.changesForPrompt(`${sid}-1`);
  assert(ch1.length === 1, "second prompt has exactly 1 change");
  assert(ch1[0].path === "hello.html", "the one change is hello.html");
  assert(ch1[0].status === "added", "hello.html is added (not the whole repo)");

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nALL FIRST-PROMPT TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
