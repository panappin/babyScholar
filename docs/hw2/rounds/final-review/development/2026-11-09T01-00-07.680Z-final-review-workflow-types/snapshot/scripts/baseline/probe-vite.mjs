// Bounded isolation experiment: Vite and a tiny loopback API, without Chrome,
// CDP interception, Wrangler, D1, R2, or any remote provider.
import { spawn } from 'node:child_process';
import { createServer, get } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '../..');
const mode = process.argv[2] ?? 'control';
if (!['control', 'no-watch'].includes(mode)) throw new Error('Use control or no-watch');
const state = resolve(root, '.wrangler/hw2-vite-probe', randomUUID());
await mkdir(state, { recursive: true });
const evidence = { mode, startedAt: new Date().toISOString(), results: [], result: 'running', liveProviderRequests: 0 };
const api = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"status":"ok","papers":[]}'); });
await new Promise(done => api.listen(0, '127.0.0.1', done));
const portServer = createServer(); await new Promise(done => portServer.listen(0, '127.0.0.1', done));
const port = portServer.address().port; await new Promise(done => portServer.close(done));
const origin = `http://127.0.0.1:${port}`;
const args = [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
if (mode === 'no-watch') {
  const config = resolve(state, 'vite.config.mjs');
  await writeFile(config, `import { mergeConfig } from 'vite';\nimport original from ${JSON.stringify(resolve(root, 'vite.config.ts').replaceAll('\\', '/'))};\nexport default mergeConfig(original, {server: {watch: null}});\n`);
  args.push('--config', config);
}
const child = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, CI: 'true', LOCAL_WORKER_ORIGIN: `http://127.0.0.1:${api.address().port}` } });
const closed = new Promise(done => child.once('close', done));
let output = '';
child.stdout.on('data', chunk => { output = (output + chunk).slice(-16_000); });
child.stderr.on('data', chunk => { output = (output + chunk).slice(-16_000); });
function probe(path, timeoutMs = 5_000) {
  const started = performance.now();
  return new Promise(done => {
    const request = get(origin + path, { agent: false }, response => {
      let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; });
      response.on('end', () => { clearTimeout(timer); done({ path, status: response.statusCode, bytes, wallMs: performance.now() - started }); });
    });
    const timer = setTimeout(() => request.destroy(new Error('probe timeout')), timeoutMs);
    request.on('error', error => { clearTimeout(timer); done({ path, error: error.message, wallMs: performance.now() - started }); });
  });
}
try {
  for (let attempt = 0; attempt < 40; attempt++) {
    const ready = await probe('/', 500);
    if (ready.status === 200) break;
    if (attempt === 39) throw new Error('Vite did not become ready');
    await delay(100);
  }
  for (let pass = 0; pass < 3; pass++) {
    const results = await Promise.all(['/', '/@vite/client', '/@react-refresh', '/src/main.tsx', '/src/App.tsx', '/src/DocumentWorkspace.tsx', '/api/library/papers'].map(path => probe(path)));
    evidence.results.push({ pass, results });
    console.log(JSON.stringify({ pass, results }));
    if (results.some(result => result.status !== 200)) throw new Error('One or more direct requests failed');
  }
  evidence.result = 'passed';
} catch (error) { evidence.result = 'failed'; evidence.error = String(error); process.exitCode = 1; }
finally {
  const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  await new Promise(done => killer.once('close', done)); await closed;
  await new Promise(done => api.close(done));
  evidence.finishedAt = new Date().toISOString(); evidence.viteOutput = output;
  await writeFile(resolve(state, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ result: evidence.result, evidence: resolve(state, 'result.json'), command: [process.execPath, ...args] }));
}
