// Extension comparison: keep the original three-round comparison immutable.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const rounds = resolve(root, 'docs/hw2/rounds');
const development = resolve(rounds, 'round-3/development');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
// Coverage keys retain the measuring machine's absolute paths. Resolve their
// source suffix rather than the current checkout path so other clones agree.
const sourcePath = file => {
  const normalized = file.replaceAll('\\', '/');
  const marker = normalized.lastIndexOf('/src/');
  assert.ok(marker >= 0, `Coverage file is outside the source scope: ${file}`);
  return normalized.slice(marker + 1);
};
const entries = await readdir(development);
const commandPath = label => {
  const matches = entries.filter(entry => entry.endsWith('-' + label));
  assert.equal(matches.length, 1, `One archived ${label} run is required`);
  return resolve(development, matches[0]);
};
const phases = [
  ['initial', resolve(rounds, 'initial/evidence')],
  ['round-1', resolve(rounds, 'round-1/evidence')],
  ['round-2', resolve(rounds, 'round-2/evidence')],
  ['preflight', resolve(rounds, 'round-3-preflight/evidence')],
  ['bridge', commandPath('configuration-bridge')],
  ['expanded', commandPath('expanded-coverage-first')],
  ['refined', commandPath('boundary-refinement')],
  ['final', resolve(rounds, 'round-3/evidence')],
];
const measurements = [];
for (const [phase, directory] of phases) {
  const coverage = await json(resolve(directory, 'coverage/coverage-summary.json'));
  let execution; try { execution = await json(resolve(directory, 'results.json')); }
  catch { execution = await json(resolve(directory, 'command.json')); }
  const files = Object.fromEntries(Object.entries(coverage).filter(([file]) => file !== 'total')
    .map(([file, metrics]) => [sourcePath(file), metrics]));
  measurements.push({ phase, evidence: relative(root, directory).replaceAll('\\', '/'),
    coverage: coverage.total, files, execution });
}
const byPhase = Object.fromEntries(measurements.map(value => [value.phase, value]));
assert.deepEqual(byPhase['round-2'].coverage, byPhase.bridge.coverage, 'Frozen-suite bridge must reproduce coverage');
for (const metric of ['lines', 'branches']) assert.equal(byPhase.initial.coverage[metric].total, byPhase.final.coverage[metric].total);
assert.equal(byPhase.final.coverage.statements.total - byPhase.initial.coverage.statements.total, 1);
assert.equal(byPhase.final.coverage.functions.total - byPhase.initial.coverage.functions.total, 1);
const oldLock = await json(resolve(rounds, 'round-2/evidence/snapshot/package-lock.json'));
const newLock = await json(resolve(rounds, 'round-3/evidence/snapshot/package-lock.json'));
for (const [path, pkg] of Object.entries(oldLock.packages)) {
  assert.equal(newLock.packages[path]?.version, pkg.version, `Pre-existing dependency version changed: ${path}`);
}
const report = { generatedAt: new Date().toISOString(),
  interpretation: 'One combined Vitest 5.1.0/V8 run instruments Node and jsdom files. Same all-source scope; frozen bridge matches round 2. The confirmed App fix adds one statement/function; line and branch denominators are unchanged. Legacy browser/workerd execution is excluded.',
  unchangedExistingDependencyVersions: true, measurements };
await writeFile(resolve(root, 'docs/hw2/workflow-comparison.json'), JSON.stringify(report, null, 2) + '\n');
const metrics = ['statements', 'branches', 'functions', 'lines'];
const rows = ['phase,file,' + metrics.flatMap(metric => [`${metric}_covered`, `${metric}_total`, `${metric}_pct`]).join(',')];
for (const run of measurements) for (const [file, coverage] of [['TOTAL', run.coverage], ...Object.entries(run.files)]) {
  rows.push([run.phase, file, ...metrics.flatMap(metric => [coverage[metric].covered, coverage[metric].total, coverage[metric].pct])].join(','));
}
await writeFile(resolve(root, 'docs/hw2/workflow-per-file-comparison.csv'), rows.join('\n') + '\n');
let checked = 0;
async function verify(directory) {
  const files = await readdir(directory, { withFileTypes: true });
  const manifest = files.find(entry => entry.name === 'archive.json');
  if (manifest) {
    const data = await json(resolve(directory, manifest.name));
    for (const file of data.files) {
      assert.equal(createHash('sha256').update(await readFile(resolve(directory, file.path))).digest('hex'), file.sha256,
        `Evidence bytes differ: ${relative(root, directory)}/${file.path}`);
      checked++;
    }
    return;
  }
  for (const file of files) if (file.isDirectory()) await verify(resolve(directory, file.name));
}
await verify(rounds);
console.log(JSON.stringify({ result: 'passed', archivedFilesVerified: checked, finalCoverage: byPhase.final.coverage, comparison: 'docs/hw2/workflow-comparison.json' }));
