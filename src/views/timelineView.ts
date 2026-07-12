import * as vscode from "vscode";
import { Repository } from "../store/repository";
import type { PromptRow, FileChangeRow } from "../store/db";

/**
 * Timeline TreeView: for the currently open file, every prompt that touched
 * it (oldest-first). Each node shows title · time · status · +/- and, on
 * click, opens the before/after diff via the existing `prompttrace.openDiff`
 * command (same arg shape as the Prompts view's file nodes).
 *
 * The active file is set from the extension via `setFile`; switching tabs or a
 * new Stop (db watcher) triggers a refresh.
 */

export interface TimelineNode {
  prompt: PromptRow;
  change: FileChangeRow;
  relPath: string;
}

export class TimelineTreeProvider implements vscode.TreeDataProvider<TimelineNode> {
  private readonly emitter = new vscode.EventEmitter<TimelineNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private relPath: string | null = null;

  constructor(private readonly repo: Repository) {}

  /** Set the active file's workspace-relative path; refresh only if it changed. */
  setFile(relPath: string | null): void {
    if (relPath === this.relPath) return;
    this.relPath = relPath;
    this.refresh();
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: TimelineNode): vscode.TreeItem {
    const { prompt: p, change: c, relPath } = element;
    const item = new vscode.TreeItem(p.title, vscode.TreeItemCollapsibleState.None);
    item.id = `tl:${p.id}:${relPath}`;
    const time = new Date(p.timestamp).toLocaleString();
    item.description = `${time} · ${c.status} · +${c.additions}/-${c.deletions}`;
    item.tooltip = new vscode.MarkdownString(
      `**${p.title}**\n\n\`${relPath}\`\n\n${c.status} · +${c.additions} −${c.deletions} · _${time}_\n\nprompt: ${p.text ?? ""}`
    );
    item.iconPath = statusIcon(c.status);
    item.contextValue = "fileChange";
    item.command = {
      command: "prompttrace.openDiff",
      title: "Open Diff",
      arguments: [
        {
          path: relPath,
          beforeHash: c.before_hash,
          afterHash: c.after_hash,
          promptTitle: p.title,
        },
      ],
    };
    return item;
  }

  getChildren(element?: TimelineNode): TimelineNode[] {
    if (element || !this.relPath) return []; // flat: top-level only, and only when a file is set
    // historyForFile is oldest-first; the Timeline reads top→bottom as evolution.
    return this.repo.historyForFile(this.relPath).map(({ prompt, change }) => ({
      prompt,
      change,
      relPath: this.relPath!,
    }));
  }
}

// Colored like git's own resource decorations (green/red/orange/…), reusing the
// built-in git theme colors so the icons match the user's theme automatically.
function statusIcon(status: FileChangeRow["status"]): vscode.ThemeIcon {
  switch (status) {
    case "added":
      return new vscode.ThemeIcon(
        "diff-added",
        new vscode.ThemeColor("gitDecoration.addedResourceForeground")
      );
    case "modified":
      return new vscode.ThemeIcon(
        "diff-modified",
        new vscode.ThemeColor("gitDecoration.modifiedResourceForeground")
      );
    case "deleted":
      return new vscode.ThemeIcon(
        "diff-removed",
        new vscode.ThemeColor("gitDecoration.deletedResourceForeground")
      );
    case "renamed":
      return new vscode.ThemeIcon(
        "diff-renamed",
        new vscode.ThemeColor("gitDecoration.renamedResourceForeground")
      );
  }
}
