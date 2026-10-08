import { homedir } from 'node:os'
import { join } from 'node:path'
import { revise, tick } from '../src/delta.ts'
import { measureDelta, measureOf, sayMeasurement } from '../src/measure.ts'
import { GRANTS } from '../src/reach.ts'
import { inputFrom } from './home-input.ts'

// How big is a projection of this machine, and what does a beat of it cost?
//
//   node packages/web/scripts/measure.ts            # a device granted nothing
//   node packages/web/scripts/measure.ts --all      # a device granted everything
//   TADE_HOME=/somewhere node packages/web/scripts/measure.ts
//
// It prints counts, lengths and byte totals and **no value out of the
// projection** — see `src/measure.ts` for why that matters and
// `test/measure.test.ts` for what holds it. The numbers DESIGN.md §10.7 asks
// for go in a commit message; this is what produces them without putting the
// person's own words on a terminal.

const home = process.env.TADE_HOME ?? join(homedir(), '.tade')
const all = process.argv.includes('--all')
const now = Date.now()

const input = inputFrom(
  home,
  { device: 'measuring', projects: { kind: 'every' }, granted: all ? GRANTS : [] },
  now,
)
const made = revise(null, input, now)
const measured = measureOf(made.snapshot)

// A beat that changed nothing, and a beat that changed one row, which are the
// two shapes a stream actually sends.
const quiet = revise(made.snapshot, input, now + 2_000)
const first = input.tasks[0]
const moved =
  first === undefined
    ? null
    : revise(
        made.snapshot,
        { ...input, tasks: [{ ...first, stalled: !first.stalled }, ...input.tasks.slice(1)] },
        now + 4_000,
      )

const deltas = [
  measureDelta(tick(made.snapshot, now + 2_000)),
  ...(moved?.kind === 'changed' ? [measureDelta(moved.delta)] : []),
]

process.stdout.write(`${sayMeasurement(measured, deltas)}\n`)
process.stdout.write(
  `\na beat with nothing new sent ${quiet.kind === 'unchanged' ? 'nothing' : 'a delta'}\n`,
)
