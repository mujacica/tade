import { appliesTo, type Note, printable, scopesOf, tadeHome } from '@tade/core'
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
      // The same words twice are one note, and that is said rather than
      // looking like a second one was taken.
      const was = note.already === 'noted' ? `already noted, on ${note.at.slice(0, 10)}` : 'noted'
      io.out(note.scope ? `${was}, about ${scopesOf(note).join(', ')}` : was)
    })

  program
    .command('notes [scope]')
    .description('What you have told Tade, newest first')
    .option('--json', 'machine-readable output')
    .option('--all', 'retired notes as well, each with who retired it and why')
    .action((scope: string | undefined, opts: { json?: boolean; all?: boolean }) => {
      const memory = Memory.open(tadeHome())
      // No scope asks for everything; a scope asks for what applies to it,
      // which includes what was said about its project and about everything.
      // A retired note is told to nobody, and read here only when asked for,
      // after every one that still is.
      const retired = opts.all
        ? memory
            .all({ retired: true })
            .filter((note) => note.retired && (scope === undefined || appliesTo(note, scope)))
        : []
      const notes = [...(scope === undefined ? memory.all() : memory.recall(scope)), ...retired]
      if (opts.json) {
        io.out(JSON.stringify(notes, null, 2))
        return
      }
      if (notes.length === 0) {
        io.out(scope ? `nothing about ${scope}` : 'nothing yet')
        return
      }
      // Drawn as text (`printable`), as the window draws them: the orchestrator
      // writes notes too, and its words are a model's. The note is not changed.
      const about = (note: Note) =>
        note.scope === null ? '—' : printable(scopesOf(note).join(', '))
      const width = Math.max(...notes.map((note) => about(note).length))
      for (const note of notes) {
        // The words, always — a headline is said after them, never instead of
        // them, because the words are the only part nothing can recover.
        const headline = note.summary ? `  (${note.summary})` : ''
        // Where it was taken, only where that was another of their machines:
        // what is shared is the words, and this is the one place it is asked.
        const from = note.from ? `  [taken on ${note.from}]` : ''
        const retired = note.retired
          ? `  [retired ${note.retired.at.slice(0, 10)} by ${note.retired.by}: ${note.retired.because}]`
          : ''
        io.out(
          `${about(note).padEnd(width)}  ${printable(`${note.text}${headline}${from}${retired}`)}`,
        )
      }
    })
}
