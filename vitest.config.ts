import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/*/test/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    // Generous, because what these mostly bound is liveness and not speed:
    // a test waits for a real process to say something, and `until` fails
    // with what it was waiting for long before this does. Ten seconds was
    // tight enough that a runner running 279 forked workers on two cores
    // starved ordinary waits into failures that named a different test every
    // run — and a suite nobody believes is worse than a slow one. Only a test
    // that is actually going to fail ever waits this long.
    testTimeout: 45_000,
    // A test may never reach the desktop of the machine it runs on: refused at
    // the spawn, and reported against the test that tried. `test/no-gui.ts`
    // says why this is loaded for every file rather than asked for per package.
    setupFiles: ['./test/no-gui.ts'],
    // Tests build real git repos in tmp dirs; keep them isolated per file.
    pool: 'forks',
    coverage: {
      // Off unless asked for, because a partial run measured against whole-repo
      // floors is red for reasons that have nothing to do with the change.
      // `pnpm coverage` turns it on and then holds the answer to
      // `scripts/coverage.ts`, which is where the floors and the exclusions are
      // and which is what the `tests` check runs.
      enabled: false,
      provider: 'v8',
      // Everything `include` matches is in the report whether or not a test
      // imported it, which is the half that matters: a file nothing imports
      // has to count as zero, not be absent and read as covered. The gate
      // fails if a file it names is missing from the report, so this cannot
      // quietly stop being true.
      include: ['packages/*/src/**/*.ts', 'packages/*/*/src/**/*.ts'],
      reporter: ['json'],
    },
  },
})
