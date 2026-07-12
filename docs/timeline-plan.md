# Prompt Timeline (milestone 7) — Implementation Plan

A second sidebar TreeView ("Timeline") in the PromptTrace container that shows every prompt that touched the **currently open file**, oldest-first. Clicking a prompt reuses the existing diff editor (`prompttrace.openDiff`).

Data already exists: `Repository.historyForFile(relPath)` returns `{ prompt, change }[]` oldest-first, each `change` carrying `before_hash` / `after_hash` / `patch` / `additions` / `deletions` / `status`.

## Files

### New: `src/views/timelineView.ts`
`TimelineTreeProvider implements vscode.TreeDataProvider<TimelineNode>`, mirroring `promptsView.ts`.

- Node = one prompt that touched the current file:
  - `label` = prompt title; `description` = `time · status · +N/-M`; `tooltip` (Markdown) = title + text snippet + patch.
  - `iconPath` = reuse `statusIcon` logic (diff-added/modified/removed).
  - `command` = `prompttrace.openDiff` with `{ path, beforeHash, afterHash, promptTitle }` — identical shape to the Prompts view's file nodes, so the existing diff editor opens with no new command.
  - `collapsibleState` = None (flat list, per the chosen design).
- `setFile(relPath: string | null)`: store the active file's relative path; if changed, fire `onDidChangeTreeData` to re-render.
- `getChildren()`: if no current file → `[]` (empty state shown via the view's `message`); else `repo.historyForFile(relPath)` oldest-first → nodes.
- Order: oldest-first (matches `historyForFile` and the chosen preview).

### New: `src/util/workspace.ts` (pure helper, unit-testable)
```ts
/** POSIX-normalized workspace-relative path, or null if `abs` is outside the workspace / not a file URI. */
export function toWorkspaceRel(workspacePath: string, uri: { scheme: string; fsPath: string }): string | null {
  if (uri.scheme !== "file") return null;
  const rel = path.relative(workspacePath, uri.fsPath);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}
```
Store paths are POSIX-normalized relative paths (see `snapshot.ts` `toPosix`), so the active file must be normalized identically to match `historyForFile`.

### `src/extension.ts`
After the Prompts TreeView (line ~60):
- Create `timelineProvider = new TimelineTreeProvider(repo)` + `createTreeView("prompttrace.timelineView", { treeDataProvider: timelineProvider })` (no `showCollapseAll` — flat). Keep a reference to the returned `TreeView` to set `description` / `message`.
- Initialize from the current active editor: `setFile(toWorkspaceRel(workspacePath, activeTextEditor.document.uri))` if present.
- `vscode.window.onDidChangeActiveTextEditor` → `timelineProvider.setFile(toWorkspaceRel(...))`.
- Extend the existing `dbWatcher.onDidChange` (line 66) to also `timelineProvider.refresh()` (a new prompt touching the open file surfaces).
- Extend the `prompttrace.refresh` command (line 74) to also `timelineProvider.refresh()`.
- Extend the `onDidSaveTextDocument` handler (line ~118) to also `timelineProvider.refresh()`.
- Description/message wiring: when the file changes, set `timelineView.description = "${relPath} · ${n} prompt(s)"` and `timelineView.message` for empty states ("Open a file in this workspace to see its prompt history" / "No prompts have touched this file").

### `package.json`
- `contributes.views.prompttrace`: add `{ "id": "prompttrace.timelineView", "name": "Timeline", "icon": "media/activitybar.svg" }` after the Prompts view.
- `contributes.menus.view/title`: add a `prompttrace.refresh` entry scoped to `view == prompttrace.timelineView` (group `navigation`) so the Timeline view gets a refresh button (reuses the existing command).

No new commands — click-to-diff reuses `prompttrace.openDiff`.

## Behavior & edge cases
- Active file outside the workspace, a non-`file:` URI (e.g. the `prompttrace:` diff docs), or untitled → empty state, no history.
- File never touched by a prompt → "No prompts have touched this file".
- File excluded from tracing → no history (unless it had history before exclusion); show whatever `historyForFile` returns.
- Switching tabs updates the view live; new `Stop` writes (via the db watcher) refresh it too.

## Test
- `historyForFile` is already exercised by `test-capture.ts` (asserts `a.txt` history → prompt 1). Data layer covered.
- New `scripts/test-workspace.ts` (or fold into an existing util test) for the pure `toWorkspaceRel` helper: in-workspace file → rel path; nested dir → `src/x.ts`; outside workspace → null; non-file URI → null; backslash normalization.
- The TreeView itself is VS Code glue — type-checked + built, not runtime-tested (same gap as the Prompts view; no extension-host harness exists yet). Noted, not blocked on.

## Verification
- `tsc --noEmit` clean; `npm run build` succeeds.
- `test-store` / `test-capture` / `test-installer` / `test-reindex` / new util test all pass.
- Manual smoke (Extension Development Host, F5): open a file with captured history → Timeline shows prompts oldest-first, description "app.ts · N prompts"; click a node → diff editor opens; switch tabs → view updates.

## Out of scope (future)
- Inline hunk rendering (would need the webview variant); the diff editor covers "see the hunk" for now.
- Prompt Blame (milestone 8) — separate, builds on the same `historyForFile` + blob contents.
