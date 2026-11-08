import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/baseline/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 1,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.d.ts', 'src/**/*-types.ts', 'src/worker/local-probe.ts', 'src/worker/local-integration-probe.ts'],
      reporter: ['text', 'json-summary', 'json', 'html', 'lcov'],
      reportsDirectory: 'coverage/baseline',
      reportOnFailure: true,
    },
  },
});
