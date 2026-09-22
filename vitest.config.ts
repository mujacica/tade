import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/*/test/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    testTimeout: 10_000,
    // A test may never reach the desktop of the machine it runs on: refused at
    // the spawn, and reported against the test that tried. `test/no-gui.ts`
    // says why this is loaded for every file rather than asked for per package.
    setupFiles: ['./test/no-gui.ts'],
    // Tests build real git repos in tmp dirs; keep them isolated per file.
    pool: 'forks',
  },
})
