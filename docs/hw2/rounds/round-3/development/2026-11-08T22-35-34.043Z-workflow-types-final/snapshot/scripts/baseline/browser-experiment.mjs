// Explicit experiment entry point; the normal verifier remains the control.
const mode = process.argv[2];
if (!['drain', 'network'].includes(mode)) throw new Error('Usage: node scripts/baseline/browser-experiment.mjs drain|network');
process.env.HW2_DRAIN_CHILD_PIPES = '1';
if (mode === 'network') process.env.HW2_NETWORK_DIAGNOSTICS = '1';
console.log(JSON.stringify({ experiment: mode, hypothesis: 'Unconsumed child pipes stall an owned server', startedAt: new Date().toISOString() }));
await import('../frontend-search-browser-check.mjs');
