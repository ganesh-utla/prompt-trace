/**
 * Standalone smoke test for the storage layer (no VS Code host required).
 * Run: npx ts-node scripts/test-store.ts   (or compile + node)
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openStore } from "../src/store/db";
import { Repository } from "../src/store/repository";
import { writeBlob, readBlobText } from "../src/store/blobs";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log("  ok:", msg);
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pt-test-"));
  const storeRoot = path.join(tmp, ".prompt-trace");
  console.log("store:", storeRoot);

  const db = await openStore(storeRoot);
  const repo = new Repository(db, storeRoot);

  // blobs
  const h1 = writeBlob(storeRoot, Buffer.from("hello world"));
  assert(readBlobText(storeRoot, h1) === "hello world", "blob round-trips");
  const h1b = writeBlob(storeRoot, Buffer.from("hello world"));
  assert(h1 === h1b, "blob dedup returns same hash");

  // prompt + file changes
  const now = Date.now();
  repo.recordPrompt(
    {
      id: "p1",
      title: "add login",
      text: "add a login page",
      timestamp: now,
      agent: "claude-code",
      sessionId: "s1",
      sequence: 0,
    },
    [
      {
        path: "src/login.ts",
        beforeHash: null,
        afterHash: h1,
        patch: "+hello world",
        additions: 1,
        deletions: 0,
        status: "added",
      },
    ],
    [{ path: "src/login.ts", hash: h1 }],
    new Map([["src/login.ts", Buffer.from("hello world")]])
  );

  assert(repo.countPrompts() === 1, "one prompt stored");
  const prompts = repo.listPrompts();
  assert(prompts[0].title === "add login", "prompt title readable");

  const changes = repo.changesForPrompt("p1");
  assert(changes.length === 1, "one file change for p1");
  assert(changes[0].path === "src/login.ts", "change path correct");
  assert(changes[0].status === "added", "change status correct");

  const hist = repo.historyForFile("src/login.ts");
  assert(hist.length === 1, "file history has one entry");
  assert(hist[0].prompt.id === "p1", "history joins to prompt");

  // last-state cursor
  const ls = repo.getLastState();
  assert(ls.get("src/login.ts") === h1, "last-state cursor reflects snapshot");

  // settings kv
  repo.setSetting("excludePatterns", JSON.stringify(["**/node_modules/**"]));
  assert(
    JSON.stringify(repo.getSettingJSON("excludePatterns", [])) === JSON.stringify(["**/node_modules/**"]),
    "settings kv round-trips JSON"
  );

  // clear
  repo.clearAll();
  assert(repo.countPrompts() === 0, "clearAll empties prompts");

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\nALL STORAGE TESTS PASSED");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
