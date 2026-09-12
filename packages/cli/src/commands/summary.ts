import { describeWork, summariseWork } from '@wilco/core'
import type { Command } from 'commander'
import type { Io } from '../io.ts'
import { withDaemon } from '../with-daemon.ts'

// What an agent has been doing, read off the journal rather than asked of the
// agent: an agent's own account of itself is exactly what Wilco does not trust.

/** How far back to read before summarising. */
const DEPTH = 2_000

export function registerSummary(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('summary <task>')
    .description('What an agent has been doing')
    .option('--json', 'machine-readable output')
    .action(async (task: string, opts: { json?: boolean }) => {
      await withDaemon(io, setExit, async (client) => {
        const events = await client.events({ task, limit: DEPTH })
        const now = Date.now()
        const summary = summariseWork(events, task, now)
        if (opts.json) {
          io.out(JSON.stringify(summary, null, 2))
          return
        }
        io.out(describeWork(summary, now))
      })
    })
}
