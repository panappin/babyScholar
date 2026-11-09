// Explicit experiment entry point; the normal verifier remains the control.
const mode = process.argv[2];
if (!['drain', 'network', 'preview'].includes(mode)) throw new Error('Usage: node scripts/baseline/browser-experiment.mjs drain|network|preview');
if (mode === 'preview') process.env.HW2_BROWSER_PREVIEW = '1';
else process.env.HW2_DRAIN_CHILD_PIPES = '1';
if (mode === 'network') process.env.HW2_NETWORK_DIAGNOSTICS = '1';
console.log(JSON.stringify({ experiment: mode, hypothesis: mode === 'preview'
  ? 'Separate built-app workflows from development-server transforms and HMR'
  : mode === 'network' ? 'Separate Worker, proxy, static requests and HTTP client behavior'
  : 'Unconsumed child pipes stall an owned server', startedAt: new Date().toISOString() }));
await import('../frontend-search-browser-check.mjs');
