// Append-only archive of completed extension commands and selected fault probes.
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const round = process.argv[3] ?? 'round-3';
if (!['round-3', 'round-4'].includes(round)) throw new Error('Unsupported archive round.');
const destinationRoot = resolve(root, 'docs/hw2/rounds', round, 'development');
const input = resolve(root, process.argv[2] ?? '');
const allowed = ['artifacts/hw2-extension', 'artifacts/hw2-workflow-faults', 'artifacts/hw2-fault-probes'];
if (!allowed.some(parent => {
  const local = relative(resolve(root, parent), input);
  return local && !local.startsWith('..') && !isAbsolute(local) && !local.includes('/') && !local.includes('\\');
})) throw new Error('Pass one timestamped command or workflow-fault directory.');
const name = input.split(/[\\/]/u).at(-1);
const destination = resolve(destinationRoot, name);
await mkdir(destinationRoot, { recursive: true });
await mkdir(destination); // Existing evidence is immutable: never overwrite.
let command;
try { command = JSON.parse(await readFile(resolve(input, 'command.json'), 'utf8')); } catch { /* Fault probe. */ }
if (command) {
  if (!command.finishedAt) throw new Error('Command is still running.');
  await cp(input, destination, { recursive: true });
  const log = await readFile(resolve(input, 'command.log'), 'utf8');
  const diagnostics = [];
  for (const line of log.split(/\r?\n/u)) {
    let entry; try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry.evidence !== 'string') continue;
    const path = resolve(root, entry.evidence), local = relative(resolve(root, '.wrangler'), path);
    if (local.startsWith('..') || isAbsolute(local) || !local.endsWith('result.json')) continue;
    const file = `diagnostic-${diagnostics.length + 1}.json`;
    await cp(path, resolve(destination, file));
    diagnostics.push({ source: relative(root, path).replaceAll('\\', '/'), file });
  }
  if (diagnostics.length) await writeFile(resolve(destination, 'diagnostics.json'), JSON.stringify(diagnostics, null, 2) + '\n');
} else {
  const report = JSON.parse(await readFile(resolve(input, 'results.json'), 'utf8'));
  if (!report.finishedAt && !(report.runs?.length === 6 && Object.keys(report.testFiles ?? {}).length)) throw new Error('Fault experiment is still running.');
  for (const entry of await readdir(input, { withFileTypes: true })) {
    if (entry.isFile()) await cp(resolve(input, entry.name), resolve(destination, entry.name));
  }
  // One clean evaluated source/test/config copy is enough to reproduce every
  // mutation. The explicit patch files specify the mutant differences.
  await mkdir(resolve(destination, 'snapshot'));
  for (const path of ['src', 'tests', 'drizzle', 'package.json', 'package-lock.json', 'vitest.config.ts']) {
    if (existsSync(resolve(input, 'control', path))) await cp(resolve(input, 'control', path), resolve(destination, 'snapshot', path), { recursive: true });
  }
}
try {
  const summary = JSON.parse(await readFile(resolve(destination, 'coverage/coverage-summary.json'), 'utf8'));
  const rows = ['file,statements_covered,statements_total,statements_pct,branches_covered,branches_total,branches_pct,functions_covered,functions_total,functions_pct,lines_covered,lines_total,lines_pct'];
  for (const [file, coverage] of Object.entries(summary)) rows.push([file === 'total' ? 'TOTAL' : relative(root, file).replaceAll('\\', '/'),
    ...['statements', 'branches', 'functions', 'lines'].flatMap(metric => [coverage[metric].covered, coverage[metric].total, coverage[metric].pct])].join(','));
  await writeFile(resolve(destination, 'per-file-coverage.csv'), rows.join('\n') + '\n');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
async function manifest(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await manifest(path));
    else files.push({ path: relative(destination, path).replaceAll('\\', '/'), sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
  return files;
}
await writeFile(resolve(destination, 'archive.json'), JSON.stringify({ originalRun: relative(root, input).replaceAll('\\', '/'),
  archivedAt: new Date().toISOString(), files: await manifest(destination) }, null, 2) + '\n');
console.log(`Archived ${relative(root, destination)}`);
