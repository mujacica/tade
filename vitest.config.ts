import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/*/test/**/*.test.ts',
      'test/**/*.test.ts',
    ],
    // Very generous, because what this bounds is liveness and not speed. The
    // window's own tests drive a real terminal with real processes behind it
    // and the slowest of them take thirty to fifty seconds when they pass —
    // so sixty was not a budget, it was a coin toss, and it came up tails on
    // a release. Three minutes is not an opinion about how long anything
    // should take; it is the point at which a test is not slow but stuck, and
    // only a test that is going to fail anyway ever waits it out.
    testTimeout: 180_000,
    // A hook the same, for the same reason and one more. The window's tests
    // build a repository and open a workbench in `beforeEach`, which took up to
    // 17 s on a loaded laptop against vitest's default of ten; and a hook that times
    // out is abandoned, not stopped, so its open finishes later with nobody to
    // close the journal it opened — Node then throws "A FileHandle object was
    // closed during garbage collection" out of whichever test it lands in.
    hookTimeout: 180_000,
    // A test runs in an empty home of its own, never the person's
    // (`test/own-home.ts`, first so nothing reads the real one before it), and
    // may never reach the desktop of the machine it runs on: refused at the
    // spawn, and reported against the test that tried. `test/no-gui.ts` says
    // why these are loaded for every file rather than asked for per package.
    // And what a test makes outside its run's temp root is written down as
    // the run's, so the temp guard answers for that and nothing else
    // (`test/made-here.ts`).
    setupFiles: ['./test/own-home.ts', './test/no-gui.ts', './test/made-here.ts'],
    // A full suite waits for this machine's turn, however it was started —
    // `test/one-suite.ts` says why it is here rather than in a script.
    globalSetup: ['./test/one-suite.ts'],
    // Tests build real git repos in tmp dirs; keep them isolated per file.
    pool: 'forks',
    // Half the cores, where vitest's default is all of them but one: a worker
    // per core is one suite taking the whole machine, with the window, the
    // agents and every git and PTY process the tests themselves spawn left to
    // fight over what is left — which is what makes a short timeout fire and
    // read like a regression. `VITEST_MAX_WORKERS` or `--maxWorkers` overrides
    // it for one run. On CI the runner is the step's own, three or four cores,
    // and halving those would only make the gate slower.
    maxWorkers: process.env.CI ? undefined : '50%',
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
