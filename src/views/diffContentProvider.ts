import * as path from "path";
import * as vscode from "vscode";
import { readBlobText } from "../store/blobs";
import { log } from "../util/log";

/**
 * Provides virtual documents for the before/after content of a file change,
 * so `vscode.diff` can show a real diff editor between two prompt snapshots.
 *
 * URI scheme: prompttrace:///<side>/<hash|none>?file=<encoded-abs-path>
 *   e.g. prompttrace:///before/<hash>?file=%2Fproj%2Fsrc%2Ffoo.ts  -> before content
 *        prompttrace:///after/<hash>?file=%2Fproj%2Fsrc%2Ffoo.ts   -> after content
 *        prompttrace:///before/none?file=...                        -> empty (added file's "before")
 *        prompttrace:///after/none?file=...                         -> empty (deleted file's "after")
 *
 * The `file` query param carries the absolute on-disk path of the changed file
 * so the editor-title "open current file" command can open the real workspace
 * file (its final/current state) from the diff view. It is ignored by
 * `provideTextDocumentContent`, which reads only `uri.path` for the side/hash.
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(
    private readonly storeRoot: string,
    private readonly workspacePath: string
  ) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // uri.path = /<side>/<hash|none>  (the ?file= query is not part of uri.path)
    const parts = uri.path.split("/").filter(Boolean); // [side, hash]
    const hash = parts[1] === "none" ? null : parts[1] ?? null;
    if (!hash) return "";
    const content = readBlobText(this.storeRoot, hash);
    return content ?? "";
  }

  /** Open a diff editor for a file change (before hash → after hash). */
  async openDiff(
    relPath: string,
    beforeHash: string | null,
    afterHash: string | null,
    promptTitle: string
  ): Promise<void> {
    // Tag both sides with the absolute file path so the title-bar "open current
    // file" command can recover it from whichever side VS Code reports as active.
    const absPath = path.join(this.workspacePath, relPath);
    const fileParam = `file=${encodeURIComponent(absPath)}`;
    const beforeUri = vscode.Uri.parse(
      `prompttrace:///before/${beforeHash ?? "none"}?${fileParam}`
    );
    const afterUri = vscode.Uri.parse(
      `prompttrace:///after/${afterHash ?? "none"}?${fileParam}`
    );

    const label = `${relPath} — ${promptTitle}`.slice(0, 80);
    try {
      await vscode.commands.executeCommand("vscode.diff", beforeUri, afterUri, label, {
        preview: true,
      });
    } catch (err) {
      log.error(`openDiff failed: ${err}`);
      vscode.window.showErrorMessage(`PromptTrace: could not open diff: ${err}`);
    }
  }
}
