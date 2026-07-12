import { diffLines } from "diff";
import type { PromptRow, FileChangeRow } from "../store/db";

export interface LineBlame {
  /** The prompt that introduced this line, or null for baseline / un-captured. */
  promptId: string | null;
  /** The prompt row (for hover), or null when promptId is null. */
  prompt: PromptRow | null;
}

/**
 * Attribute each line of `liveText` to the prompt that introduced it, by
 * walking the file's prompt history (oldest→newest) and propagating line
 * identities forward through each prompt's `before → after` diff.
 *
 * `readBlob` is injected so the pure algorithm is testable with real blobs or
 * mocks. `history` is oldest-first (as `historyForFile` returns). Returns a
 * `LineBlame` per line of `liveText`.
 */
export function computeBlame(
  history: Array<{ prompt: PromptRow; change: FileChangeRow }>,
  readBlob: (hash: string | null) => string,
  liveText: string
): LineBlame[] {
  if (history.length === 0) return [];

  // identities[i] = the prompt that introduced the i-th line of the "current"
  // snapshot as we walk forward. null = present since the baseline (B0).
  let identities: Array<string | null> = [];

  // Baseline B0 = content before the first prompt. Init via diffLines so the
  // line count matches diffLines' own view (avoids trailing-newline mismatches).
  const firstBefore = history[0].change.before_hash;
  const B0 = firstBefore ? readBlob(firstBefore) : "";
  for (const part of diffLines("", B0)) {
    if (!part.added) continue;
    const count = part.count ?? 0;
    for (let i = 0; i < count; i++) identities.push(null);
  }

  // Walk prompts oldest→newest, applying each before→after diff.
  for (const { change } of history) {
    const before = change.before_hash ? readBlob(change.before_hash) : "";
    const after = change.after_hash ? readBlob(change.after_hash) : "";
    const next: Array<string | null> = [];
    let idx = 0; // cursor into identities (= lines of `before`, in order)
    for (const part of diffLines(before, after)) {
      const count = part.count ?? 0;
      if (part.removed) {
        idx += count; // drop these old lines
      } else if (part.added) {
        for (let i = 0; i < count; i++) next.push(change.prompt_id);
      } else {
        // unchanged: carry the surviving identities forward, in order
        for (let i = 0; i < count; i++) next.push(identities[idx++]);
      }
    }
    identities = next;
  }

  // identities now aligns 1:1 with the last snapshot (Bn). Map to the live file
  // via diffLines(Bn, live): unchanged → carry the tag; added (live-only) → null
  // (un-captured edit); removed (Bn-only) → dropped (not visible).
  const Bn =
    history[history.length - 1].change.after_hash
      ? readBlob(history[history.length - 1].change.after_hash)
      : "";
  const liveBlame: LineBlame[] = [];
  let bnIdx = 0;
  for (const part of diffLines(Bn, liveText)) {
    const count = part.count ?? 0;
    if (part.removed) {
      bnIdx += count; // skip Bn lines not in live
    } else if (part.added) {
      for (let i = 0; i < count; i++) liveBlame.push({ promptId: null, prompt: null });
    } else {
      for (let i = 0; i < count; i++) {
        const promptId = identities[bnIdx++] ?? null;
        liveBlame.push({ promptId, prompt: null });
      }
    }
  }

  return liveBlame;
}

/** Attach the prompt row to each blamed line (caller has the history handy). */
export function attachPrompts(
  blame: LineBlame[],
  history: Array<{ prompt: PromptRow; change: FileChangeRow }>
): LineBlame[] {
  const byId = new Map(history.map((h) => [h.prompt.id, h.prompt]));
  return blame.map((b) =>
    b.promptId ? { promptId: b.promptId, prompt: byId.get(b.promptId) ?? null } : b
  );
}
