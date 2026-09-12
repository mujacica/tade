import type { Command } from 'commander'
import type { Io } from '../io.ts'
import { withDaemon } from '../with-daemon.ts'

// What you told Wilco, from a terminal rather than out loud. Everything else
// Wilco knows it worked out for itself; these are the facts it was given, so
// being able to read them back is how you trust them.

export function registerNotes(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('remember <text...>')
    .description('Write something down, exactly as you said it')
    .option('--about <scope>', 'the task or project it is about')
    .action(async (words: string[], opts: { about?: string }) => {
      await withDaemon(io, setExit, async (client) => {
        const note = await client.remember(words.join(' '), opts.about ?? null, 'cli')
        io.out(note.scope ? `noted, about ${note.scope}` : 'noted')
      })
    })

  program
    .command('notes [scope]')
    .description('What you have told Wilco, newest first')
    .option('--json', 'machine-readable output')
    .action(async (scope: string | undefined, opts: { json?: boolean }) => {
      await withDaemon(io, setExit, async (client) => {
        // No scope asks for everything; a scope asks for what applies to it,
        // which includes what was said about its project and about everything.
        const notes = scope === undefined ? await client.recallAll() : await client.recall(scope)
        if (opts.json) {
          io.out(JSON.stringify(notes, null, 2))
          return
        }
        if (notes.length === 0) {
          io.out(scope ? `nothing about ${scope}` : 'nothing yet')
          return
        }
        const width = Math.max(...notes.map((note) => (note.scope ?? '—').length))
        for (const note of notes) io.out(`${(note.scope ?? '—').padEnd(width)}  ${note.text}`)
      })
    })
}
