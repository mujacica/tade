import { describeWork, summariseWork, wilcoHome } from '@wilco/core'
import { readJournal } from '@wilco/workbench/events'
import type { Command } from 'commander'
import type { Io } from '../io.ts'

// What an agent has been doing, read off the journal rather than asked of the
// agent: an agent's own account of itself is exactly what Wilco does not trust.
//
// Reading the file rather than taking the workbench, so this still answers with
// a window open — which is when you are most likely to be asking.

/** How far back to read before summarising. */
const DEPTH = 2_000

export function registerSummary(program: Command, io: Io, _setExit: (code: number) => void): void {
  program
    .command('summary <task>')
    .description('What an agent has been doing')
    .option('--json', 'machine-readable output')
    .action(async (task: string, opts: { json?: boolean }) => {
      const events = await readJournal(wilcoHome(), { task, limit: DEPTH })
      const now = Date.now()
      const summary = summariseWork(events, task, now)
      if (opts.json) {
        io.out(JSON.stringify(summary, null, 2))
        return
      }
      io.out(describeWork(summary, now))
    })
}
