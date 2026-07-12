# Retention auto-prune (milestone 9 completion) — Implementation Plan

Wire the existing (dormant) retention settings into automatic pruning. Clear/compact commands are already done; this closes milestone 9.

**Semantics (confirmed):** keep a prompt if it's in the last `keepLastPrompts` most-recent **OR** newer than `keepLastDays` days. Delete only prompts that are **both** beyond the last N **and** older than N days.

Derivation: keep if `ts >= boundary OR ts >= daysCutoff` → delete if `ts < boundary AND ts < daysCutoff` = `ts < min(boundary, daysCutoff)`, where `boundary` = timestamp of the Nth-most-recent prompt. So `cutoff = min(boundary, daysCutoff)`, then reuse the existing `clearOlderThan(cutoff)` (which deletes `ts < cutoff` and reclaims orphaned blobs).

## Files

### `src/store/repository.ts`
New method (mirrors `clearOlderThan`'s return + reclaim):
```ts
/**
 * Apply retention: keep the last `keepLastPrompts` most-recent prompts and
 * anything newer than `keepLastDays` days; delete the rest. OR-semantics — a
 * prompt survives if EITHER threshold keeps it. `now` is injected for testing.
 * Returns the number of prompts deleted. No-op when retention is off (caller
 * gates on `retentionEnabled`) or when nothing exceeds either threshold.
 */
applyRetention(keepLastPrompts: number, keepLastDays: number, now: number): number {
  // Collect the applicable cutoffs; a threshold <= 0 means "not applicable".
  const cutoffs: number[] = [];
  if (keepLastPrompts > 0) {
    const row = this.db
      .prepare("SELECT timestamp AS t FROM prompts ORDER BY timestamp DESC LIMIT 1 OFFSET ?")
      .get(keepLastPrompts - 1) as { t: number } | undefined;
    if (row) cutoffs.push(row.t); // boundary = Nth-newest; <= N prompts → none beyond → no count-cutoff
  }
  if (keepLastDays > 0) cutoffs.push(now - keepLastDays * 86_400_000);
  if (cutoffs.length === 0) return 0;            // no threshold → keep everything
  const cutoff = Math.min(...cutoffs);
  return this.clearOlderThan(cutoff);
}
```
(With `LIMIT 1 OFFSET N-1`: if there are ≤ N prompts, the query returns no row → no count-cutoff, so only the days threshold applies. `>=` vs `<` at the boundary keeps the Nth-newest, satisfying "at least N".)

### `src/extension.ts`
- After `persistCaptureSettings(repo, settings)` (line ~50), before the views render:
  ```ts
  if (settings.retentionEnabled) {
    const n = repo.applyRetention(settings.retentionKeepLastPrompts, settings.retentionKeepLastDays, Date.now());
    if (n) log.info(`retention pruned ${n} prompt(s) on activation`);
  }
  ```
- In `onDidChangeConfiguration` (existing block), when `e.affectsConfiguration("prompttrace.retention")`: with fresh settings, if `retentionEnabled` run `applyRetention(...)` before the existing `treeProvider.refresh()` / `timelineProvider.refresh()` so the pruned state renders. (Cheap, expected when the user enables/tightens retention.)

### `package.json`
No change — retention settings + `retention.enabled` already declared (lines 185–199). `retention.enabled` default `false` → opt-in, matches "off by default" in the design.

### New: `scripts/test-retention.ts`
Drive `applyRetention` against bare prompts (no file_changes needed) with controlled timestamps + injected `now`. Cases (keepLastPrompts=100, keepLastDays=90):
- 120d old, rank #50 → KEEP (in last 100).
- 10d old, rank #500 → KEEP (within 90d).
- 120d old, rank #500 → DELETE (beyond last 100 AND older than 90d).
- Edge: ≤ keepLastPrompts prompts → none deleted (count threshold alone).
- Edge: keepLastDays=0 → pure count retention (days threshold not applicable).
- Edge: keepLastPrompts=0 → pure days retention.
- Edge: retention off (caller doesn't call) → untouched (the method is only invoked when enabled; also test both thresholds <= 0 → 0 deleted).
Assert survivors by id.

## Verification
- `tsc --noEmit` clean; `npm run build` succeeds.
- `test-store` / `test-capture` / `test-installer` / `test-reindex` / `test-workspace` / `test-blame` / `test-retention` all pass.

## Out of scope
- A "retention ran, deleted N" user-facing toast on activation (could be noisy on every startup); log-only for v1. Easy to add later.
- Scheduling periodic pruning mid-session (only on activation + config change today; the db watcher could trigger it too, but that risks pruning on every captured prompt — not v1).
