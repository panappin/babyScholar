import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';

const root = resolve(import.meta.dirname, '../..');
const stamp = new Date().toISOString().replaceAll(':', '-');
const output = resolve(root, process.argv[2] ?? `artifacts/baseline/${stamp}`);
await mkdir(output, { recursive: true });
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run via npm run baseline, so the same npm installation is used.');
const command = (script) => [npm, 'run', script];
const steps = [
  ['build', command('build')],
  ['papers', command('papers')],
  ['integrations', command('integrations')],
  ...['question-text', 'document-details-timeout', 'library', 'document', 'document-delete', 'extraction', 'metadata', 'summary', 'question', 'metadata-live-verifier', 'local-reset', 'frontend-search-browser', 'sites-artifact'].map(name => [name, [`scripts/${name}-check.mjs`]]),
  ['generated-suite-coverage', [npm, 'run', 'test:coverage']],
  ['profile-prepare', command('checks:prepare')],
  ['profile', ['--cpu-prof', `--cpu-prof-dir=${output}`, '--cpu-prof-name=baseline.cpuprofile', 'scripts/baseline/profile.mjs', output]],
];
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const report = { timestamp: new Date().toISOString(), baseCommit: git('rev-parse', 'HEAD'), workingTreeAtStart: git('status', '--short'), sourceTree: git('rev-parse', 'HEAD:src'), node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), steps: [] };
const save = () => writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
await save();
for (const [name, args] of steps) {
  console.log(`BASELINE ${name}`);
  if (name === 'generated-suite-coverage') await rm(resolve(root, 'coverage/baseline'), { recursive: true, force: true });
  const log = createWriteStream(resolve(output, `${name}.log`));
  const start = performance.now();
  const result = await new Promise(resolveResult => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.once('error', error => { log.write(String(error)); resolveResult({ exitCode: null, error: String(error) }); });
    child.once('close', (exitCode, signal) => resolveResult({ exitCode, signal }));
  });
  await new Promise(resolveEnd => log.end(resolveEnd));
  report.steps.push({ name, command: [process.execPath, ...args], ...result, status: result.exitCode === 0 ? 'passed' : 'failed', wallMs: performance.now() - start, log: `${name}.log` });
  if (name === 'generated-suite-coverage') {
    try { await cp(resolve(root, 'coverage/baseline'), resolve(output, 'coverage'), { recursive: true }); }
    catch (error) { report.coverageArchiveError = String(error); }
  }
  await save();
  console.log(`${name}: ${report.steps.at(-1).status} (${Math.round(report.steps.at(-1).wallMs)} ms)`);
}
try { report.generatedSuiteCoverage = JSON.parse(await readFile(resolve(root, 'coverage/baseline/coverage-summary.json'), 'utf8')).total; } catch { report.generatedSuiteCoverage = null; }
await save();
console.log(`Evidence: ${output}`);
if (report.steps.some(step => step.status !== 'passed')) process.exitCode = 1;
