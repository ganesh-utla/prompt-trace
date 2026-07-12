# PromptTrace — Claude Code Hooks Solution Plan

## Problem to Solve

Git shows staged/unstaged changes but can't attribute changes to the specific prompt that produced them. When a coding agent edits across many prompts, the "which prompt caused which hunk" mapping is lost. Goal: capture, per prompt, the exact file diff the agent made — reliably and automatically.

Scope of this plan: changes made by **Claude Code**, captured via its hooks system.

## Approach in Detail

### Why hooks
Claude Code fires lifecycle hooks at known points in a prompt cycle, giving exact boundaries — no timestamp guessing or idle heuristics:
- `UserPromptSubmit` — prompt text + timestamp = prompt **start**.
- `Stop` — agent turn ended, all edits on disk = prompt **end**.
- `PostToolUse` — after each Edit/Write (optional, finer granularity).

### Capture flow
1. **`UserPromptSubmit`** → record prompt text + timestamp as a new prompt event.
2. **`Stop`** → snapshot the working tree (hash + content of every tracked file). Diff against the previous prompt's `Stop` snapshot (or the baseline). That diff = this prompt's changes.
3. Store prompt metadata + per-changed-file before/after hashes + a unified patch. Unchanged files cost nothing (hash only; content deduped by hash).

### Baseline
On activation (or first `UserPromptSubmit` with no prior snapshot), take a baseline snapshot of the workspace. First prompt's diff is measured against it.

### Attribution model
One prompt → one **net diff** (change between its `Stop` and the previous `Stop`). Matches "diff per prompt". If the agent edits a file twice in one prompt, intermediate states collapse — acceptable for v1; `PostToolUse` can preserve them later.

### Storage (`.prompt-trace/` in workspace root)
- `db.sqlite` — `prompts(id, title, text, timestamp, agent)`, `file_changes(id, prompt_id, path, before_hash, after_hash, patch, additions, deletions)`.
- `blobs/<sha256>` — raw file contents, content-addressed for dedup. Only changed files get new blobs.
- **Location:** Phase 1 = `.prompt-trace/` in the workspace root (simplest for the cwd-relative capture CLI). Resolved through one `resolveStoreRoot()` function + a `storageLocation` setting (`workspace` | `global`, default `workspace`), so the phase-2 move to a home-dir store is a localized change, not a rewrite (see Open Questions).

### Hook installation
Extension writes/updates the `hooks` block in project `.claude/settings.json` on activation, so the user doesn't configure by hand. Hooks invoke a small bundled CLI entry that appends events to the store — decoupling capture from the IDE keeps it reliable even when VS Code isn't focused.

## Functionalities to Provide

1. **Diff per Prompt** — Sidebar TreeView: prompts newest-first (title, timestamp, agent, `+/-` totals); expand → changed files with per-file `+/-`; click → VS Code diff editor over before/after snapshots.
2. **Prompt Timeline (per file)** — For the open file, chronological list of every prompt that touched it, each with hunk + one-line diff summary.
3. **Prompt Blame** — Line-level attribution: walk the file's prompt history backwards (Myers diff between consecutive snapshots), blame each surviving line to the most recent prompt that introduced it. Render as gutter decorations colored per prompt + hover tooltip with prompt title.
4. **Exclude patterns** — Settings-driven ignore list (lockfiles, build output, `*.min.js`) so noise never enters the store.
5. **Refresh / reindex** — Command to re-snapshot and rebuild the index (e.g., after editing exclude rules).
6. **Clear & manage storage** — Commands to clear all / clear older-than / clear current session, plus an optional retention setting and a compact/GC action.

## End User Setup

1. **Install** the extension from the VS Code Marketplace (or a `.vsix`).
2. **Open** the project folder in VS Code — the extension is per-workspace; storage lives in `.prompt-trace/`.
3. **Authorize hook install** — on first activation the extension asks to write the `hooks` block into the project's `.claude/settings.json`. Approve once; future updates are automatic. (User-global install available as a setting.)
4. **(Optional) Configure** exclude patterns and capture preferences under VS Code Settings → PromptTrace.
5. **Use Claude Code normally** — a baseline snapshot is taken automatically, then each prompt's diff is captured on `Stop`. No per-prompt manual steps.
6. **Open the PromptTrace view** from the activity bar to browse Diff-per-Prompt, Timeline, and Blame.

## Storage Lifecycle & Clearing

- **Gitignore:** `.prompt-trace/` is local history (db + blobs), not source. Extension offers to add it to `.gitignore` on first run. (Sharing history across a team is a possible opt-in later, not v1.)
- **Default: never auto-clear.** The history is the point — full provenance is preserved until the user acts. (Optional retention setting, off by default.)
- **Manual clear commands** (command palette + view title bar; destructive → confirm dialog):
  - **Clear All** — wipe db + blobs and re-baseline (fresh start).
  - **Clear Older Than…** — prune prompts before a chosen date / older than N days or N prompts.
  - **Clear Current Session** — remove just the active Claude Code session.
- **Retention setting (optional, off by default):** "keep last N prompts" or "keep last N days"; prunes on activation.
- **Compact / GC:** remove orphaned blobs (unreferenced after pruning) and `VACUUM` the SQLite db; also a manual command. Bounds size without losing retained history.
- **Size note:** blobs are content-addressed + deduped, so growth tracks *unique* content, not prompt count; still can grow on long-lived projects — retention + compact cover that.

## Tech Stack

- **Language:** TypeScript
- **Platform:** VS Code Extension API — TreeView, `vscode.diff`, `TextDocumentContentProvider`, `DecorationOptions` + `setDecorations`, hover, webview (timeline), commands.
- **Storage:** `better-sqlite3` (bundled) for the index; content-addressed blob files on disk.
- **Diff:** `diff` (Myers) for line-level blame; VS Code's built-in diff editor for viewing.
- **Capture bridge:** bundled CLI entry invoked by Claude Code hooks, writing to SQLite.
- **Build/package:** `esbuild` for bundling, `vsce` for packaging.

## Open Questions / Decisions

- **Net diff vs. per-tool diff:** v1 = net diff per prompt (simpler). Per-tool replay deferred to v2 via `PostToolUse`.
- **Hook config location:** project `.claude/settings.json` (travels with repo, opt-in setting) vs. user-global. Lean project-level.
- **Large/binary files:** skip content snapshot above a size threshold or for binary patterns; store metadata only.
- **Storage location:** Phase 1 keeps `.prompt-trace/` in the workspace root; phase 2 moves to `~/.prompt-trace/<hash-of-workspace-path>/` (the same path-hash keying Claude Code uses for its transcripts) to keep the project folder clean and survive renames. Home-dir (not VS Code's `globalStorageUri`) because the hook-launched capture CLI runs outside the IDE and must reach the store independently. A `storageLocation` setting + single path-resolver land in phase 1; phase 2 adds global mode + a one-time migration.

## Next Step

Scaffold the extension: project structure, hook script + install logic, SQLite schema + capture CLI, then the Diff-per-Prompt TreeView + diff editor as the first visible feature.
