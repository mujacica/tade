import { recordMade } from './own-tmp.ts'

// Every folder a test makes in the machine's temp folders rather than under
// its run's root is written down as this run's (`recordMade`), so the guard at
// the end of a full run fails for what this run left there and for nothing
// else beside it (`test/own-tmp.ts` says why).
//
// Loaded by every test file (`setupFiles` in `vitest.config.ts`), before the
// test's own imports, which is what makes a path built from the wrong place
// one the run can answer for: the worker is the process that made it.

recordMade()
