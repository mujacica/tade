import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { allNotes, type Note, NoteSchema, note, recall } from '@wilco/core'

// Things you told Wilco, kept next to the journal and in the same shape:
// append-only, one JSON object per line, the file itself the truth.
//
// A note is the one kind of fact no probe could ever recover, so losing them
// to a half-written line would be losing them for good. A line that cannot be
// read is skipped rather than thrown over, exactly like a provider transcript:
// one bad record must never stop the daemon from starting.

const FILE = 'memory.jsonl'

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

  /** Write something down, verbatim. */
  remember(text: string, scope: string | null, now: number = Date.now()): Note {
    const entry = note(text, scope, now)
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`)
    this.notes.push(entry)
    return entry
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
      const parsed = NoteSchema.safeParse(JSON.parse(line))
      if (parsed.success) notes.push(parsed.data)
    } catch {
      // A torn or hand-edited line. Keep the rest.
    }
  }
  return notes
}
