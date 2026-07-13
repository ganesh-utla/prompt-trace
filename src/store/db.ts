import * as fs from "fs";
import * as path from "path";
import initSqlJs from "sql.js";
import type { Database as SqlJsDatabase, BindParams } from "sql.js";
import { dbFilePath } from "../util/paths";
import { log } from "../util/log";

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompts (
  id         TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  text        TEXT,
  timestamp  INTEGER NOT NULL,
  agent      TEXT NOT NULL,
  session_id TEXT,
  sequence   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompts_ts ON prompts(timestamp DESC);

CREATE TABLE IF NOT EXISTS file_changes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt_id   TEXT NOT NULL,
  path        TEXT NOT NULL,
  before_hash TEXT,
  after_hash  TEXT,
  patch       TEXT,
  additions   INTEGER NOT NULL DEFAULT 0,
  deletions   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL,            -- added | modified | deleted | renamed
  FOREIGN KEY (prompt_id) REFERENCES prompts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_fc_prompt ON file_changes(prompt_id);
CREATE INDEX IF NOT EXISTS idx_fc_path ON file_changes(path);

-- Latest known content hash per tracked path, i.e. the "previous Stop" state.
-- Drives the diff for the next prompt; also the baseline before the first prompt.
CREATE TABLE IF NOT EXISTS last_state (
  path     TEXT PRIMARY KEY,
  hash     TEXT,
  mtime    INTEGER
);

CREATE TABLE IF NOT EXISTS settings_kv (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

export interface PromptRow {
  id: string;
  title: string;
  text: string | null;
  timestamp: number;
  agent: string;
  session_id: string | null;
  sequence: number;
}

export interface FileChangeRow {
  id: number;
  prompt_id: string;
  path: string;
  before_hash: string | null;
  after_hash: string | null;
  patch: string | null;
  additions: number;
  deletions: number;
  status: "added" | "modified" | "deleted" | "renamed";
}

/** Minimal better-sqlite3-shaped API so repository.ts needs almost no changes. */
export interface DB {
  prepare(sql: string): PreparedStatement;
  transaction<T extends (...args: any[]) => void>(fn: T): T;
  pragma(sql: string): void;
  close(): void;
  /** Reload the in-memory DB from the persisted file (sql.js only). */
  reload(): void;
}

interface PreparedStatement {
  run(params?: unknown): { changes: number };
  get(params?: unknown): unknown | undefined;
  all(params?: unknown): unknown[];
}

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

function wasmPath(): string {
  // Both extension.js and cli.js live in dist/, and the wasm file is copied there.
  const besideBundle = path.join(__dirname, "sql-wasm.wasm");
  if (fs.existsSync(besideBundle)) return besideBundle;
  // When run from source (e.g. tests via tsx), __dirname is src/store/ and the
  // copied wasm isn't there — fall back to the sql.js package's own copy.
  try {
    return require.resolve("sql.js/dist/sql-wasm.wasm");
  } catch {
    return besideBundle; // let init() throw the original, more helpful error
  }
}

async function init(): Promise<Awaited<ReturnType<typeof initSqlJs>>> {
  if (!SQL) {
    const wasm = wasmPath();
    if (!fs.existsSync(wasm)) {
      throw new Error(
        `PromptTrace: sql.js WASM not found at ${wasm}. The extension install ` +
          `may be corrupt — uninstall PromptTrace, reload the window, and reinstall. ` +
          `(If running from source, rebuild so dist/sql-wasm.wasm is copied.)`
      );
    }
    try {
      SQL = await initSqlJs({ locateFile: () => wasm });
    } catch (err) {
      throw new Error(
        `PromptTrace: could not load sql.js WASM from ${wasm}: ${
          err instanceof Error ? err.message : err
        }. On macOS, if the file is quarantined, run: ` +
          `xattr -d com.apple.quarantine "${wasm}"`
      );
    }
  }
  return SQL;
}

function toBindParams(params: unknown): BindParams | undefined {
  if (params === undefined || params === null) return undefined;
  if (Array.isArray(params)) return params;
  if (typeof params === "object" && params !== null) {
    // sql.js matches named parameters by their full name (e.g. @title).
    // repository.ts currently uses plain keys (title) for @title params.
    // Provide both forms so the binding succeeds.
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      normalized[key] = value;
      normalized[`@${key}`] = value;
    }
    return normalized as BindParams;
  }
  return [params] as BindParams;
}

class SqlJsDBAdapter implements DB {
  private inTransaction = false;

  constructor(
    private db: SqlJsDatabase,
    private readonly dbPath: string
  ) {}

  prepare(sql: string): PreparedStatement {
    const self = this;
    return {
      run(params?: unknown): { changes: number } {
        self.db.run(sql, toBindParams(params));
        const changes = self.db.getRowsModified();
        if (!self.inTransaction) self.persist();
        return { changes };
      },
      get(params?: unknown): unknown | undefined {
        const stmt = self.db.prepare(sql);
        stmt.bind(toBindParams(params) ?? []);
        const row = stmt.step() ? stmt.getAsObject() : undefined;
        stmt.free();
        return row;
      },
      all(params?: unknown): unknown[] {
        const stmt = self.db.prepare(sql);
        stmt.bind(toBindParams(params) ?? []);
        const rows: unknown[] = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        stmt.free();
        return rows;
      },
    };
  }

  transaction<T extends (...args: any[]) => void>(fn: T): T {
    const self = this;
    return ((...args: any[]) => {
      if (self.inTransaction) {
        // sql.js does not support nested transactions / savepoints. Run inline
        // so the outer transaction still governs atomicity.
        fn(...args);
        return;
      }
      self.inTransaction = true;
      self.db.run("BEGIN");
      try {
        fn(...args);
        self.db.run("COMMIT");
      } catch (err) {
        self.db.run("ROLLBACK");
        throw err;
      } finally {
        self.inTransaction = false;
        self.persist();
      }
    }) as T;
  }

  pragma(sql: string): void {
    this.db.run(sql);
  }

  close(): void {
    this.persist();
    this.db.close();
  }

  reload(): void {
    if (!SQL) {
      throw new Error("sql.js not initialized; cannot reload");
    }
    this.db.close();
    if (fs.existsSync(this.dbPath)) {
      this.db = new SQL.Database(fs.readFileSync(this.dbPath));
    } else {
      this.db = new SQL.Database();
      this.db.exec(SCHEMA_SQL);
      this.persist();
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.dbPath, Buffer.from(this.db.export()));
    } catch (err) {
      log.error(`failed to persist db to ${this.dbPath}: ${err}`);
      throw err;
    }
  }
}

/**
 * Open (creating if needed) the trace store at `storeRoot`, running migrations.
 * Uses sql.js (WASM) instead of a native SQLite binding so it works inside the
 * VS Code extension host regardless of Electron/Node version.
 */
export async function openStore(storeRoot: string): Promise<DB> {
  await init();
  fs.mkdirSync(storeRoot, { recursive: true });

  const dbPath = dbFilePath(storeRoot);
  let db: SqlJsDatabase;
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    const SQL = await init();
    db = new SQL.Database(new Uint8Array(buf));
  } else {
    const SQL = await init();
    db = new SQL.Database();
  }

  db.exec(SCHEMA_SQL);

  const current = db.exec(
    "SELECT value FROM schema_meta WHERE key = 'version'"
  )?.[0]?.values?.[0]?.[0] as string | undefined;

  if (!current) {
    db.run("INSERT INTO schema_meta(key, value) VALUES ('version', ?)", [
      String(SCHEMA_VERSION),
    ]);
  } else if (Number(current) !== SCHEMA_VERSION) {
    log.warn(`schema version ${current} → ${SCHEMA_VERSION}; no migration defined yet`);
    db.run("UPDATE schema_meta SET value = ? WHERE key = 'version'", [
      String(SCHEMA_VERSION),
    ]);
  }

  const adapter = new SqlJsDBAdapter(db, dbPath);
  return adapter;
}
