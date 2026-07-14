/**
 * Capture CLI entry point — invoked by Claude Code hooks.
 *
 * Hook contract: a JSON object arrives on stdin, including at least:
 *   - hook_event_name: "UserPromptSubmit" | "Stop" | ...
 *   - session_id
 *   - cwd (the project path)
 *   - prompt (the user's text, for UserPromptSubmit)
 *
 * Flow:
 *   UserPromptSubmit → insert the prompt row (title/text/ts/session/sequence).
 *   Stop            → snapshot the workspace, diff vs last_state, attach the
 *                     net changes to the most recent unattached prompt, advance
 *                     the cursor. On the very first Stop, establish a baseline
 *                     (record the snapshot as last_state with no prompt).
 *
 * The store location is resolved from `cwd` exactly as the extension does, so
 * both agree on the same path.
 */
import * as fs from "fs";
import * as path from "path";
import { resolveStoreRoot } from "../store/resolve";
import { openStore } from "../store/db";
import { Repository } from "../store/repository";
import { snapshotWorkspace } from "./snapshot";
import { computeDiff } from "./differ";
import { log } from "../util/log";

interface HookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  prompt?: string;
  [k: string]: unknown;
}

const AGENT = "claude-code";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  return await new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    // Some hook runners close stdin immediately; guard with a short timeout.
    setTimeout(() => resolve(data), 2000);
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  let payload: HookPayload = {};
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw) as HookPayload;
    } catch (err) {
      log.error(`could not parse hook payload: ${err}`);
      log.error(`raw: ${raw.slice(0, 500)}`);
    }
  }

  const event = payload.hook_event_name ?? process.env.PROMPTTRACE_EVENT;
  const cwd = payload.cwd ?? process.env.PROMPTTRACE_CWD ?? process.cwd();
  const sessionId = payload.session_id ?? process.env.PROMPTTRACE_SESSION ?? "unknown";

  if (!event) {
    log.error("no hook_event_name in payload or env; nothing to do");
    return;
  }

  const location = (process.env.PROMPTTRACE_STORAGE ?? "global") as "workspace" | "global";
  const storeRoot = resolveStoreRoot(cwd, location);
  const db = await openStore(storeRoot);
  const repo = new Repository(db, storeRoot);

  // Settings are normally written to settings_kv by the extension; fall back
  // to safe defaults if the CLI runs before the extension has.
  const excludePatterns = repo.getSettingJSON<string[]>("excludePatterns", [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/.hie/**",
    "**/dist-newstyle/**",
  ]);
  const maxFileSizeBytes =
    Number(repo.getSetting("maxFileSizeBytes") ?? 1024 * 1024);

  if (event === "UserPromptSubmit") {
    await handleUserPromptSubmit(repo, payload.prompt ?? "", sessionId);
  } else if (event === "Stop") {
    await handleStop(repo, storeRoot, cwd, sessionId, excludePatterns, maxFileSizeBytes);
  } else {
    log.info(`ignoring event ${event}`);
  }

  db.close();

  // We've consumed stdin (or timed out). If the hook runner keeps the stdin
  // pipe open after sending the payload — Claude Code's Stop hook does — the
  // still-attached listeners keep Node's event loop alive and the process
  // never exits, so Claude Code shows the hook as "running" until its own
  // timeout. Destroy stdin and exit explicitly so completion always signals.
  process.stdin.destroy();
  process.exit(0);
}

async function handleUserPromptSubmit(
  repo: Repository,
  promptText: string,
  sessionId: string
): Promise<void> {
  const title = deriveTitle(promptText);
  const sequence = repo.maxSequence() + 1;
  const id = `${sessionId}-${sequence}`;
  const timestamp = Date.now();

  repo.addPrompt({
    id,
    title,
    text: promptText || null,
    timestamp,
    agent: AGENT,
    sessionId,
    sequence,
  });
  log.info(`UserPromptSubmit recorded: ${id} "${title}"`);
}

async function handleStop(
  repo: Repository,
  storeRoot: string,
  cwd: string,
  sessionId: string,
  excludePatterns: string[],
  maxFileSizeBytes: number
): Promise<void> {
  const { entries } = await snapshotWorkspace({
    workspacePath: cwd,
    excludePatterns,
    maxFileSizeBytes,
  });

  const prev = repo.getLastState();

  if (prev.size === 0) {
    // No cursor yet: establish the baseline. Write blobs for every file so the
    // next prompt's diff has real before-content to compare against. This
    // fires on the first Stop ever (and after Clear All), regardless of
    // whether a prompt is already pending — a pending UserPromptSubmit does
    // NOT constitute a baseline, so we must seed rather than diff against an
    // empty cursor (which would mark every file as added).
    const baselineContents = new Map<string, Buffer>();
    for (const e of entries) {
      try {
        baselineContents.set(e.path, await readFileSafe(path.join(cwd, e.path)));
      } catch {
        // skip unreadable
      }
    }
    repo.seedBaseline(entries, baselineContents);
    return;
  }

  const pending = repo.latestUnattachedPrompt(sessionId);
  if (!pending) {
    // No pending prompt (e.g. Stop fired without a UserPromptSubmit, or already
    // attached). Still advance the cursor so future diffs stay accurate, but
    // don't fabricate a prompt.
    const { changes, nextSnapshot } = await computeDiff(
      cwd,
      storeRoot,
      prev,
      entries
    );
    repo.attachChanges("__orphan__", [], nextSnapshot, new Map());
    log.info(
      `Stop with no pending prompt; cursor advanced${changes.length ? ` (${changes.length} unattributed change(s))` : ""}`
    );
    return;
  }

  const { changes, afterContents, nextSnapshot } = await computeDiff(
    cwd,
    storeRoot,
    prev,
    entries
  );

  repo.attachChanges(pending.id, changes, nextSnapshot, afterContents);
  log.info(
    `Stop attributed ${changes.length} change(s) to prompt ${pending.id} "${pending.title}"`
  );
}

function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "(empty prompt)";
  return clean.length > 60 ? clean.slice(0, 57) + "…" : clean;
}

async function readFileSafe(absPath: string): Promise<Buffer> {
  return fs.promises.readFile(absPath);
}

main().catch((err) => {
  log.error(`capture CLI failed: ${err?.stack ?? err}`);
  // Hooks must not block the agent — exit 0 regardless of capture failure.
  process.stdin.destroy();
  process.exit(0);
});
