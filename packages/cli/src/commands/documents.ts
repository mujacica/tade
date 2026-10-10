import { documentsIn, producedClause, tadeHome, waitingDocuments } from '@tade/core'
import { readJournal } from '@tade/workbench/events'
import type { Command } from 'commander'
import type { Io } from '../io.ts'

// The documents tasks produced, and which of them nobody has decided about.
//
// Here because the person who closes the agents is the person who loses the
// documents, and until this there was nowhere at the machine to see one: the
// only surface was a line in the orchestrator's briefing, which a person
// talking to Tade may never read. The window asks before it destroys one now,
// and this is how you look without being asked.
//
// Reads the journal directly, like `status`, `logs` and `notes`: a question
// never needs the workbench, so this answers with a window open or shut.

export function registerDocuments(program: Command, io: Io, _setExit: (n: number) => void): void {
  program
    .command('documents')
    .description('Documents tasks produced, and which nobody has decided about yet')
    .option('--all', 'include the ones already decided about')
    .option('--json', 'machine-readable output')
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const every = documentsIn(await readJournal(tadeHome()))
      const shown = opts.all ? every : waitingDocuments(every, Date.now())
      if (opts.json) {
        io.out(JSON.stringify(shown, null, 2))
        return
      }
      if (shown.length === 0) {
        io.out(
          every.length === 0
            ? 'no task has produced a document yet'
            : 'nothing waiting: every document a task produced has been decided about',
        )
        return
      }
      for (const one of shown) {
        io.out(`${one.task} ${producedClause(one)}`)
        // The agent's own line after the facts, never instead of them: it is
        // what the document is about and not what the document says.
        if (one.summary) io.out(`  its agent said: ${one.summary}`)
      }
    })
}
