import * as fs from "fs";
import * as path from "path";
import { log } from "../util/log";
import {
  HOOK_EVENTS,
  HOOK_MARKER,
  buildHookCommand,
  isOurHook,
  type HookEvent,
} from "./hookConfig";

/**
 * Installs/updates PromptTrace hooks into a Claude Code settings file.
 *
 * We install into `.claude/settings.local.json` (machine-local, conventionally
 * gitignored) rather than the shared `.claude/settings.json`, because the hook
 * command contains an absolute path to this machine's built `dist/cli.js` — it
 * must not be committed. This is a deliberate, documented deviation from the
 * plan (which suggested project `settings.json`); the rationale is that shared
 * settings should stay machine-agnostic.
 */
export async function installHooks(
  workspacePath: string,
  cliPath: string
): Promise<{ installed: boolean; file: string }> {
  const claudeDir = path.join(workspacePath, ".claude");
  const settingsFile = path.join(claudeDir, "settings.local.json");
  await fs.promises.mkdir(claudeDir, { recursive: true });

  const settings = await readJsonSafe(settingsFile);
  const command = buildHookCommand(cliPath);

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  for (const event of HOOK_EVENTS) {
    hooks[event] = upsertEvent(hooks[event], event, command);
  }
  settings.hooks = hooks;

  await fs.promises.writeFile(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
  log.info(`hooks installed into ${settingsFile}`);
  return { installed: true, file: settingsFile };
}

/** Remove our hooks from the settings file. */
export async function uninstallHooks(
  workspacePath: string
): Promise<{ removed: boolean; file: string }> {
  const settingsFile = path.join(workspacePath, ".claude", "settings.local.json");
  const settings = await readJsonSafe(settingsFile);
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  let removed = false;
  for (const event of HOOK_EVENTS) {
    const list = hooks[event];
    if (Array.isArray(list)) {
      const filtered = list.filter((e) => !isOurHook(e));
      if (filtered.length !== list.length) removed = true;
      if (filtered.length) hooks[event] = filtered;
      else delete hooks[event];
    }
  }
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;

  await fs.promises.writeFile(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf8");
  log.info(`hooks removed from ${settingsFile} (changed=${removed})`);
  return { removed, file: settingsFile };
}

/** True if our hooks are present and point at `cliPath`. */
export async function hooksInstalled(
  workspacePath: string,
  cliPath: string
): Promise<boolean> {
  const settingsFile = path.join(workspacePath, ".claude", "settings.local.json");
  const settings = await readJsonSafe(settingsFile);
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  const expected = buildHookCommand(cliPath);
  for (const event of HOOK_EVENTS) {
    const list = hooks[event];
    if (!Array.isArray(list)) return false;
    const ours = list.filter(isOurHook);
    if (ours.length !== 1) return false;
    const cmd = ((ours[0] as { hooks: Array<{ command: string }> }).hooks ?? []).find(
      (h) => h.command.includes(HOOK_MARKER)
    );
    if (!cmd || cmd.command !== expected) return false;
  }
  return true;
}

function upsertEvent(
  existing: unknown[] | undefined,
  _event: HookEvent,
  command: string
): unknown[] {
  const list = Array.isArray(existing) ? [...existing] : [];
  // Remove any prior entry of ours, then append the fresh one.
  const withoutOurs = list.filter((e) => !isOurHook(e));
  withoutOurs.push({
    matcher: "",
    hooks: [{ type: "command", command }],
  });
  return withoutOurs;
}

async function readJsonSafe(file: string): Promise<Record<string, unknown>> {
  try {
    const txt = await fs.promises.readFile(file, "utf8");
    return txt.trim() ? (JSON.parse(txt) as Record<string, unknown>) : {};
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    log.warn(`could not parse ${file}: ${err}; starting fresh`);
    return {};
  }
}
