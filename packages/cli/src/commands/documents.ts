import { readFile } from 'node:fs/promises'
import {
  compactedSays,
  DOCUMENT_EVENTS,
  defaultConfigPath,
  documentsIn,
  documentsToCompact,
  loadConfig,
  printable,
  printableLines,
  producedClause,
  tadeHome,
  waitingDocuments,
} from '@tade/core'
import { cleanupDocuments, deleteDocument, documentOf } from '@tade/workbench'
import { readJournal } from '@tade/workbench/events'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'
import { withWorkbench } from '../with-workbench.ts'

// The documents tasks produced: which nobody has decided about, what one says,
// and letting one go.
//
// Documents outlive their tasks — they are kept in each project's documents
// folder in Tade's home — so this is where a person at the machine looks at
// them, reads one, deletes one or tidies up, without a window or an
// orchestrator in between.
//
// Reading reads the journal and the file directly, like `status`, `logs` and
// `notes`: a question never needs the workbench, so it answers with a window
// open or shut. Deleting writes the journal, so it needs the home like every
// command that writes, and with a window open it says to ask there.

/** Where to go instead while a window holds the home. */
const THERE = 'Ask the orchestrator there (tade_document_delete, tade_documents_cleanup)'

export function registerDocuments(program: Command, io: Io, setExit: (n: number) => void): void {
  const documents = program
    .command('documents')
    .description(
      'Documents tasks produced, which nobody has decided about yet, and reading, deleting or cleaning them up',
    )
    .option('--all', 'include the ones already decided about, and the deleted')
    .option('--json', 'machine-readable output')
    .action(async (opts: { all?: boolean; json?: boolean }) => {
      const every = documentsIn(await readJournal(tadeHome(), { types: [...DOCUMENT_EVENTS] }))
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
        // What an agent wrote and asked is drawn as text (`printable`), as
        // the window draws it.
        io.out(printable(`${one.task} ${producedClause(one)}`))
        // The agent's own line after the facts, never instead of them: it is
        // what the document is about and not what the document says.
        if (one.summary) io.out(`  its agent said: ${printable(one.summary)}`)
      }
    })

  documents
    .command('read <task>')
    .description('Print the document a task produced, finished or still being written')
    .action(async (task: string) => {
      const home = tadeHome()
      const kept = documentsIn(await readJournal(home, { types: [...DOCUMENT_EVENTS] })).filter(
        (one) => one.task === task,
      )
      const latest = kept.at(-1)
      // The journal's path where it has one, and otherwise where the task's
      // agent is writing it now: a document half-written is still worth reading.
      const path = latest?.path ?? (await documentOf(home, task))
      if (!path) {
        io.err(`${task} has produced no document: \`tade documents --all\` says which have`)
        setExit(Exit.error)
        return
      }
      if (latest && (latest.state === 'deleted' || latest.state === 'gone')) {
        io.err(printable(`${task} ${producedClause(latest)}`))
        setExit(Exit.error)
        return
      }
      const text = await readFile(path, 'utf8').catch(() => null)
      if (text === null) {
        io.err(`${path} is not there to read`)
        setExit(Exit.error)
        return
      }
      // An agent wrote it, so it is printed as text, a line at a time — its
      // tabs the spaces the window's viewer gives them, which `printable`
      // would otherwise make one.
      io.out(printableLines(text.trimEnd().replace(/\t/g, '   ')))
    })

  documents
    .command('delete <task>')
    .description('Delete the document a task produced, and write down why')
    .requiredOption('--why <sentence>', 'why it is going: the whole record of it in the journal')
    .option('--path <path>', 'which of its documents, where it produced more than one')
    .action((task: string, opts: { why: string; path?: string }) =>
      withWorkbench(
        io,
        setExit,
        async (tade) => {
          const kept = documentsIn(await tade.log.read({ types: [...DOCUMENT_EVENTS] })).filter(
            (one) => one.task === task && one.state === 'written',
          )
          const path = opts.path ?? kept.at(-1)?.path ?? ''
          const gone = await deleteDocument(tade, { task, path, why: opts.why, by: 'you' })
          io.out(`deleted ${gone.path}`)
        },
        THERE,
      ),
    )

  documents
    .command('cleanup')
    .description(
      'Say which documents decided about long enough ago would be deleted, and delete them with --apply',
    )
    .option('--apply', 'delete them, rather than only saying which')
    .action(async (opts: { apply?: boolean }) => {
      const loaded = await loadConfig(defaultConfigPath())
      const keepDays = loaded.ok ? loaded.config.documents.keep_days : 30
      // Asked before the home is opened, because opening it runs the same
      // cleanup (`settleDocuments`): what is said is everything that goes,
      // whichever of the two took it.
      const taken = documentsToCompact(
        await readJournal(tadeHome(), { types: [...DOCUMENT_EVENTS] }),
        Date.now(),
        keepDays * 86_400_000,
      )
      if (!opts.apply) {
        io.out(compactedSays(taken, false))
        return
      }
      await withWorkbench(
        io,
        setExit,
        async (tade) => {
          await cleanupDocuments(tade, { keepDays, apply: true, by: 'you' })
          io.out(compactedSays(taken, true))
        },
        THERE,
      )
    })
}
