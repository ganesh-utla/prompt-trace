import * as vscode from "vscode";
import { Repository } from "../store/repository";
import type { PromptRow, FileChangeRow } from "../store/db";

/**
 * TreeView: prompts (newest-first) → changed files (with +/- and status).
 * Clicking a file opens the before/after diff via `prompttrace.openDiff`.
 */

export type TreeNode =
  | { kind: "prompt"; prompt: PromptRow; totalAdd: number; totalDel: number }
  | {
      kind: "file";
      path: string;
      change: FileChangeRow;
      promptTitle: string;
      beforeHash: string | null;
      afterHash: string | null;
    };

export class PromptTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly repo: Repository) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === "prompt") {
      const p = element.prompt;
      const item = new vscode.TreeItem(
        `${p.title}`,
        vscode.TreeItemCollapsibleState.Collapsed
      );
      item.id = `prompt:${p.id}`;
      const time = new Date(p.timestamp).toLocaleString();
      item.description = `${time} · +${element.totalAdd}/-${element.totalDel}`;
      item.tooltip = new vscode.MarkdownString(
        `**${p.title}**\n\n${p.text ?? ""}\n\n_${time}_ · agent: ${p.agent}`
      );
      item.iconPath = new vscode.ThemeIcon("comment");
      item.contextValue = "prompt";
      return item;
    }

    // file node
    const c = element.change;
    const item = new vscode.TreeItem(element.path, vscode.TreeItemCollapsibleState.None);
    item.id = `file:${c.prompt_id}:${c.path}`;
    item.description = `${c.status} · +${c.additions}/-${c.deletions}`;
    item.tooltip = new vscode.MarkdownString(
      `\`${element.path}\`\n\n${c.status} · +${c.additions} −${c.deletions}\n\nprompt: ${element.promptTitle}`
    );
    item.iconPath = statusIcon(c.status);
    item.contextValue = "fileChange";
    item.command = {
      command: "prompttrace.openDiff",
      title: "Open Diff",
      arguments: [
        {
          path: element.path,
          beforeHash: element.beforeHash,
          afterHash: element.afterHash,
          promptTitle: element.promptTitle,
        },
      ],
    };
    return item;
  }

  async getChildren(element?: TreeNode): Promise<TreeNode[]> {
    if (!element) {
      // top level: prompts
      const prompts = this.repo.listPrompts();
      return prompts.map((p) => {
        const changes = this.repo.changesForPrompt(p.id);
        const totalAdd = changes.reduce((s, c) => s + c.additions, 0);
        const totalDel = changes.reduce((s, c) => s + c.deletions, 0);
        return { kind: "prompt" as const, prompt: p, totalAdd, totalDel };
      });
    }

    if (element.kind === "prompt") {
      const changes = this.repo.changesForPrompt(element.prompt.id);
      return changes.map((c) => ({
        kind: "file" as const,
        path: c.path,
        change: c,
        promptTitle: element.prompt.title,
        beforeHash: c.before_hash,
        afterHash: c.after_hash,
      }));
    }

    return [];
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
