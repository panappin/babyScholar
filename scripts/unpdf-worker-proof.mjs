import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createTextPdfFixture } from "./fixtures/pdf-fixtures.mjs";

const root = resolve(import.meta.dirname, "..");
const evidenceRoot = resolve(root, ".wrangler", "unpdf-worker-proof", randomUUID());
const bundlePath = resolve(evidenceRoot, "bundle");
const buildConfig = resolve(evidenceRoot, "build-wrangler.jsonc");
const runtimeConfig = resolve(evidenceRoot, "runtime-wrangler.jsonc");
const wrangler = resolve(root, "node_modules", "wrangler", "bin", "wrangler.js");
const resultPath = resolve(evidenceRoot, "result.json");
let child;
let workerLog = "";
const result = { check: "unpdf-worker-proof", status: "failed", evidenceRoot, commands: [], errors: [] };

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  if (!address || typeof address === "string") throw new Error("Could not reserve a local Worker port.");
  return address.port;
}

function run(args, label) {
  result.commands.push({ label, args });
  return new Promise((resolveRun, reject) => {
    const childProcess = spawn(process.execPath, [wrangler, ...args], {
      cwd: root,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...globalThis.process.env, WRANGLER_SEND_METRICS: "false" },
    });
    let output = "";
    childProcess.stdout.on("data", (value) => { output += value; });
    childProcess.stderr.on("data", (value) => { output += value; });
    childProcess.once("error", reject);
    childProcess.once("exit", (code) => code === 0 ? resolveRun(output) : reject(new Error(`${label} exited ${code}: ${output}`)));
  });
}

async function waitForWorker(port) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.status === 404 && await response.text() === "Not found") return;
    } catch {
      // Starting; the deadline supplies the bounded wait.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error("The isolated UnPDF Worker did not start within 20 seconds.");
}

async function stopWorker() {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((resolveStop) => child.once("exit", resolveStop));
}

try {
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(buildConfig, JSON.stringify({
    name: "index",
    main: "../../../scripts/fixtures/unpdf-worker-proof.mjs",
    compatibility_date: "2025-09-01",
  }, null, 2));
  await run(["deploy", "--dry-run", "--config", buildConfig, "--outdir", bundlePath, "--metafile"], "Wrangler bundle");
  const workerFile = (await readdir(bundlePath)).find((entry) => entry.endsWith(".js"));
  if (!workerFile) throw new Error("Wrangler did not emit a Worker ESM entrypoint.");
  const metafile = JSON.parse(await readFile(resolve(bundlePath, "bundle-meta.json"), "utf8"));
  const bundledInputs = Object.keys(metafile.inputs);
  if (!bundledInputs.some((entry) => entry.replaceAll("\\", "/").includes("node_modules/unpdf/"))) {
    throw new Error("Wrangler bundle metadata did not include UnPDF.");
  }
  const bundle = await readFile(resolve(bundlePath, workerFile), "utf8");
  if (/from\s+["']unpdf(?:\/pdfjs)?["']/.test(bundle)) {
    throw new Error("The Wrangler artifact retained a bare UnPDF import.");
  }
  await writeFile(runtimeConfig, JSON.stringify({
    name: "unpdf-worker-proof-runtime",
    main: `./bundle/${workerFile}`,
    compatibility_date: "2025-09-01",
  }, null, 2));
  const port = await availablePort();
  result.commands.push({ label: "Wrangler local bundled Worker", args: ["dev", "--local", "--config", runtimeConfig, "--port", String(port)] });
  child = spawn(process.execPath, [wrangler, "dev", "--local", "--config", runtimeConfig, "--ip", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...globalThis.process.env, WRANGLER_SEND_METRICS: "false" },
  });
  child.stdout.on("data", (value) => { workerLog += value; });
  child.stderr.on("data", (value) => { workerLog += value; });
  await waitForWorker(port);
  const fixture = createTextPdfFixture();
  const response = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: fixture.bytes });
  const responseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`UnPDF Worker returned non-JSON for the fixture: HTTP ${response.status}.`);
  }
  if (response.status !== 200 || payload.pageCount !== 2 || payload.pages?.[0]?.text !== fixture.expected.first || payload.pages?.[1]?.text !== fixture.expected.second || typeof payload.parserVersion !== "string") {
    throw new Error(`Unexpected UnPDF Worker response: HTTP ${response.status}.`);
  }
  result.status = "passed";
  result.fixture = { source: "scripts/fixtures/pdf-fixtures.mjs", license: "CC0-1.0", pages: 2, nonAscii: "Caf\u00e9" };
  result.parserVersion = payload.parserVersion;
  result.bundle = { path: bundlePath, entry: workerFile, unpdfBundled: true, bareImportAbsent: true };
  result.response = { status: response.status, pageCount: payload.pageCount };
} catch (error) {
  result.errors.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await stopWorker();
  result.workerLog = workerLog.slice(-8_000);
  await writeFile(resultPath, JSON.stringify(result, null, 2) + "\n");
  if (result.status === "passed") console.log(`UnPDF Worker proof: PASS (${resultPath})`);
  else console.error(`UnPDF Worker proof: FAIL (${resultPath})`);
}
