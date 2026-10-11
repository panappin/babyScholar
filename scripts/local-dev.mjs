import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, lstat, realpath, unlink } from "node:fs/promises";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
export const root = resolve(import.meta.dirname, "..");
const script = fileURLToPath(import.meta.url);
const registry = resolve(root, ".wrangler/dev-session.json");
const state = resolve(root, ".wrangler/state");
const normalize = (value) => value.replaceAll("\\", "/").toLowerCase();

export async function windowsProcesses() {
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(node|workerd|cmd)\\.exe$' } | Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress"], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  const data = JSON.parse(stdout || "[]");
  return Array.isArray(data) ? data : [data];
}

export async function assertProjectStopped() {
  if (process.platform !== "win32") {
    // Never infer absence from a stale marker alone on POSIX either.
    const { stdout } = await exec("ps", ["-ax", "-o", "pid=,command="]);
    if (stdout.split("\n").some((line) => line.includes(root) && /wrangler|vite|local-dev\.mjs run/u.test(line))) throw new Error("A project dev process is still running. Stop it before resetting local storage.");
    return;
  }
  const processes = await windowsProcesses();
  const active = processes.filter((entry) => {
    const command = normalize(entry.CommandLine ?? "");
    return command.includes(normalize(root) + "/") && /wrangler|workerd|vite|local-dev\.mjs.* run/u.test(command);
  });
  if (active.length) throw new Error(`Project dev processes are still running (PIDs ${active.map((entry) => entry.ProcessId).join(", ")}). Close their owning terminals or use dev:stop for a managed session.`);
}

/** Exported for disposable-state checks. A failed move NEVER reaches migration. */
export async function resetStorage({ statePath, backupRoot, assertStopped, migrate, move = rename }) {
  await assertStopped();
  const runtimeRoot = await realpath(resolve(root, ".wrangler"));
  const target = resolve(statePath);
  if (!target.startsWith(runtimeRoot + sep) || target === runtimeRoot || !resolve(backupRoot).startsWith(runtimeRoot + sep)) throw new Error("Reset targets must stay inside this project's local runtime directory.");
  const parent = await realpath(dirname(target));
  if (parent !== dirname(target)) throw new Error("Reset refuses redirected state paths.");
  let info;
  try { info = await lstat(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error("Reset requires an ordinary state directory.");
  await mkdir(backupRoot, { recursive: true });
  if (await realpath(backupRoot) !== resolve(backupRoot)) throw new Error("Reset refuses redirected backup paths.");
  const backup = resolve(backupRoot, `state-${Date.now()}-${randomUUID()}`);
  if (info) await move(target, backup); // Access denied/lock => stop here.
  await assertStopped();
  await mkdir(target, { recursive: true });
  try { await migrate(target); }
  catch { throw new Error(`Fresh-state migrations failed. Existing records remain in the backup: ${info ? backup : "no prior state"}. Do not assume reset succeeded.`); }
  return { backup: info ? backup : null, state: target };
}

export async function stopSession(sessionFile = registry) {
  const session = JSON.parse(await readFile(sessionFile, "utf8"));
  if (session.root !== root || !/^[a-f0-9-]{36}$/u.test(session.token)) throw new Error("Unrecognized project session; refusing process termination.");
  if (process.platform === "win32") {
    const processes = await windowsProcesses();
    const owner = processes.find((entry) => entry.ProcessId === session.pid);
    if (owner) {
      const command = normalize(owner.CommandLine ?? "");
      if (!command.includes(normalize(script)) || !command.includes(`--session=${session.token}`) || !command.includes(" run ")) throw new Error("PID ownership changed; refusing process termination.");
      await exec("taskkill.exe", ["/PID", String(session.pid), "/T", "/F"], { windowsHide: true });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if (!(await windowsProcesses()).some((entry) => entry.ProcessId === session.pid)) break;
        await delay(100);
      }
      if ((await windowsProcesses()).some((entry) => entry.ProcessId === session.pid)) throw new Error("Owned session did not stop; do not reset storage.");
    }
  } else {
    const { stdout } = await exec("ps", ["-p", String(session.pid), "-o", "command="]).catch(() => ({ stdout: "" }));
    if (stdout) {
      if (!stdout.includes(script) || !stdout.includes(`--session=${session.token}`)) throw new Error("PID ownership changed; refusing process termination.");
      process.kill(session.pid, "SIGTERM");
    }
  }
  await unlink(sessionFile).catch((error) => { if (error.code !== "ENOENT") throw error; });
  console.log("Stopped only the verified project dev session.");
}

function launch(args, options = {}) {
  return spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: "inherit", ...options });
}

async function main() {
  const command = process.argv[2] ?? "start";
  if (command === "start") {
    await assertProjectStopped();
    const child = launch([script, "run", `--session=${randomUUID()}`]);
    process.on("SIGINT", () => {});
    process.on("SIGTERM", () => { void stopSession().catch(() => child.kill()); });
    child.once("exit", (code) => { process.exitCode = code ?? 0; });
    return;
  }
  if (command === "run") {
    const token = process.argv.find((arg) => arg.startsWith("--session="))?.slice(10);
    if (!token) throw new Error("Missing session identity.");
    const testRegistry = process.argv.find((arg) => arg.startsWith("--check-registry="))?.slice(17);
    const sessionPath = testRegistry ? resolve(testRegistry) : registry;
    if (testRegistry && !sessionPath.startsWith(resolve(root, ".wrangler/local-reset-check") + sep)) throw new Error("Invalid check registry.");
    const checkPort = (name) => {
      const value = Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1]);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) throw new Error("Invalid owned check port.");
      return String(value);
    };
    const workerPort = testRegistry ? checkPort("check-worker-port") : "8787";
    const frontendArgs = testRegistry ? ["--host", "127.0.0.1", "--port", checkPort("check-vite-port")] : [];
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, JSON.stringify({ root, token, pid: process.pid }));
    const children = [
      launch([resolve(root, "node_modules/wrangler/bin/wrangler.js"), "dev", "--config", "wrangler.jsonc", "--local", "--persist-to", testRegistry ? relative(root, resolve(dirname(sessionPath), "state")) : ".wrangler/state", "--port", workerPort,
        ...(testRegistry ? ["--ip", "127.0.0.1", "--var", "OPENAI_API_KEY:", "--inspector-port", "0", "--show-interactive-dev-session=false"] : [])]),
      launch([resolve(root, "node_modules/vite/bin/vite.js"), "--strictPort", ...frontendArgs], testRegistry ? { env: { ...process.env, LOCAL_WORKER_ORIGIN: `http://127.0.0.1:${workerPort}` } } : {}),
    ];
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      for (const child of children) {
        if (child.exitCode !== null) continue;
        if (process.platform === "win32") await exec("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
        else child.kill("SIGTERM");
      }
      await unlink(sessionPath).catch(() => {});
    };
    process.on("SIGINT", () => { void stop(); });
    process.on("SIGTERM", () => { void stop(); });
    for (const child of children) { child.once("exit", () => { void stop(); }); child.once("error", () => { process.exitCode = 1; void stop(); }); }
    return;
  }
  if (command === "stop") return stopSession();
  if (command === "reset") {
    if (!process.argv.includes("--confirm-reset")) throw new Error("Use npm.cmd run storage:reset -- --confirm-reset after stopping local dev. Existing local state will be backed up.");
    await mkdir(resolve(root, ".wrangler"), { recursive: true });
    const result = await resetStorage({ statePath: state, backupRoot: resolve(root, ".wrangler/state-backups"), assertStopped: assertProjectStopped,
      migrate: async (target) => {
        const child = launch([resolve(root, "node_modules/wrangler/bin/wrangler.js"), "d1", "migrations", "apply", "DB", "--config", "wrangler.jsonc", "--local", "--persist-to", relative(root, target)]);
        const code = await new Promise((done, fail) => { child.once("error", fail); child.once("exit", done); });
        if (code !== 0) throw new Error("Migration failed.");
      } });
    console.log(JSON.stringify({ reset: "complete", ...result }));
    return;
  }
  throw new Error("Unknown local dev command.");
}

if (resolve(process.argv[1] ?? "") === script) await main().catch((error) => { console.error(error.message); process.exitCode = 1; });
