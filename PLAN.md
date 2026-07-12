# PromptTrace — Implementation Plan

Implement the phase-1 VS Code extension per `docs/claude-hooks-plan.md`.
**First runnable milestone: Diff per Prompt** (engine + first visible feature). Timeline and Blame follow in the same pass.

## Project Scaffold
- `package.json` — manifest: activation `onStartupFinished`, commands, viewsContainers + views (PromptTrace sidebar), settings (`excludePatterns`, `storageLocation`, `retention`), `main` → `dist/extension.js`, engine `node`, deps (`better-sqlite3`, `diff`), devDeps (`typescript`, `esbuild`, `@types/vscode`, `@types/node`), scripts (`build`, `watch`, `package`).
- `tsconfig.json` — `module: commonjs`, `target: ES2020`, `strict`, `outDir: dist`.
- `esbuild.config.mjs` — two entries: `src/extension.ts` → `dist/extension.js` (external: `vscode`) and `src/capture/cli.ts` → `dist/cli.js`.
- `.vscodeignore`, `.gitignore` (`dist/`, `node_modules/`, `*.vsix`, `.prompt-trace/`), `README.md`.

## Source Structure
```
src/
  extension.ts             # activate(): register views/commands, ensure hook install, init storage
  settings.ts              # read config: excludePatterns, storageLocation, retention
  store/
    resolve.ts             # resolveStoreRoot(wsPath, setting) -> path (workspace; global stubbed)
    db.ts                  # open/migrate SQLite, schema (prompts, file_changes), prepared stmts
    blobs.ts               # content-addressed blob read/write (sha256)
    repository.ts          # queries: addPrompt, addFileChanges, listPrompts, fileHistory...
  capture/
    cli.ts                 # hook entry: reads hook payload, snapshots, diffs, writes store
    snapshot.ts            # walk workspace (respecting excludes), hash files -> snapshot map
    differ.ts              # diff two snapshots -> per-file before/after hashes + unified patch
  hooks/
    installer.ts           # write/update hooks block in .claude/settings.json
    hookConfig.ts          # hook command template (Stop, UserPromptSubmit)
  views/
    promptsView.ts         # TreeDataProvider: prompts -> changed files; labels w/ +/- and title
    diffContentProvider.ts # TextDocumentContentProvider: serves before/after snapshots to vscode.diff
    timeline.ts            # (step 7) per-file prompt timeline
  blame/
    blame.ts               # (step 8) iterative Myers blame over a file's prompt history
    decorations.ts         # (step 8) gutter decorations + hover
  util/
    gitignore.ts hash.ts paths.ts log.ts
```

## Build Order (milestones)
All nine are implemented. See `docs/{reindex,timeline,blame,retention}-plan.md` for the detailed designs of 6–9.

1. ✅ **Scaffold** — package.json, tsconfig, esbuild, gitignore. Extension activates and shows an empty PromptTrace view.
2. ✅ **Storage layer** — `resolve.ts`, `db.ts` schema, `blobs.ts`. Verified: write/read a blob, insert a prompt + file_change (`scripts/test-store.ts`).
3. ✅ **Capture engine** — `snapshot.ts` + `differ.ts` + `cli.ts`. Verified end-to-end: baseline → add/modify/delete → history (`scripts/test-capture.ts`).
4. ✅ **Hook installer** — `installer.ts` writes `.claude/settings.local.json` hooks pointing at `dist/cli.js`; auto-adds `.gitignore` entry. Activation offers to install. Verified (`scripts/test-installer.ts`).
5. ✅ **Diff per Prompt (milestone)** — `promptsView.ts` TreeView (prompts → files, +/- labels) + `diffContentProvider.ts` + `vscode.diff` on click. **First visible milestone.**
6. ✅ **Exclude patterns + Refresh/reindex** — exclude patterns wired into snapshot; `refresh` reloads the tree. **Reindex** is a two-operation design (see `docs/reindex-plan.md`): automatic scope-only `reconcileScope` on `excludePatterns`/`maxFileSizeKB` change (preserves manual-edit drift), plus a manual `prompttrace.reindex` command for full re-baseline (absorbs branch switches / downtime drift). Verified (`scripts/test-reindex.ts`).
7. ✅ **Prompt Timeline** — `timelineView.ts`: a second sidebar TreeView of prompts that touched the open file (oldest-first), updates as the active editor changes, click reuses the diff editor. Verified via `toWorkspaceRel` (`scripts/test-workspace.ts`).
8. ✅ **Prompt Blame** — `blame/blame.ts` (forward-propagation over the diff chain) + `blame/decorations.ts` (palette-capped colored gutter dots + hover). `prompttrace.toggleBlame` command. Verified (`scripts/test-blame.ts`).
9. ✅ **Clear & manage storage** — Clear All / Clear Older Than / Clear Current Session / Compact (all wired) + **retention auto-prune** (`applyRetention`, OR-semantics: keep if in last N or within N days) on activation + retention config change. Verified (`scripts/test-retention.ts`).

## Implementation Notes / Decisions
- **Capture CLI** is a separate esbuild entry (`dist/cli.js`), invoked by hooks as `node dist/cli.js`. It resolves the store from `cwd` exactly as the extension does — `resolveStoreRoot` is compiled into both bundles so they agree.
- **Snapshot scope (v1):** whole tracked tree at each `Stop` (per plan). The "only files the agent touched" refinement (the option-c idea) is deferred — noted as a follow-up, not lost.
- **Storage backend: `sql.js` (WASM), not `better-sqlite3`.** The native binding was avoided so the extension runs in the extension host regardless of Electron/Node version. `db.ts` exposes a minimal better-sqlite3-shaped API (`prepare`/`transaction`/`pragma`/`reload`) so `repository.ts` is backend-agnostic. The WASM is resolved beside the bundle, with a fallback to the `sql.js` package's own copy when run from source (tests).
- **Hook install target: `.claude/settings.local.json`** (machine-local, conventionally gitignored), not the shared `.claude/settings.json` the original plan suggested — deliberate, because the hook command contains an absolute path to this machine's `dist/cli.js` and must not be committed. Documented in `installer.ts`.
- **Storage location:** workspace in phase 1 (per plan); `global` stubbed behind the `storageLocation` setting.
- **Non-agent manual edits** between prompts get attributed to the next prompt by default (known limitation). The manual `Reindex` command is the escape hatch: it absorbs such drift into the baseline so the next prompt isn't blamed. The automatic scope-only `reconcileScope` (on exclude-rule changes) deliberately preserves manual-edit drift for attribution.

## Out of Scope for This Pass
Per-tool (`PostToolUse`) replay, transcript parsing for Codex/Copilot, agent comparison, export report, token tracking, global storage mode — all phase 2+ per the plan. (Retention enforcement, originally listed here, is now implemented as milestone 9.)

## Known Gaps (post-implementation)
- **No extension-host test harness** — VS Code glue (views, commands, decorations, config hooks) is type-checked + built but not runtime-tested; the pure logic is covered by the seven `scripts/test-*.ts` suites.
- **Snapshot scope is the whole tree** at each `Stop`; the "only files the agent touched" refinement is deferred.
- **Global storage mode** is stubbed behind the setting (workspace only in phase 1).
