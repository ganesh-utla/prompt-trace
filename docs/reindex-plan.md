# Reindex — Implementation Plan

Two operations that reconcile the `last_state` cursor (the moving baseline each prompt's diff is measured against). Both touch **only** `last_state` + blobs — `prompts` and `file_changes` are never edited, so past diffs are immutable.

## Operation 1 — `reconcileScope` (automatic, narrow)

Reconciles cursor **membership** only; leaves in-scope hashes untouched so manual edits stay attributed to the next prompt.

**Trigger:** `excludePatterns` or `maxFileSizeKB` changes, inside the existing `onDidChangeConfiguration` handler (`src/extension.ts:114`).

**Algorithm** (the stat check distinguishes "scope rule removed it" from "deleted from disk"):

```
prev = repo.getLastState()
next = snapshotWorkspace(...)              // under NEW rules
snapMap = Map(next)
newCursor = []
added = []                                  // paths needing a blob written

for path, hash in prev:
  if path in snapMap:        newCursor += {path, hash}        // in scope both → KEEP old hash (preserve drift)
  else if existsOnDisk(path): /* drop */                      // scope rule removed it (pattern or size)
  else:                      newCursor += {path, hash}        // real on-disk deletion → KEEP for attribution

for path, hash in snapMap:
  if path not in prev:       { newCursor += {path, hash};  added += {path, hash} }  // newly in scope

// read + write blobs for `added` only; set cursor
repo.reindex(newCursor, contentsOf(added))
```

Info message: `Reindexed: N files re-scoped under new rules (M added, D dropped).`

## Operation 2 — `reindex` (manual command, full)

Absorbs **all** drift (manual edits, branch switch, downtime, desync) into the baseline.

**Trigger:** user runs `prompttrace.reindex`.

```
prev = repo.reload(); repo.getLastState()   // pick up any CLI writes first
next = snapshotWorkspace(...)               // current rules
changed = [ e in next where prev.get(e.path) !== e.hash ]   // new + modified; blobs already exist for unchanged
repo.reindex(next, contentsOf(changed))
```

Info message: `Reindexed: cursor re-baselined; N files had uncaptured changes that will no longer be attributed to the next prompt.`

No modal confirm — reindex deletes nothing (past prompts are kept); the info message is the transparency mechanism.

## Files

### New: `src/capture/reconcile.ts`
Pure scope/planning logic (fs.stat for disk-existence; no vscode dep, so usable from the extension host and tests).
- `planScopeReconcile(prev: Map<string, string|null>, next: PathHash[], workspacePath: string): { newCursor: PathHash[]; added: PathHash[] }`
- `planFullReindex(prev: Map<string, string|null>, next: PathHash[]): { newCursor: PathHash[]; changed: PathHash[] }`
Both return the new cursor entries + the set of paths whose content must be read (added / changed).

### `src/store/repository.ts`
Add one method, mirroring `seedBaseline` (`repository.ts:208`):
```ts
/** Replace the cursor with `newCursor`, writing blobs for `contents`. Used by Reindex (scope + full). */
reindex(newCursor: PathHash[], contents: Map<string, Buffer>): void {
  const tx = this.db.transaction(() => {
    for (const [, buf] of contents) writeBlob(this.storeRoot, buf);
    this.setLastState(newCursor);
  });
  tx();
  log.info(`reindex: cursor set to ${newCursor.length} paths (${contents.size} blob(s) written)`);
}
```
(`seedBaseline` stays — it reads/writes *every* file for first-run; `reindex` writes only the plan's subset.)

### `src/extension.ts`
- Import `snapshotWorkspace` (no vscode dep — safe) + the two reconcile planners + `fs`.
- Add `prompttrace.reindex` command → `runFullReindex(workspacePath, storeRoot, repo)`.
- In `onDidChangeConfiguration`: keep the existing `persistCaptureSettings` + `refresh`, but when `e.affectsConfiguration("prompttrace.excludePatterns")` || `e.affectsConfiguration("prompttrace.maxFileSizeKB")`, also call `runScopeReconcile(...)` (fire-and-forget async, logged on error). Snapshot uses fresh `readSettings()`.
- A small helper reads the added/changed files' content (`fs.promises.readFile`) into a `Map<path, Buffer>` for `repo.reindex`.

### `package.json`
- Add command `prompttrace.reindex` ("PromptTrace: Reindex / Re-baseline").
- Add `views/title` menu entry in group `9_management` (after `compact`), `when view == prompttrace.promptsView`.

### New: `scripts/test-reindex.ts`
Mirrors `test-capture.ts` (tsx-runnable, temp workspace). Proves both operations:
1. baseline → Prompt A modifies `app.ts` (H_a0→H_a1) → cursor has `app.ts:H_a1`.
2. Manually edit `app.ts` to H_a2 (cursor still H_a1).
3. Add `**/vendor/**` to excludes → `planScopeReconcile` → assert cursor still `app.ts:H_a1` (manual edit **not** absorbed) and `vendor/lib.ts` dropped.
4. Simulate next Stop: snapshot now has `app.ts:H_a2` (excludes vendor) → `computeDiff(prev, next)` asserts `app.ts` shows as **modified** (attributed to next prompt) — manual edit preserved.
5. Full path: `planFullReindex` → cursor becomes `app.ts:H_a2` → next Stop shows **no** `app.ts` change — absorbed.
6. Deletion-preservation: delete an in-scope file → `planScopeReconcile` keeps it in cursor with old hash (next Stop attributes the deletion).

## Triggers summary
- **Auto:** `excludePatterns` / `maxFileSizeKB` change → `reconcileScope` (scope-only).
- **Manual:** `prompttrace.reindex` command → full re-baseline (manual edits, branch switch, downtime, desync).
- **Never:** a normal `Stop` (that's the normal diff+advance); `.gitignore` edits (not in scope today); `refresh` (UI-only).

## Guarantees & caveats
- Neither operation edits `prompts`/`file_changes` — history is immutable.
- Manual edits between prompts: default → attributed to next prompt (v1, `PLAN.md:57`); after auto `reconcileScope` → still attributed; after manual `Reindex` → absorbed. The choice stays with the user.
- Reindex reloads from disk first (`repo.reload()`) to avoid overwriting a concurrent CLI write — but a `Stop` firing *during* reindex is still a best-effort race (pre-existing sql.js whole-file-persist limitation, same as `clearAll`); accepted for v1.
- `.gitignore` not wired into scope; if it is later, its edits join the auto-`reconcileScope` triggers via a file watcher — same mechanism, no design change.

## Verification
- `npx tsc -p ./ --noEmit` clean.
- `npm run build` succeeds.
- `npx tsx scripts/test-reindex.ts` → ALL REINDEX TESTS PASSED.
- Existing `test-store` / `test-capture` / `test-installer` still pass.
