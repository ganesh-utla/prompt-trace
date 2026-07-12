# Prompt Blame (milestone 8) — Implementation Plan

Line-level attribution: for each line of the open file, attribute it to the prompt that introduced it. Render as per-prompt **colored gutter dots** + hover (prompt title / time). Toggle on/off via a command.

Data already exists: `Repository.historyForFile(relPath)` (prompts touching a file, oldest-first, each with `before_hash` / `after_hash`), and `readBlobText(storeRoot, hash)` for snapshot contents. `before_hash(Pi) == after_hash(Pi-1)` (or the baseline blob), so all intermediate contents are retrievable.

## Algorithm: forward propagation over the diff chain

Walk prompts oldest→newest, maintaining a list of line "identities" (each tagged with the prompt that introduced it, or `null` for pre-existing baseline). Applying each prompt's `diffLines(before, after)` updates the list to that snapshot's lines:

```
identities: Array<{ promptId: string | null }> = []
// baseline B0 (before first prompt): init via diff so line counts match diffLines' view
for part in diffLines("", B0):  // one "added" part, count = lines in B0
  push count identities with promptId = null

for { prompt, change } in history (oldest→newest):
  before = change.before_hash ? readBlobText(before_hash) : ""   // = Bi-1
  after  = change.after_hash  ? readBlobText(after_hash)  : ""   // = Bi
  newIdentities = []
  for part in diffLines(before, after):
    if part.removed:   consume `count` from identities  (drop them)
    elif part.added:   push `count` new identities tagged prompt.id
    else (unchanged):  consume `count` from identities (keep them) → push as-is
  identities = newIdentities
// identities now aligns 1:1 with the lines of the LAST snapshot (Bn)
```

Correctness properties (verified by test):
- A line added by Pi and surviving to Bn → tagged Pi (most recent introduction wins, since re-added lines get fresh tags from the re-adding prompt).
- Lines present since B0 → `null` (baseline, no prompt).

**Map to the live file** (so blame follows uncommitted edits): `diffLines(Bn, live)`:
- unchanged → carry the Bn line's tag to the live line.
- added (in live, not Bn) → `null` (un-captured edit; neutral, like baseline).
- removed (in Bn, not live) → dropped (not visible).

Result: `liveBlame: Array<{ promptId: string | null; prompt: PromptRow | null }>` aligned to the editor's lines. `null` covers both baseline and un-captured — both render with no colored dot (neutral), which is fine for v1.

## Files

### New: `src/blame/blame.ts` (pure, no vscode)
```ts
export interface LineBlame { promptId: string | null; prompt: PromptRow | null; }
/** Attribute each line of `liveText` to the prompt that introduced it. */
export function computeBlame(
  history: Array<{ prompt: PromptRow; change: FileChangeRow }>,
  readBlob: (hash: string | null) => string,
  liveText: string
): LineBlame[]
```
Implements the forward-propagation + live-map above. `readBlob` is injected so the algorithm is unit-testable with real blobs (or mocks).

### New: `src/blame/decorations.ts` (vscode)
`BlameDecorator`:
- A fixed palette of ~10 hues; `hue = palette[hash(promptId) % palette.length]`. Bounds decoration types to ≤10 regardless of prompt count (collisions disambiguated by hover).
- `coloredGutterIcon(hue)` → `vscode.Uri` data-URI SVG (a filled circle), cached per hue.
- `apply(editor, liveBlame, promptById)`: group line ranges by promptId (excluding null), create/reuse one `TextEditorDecorationType` per distinct promptId, `setDecorations` with per-line `DecorationOptions` (range + hover MarkdownString: `**title** · time · status · +N/-M`). Null lines get no decoration.
- `clear(editor)`: dispose + clear all types for that editor.
- Disposes types on deactivation.

### `src/extension.ts`
- Register `prompttrace.toggleBlame` — toggles a module-level `blameOn` boolean + context key `prompttrace.blameOn`. When turning on: `applyBlame(activeEditor)`. When off: `decorator.clear(activeEditor)`.
- `applyBlame(editor)`: if no editor / non-file / no history → clear + status message; else `relPath = toWorkspaceRel(...)`, `history = repo.historyForFile(relPath)`, `liveText = editor.document.getText()`, `computeBlame(...)`, `decorator.apply(...)`.
- Re-apply when blame is on: `onDidChangeActiveTextEditor` (new file), `onDidSaveTextDocument` (live changed), `dbWatcher.onDidChange` (new prompt captured — reload repo first).
- Dispose the decorator + reset context key on deactivate.

### `package.json`
- Command `prompttrace.toggleBlame` ("PromptTrace: Toggle Prompt Blame").
- `editor/title` menu entry (group `navigation`) with an icon, `when: activeEditor && resourcePath` so it shows for open files. (Toggle icon state via the `prompttrace.blameOn` context key — icon stays; the command flips state.)
- Context key `prompttrace.blameOn` set/cleared via `setContext`.

### New: `scripts/test-blame.ts`
Tests `computeBlame` (the algorithm) with a real repo + blobs, mirroring `test-capture.ts`. Scenario:
- B0 = `a\nb\nc\n`; P1 b→B (`a\nB\nc\n`); P2 add d (`a\nB\nc\nd\n`); P3 delete c (`a\nB\nd\n`).
- Assert live==B3 blame = `[null, P1, P2]` (a=baseline, B=P1, d=P2).
- Re-add scenario: P4 delete B then P5 re-add B' → B' blamed to P5 (not P1).
- Un-captured live edit: live = `a\nB\nd\nE\n` → `[null, P1, P2, null]` (E un-captured).
- Empty/no-history file → `[]`.

## Behavior & edge cases
- Toggle is opt-in and bounded (only the active editor when on); switching tabs re-applies to the new file; turning off clears.
- File with no prompt history → no decorations + status "No prompt history for this file."
- Un-captured edits (live ≠ Bn) → those lines get no dot (neutral), same as baseline.
- File deleted by the last prompt (after_hash null) but live content present → all un-captured (no blame).
- Decoration types capped at the palette size (~10); many prompts share hues, hover disambiguates.
- Large files: `setDecorations` over all attributed ranges; if perf matters, limit to visible ranges later (noted, not v1).

## Test coverage (honest)
- **Tested:** `computeBlame` algorithm (the real complexity) via `test-blame.ts`, against real blobs + `diffLines`.
- **Not runtime-tested:** the `BlameDecorator` (vscode decoration types, gutter SVG, hover) and the toggle/editor-tracking wiring — type-checked + built, no extension-host harness. Same gap as milestones 5/7.

## Verification
- `tsc --noEmit` clean; `npm run build` succeeds.
- `test-store` / `test-capture` / `test-installer` / `test-reindex` / `test-workspace` / `test-blame` all pass.
- Manual smoke (F5): open a file with captured history → toggle blame → colored gutter dots appear with hover showing the prompt; edit a line → save → new line shows no dot; toggle off → dots clear.

## Out of scope (future)
- Per-range visible-only rendering for very large files.
- Distinct visual for baseline vs un-captured (currently both neutral).
- Blame for files with >palette-size distinct prompts using more colors (capped today).
- Persisting blame-on across sessions / per-file toggle memory.
