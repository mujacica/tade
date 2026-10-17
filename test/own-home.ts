import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A test's home directory is an empty one of its own, never the home of
// whoever runs the suite.
//
// Loaded by every test file (`setupFiles` in `vitest.config.ts`), before
// anything is imported that could read `os.homedir()`. Two reasons, and the
// second is the one that was measured:
//
//  - **What a home holds is the person's, not the suite's.** A test that falls
//    back to `~/.pi`, `~/.claude` or `~/.codex` reads somebody's real agent
//    transcripts and writes into them: the suite had left 26,705 pi sessions
//    in one laptop's `~/.pi/agent/sessions`, and one workbench test went red on
//    every machine that had run the suite before.
//  - **A home that big is slow, and only here.** Finding one session scans
//    every folder under that root, so the more often the suite had run, the
//    slower it got: `orchestrator.test.ts` took 64 s against 18 s with an empty
//    home, and the whole suite 328 s against 265 s. CI never saw it, because
//    a runner's home is empty — which is the home every test here was already
//    written for, so this is reality and not a kindness.
//
// The vitest process itself keeps the real home: `test/one-suite.ts` runs
// there, and the turn it takes is this machine's, in this machine's Tade home.

process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), 'tade-test-home-')))
