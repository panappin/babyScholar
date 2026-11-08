// Selected realistic regressions, evaluated only in isolated copies.
import { spawnSync, execFileSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const label = process.argv[2];
if (!['first', 'refined'].includes(label)) throw new Error('Usage: node scripts/baseline/workflow-fault-probes.mjs first|refined');
const output = resolve(root, 'artifacts/hw2-workflow-faults', `${new Date().toISOString().replaceAll(':', '-')}-${label}`);
await mkdir(output, { recursive: true });
const mutations = [
  { name: 'arxiv-expiry-off-by-one', file: 'src/worker/arxiv.ts', test: 'arxiv-service',
    before: 'if (entry.expiresAt <= timestamp)', after: 'if (entry.expiresAt < timestamp)',
    requirement: 'A result expires at the TTL boundary, not one clock tick later.' },
  { name: 'arxiv-shared-author-array', file: 'src/worker/arxiv.ts', test: 'arxiv-service',
    before: 'authors: [...paper.authors]', after: 'authors: paper.authors',
    requirement: 'Mutating a returned author array must not change another caller or cached data.' },
  { name: 'arxiv-poisoned-request-queue', file: 'src/worker/arxiv.ts', test: 'arxiv-service',
    before: 'requestQueue = scheduled.then(() => undefined, () => undefined);', after: 'requestQueue = scheduled.then(() => undefined);',
    requirement: 'One failed upstream request must not prevent later explicit requests from running.' },
  { name: 'library-stale-read-erases-save', file: 'src/App.tsx', test: 'app-workflows',
    before: 'if (revisionAtStart !== libraryRevision.current) return body.papers;', after: '// Seed: omit revision check after a concurrent save.',
    requirement: 'A read begun before a successful save must not erase the new confirmed library record.' },
  { name: 'document-stale-details-overwrite-selection', file: 'src/DocumentWorkspace.tsx', test: 'document-workspace',
    before: 'if (!mounted.current || controller.signal.aborted || revision !== detailRevision.current) return results;',
    after: '// Seed: omit the completed detail response ownership check.',
    requirement: 'A late result for an earlier selection must not populate the current document.' },
  { name: 'summary-reload-discards-confirmed-result', file: 'src/DocumentWorkspace.tsx', test: 'document-workspace',
    before: '? { ...summary, summary: current.summary.summary }', after: '? { ...summary, summary: null }',
    requirement: 'A failed reload retains the already-confirmed saved summary.' },
  { name: 'document-selection-leaks-prepared-url', file: 'src/DocumentWorkspace.tsx', test: 'document-workspace',
    before: 'revokeDownloadObjectUrl();\n    setDownloadState({ status: "idle" });\n    setSelectedId(id);',
    after: 'setDownloadState({ status: "idle" });\n    setSelectedId(id);',
    requirement: 'Changing selection revokes the old prepared object URL.' },
  { name: 'download-rejects-exact-limit', file: 'src/DocumentWorkspace.tsx', test: 'document-workspace',
    before: 'if (byteCount > MAX_PDF_BYTES)', after: 'if (byteCount >= MAX_PDF_BYTES)',
    requirement: 'A valid original PDF of exactly 10 MiB remains downloadable.' },
];
async function hashes(directory, prefix = '') {
  const files = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name), key = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(files, await hashes(path, key + '/'));
    else files[key] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return files;
}
const sourceHashes = await hashes(resolve(root, 'src'));
const report = { label, startedAt: new Date().toISOString(),
  baseCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  scope: 'Eight selected workflow regressions, not existing bugs or a repository-wide mutation score. Control runs all tests; each mutant runs its affected workflow file.',
  sourceHashes, testHashes: await hashes(resolve(root, 'tests')), selectedMutations: mutations, runs: [] };
await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
for (const mutation of [null, ...mutations]) {
  const name = mutation?.name ?? 'control', sandbox = resolve(output, name);
  await mkdir(sandbox);
  for (const path of ['src', 'tests', 'vitest.config.ts', 'package.json', 'package-lock.json']) {
    await cp(resolve(root, path), resolve(sandbox, path), { recursive: true });
  }
  if (mutation) {
    const path = resolve(sandbox, mutation.file), original = await readFile(path, 'utf8');
    // CRLF/LF normalization is confined to the isolated mutant copy.
    const normalized = original.replaceAll('\r\n', '\n');
    if (normalized.split(mutation.before).length !== 2) throw new Error(`Expected exactly one site: ${name}`);
    await writeFile(path, normalized.replace(mutation.before, mutation.after));
    await writeFile(resolve(output, `${name}.patch.txt`), `${mutation.file}\n- ${mutation.before}\n+ ${mutation.after}\n`);
  }
  const jsonPath = resolve(output, `${name}.tests.json`);
  const args = [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', sandbox,
    '--config', resolve(sandbox, 'vitest.config.ts'), '--reporter=default', '--reporter=json', `--outputFile=${jsonPath}`,
    ...(mutation ? [mutation.test] : [])];
  const run = spawnSync(process.execPath, args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: 'true' } });
  await writeFile(resolve(output, `${name}.log`), (run.stdout ?? '') + (run.stderr ?? ''));
  let result;
  try { result = JSON.parse(await readFile(jsonPath, 'utf8')); } catch { /* Invalid below. */ }
  const outcome = run.status === 0 && result?.numFailedTests === 0 ? (mutation ? 'survived' : 'passed')
    : run.status === 1 && result?.numFailedTests > 0 && mutation ? 'detected' : 'invalid';
  report.runs.push({ name, command: [process.execPath, ...args], exitCode: run.status, error: run.error?.message,
    outcome, tests: result?.numTotalTests, failedTests: result?.numFailedTests,
    failedAssertions: result?.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName)) });
  await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${name}: ${outcome} (${result?.numFailedTests ?? '?'} failing tests)`);
  if (outcome === 'invalid') throw new Error(`Invalid experiment: ${name}`);
}
if (JSON.stringify(await hashes(resolve(root, 'src'))) !== JSON.stringify(sourceHashes)) throw new Error('Working source changed during fault probes.');
report.finishedAt = new Date().toISOString();
await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Workflow fault evidence: ${relative(root, output)}`);
