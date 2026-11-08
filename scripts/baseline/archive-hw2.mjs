// Preserve selected reviewable evidence; full HTML and raw runs remain in artifacts/.
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const [label, input] = process.argv.slice(2);
if (!['initial', 'round-1', 'round-2', 'round-3-preflight', 'round-3', 'round-4'].includes(label) || !input) {
  throw new Error('Usage: node scripts/baseline/archive-hw2.mjs ROUND artifacts/baseline/TIMESTAMP');
}
const source = resolve(root, input);
const withinArtifacts = relative(resolve(root, 'artifacts/baseline'), source);
if (!withinArtifacts || withinArtifacts.startsWith('..') || isAbsolute(withinArtifacts)) {
  throw new Error('Input must be a timestamped run under artifacts/baseline.');
}
const report = JSON.parse(await readFile(resolve(source, 'results.json'), 'utf8'));
if (report.steps.length !== 19 || !report.generatedSuiteCoverage) throw new Error('Baseline has not finished.');
const destination = resolve(root, 'docs/hw2/rounds', label, 'evidence');
await mkdir(resolve(destination, '..'), { recursive: true });
await mkdir(destination); // Refuse to overwrite an existing evidence archive.
for (const name of ['results.json', 'profile.json', 'baseline.cpuprofile', ...report.steps.map(step => step.log)]) {
  await cp(resolve(source, name), resolve(destination, name));
}
await mkdir(resolve(destination, 'coverage'));
for (const name of ['coverage-summary.json', 'coverage-final.json', 'lcov.info']) {
  await cp(resolve(source, 'coverage', name), resolve(destination, 'coverage', name));
}
const snapshot = resolve(destination, 'snapshot');
await mkdir(snapshot);
for (const name of ['tests/baseline', 'vitest.config.ts', 'package.json', 'package-lock.json',
  'scripts/baseline/run.mjs', 'scripts/baseline/profile.mjs', 'scripts/metadata-live-check.mjs',
  'scripts/metadata-live-verifier-check.mjs', 'scripts/frontend-search-browser-check.mjs',
  ...(['round-3', 'round-4'].includes(label) ? ['tsconfig.tests.json', 'scripts/baseline/browser-experiment.mjs', 'src/App.tsx'] : []),
  ...(label === 'round-4' ? ['src', 'drizzle', 'worker-configuration.d.ts', 'tsconfig.provider-tests.json'] : [])]) {
  const target = resolve(snapshot, name);
  await mkdir(resolve(target, '..'), { recursive: true });
  await cp(resolve(root, name), target, { recursive: true });
}

// Archive existing checks' structured diagnostics referenced in their logs.
// Only result.json files from project-owned disposable check directories qualify.
const diagnostics = resolve(destination, 'diagnostics');
await mkdir(diagnostics);
const diagnosticsIndex = [];
for (const step of report.steps) {
  const log = await readFile(resolve(source, step.log), 'utf8');
  const candidates = new Set();
  for (const line of log.split(/\r?\n/u)) {
    const match = /(?:Evidence:|Metadata live-check evidence:)\s*(.+result\.json)/iu.exec(line);
    if (match) candidates.add(match[1].trim());
    try {
      const record = JSON.parse(line);
      for (const [key, value] of Object.entries(record)) {
        if (/evidence$/iu.test(key) && typeof value === 'string') candidates.add(value);
      }
    } catch { /* Not a JSON log record. */ }
  }
  let index = 0;
  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    const local = relative(resolve(root, '.wrangler'), path);
    if (local.startsWith('..') || isAbsolute(local) || !local.endsWith('result.json')) continue;
    const filename = `${step.name}-${++index}.json`;
    await cp(path, resolve(diagnostics, filename));
    diagnosticsIndex.push({ stage: step.name, source: relative(root, path), file: filename });
  }
}
// The verifier's parent suppresses its child's log on assertion failure, so
// collect its offline diagnostic records by this run's start time as well.
const metadataDirectory = resolve(root, '.wrangler/metadata-live-check');
for (const entry of await readdir(metadataDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = resolve(metadataDirectory, entry.name, 'result.json');
  let record;
  try { record = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
  if (!record.mode?.startsWith('offline:') || record.startedAt < report.timestamp) continue;
  if (diagnosticsIndex.some(item => item.source === relative(root, path))) continue;
  const filename = `metadata-offline-${entry.name}.json`;
  await cp(path, resolve(diagnostics, filename));
  diagnosticsIndex.push({ stage: 'metadata-live-verifier', source: relative(root, path), file: filename });
}
await writeFile(resolve(diagnostics, 'index.json'), JSON.stringify(diagnosticsIndex, null, 2) + '\n');

const summary = JSON.parse(await readFile(resolve(source, 'coverage/coverage-summary.json'), 'utf8'));
const csv = ['file,statements_covered,statements_total,statements_pct,branches_covered,branches_total,branches_pct,functions_covered,functions_total,functions_pct,lines_covered,lines_total,lines_pct'];
for (const [file, coverage] of Object.entries(summary)) {
  csv.push([file === 'total' ? 'TOTAL' : relative(root, file).replaceAll('\\', '/'),
    ...['statements', 'branches', 'functions', 'lines'].flatMap(metric => [coverage[metric].covered, coverage[metric].total, coverage[metric].pct])].join(','));
}
await writeFile(resolve(destination, 'per-file-coverage.csv'), csv.join('\n') + '\n');

async function hashes(directory) {
  const entries = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) entries.push(...await hashes(path));
    else entries.push({ path: relative(destination, path).replaceAll('\\', '/'),
      sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
  return entries;
}
await writeFile(resolve(destination, 'archive.json'), JSON.stringify({ label,
  archivedAt: new Date().toISOString(), originalRun: relative(root, source).replaceAll('\\', '/'),
  baselineTimestamp: report.timestamp, command: 'npm.cmd run baseline',
  aggregateExitCode: report.steps.some(step => step.status !== 'passed') ? 1 : 0,
  note: 'Snapshot taken before implementing the following round. Full generated HTML remains in the original run.',
  files: await hashes(destination) }, null, 2) + '\n');
console.log(`Archived ${label}: ${relative(root, destination)}`);
