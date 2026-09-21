import { tadeHome } from '@tade/core'
import { Memory } from '@tade/workbench/memory'
import type { Command } from 'commander'
import type { Io } from '../io.ts'

// What you told Tade, from a terminal rather than out loud. Everything else
// Tade knows it worked out for itself; these are the facts it was given, so
// being able to read them back is how you trust them.
//
// Notes need no workbench: the file is append-only and nothing numbers the
// lines, so writing one with a window open is safe and reading one always is.

export function registerNotes(program: Command, io: Io, _setExit: (code: number) => void): void {
  program
    .command('remember <text...>')
    .description('Write something down, exactly as you said it')
    .option('--about <scope>', 'the task or project it is about')
    .option(
      '--headline <words>',
      'what it is about and what it does, in a few words: the line the window reads it by',
    )
    .action((words: string[], opts: { about?: string; headline?: string }) => {
      const note = Memory.open(tadeHome()).remember(
        words.join(' '),
        opts.about ?? null,
        'cli',
        Date.now(),
        opts.headline ?? null,
      )
      io.out(note.scope ? `noted, about ${note.scope}` : 'noted')
    })

  program
    .command('notes [scope]')
    .description('What you have told Tade, newest first')
    .option('--json', 'machine-readable output')
    .action((scope: string | undefined, opts: { json?: boolean }) => {
      const memory = Memory.open(tadeHome())
      // No scope asks for everything; a scope asks for what applies to it,
      // which includes what was said about its project and about everything.
      const notes = scope === undefined ? memory.all() : memory.recall(scope)
      if (opts.json) {
        io.out(JSON.stringify(notes, null, 2))
        return
      }
      if (notes.length === 0) {
        io.out(scope ? `nothing about ${scope}` : 'nothing yet')
        return
      }
      const width = Math.max(...notes.map((note) => (note.scope ?? '—').length))
      for (const note of notes) {
        // The words, always — a headline is said after them, never instead of
        // them, because the words are the only part nothing can recover.
        const headline = note.summary ? `  (${note.summary})` : ''
        io.out(`${(note.scope ?? '—').padEnd(width)}  ${note.text}${headline}`)
      }
    })
}
