import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, ".openai/hosting.json");
const hosting = JSON.parse(await readFile(manifestPath, "utf8"));
if (!hosting.project_id || hosting.d1 !== "DB" || hosting.r2 !== "PAPER_BUCKET") {
  throw new Error("Sites needs its registered project ID and the existing storage bindings.");
}

// Keep the original build outputs and stage all sibling Worker modules for Sites.
for (const [source, destination] of [["frontend", "client"], ["worker", "server"]]) {
  const target = resolve(root, "dist", destination);
  await rm(target, { recursive: true, force: true });
  await cp(resolve(root, "dist", source), target, { recursive: true });
}

const metadata = resolve(root, "dist/.openai");
await rm(metadata, { recursive: true, force: true });
await mkdir(metadata, { recursive: true });
await cp(manifestPath, resolve(metadata, "hosting.json"));
await cp(resolve(root, "drizzle"), resolve(metadata, "drizzle"), { recursive: true });

// Production bindings come from Sites, never from the local placeholder IDs.
await writeFile(resolve(root, "dist/server/wrangler.json"), JSON.stringify({
  name: "ai-research-assistant",
  main: "index.js",
  compatibility_date: "2025-09-01",
  assets: {
    directory: "../client",
    binding: "ASSETS",
    run_worker_first: ["/api/*"],
    not_found_handling: "none",
  },
}, null, 2) + "\n");

console.log("Prepared dist/client, full dist/server, and immutable migration metadata for Sites.");
