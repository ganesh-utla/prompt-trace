# PromptTrace

Trace code changes back to the prompt that produced them. **GitLens, but for prompts.**

PromptTrace captures every change a coding-agent prompt makes to your files and ties it back to that prompt — so you can answer "which prompt touched this file, and what exactly did it change?" Currently focused on **Claude Code**, captured automatically via its hooks.

- **Diff per Prompt** — the exact file diff for each prompt, with the prompt title. Prompts view (sidebar) → expand a prompt → expand a changed file → click → VS Code diff editor (before/after snapshots).
- **Prompt Timeline** — for the open file, the chronological list of prompts that touched it, each with status and +/- totals. A second sidebar view that updates as you switch tabs.
- **Prompt Blame** — `git blame`-style attribution: the prompt that introduced each line, shown as colored gutter dots + hover. Toggle on/off per editor.
- **Reindex / Re-baseline** — reconcile the capture cursor after editing exclude rules (automatic, scope-only) or to absorb out-of-band changes like a branch switch (manual command).
- **Clear & manage storage** — Clear All / Clear Older Than / Clear Current Session / Compact, plus optional retention (keep last N prompts and/or last N days, pruned on activation).

## Requirements

- VS Code **1.80+**
- Node **18+** (for building from source)
- **Claude Code** installed and used in the workspace (it provides the hooks that drive capture)

## Quick start

1. **Install the extension** (or load it in dev via `F5`).
2. **Open your project folder.** PromptTrace activates on startup.
3. **Approve the one-time hook install.** It writes a `hooks` block into `.claude/settings.local.json` — machine-local, since the hook command contains an absolute path to this machine's `dist/cli.js`, so it must not be committed. (Toggle with the `prompttrace.autoInstallHooks` setting.)
4. **PromptTrace auto-reindexes on first install.** Right after the hooks are written, it seeds the capture baseline from your current workspace state and shows `baseline established from N file(s) — ready to trace your next prompt`. No manual step needed on a fresh install. See [Why auto-reindex on install?](#why-auto-reindex-on-install) below.
5. **Use Claude Code normally.** Each prompt's diff is captured automatically when the session `Stop` hook fires.
6. **Open the PromptTrace view** in the activity bar (Prompts + Timeline).

Storage lives in `.prompt-trace/` (auto-added to `.gitignore`).

### Why auto-reindex on install?

The capture baseline is the state each prompt's diff is measured against. On the very first `Stop` after install there is no baseline yet, so that first prompt would otherwise be **consumed to seed it** — its own changes wouldn't be recorded. To avoid wasting your first prompt, PromptTrace seeds the baseline from the current workspace state *immediately after the hooks are installed*, so the next prompt you run is attributed to that prompt. It also absorbs any pre-existing on-disk changes (prior manual edits, branch state) into the baseline instead of letting them leak into the first captured diff.

Auto-reindex only fires on a **fresh install** (no prior baseline). If you reinstall or update the hooks on a workspace that's already being traced, the existing baseline is left untouched — re-baselining in that case stays an explicit manual `PromptTrace: Reindex / Re-baseline` (e.g. after a branch switch or downtime), so in-flight changes aren't silently absorbed.

## How it works

```
Claude Code session ──Stop hook──▶  dist/cli.js  ──▶  .prompt-trace/ (SQLite + blobs)
                       (per prompt)   snapshot + diff      ▲
                                                          │ reload (file watcher)
                       PromptTrace extension ◀────────────┘
                       (Prompts / Timeline / Blame views)
```

- The **hook** (`Stop` and `UserPromptSubmit`) shells out to a small CLI (`dist/cli.js`) that snapshots the workspace (respecting excludes), diffs it against the stored baseline, writes the prompt + per-file changes to SQLite, and advances the baseline.
- The **extension** watches the DB file, reloads, and re-renders the Prompts/Timeline trees and re-applies blame. Views never write to the store — only the CLI does.
- Storage uses `sql.js` (WASM) rather than a native SQLite binding, so it runs in the extension host regardless of Electron/Node version. File contents are stored as content-addressed blobs (sha256).

## Commands

All commands appear in the Command Palette under `PromptTrace:`. The Prompts view's title menu also surfaces the management + reindex actions.

| Command | What it does |
|---|---|
| `PromptTrace: Refresh` | Reload the store from disk and refresh the Prompts + Timeline views. |
| `PromptTrace: Open Diff` | Open the VS Code diff editor for a changed file under a prompt (prompts view → click a file change). |
| `PromptTrace: Install Claude Code Hooks` | Write/update the hooks block in `.claude/settings.local.json`. On a fresh install (no prior baseline), also seeds the capture baseline automatically. Shown when hooks aren't installed. |
| `PromptTrace: Toggle Prompt Blame` | Turn prompt blame on/off for the active editor (gutter dots + hover). Editor title action. |
| `PromptTrace: Reindex / Re-baseline` | Full re-baseline: absorb all on-disk drift (manual edits, branch switch, downtime) into the cursor. History is untouched. |
| `PromptTrace: Compact Storage` | Non-destructive: garbage-collect orphaned blobs + `VACUUM` the SQLite file. |
| `PromptTrace: Clear Current Session` | Delete prompts from the most recent captured session. |
| `PromptTrace: Clear Older Than…` | Delete prompts older than a 7/30/90-day cutoff. |
| `PromptTrace: Clear All Tracing` | Wipe everything, including the baseline cursor (modal confirmation). |

## Settings

Configure under VS Code Settings → Extensions → PromptTrace (or `settings.json`).

| Setting | Default | Description |
|---|---|---|
| `prompttrace.excludePatterns` | `node_modules`, `.git`, `dist`, `build`, `*.min.js`, `*.map`, lockfiles | Glob patterns excluded from tracing (never snapshotted). Changing this triggers an automatic **scope reconcile**. |
| `prompttrace.maxFileSizeKB` | `1024` | Skip content snapshot for files larger than this (metadata only). Changing this also triggers a scope reconcile. |
| `prompttrace.storageLocation` | `workspace` | Where tracing lives: `workspace` (`<workspace>/.prompt-trace/`) or `global` (`~/.prompt-trace/<hash>/` keyed by workspace path). |
| `prompttrace.autoInstallHooks` | `true` | Prompt to install Claude Code hooks on first activation. |
| `prompttrace.retention.enabled` | `false` | Automatically prune old prompts on activation. |
| `prompttrace.retention.keepLastPrompts` | `1000` | When retention is on, keep at least this many most-recent prompts. |
| `prompttrace.retention.keepLastDays` | `90` | When retention is on, also keep prompts newer than this many days. |

Retention uses **OR-semantics**: a prompt is kept if it's within the last N prompts *or* within N days.

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

## Development

```bash
npm install          # dependencies
npm run build        # production bundle → dist/ (esbuild)
npm run watch        # rebuild on change
npm run compile      # tsc type-check (no emit)
npm run package      # build a .vsix via vsce
```

Load it in a dev host with `F5` (Launch Extension). The capture/storage/reconcile/blame/retention logic is covered by runnable test scripts under `scripts/`:

```bash
npx tsx scripts/test-store.ts
npx tsx scripts/test-capture.ts
npx tsx scripts/test-reindex.ts
npx tsx scripts/test-blame.ts
npx tsx scripts/test-retention.ts
npx tsx scripts/test-installer.ts
```

## Status

All nine planned milestones are implemented (scaffold, storage, capture, hook installer, diff-per-prompt, exclude+reindex, timeline, blame, clear+retention). The capture/storage/reconcile/blame/retention logic is covered by the test scripts above. The VS Code-facing glue (views, commands, decorations, config hooks) is type-checked and builds but is not yet covered by an extension-host test harness.

## License

MIT. See `docs/claude-hooks-plan.md` for the capture design, `docs/reindex-plan.md` for reindex, and `PLAN.md` for the implementation plan.
