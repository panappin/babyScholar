// One selected oracle probe across before/after test versions, not a mutation score.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
const output = resolve(root, 'artifacts/hw2-workflow-faults', `${new Date().toISOString().replaceAll(':', '-')}-provider-utf8`);
await mkdir(output, { recursive: true });
const first = 'docs/hw2/rounds/round-4/development/2026-11-08T23-39-50.905Z-r4-provider-first/snapshot/tests/baseline/provider-adapters.test.ts';
const current = 'tests/baseline/provider-adapters.test.ts';
const file = 'src/worker/question-openai.ts';
const original = await readFile(resolve(root, file));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = { startedAt: new Date().toISOString(), scope: 'One selected artificial lossy-decoding fault, before/after correcting the four provider UTF-8 fixtures. Not an existing defect or broad mutation score.',
  mutation: { file, before: 'fatal: true, ignoreBOM: false', after: 'fatal: false, ignoreBOM: false' },
  sourceHash: sha256(original), runs: [] };
for (const [version, test] of [['first', first], ['corrected', current]]) {
  for (const mutant of [false, true]) {
    const name = `${version}-${mutant ? 'mutant' : 'control'}`, sandbox = resolve(output, name);
    await mkdir(resolve(sandbox, 'tests/baseline'), { recursive: true });
    for (const path of ['src', 'package.json', 'package-lock.json', 'vitest.config.ts']) await cp(resolve(root, path), resolve(sandbox, path), { recursive: true });
    await cp(resolve(root, test), resolve(sandbox, current));
    if (mutant) {
      const text = original.toString('utf8');
      assert.equal(text.split(report.mutation.before).length, 2);
      await writeFile(resolve(sandbox, file), text.replace(report.mutation.before, report.mutation.after));
    }
    const json = resolve(output, `${name}.tests.json`);
    const args = [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--root', sandbox, '--config', resolve(sandbox, 'vitest.config.ts'),
      '--reporter=default', '--reporter=json', `--outputFile=${json}`];
    const result = spawnSync(process.execPath, args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    await writeFile(resolve(output, `${name}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
    const tests = JSON.parse(await readFile(json, 'utf8'));
    const outcome = result.status === 0 && tests.numFailedTests === 0 ? (mutant ? 'survived' : 'passed')
      : mutant && result.status === 1 && tests.numFailedTests > 0 ? 'detected' : 'invalid';
    report.runs.push({ name, testSource: test, testSha256: sha256(await readFile(resolve(root, test))), command: [process.execPath, ...args],
      outcome, tests: tests.numTotalTests, failedTests: tests.numFailedTests,
      failedAssertions: tests.testResults.flatMap(file => file.assertionResults.filter(test => test.status === 'failed').map(test => test.fullName)) });
    console.log(`${name}: ${outcome}, ${tests.numFailedTests} failing tests`);
    assert.notEqual(outcome, 'invalid');
  }
}
assert.equal(sha256(await readFile(resolve(root, file))), report.sourceHash);
report.finishedAt = new Date().toISOString();
await writeFile(resolve(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
// A compact reproducible snapshot for the existing immutable archive helper.
await cp(resolve(output, 'corrected-control'), resolve(output, 'control'), { recursive: true });
await writeFile(resolve(output, 'question-provider-lossy-utf8.patch.txt'), `${file}\n- ${report.mutation.before}\n+ ${report.mutation.after}\n`);
console.log(`Provider UTF-8 evidence: ${relative(root, output)}`);
