import * as vscode from "vscode";
import type { PromptRow } from "../store/db";
import type { LineBlame } from "./blame";

/**
 * Renders per-prompt blame as colored gutter dots + hover. One
 * `TextEditorDecorationType` per distinct prompt, colored from a fixed palette
 * of hues (so the number of types is bounded regardless of prompt count;
 * collisions are disambiguated by the per-prompt hover text).
 */

const PALETTE = [0, 36, 72, 108, 144, 180, 216, 252, 288, 324]; // 10 hues

export class BlameDecorator {
  /** All decoration types ever created (cleared blanket on an editor). */
  private readonly types = new Set<vscode.TextEditorDecorationType>();

  apply(editor: vscode.TextEditor, blame: LineBlame[]): void {
    // Blanket-clear anything we previously applied to this editor.
    this.clear(editor);
    if (blame.length === 0) return;

    // Group line indices by promptId (skip null = baseline / un-captured).
    const byPrompt = new Map<string, number[]>();
    for (let i = 0; i < blame.length; i++) {
      const b = blame[i];
      if (!b.promptId || !b.prompt) continue;
      const arr = byPrompt.get(b.promptId);
      if (arr) arr.push(i);
      else byPrompt.set(b.promptId, [i]);
    }

    for (const [promptId, lines] of byPrompt) {
      const prompt = blame[lines[0]].prompt!;
      const type = this.typeFor(prompt);
      const hover = hoverFor(prompt);
      // Per-line DecorationOptions so each blamed line carries the prompt hover.
      const options = lines.map(
        (line) =>
          ({
            range: new vscode.Range(line, 0, line, Number.MAX_SAFE_INTEGER),
            hoverMessage: hover,
          } as vscode.DecorationOptions)
      );
      editor.setDecorations(type, options);
      void promptId; // promptId keyed the group; prompt is used for the type/hover
    }
  }

  clear(editor: vscode.TextEditor): void {
    for (const type of this.types) editor.setDecorations(type, []);
  }

  dispose(): void {
    for (const type of this.types) type.dispose();
    this.types.clear();
  }

  private typeFor(prompt: PromptRow): vscode.TextEditorDecorationType {
    const hue = PALETTE[simpleHash(prompt.id) % PALETTE.length];
    const color = `hsl(${hue}, 70%, 50%)`;
    const type = vscode.window.createTextEditorDecorationType({
      gutterIconPath: gutterIconUri(color),
      gutterIconSize: "contain",
    });
    this.types.add(type);
    return type;
  }
}

function hoverFor(prompt: PromptRow): vscode.MarkdownString {
  const time = new Date(prompt.timestamp).toLocaleString();
  return new vscode.MarkdownString(
    `**${prompt.title}**\\n\\n_${time}_\\n\\nIntroduced by this prompt\\n\\n${prompt.text ?? ""}`,
    true
  );
}

const iconCache = new Map<string, vscode.Uri>();
function gutterIconUri(color: string): vscode.Uri {
  const cached = iconCache.get(color);
  if (cached) return cached;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><circle cx="6" cy="6" r="5" fill="${color}"/></svg>`;
  const uri = vscode.Uri.parse(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`);
  iconCache.set(color, uri);
  return uri;
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
