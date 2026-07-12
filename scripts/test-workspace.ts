/**
 * Tests for the toWorkspaceRel helper (pure, no VS Code host needed).
 */
import * as path from "path";
import { toWorkspaceRel } from "../src/util/workspace";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log("  ok:", msg);
}

async function main(): Promise<void> {
  const ws = process.platform === "win32" ? "C:\\proj" : "/proj";

  // top-level file in workspace
  assert(
    toWorkspaceRel(ws, { scheme: "file", fsPath: path.join(ws, "app.ts") }) === "app.ts",
    "top-level file → rel path"
  );

  // nested file
  assert(
    toWorkspaceRel(ws, { scheme: "file", fsPath: path.join(ws, "src", "login.ts") }) === "src/login.ts",
    "nested file → POSIX rel path"
  );

  // outside workspace → null
  assert(
    toWorkspaceRel(ws, { scheme: "file", fsPath: path.join(path.dirname(ws), "other", "x.ts") }) === null,
    "file outside workspace → null"
  );

  // non-file URI → null (e.g. the prompttrace: diff docs)
  assert(
    toWorkspaceRel(ws, { scheme: "prompttrace", fsPath: "/whatever" }) === null,
    "non-file URI → null"
  );

  // the workspace root itself → null (not a file under it)
  assert(toWorkspaceRel(ws, { scheme: "file", fsPath: ws }) === null, "workspace root → null");

  console.log("\nALL WORKSPACE TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
