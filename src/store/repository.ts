import { writeBlob, reclaimUnreferencedBlobs } from "./blobs";
import { log } from "../util/log";
import type { DB, PromptRow, FileChangeRow } from "./db";

/** A file path → content hash entry, as produced by the snapshot walker. */
export interface PathHash {
  path: string;
  hash: string | null; // null = file absent (deleted / never existed)
}

/** A change to persist for one prompt: path + before/after hashes + patch. */
export interface FileChangeInput {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
  patch: string | null;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

export interface PromptInput {
  id: string;
  title: string;
  text: string | null;
  timestamp: number;
  agent: string;
  sessionId: string | null;
  sequence: number;
}

export class Repository {
  constructor(
    private readonly db: DB,
    private readonly storeRoot: string
  ) {}

  reload(): void {
    this.db.reload();
  }

  // ---- prompts ----------------------------------------------------------

  addPrompt(p: PromptInput): void {
    this.db
      .prepare(
        `INSERT INTO prompts(id, title, text, timestamp, agent, session_id, sequence)
         VALUES (@id, @title, @text, @timestamp, @agent, @session_id, @sequence)`
      )
      .run({
        id: p.id,
        title: p.title,
        text: p.text,
        timestamp: p.timestamp,
        agent: p.agent,
        session_id: p.sessionId,
        sequence: p.sequence,
      });
  }

  getPrompt(id: string): PromptRow | undefined {
    return this.db.prepare("SELECT * FROM prompts WHERE id = ?").get(id) as
      | PromptRow
      | undefined;
  }

  listPrompts(limit = 500): PromptRow[] {
    return this.db
      .prepare("SELECT * FROM prompts ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as PromptRow[];
  }

  countPrompts(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM prompts").get() as { n: number }).n;
  }

  /** Highest sequence number seen so far (for ordering prompts within a session). */
  maxSequence(): number {
    const row = this.db
      .prepare("SELECT MAX(sequence) AS m FROM prompts")
      .get() as { m: number | null };
    return row.m ?? -1;
  }

  /**
   * The most recent prompt in `sessionId` that has no file changes attached yet
   * — i.e. the prompt whose Stop is currently firing. Null if none pending.
   */
  latestUnattachedPrompt(sessionId: string): PromptRow | undefined {
    return this.db
      .prepare(
        `SELECT p.* FROM prompts p
         WHERE p.session_id = ?
           AND NOT EXISTS (SELECT 1 FROM file_changes fc WHERE fc.prompt_id = p.id)
         ORDER BY p.sequence DESC, p.timestamp DESC
         LIMIT 1`
      )
      .get(sessionId) as PromptRow | undefined;
  }

  // ---- file changes -----------------------------------------------------

  addFileChanges(promptId: string, changes: FileChangeInput[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO file_changes
         (prompt_id, path, before_hash, after_hash, patch, additions, deletions, status)
       VALUES (@prompt_id, @path, @before_hash, @after_hash, @patch, @additions, @deletions, @status)`
    );
    const tx = this.db.transaction((rows: FileChangeInput[]) => {
      for (const r of rows) {
        stmt.run({
          prompt_id: promptId,
          path: r.path,
          before_hash: r.beforeHash,
          after_hash: r.afterHash,
          patch: r.patch,
          additions: r.additions,
          deletions: r.deletions,
          status: r.status,
        });
      }
    });
    tx(changes);
  }

  changesForPrompt(promptId: string): FileChangeRow[] {
    return this.db
      .prepare("SELECT * FROM file_changes WHERE prompt_id = ? ORDER BY path")
      .all(promptId) as FileChangeRow[];
  }

  /** Every prompt that touched `filePath`, oldest-first, with its change row. */
  historyForFile(filePath: string): Array<{ prompt: PromptRow; change: FileChangeRow }> {
    const rows = this.db
      .prepare(
        `SELECT fc.*, p.id AS p_id, p.title, p.text, p.timestamp, p.agent, p.session_id, p.sequence
         FROM file_changes fc
         JOIN prompts p ON p.id = fc.prompt_id
         WHERE fc.path = ?
         ORDER BY p.timestamp ASC, p.sequence ASC`
      )
      .all(filePath) as Array<FileChangeRow & {
        p_id: string;
        title: string;
        text: string | null;
        timestamp: number;
        agent: string;
        session_id: string | null;
        sequence: number;
      }>;

    return rows.map((r) => ({
      prompt: {
        id: r.p_id,
        title: r.title,
        text: r.text,
        timestamp: r.timestamp,
        agent: r.agent,
        session_id: r.session_id,
        sequence: r.sequence,
      },
      change: {
        id: r.id,
        prompt_id: r.p_id,
        path: r.path,
        before_hash: r.before_hash,
        after_hash: r.after_hash,
        patch: r.patch,
        additions: r.additions,
        deletions: r.deletions,
        status: r.status,
      } as FileChangeRow,
    }));
  }

  // ---- last-state (snapshot cursor) ------------------------------------

  getLastState(): Map<string, string | null> {
    const rows = this.db.prepare("SELECT path, hash FROM last_state").all() as {
      path: string;
      hash: string | null;
    }[];
    return new Map(rows.map((r) => [r.path, r.hash]));
  }

  /**
   * Replace the last-state cursor with the given snapshot. Only paths that are
   * "live" (present on disk) are kept; deleted files are pruned from the cursor.
   */
  setLastState(snapshot: PathHash[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM last_state").run();
      const ins = this.db.prepare(
        "INSERT INTO last_state(path, hash) VALUES (?, ?)"
      );
      for (const e of snapshot) {
        ins.run([e.path, e.hash]);
      }
    });
    tx();
  }

  /**
   * Establish the very first baseline: write blobs for every file in the
   * snapshot (so the first real prompt can diff against real before-content)
   * and set the last-state cursor. Called once, on the first Stop ever.
   */
  seedBaseline(snapshot: PathHash[], contents: Map<string, Buffer>): void {
    const tx = this.db.transaction(() => {
      for (const [, buf] of contents) {
        writeBlob(this.storeRoot, buf);
      }
      this.setLastState(snapshot);
    });
    tx();
    log.info(`baseline seeded: ${snapshot.length} files`);
  }

  /**
   * Replace the cursor with `newCursor`, writing blobs for `contents` first.
   * Used by Reindex (both the automatic scope-only reconcile and the manual
   * full re-baseline). Unlike `seedBaseline`, the caller passes only the files
   * that actually need a blob (newly in scope, or changed) — unchanged files
   * already have blobs on disk.
   *
   * Touches only `last_state` + blobs; `prompts` and `file_changes` are never
   * modified, so past diffs remain immutable.
   */
  reindex(newCursor: PathHash[], contents: Map<string, Buffer>): void {
    const tx = this.db.transaction(() => {
      for (const [, buf] of contents) {
        writeBlob(this.storeRoot, buf);
      }
      this.setLastState(newCursor);
    });
    tx();
    log.info(
      `reindex: cursor set to ${newCursor.length} path(s) (${contents.size} blob(s) written)`
    );
  }

  /**
   * Attach file changes to an already-inserted prompt and advance the
   * last-state cursor. Writes blobs for the changed files (content-addressed,
   * deduped). Used by the capture CLI on `Stop`, after `UserPromptSubmit`
   * already inserted the prompt row.
   */
  attachChanges(
    promptId: string,
    changes: FileChangeInput[],
    nextSnapshot: PathHash[],
    afterContents: Map<string, Buffer>
  ): void {
    const tx = this.db.transaction(() => {
      this.addFileChanges(promptId, changes);
      for (const [, content] of afterContents) {
        writeBlob(this.storeRoot, content);
      }
      this.setLastState(nextSnapshot);
    });
    tx();
    log.info(`attached ${changes.length} file change(s) to prompt ${promptId}`);
  }

  /**
   * Persist a prompt + its net file changes and advance the last-state cursor.
   * Convenience for the single-shot (baseline / non-hook) path.
   */
  recordPrompt(
    prompt: PromptInput,
    changes: FileChangeInput[],
    nextSnapshot: PathHash[],
    afterContents: Map<string, Buffer>
  ): void {
    const tx = this.db.transaction(() => {
      this.addPrompt(prompt);
      this.addFileChanges(prompt.id, changes);
      for (const [, content] of afterContents) {
        writeBlob(this.storeRoot, content);
      }
      this.setLastState(nextSnapshot);
    });
    tx();
    log.info(`recorded prompt ${prompt.id} (${changes.length} file change(s))`);
  }

  // ---- maintenance ------------------------------------------------------

  clearAll(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM file_changes").run();
      this.db.prepare("DELETE FROM prompts").run();
      this.db.prepare("DELETE FROM last_state").run();
    })();
    const removed = this.reclaimBlobs();
    log.info(`cleared all tracing data (${removed} blob(s) reclaimed)`);
  }

  clearOlderThan(timestampMs: number): number {
    const res = this.db
      .prepare("DELETE FROM prompts WHERE timestamp < ?")
      .run(timestampMs);
    // file_changes cascade-delete via FK; reclaim the now-orphaned blobs.
    const removed = this.reclaimBlobs();
    log.info(
      `cleared ${res.changes} prompt(s) older than ${timestampMs} (${removed} blob(s) reclaimed)`
    );
    return res.changes;
  }

  /**
   * Apply retention: keep the last `keepLastPrompts` most-recent prompts and
   * anything newer than `keepLastDays` days; delete the rest. OR-semantics — a
   * prompt survives if EITHER threshold keeps it. `now` is injected for testing.
   * A threshold <= 0 means "not applicable" (e.g. keepLastDays=0 → count-only).
   * Returns the number of prompts deleted; 0 when nothing exceeds either.
   */
  applyRetention(keepLastPrompts: number, keepLastDays: number, now: number): number {
    const cutoffs: number[] = [];
    if (keepLastPrompts > 0) {
      // Boundary = timestamp of the Nth-most-recent prompt. If there are < N
      // prompts, the OFFSET row is absent → every prompt is "in the last N" →
      // OR-semantics keeps them all, regardless of age.
      const row = this.db
        .prepare(
          "SELECT timestamp AS t FROM prompts ORDER BY timestamp DESC LIMIT 1 OFFSET ?"
        )
        .get(keepLastPrompts - 1) as { t: number } | undefined;
      if (!row) return 0;
      cutoffs.push(row.t);
    }
    if (keepLastDays > 0) cutoffs.push(now - keepLastDays * 86_400_000);
    if (cutoffs.length === 0) return 0; // no applicable threshold → keep everything
    const cutoff = Math.min(...cutoffs);
    return this.clearOlderThan(cutoff);
  }

  clearSession(sessionId: string): number {
    const res = this.db
      .prepare("DELETE FROM prompts WHERE session_id = ?")
      .run(sessionId);
    const removed = this.reclaimBlobs();
    log.info(
      `cleared ${res.changes} prompt(s) from session ${sessionId} (${removed} blob(s) reclaimed)`
    );
    return res.changes;
  }

  /**
   * Reclaim disk space: delete blobs no longer referenced by any file_change
   * or last_state row, then VACUUM the SQLite file. Safe to run anytime; loses
   * no live tracing data.
   */
  compact(): { blobsRemoved: number } {
    const blobsRemoved = this.reclaimBlobs();
    this.db.pragma("vacuum");
    log.info(`compacted: removed ${blobsRemoved} blob(s), vacuumed db`);
    return { blobsRemoved };
  }

  vacuum(): void {
    this.db.pragma("vacuum");
  }

  /**
   * Delete blobs not referenced by file_changes (before/after) or last_state
   * (current content of unchanged files — needed as the next diff's "before").
   * Best-effort: blob GC is not transactional with the row deletes.
   */
  private reclaimBlobs(): number {
    const changes = this.db
      .prepare("SELECT before_hash AS b, after_hash AS a FROM file_changes")
      .all() as { b: string | null; a: string | null }[];
    const state = this.db.prepare("SELECT hash FROM last_state").all() as {
      hash: string | null;
    }[];
    const referenced = new Set<string>();
    for (const r of changes) {
      if (r.b) referenced.add(r.b);
      if (r.a) referenced.add(r.a);
    }
    for (const s of state) {
      if (s.hash) referenced.add(s.hash);
    }
    return reclaimUnreferencedBlobs(this.storeRoot, referenced);
  }

  // ---- settings kv (shared with the capture CLI) ------------------------

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO settings_kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      )
      .run([key, value]);
  }

  getSetting(key: string): string | undefined {
    const row = this.db
      .prepare("SELECT value FROM settings_kv WHERE key = ?")
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  getSettingJSON<T>(key: string, fallback: T): T {
    const v = this.getSetting(key);
    if (!v) return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  }
}
