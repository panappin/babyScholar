import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
const output = resolve('artifacts/baseline-profile');
mkdirSync(output, { recursive: true });
const result = spawnSync(process.execPath, ['--cpu-prof', `--cpu-prof-dir=${output}`, '--cpu-prof-name=baseline.cpuprofile', 'scripts/baseline/profile.mjs', output], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
