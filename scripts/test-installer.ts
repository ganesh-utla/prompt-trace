/**
 * Tests the hook installer: install, detect, idempotent update, preserve
 * unrelated hooks, uninstall. No VS Code host required.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { installHooks, uninstallHooks, hooksInstalled } from "../src/hooks/installer";
import { buildHookCommand, HOOK_MARKER } from "../src/hooks/hookConfig";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log("  ok:", msg);
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pt-hooks-"));
  // Isolate from the real ~/.claude/settings.json: install into <tmp>/.claude/.
  process.env.PROMPTTRACE_CLAUDE_HOME = tmp;
  const cliPath = path.join(tmp, "ext", "dist", "cli.js");
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(cliPath, "// stub");

  // Pre-existing user hook in settings.json that must be preserved.
  const settingsFile = path.join(tmp, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        permissions: { allow: ["Bash(npm install *)"] },
        hooks: {
          Stop: [
            {
              matcher: "",
              hooks: [{ type: "command", command: 'echo "user stop hook"' }],
            },
          ],
        },
      },
      null,
      2
    )
  );

  // Install
  await installHooks(tmp, cliPath);
  const after = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert(!!after.hooks?.Stop, "Stop hooks present after install");
  assert(!!after.hooks?.UserPromptSubmit, "UserPromptSubmit hooks present");
  assert(after.permissions.allow.length === 1, "existing permissions preserved");

  const stopHooks = after.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
  const ours = stopHooks.find((e) => e.hooks.some((h) => h.command.includes(HOOK_MARKER)));
  assert(!!ours, "our Stop hook installed");
  const userHook = stopHooks.find((e) => e.hooks.some((h) => h.command.includes("user stop")));
  assert(!!userHook, "user's Stop hook preserved");

  assert(await hooksInstalled(cliPath), "hooksInstalled reports true after install");
  assert(!(await hooksInstalled(cliPath + "x")), "hooksInstalled false for wrong path");

  // Idempotent re-install: should not duplicate our hook.
  await installHooks(tmp, cliPath);
  const after2 = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const oursCount = (after2.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>).filter(
    (e) => e.hooks.some((h) => h.command.includes(HOOK_MARKER))
  ).length;
  assert(oursCount === 1, "re-install does not duplicate our hook");

  // Update: change cliPath -> our command updates, user hook stays.
  const cliPath2 = path.join(tmp, "ext2", "dist", "cli.js");
  await installHooks(tmp, cliPath2);
  const after3 = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const stop3 = after3.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
  const oursCmd = stop3.find((e) => e.hooks.some((h) => h.command.includes(HOOK_MARKER)))!
    .hooks[0].command;
  assert(oursCmd.includes("ext2"), "our hook command updated to new cliPath");
  assert(await hooksInstalled(cliPath2), "hooksInstalled true for new path");

  // Uninstall: removes ours, keeps user's.
  await uninstallHooks(tmp);
  const after4 = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  const stop4 = after4.hooks.Stop as Array<{ hooks: Array<{ command: string }> }>;
  const oursCount4 = stop4.filter((e) => e.hooks.some((h) => h.command.includes(HOOK_MARKER))).length;
  assert(oursCount4 === 0, "uninstall removes our hook");
  const userKept = stop4.some((e) => e.hooks.some((h) => h.command.includes("user stop")));
  assert(userKept, "uninstall keeps user hook");
  assert(!after4.hooks.UserPromptSubmit, "our UserPromptSubmit removed entirely");

  // Command shape sanity
  assert(buildHookCommand(cliPath).includes(HOOK_MARKER), "command contains marker");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nALL INSTALLER TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
