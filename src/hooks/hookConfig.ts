import * as path from "path";

/**
 * The marker we leave in a hook command so we can recognize (and update) our
 * own hooks without trampling user-configured ones.
 */
export const HOOK_MARKER = "prompttrace";

/** Events we install handlers for. */
export const HOOK_EVENTS = ["UserPromptSubmit", "Stop"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/**
 * The command Claude Code will run for each event. We pipe nothing on stdin
 * except the hook's own JSON payload (Claude Code provides it). The CLI reads
 * `cwd`/`session_id`/`hook_event_name` from that payload.
 */
export function buildHookCommand(cliPath: string): string {
  // Quote the script path for safety; node is expected on PATH. A trailing
  // marker comment lets us recognize our own hook entries across runs.
  const safe = JSON.stringify(cliPath);
  return `node ${safe} # ${HOOK_MARKER}`;
}

/**
 * A recognizable shape for our installed hook block, so the installer can find
 * and update it across runs without touching unrelated hooks.
 */
export interface InstalledHookBlock {
  matcher: string;
  hooks: Array<{ type: "command"; command: string }>;
}

/** Whether a hook entry belongs to us (contains our marker in its command). */
export function isOurHook(entry: unknown): boolean {
  try {
    const e = entry as { hooks?: Array<{ command?: string }> };
    return (e.hooks ?? []).some((h) => (h.command ?? "").includes(HOOK_MARKER));
  } catch {
    return false;
  }
}

export function cliPathFor(extensionPath: string): string {
  return path.join(extensionPath, "dist", "cli.js");
}
