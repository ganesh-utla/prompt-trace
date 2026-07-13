import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { log, setOutputChannel } from "./util/log";
import { resolveStoreRoot } from "./store/resolve";
import { openStore } from "./store/db";
import type { DB } from "./store/db";
import { Repository } from "./store/repository";
import type { PathHash } from "./store/repository";
import { ensureGitignoreEntry } from "./util/gitignore";
import { readSettings } from "./settings";
import { cliPathFor } from "./hooks/hookConfig";
import { installHooks, hooksInstalled } from "./hooks/installer";
import { snapshotWorkspace } from "./capture/snapshot";
import { planScopeReconcile, planFullReindex } from "./capture/reconcile";
import { computeBlame, attachPrompts } from "./blame/blame";
import { BlameDecorator } from "./blame/decorations";
import { readBlobText } from "./store/blobs";
import { PromptTreeProvider } from "./views/promptsView";
import { TimelineTreeProvider } from "./views/timelineView";
import { DiffContentProvider } from "./views/diffContentProvider";
import { toWorkspaceRel } from "./util/workspace";

let activeDb: DB | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const outputChannel = vscode.window.createOutputChannel("PromptTrace");
  context.subscriptions.push(outputChannel);
  setOutputChannel((line) => outputChannel.appendLine(line));

  log.info("PromptTrace activating");

  const workspacePath = currentWorkspacePath();
  if (!workspacePath) {
    log.warn("no workspace folder; PromptTrace inactive");
    registerDegradedCommands(
      context,
      "PromptTrace needs a workspace folder open to trace prompts."
    );
    return;
  }

  const settings = readSettings();
  const storeRoot = resolveStoreRoot(workspacePath, settings.storageLocation);
  log.info(`store root: ${storeRoot}`);

  await ensureGitignoreEntry(workspacePath);

  // Open the store and persist capture-relevant settings so the hook-launched
  // CLI (which can't read VS Code config) picks them up from settings_kv. A
  // failure here — most commonly the sql.js WASM failing to load on this
  // machine — used to abort activation silently before any command was
  // registered, so VS Code reported a cryptic "command 'prompttrace.X' not
  // found" on every click. Catch it, surface the real cause, and register
  // stub commands so the views aren't dead surfaces.
  let repo: Repository;
  try {
    const db = await openStore(storeRoot);
    activeDb = db;
    repo = new Repository(db, storeRoot);
    persistCaptureSettings(repo, settings);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error(`activation failed: ${err}`);
    const choice = await vscode.window.showErrorMessage(
      `PromptTrace could not start: ${detail}. See the "PromptTrace" output channel.`,
      "Show Log"
    );
    if (choice === "Show Log") outputChannel.show();
    registerDegradedCommands(context, `PromptTrace is disabled: ${detail}`);
    return;
  }

  // Optional retention: prune old prompts on activation (off by default).
  if (settings.retentionEnabled) {
    const pruned = repo.applyRetention(
      settings.retentionKeepLastPrompts,
      settings.retentionKeepLastDays,
      Date.now()
    );
    if (pruned) log.info(`retention pruned ${pruned} prompt(s) on activation`);
  }

  // Diff content provider (serves before/after snapshots to vscode.diff).
  const diffProvider = new DiffContentProvider(storeRoot);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("prompttrace", diffProvider)
  );

  // Prompts TreeView.
  const treeProvider = new PromptTreeProvider(repo);
  context.subscriptions.push(
    vscode.window.createTreeView("prompttrace.promptsView", {
      treeDataProvider: treeProvider,
      showCollapseAll: true,
    })
  );

  // Timeline TreeView: prompts that touched the currently open file.
  const timelineProvider = new TimelineTreeProvider(repo);
  const timelineView = vscode.window.createTreeView("prompttrace.timelineView", {
    treeDataProvider: timelineProvider,
  });
  context.subscriptions.push(timelineView);
  const setTimelineFile = (editor: vscode.TextEditor | undefined) => {
    const rel = editor ? toWorkspaceRel(workspacePath, editor.document.uri) : null;
    timelineProvider.setFile(rel);
    if (rel) {
      const n = repo.historyForFile(rel).length;
      timelineView.description = `${rel} · ${n} prompt${n === 1 ? "" : "s"}`;
      timelineView.message = n === 0 ? "No prompts have touched this file." : undefined;
    } else {
      timelineView.description = undefined;
      timelineView.message = "Open a file in this workspace to see its prompt history.";
    }
  };
  setTimelineFile(vscode.window.activeTextEditor);

  // Prompt Blame: per-line attribution as colored gutter dots. Toggle on/off.
  const blameDecorator = new BlameDecorator();
  let blameOn = false;
  const applyBlame = (editor: vscode.TextEditor | undefined) => {
    if (!blameOn || !editor) return;
    const rel = toWorkspaceRel(workspacePath, editor.document.uri);
    if (!rel) {
      blameDecorator.clear(editor);
      return;
    }
    const history = repo.historyForFile(rel);
    if (history.length === 0) {
      blameDecorator.clear(editor);
      vscode.window.setStatusBarMessage(`PromptTrace: no prompt history for ${rel}`, 4000);
      return;
    }
    const readBlob = (h: string | null) => (h ? readBlobText(storeRoot, h) ?? "" : "");
    const blame = attachPrompts(computeBlame(history, readBlob, editor.document.getText()), history);
    blameDecorator.apply(editor, blame);
  };
  context.subscriptions.push({ dispose: () => blameDecorator.dispose() });

  // Auto-reload the tree when the CLI (or another process) writes the store.
  const dbWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspacePath, ".prompt-trace/db.sqlite")
  );
  dbWatcher.onDidChange(() => {
    repo.reload();
    treeProvider.refresh();
    timelineProvider.refresh();
    setTimelineFile(vscode.window.activeTextEditor); // recount + message
    applyBlame(vscode.window.activeTextEditor); // new prompt captured → re-blame
  });
  context.subscriptions.push(dbWatcher);

  // Keep the Timeline tied to the open file as the user switches tabs.
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      setTimelineFile(editor);
      applyBlame(editor);
    })
  );

  // Commands. registerCommand takes exactly one command per call.
  context.subscriptions.push(
    vscode.commands.registerCommand("prompttrace.refresh", () => {
      // sql.js is in-memory; the CLI writes the DB file independently, so reload
      // from disk before refreshing the tree.
      repo.reload();
      treeProvider.refresh();
      timelineProvider.refresh();
      setTimelineFile(vscode.window.activeTextEditor);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("prompttrace.installHooks", () =>
      ensureHooks(context, workspacePath, settings.autoInstallHooks, repo)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("prompttrace.openDiff", (arg) =>
      openDiff(arg, diffProvider)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("prompttrace.clearAll", () =>
      clearAll(repo, treeProvider)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("prompttrace.clearOlderThan", () =>
      clearOlderThan(repo, treeProvider)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("prompttrace.clearCurrentSession", () =>
      clearCurrentSession(repo, treeProvider)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("prompttrace.compact", () => compact(repo))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("prompttrace.reindex", () =>
      runFullReindex(repo, workspacePath)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("prompttrace.toggleBlame", () => {
      blameOn = !blameOn;
      vscode.commands.executeCommand(
        "setContext",
        "prompttrace.blameOn",
        blameOn
      );
      const editor = vscode.window.activeTextEditor;
      if (blameOn) {
        applyBlame(editor);
        vscode.window.setStatusBarMessage(
          "PromptTrace: prompt blame on",
          3000
        );
      } else if (editor) {
        blameDecorator.clear(editor);
        vscode.window.setStatusBarMessage(
          "PromptTrace: prompt blame off",
          3000
        );
      }
    })
  );

  // Hook install: auto if setting on, else prompt once.
  await ensureHooks(context, workspacePath, settings.autoInstallHooks, repo);

  // Refresh the trees when the workspace files change (so new prompts surface).
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      treeProvider.refresh();
      timelineProvider.refresh();
      setTimelineFile(vscode.window.activeTextEditor);
      // Re-blame if the saved doc is the active one (live content changed).
      if (
        blameOn &&
        vscode.window.activeTextEditor?.document === doc
      ) {
        applyBlame(vscode.window.activeTextEditor);
      }
    })
  );

  // Keep capture settings in sync when the user edits them.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("prompttrace")) {
        const fresh = readSettings();
        persistCaptureSettings(repo, fresh);
        // Retention change (or enabling it) → prune before the trees re-render.
        if (
          e.affectsConfiguration("prompttrace.retention") &&
          fresh.retentionEnabled
        ) {
          const pruned = repo.applyRetention(
            fresh.retentionKeepLastPrompts,
            fresh.retentionKeepLastDays,
            Date.now()
          );
          if (pruned) log.info(`retention pruned ${pruned} prompt(s) on config change`);
        }
        treeProvider.refresh();
        // A scope-rule change provably invalidates the cursor's membership —
        // reconcile it automatically (scope-only, so manual edits are preserved).
        if (
          e.affectsConfiguration("prompttrace.excludePatterns") ||
          e.affectsConfiguration("prompttrace.maxFileSizeKB")
        ) {
          runScopeReconcile(repo, workspacePath, fresh).catch((err) =>
            log.error(`scope reconcile failed: ${err}`)
          );
        }
      }
    })
  );

  log.info("PromptTrace activated");
}

export function deactivate(): void {
  log.info("PromptTrace deactivated");
  activeDb?.close();
}

/** Every command the extension contributes (see package.json `contributes.commands`). */
const PROMPTTRACE_COMMANDS = [
  "prompttrace.refresh",
  "prompttrace.openDiff",
  "prompttrace.installHooks",
  "prompttrace.clearAll",
  "prompttrace.clearOlderThan",
  "prompttrace.clearCurrentSession",
  "prompttrace.compact",
  "prompttrace.reindex",
  "prompttrace.toggleBlame",
] as const;

/**
 * Register no-op stubs for every PromptTrace command. Used when activation
 * fails (or there's no workspace folder): without these, the views declared in
 * package.json would invoke commands that were never registered, and VS Code
 * would show "command 'prompttrace.X' not found". The stubs instead surface
 * the real reason PromptTrace is disabled and offer a one-click reload to retry
 * once the user has fixed the cause (reinstall, remove quarantine, open a
 * workspace, …).
 */
function registerDegradedCommands(
  context: vscode.ExtensionContext,
  message: string
): void {
  for (const id of PROMPTTRACE_COMMANDS) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        const choice = await vscode.window.showErrorMessage(message, "Reload Window");
        if (choice === "Reload Window") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      })
    );
  }
}

async function ensureHooks(
  context: vscode.ExtensionContext,
  workspacePath: string,
  autoInstall: boolean,
  repo: Repository
): Promise<void> {
  const cliPath = cliPathFor(context.extensionPath);
  if (await hooksInstalled(workspacePath, cliPath)) {
    log.info("hooks already installed and up to date");
    await setHooksInstalledContext(true);
    return;
  }

  await setHooksInstalledContext(false);

  if (!autoInstall) {
    const choice = await vscode.window.showInformationMessage(
      "PromptTrace: install Claude Code hooks to capture per-prompt diffs?",
      "Install",
      "Not now"
    );
    if (choice !== "Install") return;
  }

  try {
    const { file } = await installHooks(workspacePath, cliPath);
    vscode.window.showInformationMessage(`PromptTrace: hooks installed (${file}).`);
    await setHooksInstalledContext(true);

    // Fresh install with no prior baseline: seed it from the current workspace
    // state so the user's next prompt is attributed to that prompt rather than
    // being consumed to establish the baseline. Skip when a baseline already
    // exists (re-install / cliPath change) to preserve in-flight drift —
    // re-baselining in that case stays a manual Reindex.
    //
    // Run this in the BACKGROUND: it snapshots the whole workspace, which can be
    // slow on a large/remote tree, and awaiting it blocks activate() — which
    // leaves the Prompts/Timeline views spinning until it finishes. If the
    // user's first prompt lands before the baseline is ready, the capture
    // CLI's Stop handler seeds the baseline itself (prev.size === 0 branch), so
    // correctness doesn't depend on this completing first; it's an optimization
    // to make the first prompt attributable.
    if (repo.getLastState().size === 0) {
      vscode.window.setStatusBarMessage("PromptTrace: establishing baseline…", 10_000);
      reindexBaseline(repo, workspacePath)
        .then((n) =>
          vscode.window.showInformationMessage(
            `PromptTrace: baseline established from ${n} file(s) — ready to trace your next prompt.`
          )
        )
        .catch((err) => log.error(`baseline establishment failed: ${err}`));
    }
  } catch (err) {
    log.error(`hook install failed: ${err}`);
    vscode.window.showErrorMessage(`PromptTrace: could not install hooks: ${err}`);
  }
}

async function setHooksInstalledContext(installed: boolean): Promise<void> {
  await vscode.commands.executeCommand("setContext", "prompttrace.hooksInstalled", installed);
}

function persistCaptureSettings(repo: Repository, s: ReturnType<typeof readSettings>): void {
  repo.setSetting("excludePatterns", JSON.stringify(s.excludePatterns));
  repo.setSetting("maxFileSizeBytes", String(s.maxFileSizeKB * 1024));
  repo.setSetting("storageLocation", s.storageLocation);
}

function currentWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function openDiff(arg: unknown, diffProvider: DiffContentProvider): Promise<void> {
  // `arg` is a FileChangeNode from the tree; extract path + prompt + before/after.
  const node = arg as { path?: string; beforeHash?: string | null; afterHash?: string | null; promptTitle?: string };
  if (!node?.path) return;
  await diffProvider.openDiff(node.path, node.beforeHash ?? null, node.afterHash ?? null, node.promptTitle ?? "");
}

async function clearAll(repo: Repository, tree: PromptTreeProvider): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    "PromptTrace: delete ALL captured prompts and file changes? This cannot be undone.",
    { modal: false },
    "Clear All",
    "Cancel"
  );
  if (choice !== "Clear All") return;
  repo.clearAll();
  tree.refresh();
  vscode.window.showInformationMessage("PromptTrace: cleared all tracing data.");
}

async function clearOlderThan(repo: Repository, tree: PromptTreeProvider): Promise<void> {
  const items = [
    { label: "Older than 7 days", ms: 7 * 86_400_000 },
    { label: "Older than 30 days", ms: 30 * 86_400_000 },
    { label: "Older than 90 days", ms: 90 * 86_400_000 },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: "Clear prompts older than…",
  });
  if (!pick) return;
  const cutoff = Date.now() - pick.ms;
  const n = repo.clearOlderThan(cutoff);
  tree.refresh();
  vscode.window.showInformationMessage(
    `PromptTrace: cleared ${n} prompt(s) ${pick.label.toLowerCase()}.`
  );
}

async function clearCurrentSession(
  repo: Repository,
  tree: PromptTreeProvider
): Promise<void> {
  // "Current session" = the session of the most recent captured prompt.
  const latest = repo.listPrompts(1)[0];
  if (!latest?.session_id) {
    vscode.window.showInformationMessage("PromptTrace: no session to clear.");
    return;
  }
  const choice = await vscode.window.showWarningMessage(
    `PromptTrace: clear all prompts in session ${latest.session_id}?`,
    { modal: false },
    "Clear Session",
    "Cancel"
  );
  if (choice !== "Clear Session") return;
  const n = repo.clearSession(latest.session_id);
  tree.refresh();
  vscode.window.showInformationMessage(
    `PromptTrace: cleared ${n} prompt(s) from session ${latest.session_id}.`
  );
}

async function compact(repo: Repository): Promise<void> {
  const { blobsRemoved } = repo.compact();
  vscode.window.showInformationMessage(
    `PromptTrace: compacted storage (removed ${blobsRemoved} unreferenced blob(s)).`
  );
}

/**
 * Core full re-baseline: snapshot the workspace and reset the cursor to it.
 * Returns the number of files whose content was written (new + modified).
 * Reads fresh settings and reloads the store first to pick up any CLI writes.
 * History (prompts / file_changes) is untouched.
 */
async function reindexBaseline(repo: Repository, workspacePath: string): Promise<number> {
  const settings = readSettings();
  const prev = currentState(repo);
  const { entries } = await snapshotWorkspace({
    workspacePath,
    excludePatterns: settings.excludePatterns,
    maxFileSizeBytes: settings.maxFileSizeKB * 1024,
  });
  const { newCursor, needContent } = planFullReindex(prev, entries);
  const contents = await readContents(workspacePath, needContent);
  repo.reindex(newCursor, contents);
  return needContent.length;
}

/**
 * Manual `Reindex` command: full re-baseline. Absorbs all on-disk drift
 * (manual edits, branch switch, downtime) into the cursor so the next prompt
 * isn't blamed for it. History (prompts / file_changes) is untouched.
 */
async function runFullReindex(repo: Repository, workspacePath: string): Promise<void> {
  const n = await reindexBaseline(repo, workspacePath);
  vscode.window.showInformationMessage(
    `PromptTrace: reindexed — cursor re-baselined; ${n} file(s) had uncaptured changes that will no longer be attributed to the next prompt.`
  );
}

/**
 * Automatic scope-only reconcile, fired on `excludePatterns` / `maxFileSizeKB`
 * change. Reconciles cursor *membership* only — drops paths that left scope,
 * adds paths that entered scope — while preserving content drift (manual edits
 * and on-disk deletions of in-scope files stay attributed to the next prompt).
 */
async function runScopeReconcile(
  repo: Repository,
  workspacePath: string,
  settings: ReturnType<typeof readSettings>
): Promise<void> {
  const prev = currentState(repo);
  const { entries } = await snapshotWorkspace({
    workspacePath,
    excludePatterns: settings.excludePatterns,
    maxFileSizeBytes: settings.maxFileSizeKB * 1024,
  });
  const { newCursor, needContent } = planScopeReconcile(prev, entries, workspacePath);
  const contents = await readContents(workspacePath, needContent);
  repo.reindex(newCursor, contents);
  const keptFromPrev = newCursor.length - needContent.length;
  const dropped = prev.size - keptFromPrev;
  vscode.window.showInformationMessage(
    `PromptTrace: reindexed — ${needContent.length} added, ${dropped} dropped, ${newCursor.length} tracked.`
  );
}

/** Reload the store from disk (pick up CLI writes) and return the current cursor. */
function currentState(repo: Repository): Map<string, string | null> {
  repo.reload();
  return repo.getLastState();
}

/** Read the given paths' contents for blob-writing; silently skip unreadable ones. */
async function readContents(
  workspacePath: string,
  paths: PathHash[]
): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  for (const e of paths) {
    try {
      out.set(e.path, await fs.promises.readFile(path.join(workspacePath, e.path)));
    } catch (err) {
      log.warn(`reindex: could not read ${e.path}: ${err}`);
    }
  }
  return out;
}
