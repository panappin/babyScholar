import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const read = path => readFile(resolve(root, path), 'utf8');
const json = async path => JSON.parse(await read(path));
const metrics = ['statements', 'branches', 'functions', 'lines'];
const rounds = [];
const files = new Map();
for (const label of ['initial', 'round-1', 'round-2']) {
  const base = `docs/hw2/rounds/${label}/evidence`;
  const run = await json(`${base}/results.json`);
  const archive = await json(`${base}/archive.json`);
  for (const file of archive.files) {
    const bytes = await readFile(resolve(root, base, file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `Evidence hash: ${label}/${file.path}`);
  }
  const coverage = await json(`${base}/coverage/coverage-summary.json`);
  const log = stripVTControlCharacters(await read(`${base}/generated-suite-coverage.log`));
  const tests = Number(/Tests\s+(\d+) passed/u.exec(log)?.[1]);
  assert.ok(tests > 0, `Missing successful test count for ${label}`);
  const profile = await json(`${base}/profile.json`);
  const configuration = {};
  for (const file of ['vitest.config.ts', 'package.json', 'package-lock.json', 'scripts/baseline/run.mjs', 'scripts/baseline/profile.mjs']) {
    configuration[file] = createHash('sha256').update(await readFile(resolve(root, base, 'snapshot', file))).digest('hex');
  }
  const outputPath = run.steps.find(step => step.name === 'profile').command.at(-1);
  const commands = run.steps.map(step => ({ name: step.name, command: step.command.map(arg => arg.replaceAll(outputPath, '<RUN>')) }));
  const environment = Object.fromEntries(['node', 'platform', 'arch', 'cpu', 'logicalCpus'].map(key => [key, run[key]]));
  if (rounds.length) {
    assert.equal(run.sourceTree, rounds[0].sourceTree, 'Source tree must remain identical');
    assert.deepEqual(configuration, rounds[0].configuration, 'Configuration/dependencies/profile input changed');
    assert.deepEqual(commands, rounds[0].commands, 'Stage commands changed beyond output destination');
    assert.deepEqual(environment, rounds[0].environment, 'Comparison environment changed');
    for (const metric of metrics) assert.equal(coverage.total[metric].total, rounds[0].coverage[metric].total, `${metric} denominator changed`);
  }
  for (const [key, values] of Object.entries(coverage)) {
    const normalized = key.replaceAll('\\', '/');
    const file = key === 'total' ? 'TOTAL' : normalized.slice(normalized.lastIndexOf('/src/') + 1);
    if (!files.has(file)) files.set(file, {});
    files.get(file)[label] = values;
  }
  const faults = label === 'initial' ? null : await json(`docs/hw2/rounds/${label}/fault-probes/results.json`);
  rounds.push({ label, timestamp: run.timestamp, originalRun: archive.originalRun, baseCommit: run.baseCommit,
    sourceTree: run.sourceTree, environment, configuration, commands, tests,
    passedStages: run.steps.filter(step => step.status === 'passed').length, totalStages: run.steps.length,
    failedStages: run.steps.filter(step => step.status !== 'passed').map(step => step.name),
    aggregateExitCode: archive.aggregateExitCode, coverage: coverage.total,
    stages: run.steps.map(({ name, status, exitCode, wallMs }) => ({ name, status, exitCode, wallMs })),
    profile: profile.measurements,
    faultProbes: faults?.runs.map(({ name, outcome, failedTests }) => ({ name, outcome, failedTests })) ?? null });
}
const comparison = { scope: 'Same source, denominator, dependency lock, Vitest config, baseline commands, profile workloads and machine. Browser/verifier repairs are separate from unit coverage.', rounds };
await writeFile(resolve(root, 'docs/hw2/comparison.json'), JSON.stringify(comparison, null, 2) + '\n');
const csv = ['file,' + rounds.flatMap(round => metrics.flatMap(metric => [`${round.label}_${metric}_covered`, `${round.label}_${metric}_total`, `${round.label}_${metric}_pct`])).join(',')];
for (const [file, coverage] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  for (const round of rounds) assert.ok(coverage[round.label], `Missing ${file} in ${round.label}`);
  csv.push([file, ...rounds.flatMap(round => metrics.flatMap(metric => {
    const value = coverage[round.label][metric];
    return [value.covered, value.total, value.pct];
  }))].join(','));
}
await writeFile(resolve(root, 'docs/hw2/per-file-comparison.csv'), csv.join('\n') + '\n');
console.log(JSON.stringify(rounds.map(({ label, tests, passedStages, totalStages, coverage }) => ({ label, tests, passedStages, totalStages, coverage })), null, 2));
