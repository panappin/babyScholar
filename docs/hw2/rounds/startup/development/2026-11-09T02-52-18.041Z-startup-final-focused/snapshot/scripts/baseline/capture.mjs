// Bounded, timestamped evidence for HW2 extension commands; never overwrite a run.
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, writeFile, cp } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { cpus } from 'node:os';

const root = resolve(import.meta.dirname, '../..');
const [label, timeoutArgument, program, ...arguments_] = process.argv.slice(2);
const timeoutMs = Number(timeoutArgument);
if (!/^[a-z0-9-]+$/u.test(label ?? '') || !Number.isInteger(timeoutMs) || timeoutMs < 1
  || !['npm', 'node'].includes(program)) {
  throw new Error('Usage: node scripts/baseline/capture.mjs LABEL TIMEOUT_MS npm|node ARGS...');
}
const output = resolve(root, 'artifacts/hw2-extension', `${new Date().toISOString().replaceAll(':', '-')}-${label}`);
await mkdir(output, { recursive: true });
const snapshot = resolve(output, 'snapshot');
await mkdir(snapshot);
for (const path of ['package.json', 'package-lock.json', 'vitest.config.ts', 'tests', 'src', 'scripts/frontend-search-browser-check.mjs']) {
  await mkdir(dirname(resolve(snapshot, path)), { recursive: true });
  await cp(resolve(root, path), resolve(snapshot, path), { recursive: true });
}
for (const path of ['scripts/local-dev.mjs', 'scripts/startup-readiness.mjs', 'tsconfig.tests.json', 'tsconfig.provider-tests.json', 'tsconfig.worker.json', 'tsconfig.app.json',
  'worker-configuration.d.ts', 'drizzle', 'scripts/baseline',
  'scripts/baseline/browser-experiment.mjs', 'scripts/baseline/workflow-fault-probes.mjs', 'scripts/baseline/probe-vite.mjs']) {
  if (existsSync(resolve(root, path))) {
    await mkdir(dirname(resolve(snapshot, path)), { recursive: true });
    await cp(resolve(root, path), resolve(snapshot, path), { recursive: true });
  }
}
const npm = process.env.npm_execpath ?? resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
if (program === 'npm' && !existsSync(npm)) throw new Error('Cannot locate the current npm CLI. Run via npm exec.');
const isTest = program === 'npm' && arguments_[0] === 'run' && ['test', 'test:coverage'].includes(arguments_[1]);
if (isTest) {
  if (!arguments_.includes('--')) arguments_.push('--');
  arguments_.push('--reporter=default', '--reporter=json', `--outputFile=${resolve(output, 'test-results.json')}`);
}
const args = program === 'npm' ? [npm, ...arguments_] : arguments_;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { label, startedAt: new Date().toISOString(), timeoutMs, command: [process.execPath, ...args],
  baseCommit: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), sourceTree: git('rev-parse', 'HEAD:src'),
  workingTree: git('status', '--short'), node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
  timedOut: false, output: relative(root, output).replaceAll('\\', '/') };
await writeFile(resolve(output, 'command.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Command evidence: ${report.output}`);
const log = createWriteStream(resolve(output, 'command.log'));
const child = spawn(process.execPath, args, { cwd: root, windowsHide: true,
  env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const timer = setTimeout(() => {
  report.timedOut = true;
  if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}, timeoutMs);
const result = await new Promise(resolveResult => {
  child.once('error', error => resolveResult({ exitCode: null, error: error.message }));
  child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal }));
});
clearTimeout(timer);
await new Promise(done => log.end(done));
if (isTest && arguments_[1] === 'test:coverage' && existsSync(resolve(root, 'coverage/baseline/coverage-summary.json'))) {
  await mkdir(resolve(output, 'coverage'));
  for (const name of ['coverage-summary.json', 'coverage-final.json', 'lcov.info']) {
    await cp(resolve(root, 'coverage/baseline', name), resolve(output, 'coverage', name));
  }
}
Object.assign(report, result, { finishedAt: new Date().toISOString() });
await writeFile(resolve(output, 'command.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`${label}: exit=${result.exitCode}, timedOut=${report.timedOut}`);
process.exitCode = result.exitCode === 0 && !report.timedOut ? 0 : 1;
