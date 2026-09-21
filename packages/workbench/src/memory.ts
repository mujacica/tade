import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { allNotes, type Note, NoteSchema, note, recall } from '@tade/core'
import { z } from 'zod'

// Things you told Tade, kept next to the journal and in the same shape:
// append-only, one JSON object per line, the file itself the truth.
//
// A note is the one kind of fact no probe could ever recover, so losing them
// to a half-written line would be losing them for good. A line that cannot be
// read is skipped rather than thrown over, exactly like a provider transcript:
// one bad record must never stop Tade from starting.

const FILE = 'memory.jsonl'

/**
 * A note taken back. Appended like everything else, never a rewrite of the
 * file: the note is named by when it was said and what it said, which together
 * are one note and nothing else.
 */
const ForgetSchema = z.strictObject({
  forget: z.strictObject({ at: z.string(), text: z.string() }),
  by: z.string().default('unknown'),
  at: z.string(),
})

export class Memory {
  private readonly path: string
  private readonly notes: Note[]

  private constructor(path: string, notes: Note[]) {
    this.path = path
    this.notes = notes
  }

  static open(home: string): Memory {
    mkdirSync(home, { recursive: true })
    const path = join(home, FILE)
    return new Memory(path, load(path))
  }

  /**
   * Write something down, verbatim. A headline may be written beside it —
   * never instead of it: `text` is kept exactly as it arrived.
   */
  remember(
    text: string,
    scope: string | null,
    by = 'unknown',
    now: number = Date.now(),
    summary: string | null = null,
  ): Note {
    const entry = note(text, scope, by, now, summary)
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`)
    this.notes.push(entry)
    return entry
  }

  /**
   * Take a note back: it is no longer recalled, here or after a restart. The
   * file keeps both lines, so what was once said is not lost from the record.
   */
  forget(target: { at: string; text: string }, by = 'unknown', now: number = Date.now()): boolean {
    const index = this.notes.findIndex((one) => one.at === target.at && one.text === target.text)
    if (index < 0) return false
    const entry = {
      forget: { at: target.at, text: target.text },
      by,
      at: new Date(now).toISOString(),
    }
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`)
    this.notes.splice(index, 1)
    return true
  }

  /** What is known while talking about `scope`, newest first. */
  recall(scope: string | null): Note[] {
    return recall(this.notes, scope)
  }

  /** Everything known, newest first. */
  all(): Note[] {
    return allNotes(this.notes)
  }
}

function load(path: string): Note[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // Nothing has been remembered yet.
    return []
  }
  const notes: Note[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const value: unknown = JSON.parse(line)
      const parsed = NoteSchema.safeParse(value)
      if (parsed.success) {
        notes.push(parsed.data)
        continue
      }
      const forgot = ForgetSchema.safeParse(value)
      if (!forgot.success) continue
      const { at, text } = forgot.data.forget
      const index = notes.findIndex((one) => one.at === at && one.text === text)
      if (index >= 0) notes.splice(index, 1)
    } catch {
      // A torn or hand-edited line. Keep the rest.
    }
  }
  return notes
}
