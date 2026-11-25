// Where a lowered process ends up, for tests about giving way to the window.
//
// The kernel clamps `nice`, and not at the same place everywhere: Linux stops
// at 19 and macOS at 20 (`PRIO_MAX`). A suite that is itself run lowered — as
// Tade runs its checks, 10 below the window — starts at 10, so 10 more lands
// on the ceiling, and a test that wrote 19 read "expected 20 to be 19" on a
// Mac. Asked of the kernel rather than of `process.platform`, so a machine
// nobody listed is answered by what it does.

import { execFileSync } from 'node:child_process'

/** As far down as this machine's kernel lets `nice` go. */
export const NICE_CEILING = Number.parseInt(
  execFileSync(
    'nice',
    [
      '-n',
      '100',
      process.execPath,
      '-e',
      "process.stdout.write(String(require('node:os').getPriority()))",
    ],
    { encoding: 'utf8' },
  ),
  10,
)

/** What `steps` below `from` comes to, where the kernel clamps it. */
export const loweredFrom = (from: number, steps: number): number =>
  Math.min(NICE_CEILING, from + steps)
