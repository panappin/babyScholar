// Add a separate comparison; never rewrite historical round measurements.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const round = resolve(root, 'docs/hw2/rounds/round-4');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const directories = await readdir(resolve(round, 'development'));
const development = label => {
  const matches = directories.filter(name => name.endsWith(`-${label}`));
  assert.equal(matches.length, 1, `Expected one archived ${label} run`);
  return resolve(round, 'development', matches[0]);
};
const phases = [
  ['initial', 'docs/hw2/rounds/initial/evidence'], ['round-1', 'docs/hw2/rounds/round-1/evidence'],
  ['round-2', 'docs/hw2/rounds/round-2/evidence'], ['round-3', 'docs/hw2/rounds/round-3/evidence'],
  ['round-4-preflight', development('r4-preflight-coverage')],
  ['round-4-first-expanded', development('r4-expanded-coverage')],
  ['round-4-corrected', development('r4-corrected-coverage')], ['round-4-final', resolve(round, 'evidence')],
];
const measurements = [];
for (const [phase, path] of phases) {
  const directory = resolve(root, path), coverage = await json(resolve(directory, 'coverage/coverage-summary.json'));
  let execution; try { execution = await json(resolve(directory, 'results.json')); }
  catch { execution = await json(resolve(directory, 'command.json')); }
  const files = Object.fromEntries(Object.entries(coverage).filter(([file]) => file !== 'total').map(([file, metrics]) => {
    const normalized = file.replaceAll('\\', '/'), marker = normalized.lastIndexOf('/src/');
    assert.ok(marker >= 0); return [normalized.slice(marker + 1), metrics];
  }));
  measurements.push({ phase, evidence: relative(root, directory).replaceAll('\\', '/'), coverage: coverage.total, files, execution });
}
const byPhase = Object.fromEntries(measurements.map(value => [value.phase, value]));
assert.deepEqual(byPhase['round-3'].coverage, byPhase['round-4-preflight'].coverage);
for (const file of ['vitest.config.ts', 'package-lock.json']) {
  assert.deepEqual(await readFile(resolve(root, 'docs/hw2/rounds/round-3/evidence/snapshot', file)),
    await readFile(resolve(round, 'evidence/snapshot', file)), `Instrumentation/dependency bytes changed: ${file}`);
}
const delta = Object.fromEntries(['lines', 'statements', 'branches', 'functions'].map(metric => [metric,
  byPhase['round-4-final'].coverage[metric].total - byPhase['round-3'].coverage[metric].total]));
assert.deepEqual(delta, { lines: 1, statements: 2, branches: 3, functions: 0 });
const comparison = { generatedAt: new Date().toISOString(),
  interpretation: 'One combined Vitest 5.1.0/V8 Node and jsdom run; fixed source scope/configuration/lock. Round-4 preflight exactly reproduces round 3. Probe fix changes denominators by the recorded deltas. Node SQLite executes real SQL under a D1-shaped test adapter; workerd/browser execution is excluded.',
  denominatorChangeFromRound3: delta, measurements };
await writeFile(resolve(root, 'docs/hw2/backend-comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
const metrics = ['statements', 'branches', 'functions', 'lines'];
const rows = ['phase,file,' + metrics.flatMap(metric => [`${metric}_covered`, `${metric}_total`, `${metric}_pct`]).join(',')];
for (const run of measurements) for (const [file, coverage] of [['TOTAL', run.coverage], ...Object.entries(run.files)]) {
  rows.push([run.phase, file, ...metrics.flatMap(metric => [coverage[metric].covered, coverage[metric].total, coverage[metric].pct])].join(','));
}
await writeFile(resolve(root, 'docs/hw2/backend-per-file-comparison.csv'), rows.join('\n') + '\n');
let verified = 0;
async function verify(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some(entry => entry.name === 'archive.json')) {
    for (const file of (await json(resolve(directory, 'archive.json'))).files) {
      assert.equal(createHash('sha256').update(await readFile(resolve(directory, file.path))).digest('hex'), file.sha256,
        `Changed evidence: ${directory}/${file.path}`); verified++;
    }
  } else for (const entry of entries) if (entry.isDirectory()) await verify(resolve(directory, entry.name));
}
await verify(resolve(root, 'docs/hw2/rounds'));
console.log(JSON.stringify({ result: 'passed', archivedFilesVerified: verified, denominatorChangeFromRound3: delta,
  finalCoverage: byPhase['round-4-final'].coverage }));
