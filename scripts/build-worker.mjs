import { spawn } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const outdir = resolve(root, "dist/worker");
const wrangler = resolve(root, "node_modules/wrangler/bin/wrangler.js");

// Wrangler's dry-run bundler resolves Worker dependencies into the same ESM
// artifact copied into dist/server for Sites. `tsc` still performs type checks
// in npm run typecheck; it is not a deployable dependency bundler.
await rm(outdir, { recursive: true, force: true });
const child = spawn(process.execPath, [wrangler, "deploy", "--dry-run", "--config", "wrangler.jsonc", "--outdir", outdir, "--metafile"], {
  cwd: root,
  windowsHide: true,
  stdio: "inherit",
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
});
const exitCode = await new Promise((resolveExit, reject) => {
  child.once("error", reject);
  child.once("exit", resolveExit);
});
if (exitCode !== 0) process.exitCode = exitCode ?? 1;
else {
  await access(resolve(outdir, "index.js"));
  await access(resolve(outdir, "bundle-meta.json"));
  console.log("Bundled Worker artifact: PASS (dry run; no upload performed).");
}
