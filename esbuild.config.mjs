import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

const prod = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const shared = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: !prod,
  minify: prod,
  logLevel: "info",
  external: ["vscode"],
};

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
};

/** @type {esbuild.BuildOptions} */
const cliConfig = {
  ...shared,
  entryPoints: ["src/capture/cli.ts"],
  outfile: "dist/cli.js",
};

async function copyWasm() {
  const src = path.join("node_modules", "sql.js", "dist", "sql-wasm.wasm");
  const dest = path.join("dist", "sql-wasm.wasm");
  fs.copyFileSync(src, dest);
  console.log("[esbuild] copied sql-wasm.wasm to dist/");
}

async function main() {
  if (watch) {
    const ctxExt = await esbuild.context(extensionConfig);
    const ctxCli = await esbuild.context(cliConfig);
    await Promise.all([ctxExt.watch(), ctxCli.watch()]);
    await copyWasm();
    console.log("[esbuild] watching extension + cli");
  } else {
    await esbuild.build(extensionConfig);
    await esbuild.build(cliConfig);
    await copyWasm();
    console.log("[esbuild] built extension + cli");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
