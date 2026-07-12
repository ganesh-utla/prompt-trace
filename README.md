# PromptTrace

Trace code changes back to the prompt that produced them. **GitLens, but for prompts.**

Currently focused on changes made by **Claude Code**, captured automatically via its hooks.

## Features

- **Diff per Prompt** — see the exact file diff for each prompt, with the prompt title. Prompts view (sidebar) → expand → changed files → click → VS Code diff editor.
- **Prompt Timeline** — for the open file, the list of prompts that touched it, chronological, each with status and +/- totals. A second sidebar view that updates as you switch tabs.
- **Prompt Blame** — `git blame`-style attribution: the prompt that introduced each line, shown as colored gutter dots + hover. Toggle on/off per editor.
- **Reindex / Re-baseline** — reconcile the capture cursor after editing exclude rules (automatic, scope-only) or to absorb out-of-band changes like a branch switch (manual command).
- **Clear & manage storage** — Clear All / Clear Older Than / Clear Current Session / Compact, plus optional retention (keep last N prompts and/or last N days, pruned on activation).

## Setup

1. Install the extension (or load it in dev via `F5`).
2. Open your project folder.
3. Approve the one-time hook install (writes the `hooks` block into `.claude/settings.local.json` — machine-local, since the hook command contains an absolute path to this machine's `dist/cli.js`).
4. Use Claude Code normally — a baseline snapshot is taken, then each prompt's diff is captured on `Stop`.
5. Open the **PromptTrace** view in the activity bar (Prompts + Timeline).

Storage lives in `.prompt-trace/` (gitignored). See `docs/claude-hooks-plan.md` for the design and `PLAN.md` for the implementation plan.

## Managing Storage

Four commands on the Prompts view's title menu, ordered least → most destructive:

### Compact Storage
Non-destructive — deletes **no tracing data**. It reclaims disk space two ways: garbage-collects blob files no longer referenced by any prompt diff or the snapshot cursor, then `VACUUM`s the SQLite database file. Safe to run anytime.

### Clear Current Session
Deletes every prompt captured during the **most recent agent session** — the `session_id` of the latest captured prompt (not the VS Code session). Its file-change diffs cascade-delete; orphaned blobs are reclaimed. Keeps all prior sessions' history intact.

### Clear Older Than…
Prompts to pick 7 / 30 / 90 days, then deletes every prompt older than that cutoff. File-change diffs cascade-delete; blobs reclaimed. This is a manual, one-shot age cutoff — distinct from the automatic **Retention** setting, which prunes on activation using OR-semantics (keep if in the last N prompts *or* within N days).

### Clear All Tracing
Wipes everything: all prompts, all file-change history, **and the snapshot cursor** (the baseline the next prompt diffs against). Modal confirmation required. The next `Stop` hook re-seeds a fresh baseline, so tracing resumes — but all past history is gone.

### At a glance

| Command | Deletes prompts | Deletes file_changes | Deletes cursor | Reclaims blobs | VACUUM |
|---------|:-:|:-:|:-:|:-:|:-:|
| Compact Storage | ❌ | ❌ | ❌ | ✅ | ✅ |
| Clear Current Session | one session | (cascade) | ❌ | ✅ | ❌ |
| Clear Older Than… | by age | (cascade) | ❌ | ✅ | ❌ |
| Clear All Tracing | all | all | ✅ | ✅ | ❌ |

The three **Clear** commands remove history (prompts + their diffs); **Compact** leaves history intact and only frees disk space. Blob garbage-collection runs automatically after every Clear.

## Status

All nine planned milestones are implemented (scaffold, storage, capture, hook installer, diff-per-prompt, exclude+reindex, timeline, blame, clear+retention). The capture/storage/reconcile/blame/retention logic is covered by test scripts under `scripts/` (`npx tsx scripts/test-*.ts`). The VS Code-facing glue (views, commands, decorations, config hooks) is type-checked and builds but is not yet covered by an extension-host test harness. Storage uses `sql.js` (WASM) rather than a native SQLite binding so it runs in the extension host regardless of Electron/Node version.
