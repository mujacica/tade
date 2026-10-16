import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  allNotes,
  type Note,
  NoteSchema,
  note,
  recall,
  type Scopes,
  scopeList,
  scopesOf,
  unnoted,
} from '@tade/core'
import { z } from 'zod'

// Things you told Tade, kept next to the journal and in the same shape:
// append-only, one JSON object per line, the file itself the truth.
//
// A note is the one kind of fact no probe could ever recover, so losing them
// to a half-written line would be losing them for good. A line that cannot be
// read is skipped rather than thrown over, exactly like a provider transcript:
// one bad record must never stop Tade from starting.
//
// Nothing is ever rewritten. A note is named by when it was said and what it
// said, which together are one note and nothing else, and every later word
// about it is a line of its own, folded in on reading the way the journal is:
//
//   {"forget":{at,text},by,at}           taken back — gone from everywhere
//   {"also":{at,text},scopes,by,at}      the same words, about more (null: everything)
//   {"retire":{at,text},because,by,at}   no longer told to anybody, still read on asking

const FILE = 'memory.jsonl'

const Named = z.strictObject({ at: z.string(), text: z.string() })

const ForgetSchema = z.strictObject({
  forget: Named,
  by: z.string().default('unknown'),
  at: z.string(),
})

const AlsoSchema = z.strictObject({
  also: Named,
  scopes: z.array(z.string().min(1)).nullable(),
  by: z.string().default('unknown'),
  at: z.string(),
})

const RetireSchema = z.strictObject({
  retire: Named,
  because: z.string().min(1),
  by: z.string().default('unknown'),
  at: z.string(),
})

/**
 * What writing a note down did. `already` is the same words found live,
 * reaching every scope asked for: nothing was written, and whoever asked is
 * told so. `widened` is the same words found live about less: one line says
 * that note is about these too, rather than a second copy of the words.
 */
export type Noted = Note & { already?: 'noted' | 'widened' }

export class Memory {
  private readonly path: string
  private notes: Note[]

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
   *
   * **The same words twice are one note.** Said again about what it already
   * reaches, nothing is written and the note that was there is handed back
   * marked `already: 'noted'`; about something more, one line widens it.
   * Read from the file first, because the CLI writes here from another
   * process and a copy held since the window opened is not the file.
   */
  remember(
    text: string,
    scope: Scopes,
    by = 'unknown',
    now: number = Date.now(),
    summary: string | null = null,
  ): Noted {
    this.notes = load(this.path)
    const words = text.trim()
    const same = this.notes.filter((one) => !one.retired && one.text === words)
    const first = same[0]
    if (first) {
      // What no live note with these words reaches yet.
      const left = scopeList(scope).filter((one) =>
        same.every((kept) => unnoted(kept, words, one).length > 0),
      )
      if (left.length === 0) return { ...first, already: 'noted' }
      const scopes = left.includes(null) ? null : (left as string[])
      this.append({
        also: { at: first.at, text: first.text },
        scopes,
        by,
        at: new Date(now).toISOString(),
      })
      const wider = widen(first, scopes)
      this.notes[this.notes.indexOf(first)] = wider
      return { ...wider, already: 'widened' }
    }
    const entry = note(text, scope, by, now, summary)
    this.append(entry)
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
    this.append({
      forget: { at: target.at, text: target.text },
      by,
      at: new Date(now).toISOString(),
    })
    this.notes.splice(index, 1)
    return true
  }

  /**
   * Stop telling anybody a note, with the sentence why. Unlike `forget` it is
   * still read on asking — `all({ retired: true })`, the window's retired
   * notes, `tade notes --all` — marked with who retired it, when and why.
   *
   * Named by when it was said, and by its words where two were said in the
   * same millisecond. Refused, never guessed: no such note, one already
   * retired, or a moment two notes share with no words to tell them apart.
   */
  retire(
    target: { at: string; text?: string },
    because: string,
    by = 'unknown',
    now: number = Date.now(),
  ): Note {
    const why = because.trim()
    if (!why) throw new Error('say why it is retired: that sentence is the whole record of it')
    this.notes = load(this.path)
    const words = target.text?.trim()
    const named = this.notes.filter(
      (one) => one.at === target.at && (words === undefined || one.text === words),
    )
    const found = named[0]
    if (!found)
      throw new Error(`no note was taken at ${target.at}: tade_notes says which there are`)
    if (named.length > 1) {
      throw new Error(`${named.length} notes were taken at ${target.at}: pass its words as well`)
    }
    if (found.retired) {
      throw new Error(
        `that note was already retired by ${found.retired.by}: ${found.retired.because}`,
      )
    }
    const at = new Date(now).toISOString()
    this.append({ retire: { at: found.at, text: found.text }, because: why, by, at })
    const retired = { ...found, retired: { by, at, because: why } }
    this.notes[this.notes.indexOf(found)] = retired
    return retired
  }

  /** What is known while talking about `scope`, newest first. Never a retired note. */
  recall(scope: string | null): Note[] {
    return recall(this.notes, scope)
  }

  /** Everything known, newest first; with `retired`, what was retired as well. */
  all(opts: { retired?: boolean } = {}): Note[] {
    return allNotes(this.notes, opts)
  }

  private append(line: object): void {
    appendFileSync(this.path, `${JSON.stringify(line)}\n`)
  }
}

/** A note about more: these scopes as well, or everything where `scopes` is null. */
function widen(entry: Note, scopes: string[] | null): Note {
  if (scopes === null) {
    const { also: _also, ...rest } = entry
    return { ...rest, scope: null }
  }
  const [first, ...more] = [...new Set([...scopesOf(entry), ...scopes])].filter(
    (one): one is string => one !== null,
  )
  return { ...entry, scope: first ?? null, ...(more.length > 0 ? { also: more } : {}) }
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
  const find = (named: { at: string; text: string }) =>
    notes.findIndex((one) => one.at === named.at && one.text === named.text)
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
      if (forgot.success) {
        const index = find(forgot.data.forget)
        if (index >= 0) notes.splice(index, 1)
        continue
      }
      const also = AlsoSchema.safeParse(value)
      if (also.success) {
        const index = find(also.data.also)
        const was = notes[index]
        if (was) notes[index] = widen(was, also.data.scopes)
        continue
      }
      const retire = RetireSchema.safeParse(value)
      if (!retire.success) continue
      const index = find(retire.data.retire)
      const was = notes[index]
      if (was && !was.retired) {
        const { by, at, because } = retire.data
        notes[index] = { ...was, retired: { by, at, because } }
      }
    } catch {
      // A torn or hand-edited line. Keep the rest.
    }
  }
  return notes
}
