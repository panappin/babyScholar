// Reproducible Markdown -> self-contained HTML -> PDF using local Chrome/Edge.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { marked, Renderer } from 'marked';

const root = resolve(import.meta.dirname, '../..');
const input = resolve(root, process.argv[2] ?? 'docs/hw2/report.md');
const output = resolve(root, process.argv[3] ?? 'docs/hw2/report.pdf');
const scratch = resolve(root, 'artifacts/hw2-report', new Date().toISOString().replaceAll(':', '-'));
await mkdir(scratch, { recursive: true });
const browser = process.env.HW2_PDF_BROWSER ?? [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(existsSync);
if (!browser || !existsSync(browser)) throw new Error('Set HW2_PDF_BROWSER to an installed Chromium/Chrome/Edge executable.');
const escape = text => text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const renderer = new Renderer();
const links = [];
renderer.link = function ({ href, title, tokens }) {
  if (!/^(https?:|mailto:|#)/u.test(href)) {
    const [local, anchor] = href.split('#');
    const target = resolve(dirname(input), decodeURIComponent(local));
    const path = relative(root, target);
    if (path.startsWith('..') || isAbsolute(path) || !existsSync(target)) throw new Error(`Broken report link: ${href}`);
    href = 'https://github.com/panappin/babyScholar/blob/hw2/initial-baseline/'
      + path.replaceAll('\\', '/').split('/').map(encodeURIComponent).join('/') + (anchor ? `#${anchor}` : '');
  }
  links.push(href);
  return `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ''}>${this.parser.parseInline(tokens)}</a>`;
};
const body = await marked.parse(await readFile(input, 'utf8'), { renderer });
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>BabyScholar HW2 — Test Evaluation</title>
<style>
@page { size: A4; margin: 17mm 17mm 19mm; @bottom-right { content: counter(page); font: 9pt Arial; color: #555; } }
* { box-sizing: border-box; }
body { font: 10.5pt/1.38 "Segoe UI", Arial, sans-serif; color: #17212b; margin: 0; }
h1 { font-size: 23pt; line-height: 1.16; margin: 0 0 12pt; color: #153d57; }
h2 { font-size: 15pt; margin: 20pt 0 9pt; border-bottom: 1px solid #bfd0dc; padding-bottom: 5pt; color: #153d57; }
h3 { font-size: 11.5pt; margin: 13pt 0 7pt; }
h1,h2,h3,h4 { break-after: avoid; }
p { margin: 0 0 8pt; orphans: 3; widows: 3; }
a { color: #174f78; text-decoration: underline; overflow-wrap: anywhere; }
table { border-collapse: collapse; width: 100%; font-size: 9pt; margin: 10pt 0 12pt; break-inside: avoid; }
th,td { border: 1px solid #c7d2da; padding: 5pt; vertical-align: top; }
th { background: #eaf0f4; text-align: left; }
tr:nth-child(even) td { background: #f6f8fa; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: #f1f4f7; padding: 9pt; border-left: 3px solid #7899ad; break-inside: avoid; }
code { font: 8.5pt/1.35 Consolas, monospace; overflow-wrap: anywhere; }
ul,ol { margin-top: 4pt; padding-left: 18pt; }
li { margin-bottom: 4pt; }
blockquote { border-left: 3px solid #7899ad; margin: 10pt 0; padding-left: 12pt; color: #334b5d; }
strong { font-weight: 650; }
</style></head><body>${body}</body></html>`;
const htmlPath = resolve(scratch, 'report.html');
await writeFile(htmlPath, html);
await mkdir(dirname(output), { recursive: true });
const args = ['--headless=new', '--disable-background-networking', '--disable-extensions', '--disable-sync',
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${resolve(scratch, 'browser-' + randomUUID())}`,
  '--no-pdf-header-footer', `--print-to-pdf=${output}`, pathToFileURL(htmlPath).href];
const start = new Date().toISOString();
const child = spawn(browser, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', chunk => { log += chunk; }); child.stderr.on('data', chunk => { log += chunk; });
const timer = setTimeout(() => {
  if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else child.kill('SIGTERM');
}, 60_000);
const code = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done); });
clearTimeout(timer);
await writeFile(resolve(scratch, 'render.log'), log);
const bytes = await readFile(output);
if (code !== 0 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error(`PDF render failed: ${code}; see ${scratch}`);
await writeFile(resolve(scratch, 'result.json'), JSON.stringify({ startedAt: start, finishedAt: new Date().toISOString(),
  input: relative(root, input), output: relative(root, output), browser, command: [browser, ...args], exitCode: code,
  bytes: bytes.length, links: [...new Set(links)], note: 'Rendering succeeded; text, links and visual layout require verification.' }, null, 2) + '\n');
console.log(`PDF: ${relative(root, output)} (${bytes.length} bytes). Render evidence: ${relative(root, scratch)}`);
