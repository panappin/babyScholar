// Local deterministic CPU microbenchmark. Not HTTP latency or provider performance.
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { canonicalArxivLink } from '../../.wrangler/check-worker/arxiv-identity.js';
import { selectSummarySource } from '../../.wrangler/check-worker/summary-source.js';

const output = resolve(process.argv[2] ?? 'artifacts/baseline-profile');
await mkdir(output, { recursive: true });
const extraction = { pageCount: 20, pages: Array.from({ length: 20 }, (_, i) => ({ pageNumber: i + 1, text: 'Research text αβγ. '.repeat(600) })) };
let sink = 0;
const workloads = [
  { name: 'canonicalArxivLink', iterations: 20000, call: () => canonicalArxivLink('http://www.arxiv.org/pdf/2401.01234v2.pdf', 'pdf')?.length ?? 0 },
  { name: 'selectSummarySource', iterations: 100, call: () => selectSummarySource(extraction).byteCount },
];
const measurements = [];
for (const workload of workloads) {
  for (let i = 0; i < 30; i++) sink += workload.call();
  const batches = [];
  for (let repeat = 0; repeat < 7; repeat++) {
    const start = performance.now();
    for (let i = 0; i < workload.iterations; i++) sink += workload.call();
    batches.push((performance.now() - start) / workload.iterations);
  }
  const sorted = [...batches].sort((a, b) => a - b);
  measurements.push({ name: workload.name, iterationsPerBatch: workload.iterations, millisecondsPerCall: batches, medianMs: sorted[3], minMs: sorted[0], maxMs: sorted[6] });
}
const report = { scope: 'Node local pure-function microbenchmark; excludes I/O, browser, workerd, D1/R2 and provider latency', node: process.version, platform: process.platform, arch: process.arch, timestamp: new Date().toISOString(), measurements, memoryAfter: process.memoryUsage(), sink };
await writeFile(resolve(output, 'profile.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
