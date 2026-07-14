import * as fs from "fs";
import * as os from "os";
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
 * Installs/updates PromptTrace hooks into the user-level Claude Code settings
 * file: ~/.claude/settings.json (the home-dir location, not a per-project file
 * in the current working directory).
 *
 * A single user-level install covers every project on this machine: the hook
 * command launches the capture CLI, which resolves the per-project store from
 * its cwd (see resolveStoreRoot), so one hook block traces all projects without
 * any per-project setup. We use settings.json (the shared user Claude settings)
 * per request; the hook command does carry an absolute, machine-specific path
 * to this machine's built dist/cli.js, but the file lives in the home dir and
 * is only shared across machines if the user explicitly dotfile-syncs it.
 *
 * PROMPTTRACE_CLAUDE_HOME (test-only) overrides the home dir so tests target a
 * temp dir instead of the real ~/.claude/settings.json.
 */
function claudeSettingsFile(): string {
  const home = process.env.PROMPTTRACE_CLAUDE_HOME ?? os.homedir();
  return path.join(home, ".claude", "settings.json");
}

/**
 * The LEGACY per-project location a prior version installed hooks into:
 * <workspace>/.claude/settings.local.json. We strip our hooks out of it on
 * install/uninstall so an upgrade does not leave duplicates (project-local +
 * user-level) that would fire the CLI twice per event.
 */
function legacySettingsFile(workspacePath: string): string {
  return path.join(workspacePath, ".claude", "settings.local.json");
}

export async function installHooks(
  workspacePath: string,
  cliPath: string
): Promise<{ installed: boolean; file: string }> {
  const settingsFile = claudeSettingsFile();
  await fs.promises.mkdir(path.dirname(settingsFile), { recursive: true });

  const settings = await readJsonSafe(settingsFile);
  const command = buildHookCommand(cliPath);

  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  for (const event of HOOK_EVENTS) {
    hooks[event] = upsertEvent(hooks[event], event, command);
  }
  settings.hooks = hooks;

  await writeSettingsFile(settingsFile, settings);
  log.info("hooks installed into " + settingsFile);

  // Clean up any hooks a prior version left in the legacy project-local file so
  // they don't double-fire alongside this user-level install.
  await removeOurHooksFromFile(legacySettingsFile(workspacePath));

  return { installed: true, file: settingsFile };
}

/** Remove our hooks from the user-level settings file (and the legacy location). */
export async function uninstallHooks(
  workspacePath: string
): Promise<{ removed: boolean; file: string }> {
  const settingsFile = claudeSettingsFile();
  const removed = await removeOurHooksFromFile(settingsFile);
  // Also clean the legacy project-local location if it still holds our hooks.
  await removeOurHooksFromFile(legacySettingsFile(workspacePath));
  return { removed, file: settingsFile };
}

/** True if our hooks are present and point at `cliPath`. */
export async function hooksInstalled(cliPath: string): Promise<boolean> {
  const settingsFile = claudeSettingsFile();
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

/**
 * Strip our hook entries from a single settings file, preserving unrelated
 * hooks. Returns true if anything was removed. No-op if the file is absent
 * or holds none of our hooks.
 */
async function removeOurHooksFromFile(file: string): Promise<boolean> {
  const settings = await readJsonSafe(file);
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
  if (!removed) return false;
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  await writeSettingsFile(file, settings);
  log.info("hooks removed from " + file);
  return true;
}

/** Write a settings object back as pretty JSON with a trailing newline. */
async function writeSettingsFile(file: string, settings: Record<string, unknown>): Promise<void> {
  await fs.promises.writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
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
