import * as vscode from "vscode";
import { readBlobText } from "../store/blobs";
import { log } from "../util/log";

/**
 * Provides virtual documents for the before/after content of a file change,
 * so `vscode.diff` can show a real diff editor between two prompt snapshots.
 *
 * URI scheme: prompttrace:///<sha-or-absent>/<label>
 *   e.g. prompttrace:///before/<hash>   -> before content
 *        prompttrace:///after/<hash>    -> after content
 *        prompttrace:///before/none     -> empty (added file's "before")
 *        prompttrace:///after/none      -> empty (deleted file's "after")
 */
export class DiffContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly storeRoot: string) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // uri.path = /<side>/<hash|none>
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
    const beforeUri = vscode.Uri.parse(`prompttrace:///before/${beforeHash ?? "none"}`);
    const afterUri = vscode.Uri.parse(`prompttrace:///after/${afterHash ?? "none"}`);

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
