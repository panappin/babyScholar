// Small, hand-selected regression probes, not an exhaustive mutation score.
// Mutations exist only in disposable copies; the working source is never edited.
import { spawnSync, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(import.meta.dirname, '../..');
const label = process.argv[2];
if (!['round-1', 'round-2'].includes(label)) throw new Error('Usage: node scripts/baseline/fault-probes.mjs round-1|round-2');
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'src'], { cwd: root, stdio: 'pipe' });
const output = resolve(root, 'artifacts/hw2-fault-probes', `${label}-${new Date().toISOString().replaceAll(':', '-')}`);
await mkdir(output, { recursive: true });
const mutations = [
  { name: 'upload-rejects-exact-limit', file: 'src/worker/document-validation.ts',
    before: 'if (file.size > DOCUMENT_FILE_BYTES)', after: 'if (file.size >= DOCUMENT_FILE_BYTES)',
    requirement: 'An exactly 10 MiB PDF is accepted.' },
  { name: 'question-lossy-utf8', file: 'src/worker/question-request.ts',
    before: 'fatal: true, ignoreBOM: false', after: 'fatal: false, ignoreBOM: false',
    requirement: 'Ill-formed UTF-8 inside otherwise valid JSON is rejected.' },
  { name: 'generation-retries-network-failure', file: 'src/worker/generation-recovery.ts',
    before: 'if (!recoverable) throw error;', after: 'if (!recoverable && attempt === 2) throw error;',
    requirement: 'Transport/provider failures do not trigger a corrective attempt.' },
  { name: 'summary-source-budget-plus-one', file: 'src/worker/summary-source.ts',
    before: 'let remaining = SUMMARY_MAX_TEXT_BYTES;', after: 'let remaining = SUMMARY_MAX_TEXT_BYTES + 1;',
    requirement: 'Selected summary text never exceeds 98304 UTF-8 bytes.' },
  { name: 'summary-demands-envelope', file: 'src/worker/summary-validation.ts',
    before: 'const text = boundedText(output, MAX_SUMMARY_PROSE_BYTES, "text");',
    after: 'invalid("Seeded fault: a JSON envelope is required.");\n    const text = boundedText(output, MAX_SUMMARY_PROSE_BYTES, "text");',
    requirement: 'Ordinary summary prose is accepted without an envelope or citations.' },
];
const report = { label, timestamp: new Date().toISOString(), sourceTree: execFileSync('git', ['rev-parse', 'HEAD:src'], { cwd: root, encoding: 'utf8' }).trim(),
  scope: 'Five hand-selected seeded regressions in isolated source/test copies; not existing defects or a repository-wide mutation score.', runs: [] };
for (const mutation of [null, ...mutations]) {
  const name = mutation?.name ?? 'control';
  const sandbox = resolve(output, name);
  await mkdir(sandbox);
  for (const path of ['src', 'tests', 'vitest.config.ts', 'package.json']) {
    await cp(resolve(root, path), resolve(sandbox, path), { recursive: true });
  }
  if (mutation) {
    const path = resolve(sandbox, mutation.file);
    const original = await readFile(path, 'utf8');
    if (original.split(mutation.before).length !== 2) throw new Error(`Expected one mutation site for ${name}`);
    const modified = original.replace(mutation.before, mutation.after);
    await writeFile(path, modified);
    await writeFile(resolve(output, `${name}.patch.txt`), `${mutation.file}\n- ${mutation.before}\n+ ${mutation.after}\n`);
  }
  const jsonPath = resolve(output, `${name}.tests.json`);
  const args = [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', sandbox,
    '--config', resolve(sandbox, 'vitest.config.ts'), '--reporter=default', '--reporter=json', `--outputFile=${jsonPath}`];
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true,
    timeout: 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: 'true' } });
  await writeFile(resolve(output, `${name}.log`), (run.stdout ?? '') + (run.stderr ?? ''));
  let result;
  try { result = JSON.parse(await readFile(jsonPath, 'utf8')); } catch { /* Classified below as an invalid experiment. */ }
  const outcome = run.status === 0 && result?.numFailedTests === 0 ? (mutation ? 'survived' : 'passed')
    : run.status === 1 && result?.numFailedTests > 0 && mutation ? 'detected' : 'invalid';
  report.runs.push({ name, mutation, command: [process.execPath, ...args], exitCode: run.status,
    error: run.error?.message, outcome, tests: result?.numTotalTests, failedTests: result?.numFailedTests,
    failedAssertions: result?.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName)) });
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${name}: ${outcome} (${result?.numFailedTests ?? '?'} failing tests)`);
  if (outcome === 'invalid' || (!mutation && outcome !== 'passed')) throw new Error(`Invalid control/experiment: ${name}`);
}
// Prove source bytes still match the original tracked source, and record the
// exact evaluated suite hashes to associate the probes with the round snapshot.
execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'src'], { cwd: root, stdio: 'pipe' });
report.testFiles = {};
const { readdir } = await import('node:fs/promises');
for (const file of await readdir(resolve(root, 'tests/baseline'))) {
  report.testFiles[file] = createHash('sha256').update(await readFile(resolve(root, 'tests/baseline', file))).digest('hex');
}
await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Fault-probe evidence: ${relative(root, output)}`);
