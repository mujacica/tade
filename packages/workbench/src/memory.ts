import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  allNotes,
  MACHINE_NAMED,
  type Note,
  NoteSchema,
  note,
  type Retired,
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
//   {"came":{at,text},from,at}           taken on another machine, and came from there
//   {"heard":digest,from,at}             a retire, forget or also line another machine gave
//   {"took":digest,by,at}                the person took one of those here, on a press
//   {"left":digest,by,at}                the person left one of those, on a press
//
// **Shared between homes** (`notes-shared.ts`):
// every line but `came` is given to the other machines this one is linked to,
// and theirs are taken, so the file on each is the union of all of them. That
// is safe because nothing here is ever rewritten and every word about a note
// names it: the fold reads every note first and every later word after, so the
// same lines in any order are the same notes. A note two machines both hold is
// one note (`named`), and of two retirements of one note the earlier is the one
// it was retired with — the same answer on both sides. `came` is each home's
// own record of where a note it took was taken, and is never given.
//
// **A change to a note taken here waits for the person's press here.** Any
// agent on a linked machine runs as the person there and can append to its
// file, so a retire, forget or also line from there is only that machine's
// word: it is written, so both files stay the same union and the exchange's
// sums meet, with a `heard` line beside it, and the fold applies it to a note
// taken here only once a `took` line says the person took it on a press here
// (`held`, `settle`: Settings › Remotes and the away view's Machines page,
// as a setting that widens agents is, `takenOnAPress`). A note that was itself
// taken elsewhere (`came`) takes it freely. `heard`, `took` and `left` are
// this home's own and never given.

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

const CameSchema = z.strictObject({
  came: Named,
  from: z.string().regex(MACHINE_NAMED),
  at: z.string(),
})

const DIGEST = /^[0-9a-f]{16}$/

const HeardSchema = z.strictObject({
  heard: z.string().regex(DIGEST),
  from: z.string().regex(MACHINE_NAMED),
  at: z.string(),
})

const TookSchema = z.strictObject({
  took: z.string().regex(DIGEST),
  by: z.string(),
  at: z.string(),
})

const LeftSchema = z.strictObject({
  left: z.string().regex(DIGEST),
  by: z.string(),
  at: z.string(),
})

/** One line of the file, read: which kind it is, and the value it was written as. */
type Read =
  | { kind: 'note'; note: Note; raw: unknown }
  | { kind: 'forget'; line: z.infer<typeof ForgetSchema>; raw: unknown }
  | { kind: 'also'; line: z.infer<typeof AlsoSchema>; raw: unknown }
  | { kind: 'retire'; line: z.infer<typeof RetireSchema>; raw: unknown }
  | { kind: 'came'; line: z.infer<typeof CameSchema>; raw: unknown }
  | { kind: 'heard'; line: z.infer<typeof HeardSchema>; raw: unknown }
  | { kind: 'took'; line: z.infer<typeof TookSchema>; raw: unknown }
  | { kind: 'left'; line: z.infer<typeof LeftSchema>; raw: unknown }

/** This home's own lines, never given and about no note by name. */
type Own = 'heard' | 'took' | 'left'

/**
 * A change another machine gave to a note taken here, waiting for the
 * person's press here (`Memory.held`): what it would do, to which note, and
 * whose word it is.
 */
export interface HeldChange {
  /** What names it, as the `heard` line does: the press takes or leaves this. */
  digest: string
  /** Retire it, take it back, or tell it about more. */
  kind: 'retire' | 'forget' | 'also'
  /** The note, as it was said here. */
  note: { at: string; text: string }
  /** The machine that gave it, as this one calls it. */
  from: string
  /** Who that machine says made it — its word, which nothing here can check. */
  by: string
  /** When it was made there. */
  at: string
  /** When it was heard here. */
  heard: string
  /** For a retirement, the sentence why. */
  because?: string
  /** For `also`, what it would tell the note about too; null for everything. */
  scopes?: string[] | null
}

/** A line this home may give another (`shared`): what names it, as written, and where its note was taken. */
export interface Shared {
  /** What names the line, digested (`digestOf`): two homes compare these, never the words. */
  digest: string
  /** The line as it was written, on one line. */
  line: string
  /** For a note taken on another machine, which (`came`); absent for one taken here. */
  from?: string
}

/** A line another home gave: as written there, and the machine its note was taken on, where not that one. */
export interface Given {
  line: string
  from?: string
}

/** What taking lines from another home did. */
export interface Took {
  /** Lines written here: every one that was not here yet. */
  lines: number
  /** Of those, notes — the rest are later words about one. */
  notes: number
  /** Lines that were not one of this file's kinds, or not a line at all: never written. */
  refused: number
  /** The digest of every line that was given and is here now, taken or already so. */
  here: string[]
}

/**
 * What writing a note down did. `already` is the same words found live,
 * reaching every scope asked for: nothing was written, and whoever asked is
 * told so. `widened` is the same words found live about less: one line says
 * that note is about these too, rather than a second copy of the words.
 */
export type Noted = Note & { already?: 'noted' | 'widened' }

export class Memory {
  /** Where the notes are: `memory.jsonl` in the home. */
  readonly path: string
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

  /**
   * Every line another home may be given (`notes-shared.ts`), once each, in the
   * order written: each note and every later word about one, as it was
   * written, and for a note that came from elsewhere, where it was taken.
   * Read from the file, as `remember` is.
   */
  shared(): Shared[] {
    const lines = readAll(this.path)
    const from = new Map<string, string>()
    for (const one of lines) {
      if (one.kind !== 'came') continue
      const key = named(one.line.came)
      if (!from.has(key)) from.set(key, one.line.from)
    }
    const seen = new Set<string>()
    const out: Shared[] = []
    for (const one of lines) {
      const key = keyOf(one)
      if (key === null) continue
      const digest = digestOf(key)
      if (seen.has(digest)) continue
      seen.add(digest)
      const was = one.kind === 'note' ? from.get(key) : undefined
      out.push({ digest, line: JSON.stringify(one.raw), ...(was ? { from: was } : {}) })
    }
    return out
  }

  /**
   * Take what another home gave (`notes-shared.ts`): every line not here yet
   * written as it was written there, and beside each note a `came` line saying
   * the machine it was taken on — the one the giver names, or `giver` itself.
   * What is not one of this file's kinds is refused and counted, never
   * written; what is here already is left. Read from the file first, as
   * `remember` is, because the CLI writes here too.
   */
  take(given: readonly Given[], giver: string, now: number = Date.now()): Took {
    if (!MACHINE_NAMED.test(giver)) {
      throw new Error(`${JSON.stringify(giver)} is not a name a note can say it was taken on`)
    }
    const have = new Set(
      readAll(this.path).flatMap((one) => {
        const key = keyOf(one)
        return key === null ? [] : [digestOf(key)]
      }),
    )
    const took: Took = { lines: 0, notes: 0, refused: 0, here: [] }
    const out: string[] = []
    for (const one of given) {
      const read = readText(one.line)
      const key = read === null ? null : keyOf(read)
      if (read === null || key === null) {
        took.refused++
        continue
      }
      const digest = digestOf(key)
      took.here.push(digest)
      if (have.has(digest)) continue
      have.add(digest)
      // Written again from the value, which is one line whatever spacing it came in.
      out.push(JSON.stringify(read.raw))
      took.lines++
      const from = one.from !== undefined && MACHINE_NAMED.test(one.from) ? one.from : giver
      if (read.kind === 'retire' || read.kind === 'forget' || read.kind === 'also') {
        // Another machine's word: about a note taken here, it waits for a press here (the fold).
        out.push(JSON.stringify({ heard: digest, from, at: new Date(now).toISOString() }))
      }
      if (read.kind !== 'note') continue
      took.notes++
      const came = { at: read.note.at, text: read.note.text }
      out.push(JSON.stringify({ came, from, at: new Date(now).toISOString() }))
    }
    if (out.length > 0) appendFileSync(this.path, out.map((line) => `${line}\n`).join(''))
    this.notes = load(this.path)
    return took
  }

  /**
   * The changes another machine gave to notes taken here that wait for the
   * person's press here, oldest first: each still about a note held here and
   * still a change to it, neither taken nor left yet. Read from the file, as
   * `remember` is.
   */
  held(): HeldChange[] {
    const lines = readAll(this.path)
    const notes = new Map(fold(lines).map((one) => [named(one), one]))
    const { cameFrom, settled } = ownOf(lines)
    const heard = new Map<string, z.infer<typeof HeardSchema>>()
    for (const one of lines) {
      if (one.kind === 'heard' && !heard.has(one.line.heard)) heard.set(one.line.heard, one.line)
    }
    const out: HeldChange[] = []
    const seen = new Set<string>()
    for (const one of lines) {
      if (one.kind !== 'retire' && one.kind !== 'forget' && one.kind !== 'also') continue
      const key = keyOf(one)
      const digest = key === null ? null : digestOf(key)
      const came = digest === null ? undefined : heard.get(digest)
      if (digest === null || came === undefined || settled.has(digest) || seen.has(digest)) continue
      seen.add(digest)
      const about = aboutOf(one)
      const note = notes.get(named(about))
      if (note === undefined || cameFrom.has(named(about))) continue
      if (one.kind === 'retire' && note.retired !== undefined) continue
      if (one.kind === 'also' && sameScopes(note, widen(note, one.line.scopes))) continue
      out.push({
        digest,
        kind: one.kind,
        note: { at: about.at, text: about.text },
        from: came.from,
        by: one.line.by,
        at: one.line.at,
        heard: came.at,
        ...(one.kind === 'retire' ? { because: one.line.because } : {}),
        ...(one.kind === 'also' ? { scopes: one.line.scopes } : {}),
      })
    }
    return out
  }

  /**
   * The person's press on a held change (`held`): `take` applies it here as if
   * this machine had made it, `leave` keeps the note as it is and stops
   * offering it. Refused where it is not held — taken or left already, or no
   * such change — rather than written twice.
   */
  settle(
    digest: string,
    answer: 'take' | 'leave',
    by: string,
    now: number = Date.now(),
  ): HeldChange {
    const found = this.held().find((one) => one.digest === digest)
    if (found === undefined) {
      throw new Error('that change to a note is not waiting for a press: taken or left already')
    }
    const at = new Date(now).toISOString()
    this.append(answer === 'take' ? { took: digest, by, at } : { left: digest, by, at })
    this.notes = load(this.path)
    return found
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
  return fold(readAll(path))
}

/** Every line of the file that is one of its kinds, in the order written. */
function readAll(path: string): Read[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    // Nothing has been remembered yet.
    return []
  }
  const lines: Read[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const read = readText(line)
    if (read !== null) lines.push(read)
  }
  return lines
}

/**
 * One line, read: null for one that is not JSON or not one of the file's
 * kinds — a torn or hand-edited line here, kept out and the rest kept, or a
 * line another home gave, refused and counted.
 */
function readText(line: string): Read | null {
  try {
    return readLine(JSON.parse(line))
  } catch {
    return null
  }
}

/** Which of the file's kinds a value is, or null for none of them. */
function readLine(raw: unknown): Read | null {
  const note = NoteSchema.safeParse(raw)
  if (note.success) return { kind: 'note', note: note.data, raw }
  const forget = ForgetSchema.safeParse(raw)
  if (forget.success) return { kind: 'forget', line: forget.data, raw }
  const also = AlsoSchema.safeParse(raw)
  if (also.success) return { kind: 'also', line: also.data, raw }
  const retire = RetireSchema.safeParse(raw)
  if (retire.success) return { kind: 'retire', line: retire.data, raw }
  const came = CameSchema.safeParse(raw)
  if (came.success) return { kind: 'came', line: came.data, raw }
  const heard = HeardSchema.safeParse(raw)
  if (heard.success) return { kind: 'heard', line: heard.data, raw }
  const took = TookSchema.safeParse(raw)
  if (took.success) return { kind: 'took', line: took.data, raw }
  const left = LeftSchema.safeParse(raw)
  return left.success ? { kind: 'left', line: left.data, raw } : null
}

/** What names a note: when it was said and what it said, which together are one note. */
function named(note: { at: string; text: string }): string {
  return JSON.stringify([note.at, note.text])
}

/** The note a later word is about. */
function aboutOf(read: Exclude<Read, { kind: 'note' | Own }>): { at: string; text: string } {
  if (read.kind === 'forget') return read.line.forget
  if (read.kind === 'also') return read.line.also
  if (read.kind === 'retire') return read.line.retire
  return read.line.came
}

/**
 * What names a line among every home's: a note by `named`, and a later word by
 * the note it is about and everything it says. Null for `came`, `heard`,
 * `took` and `left`, which are this home's own and never given.
 */
function keyOf(read: Read): string | null {
  if (read.kind === 'note') return named(read.note)
  if (read.kind === 'came' || read.kind === 'heard' || read.kind === 'took' || read.kind === 'left')
    return null
  const about = aboutOf(read)
  const { by, at } = read.line
  if (read.kind === 'forget') return JSON.stringify(['forget', about.at, about.text, at, by])
  if (read.kind === 'also') {
    return JSON.stringify(['also', about.at, about.text, at, by, read.line.scopes])
  }
  return JSON.stringify(['retire', about.at, about.text, at, by, read.line.because])
}

/** A key, digested: what two homes compare, so neither sends the other its words to find out. */
function digestOf(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

/**
 * The notes the lines come to. **Every note first, then every later word in
 * the order written**, so a word that arrived from another home before the
 * note it is about still applies: the same lines in any order are the same
 * notes. A note held twice is one. Of two retirements the earlier stands —
 * a home only ever retires a note once, so it is two homes' answer, and
 * both must come to the same one. A retire, forget or also line another
 * machine gave (`heard`) is no word about a note taken here until the person
 * took it here on a press (`took`).
 */
function fold(lines: readonly Read[]): Note[] {
  const notes: Note[] = []
  const index = new Map<string, number>()
  const { cameFrom, heard, took } = ownOf(lines)
  for (const one of lines) {
    if (one.kind !== 'note') continue
    const key = named(one.note)
    if (index.has(key)) continue
    index.set(key, notes.length)
    notes.push(one.note)
  }
  const forgotten = new Set<number>()
  for (const one of lines) {
    if (one.kind === 'note' || one.kind === 'heard' || one.kind === 'took' || one.kind === 'left')
      continue
    const about = named(aboutOf(one))
    const at = index.get(about)
    const was = at === undefined ? undefined : notes[at]
    if (at === undefined || was === undefined) continue
    if (one.kind !== 'came' && heard.size > 0 && !cameFrom.has(about)) {
      const key = keyOf(one)
      const digest = key === null ? null : digestOf(key)
      if (digest !== null && heard.has(digest) && !took.has(digest)) continue
    }
    if (one.kind === 'forget') forgotten.add(at)
    else if (one.kind === 'also') notes[at] = widen(was, one.line.scopes)
    else if (one.kind === 'came') {
      if (was.from === undefined) notes[at] = { ...was, from: one.line.from }
    } else {
      const { by, at: when, because } = one.line
      const retired = { by, at: when, because }
      if (was.retired === undefined || earlier(retired, was.retired))
        notes[at] = { ...was, retired }
    }
  }
  return notes.filter((_, at) => !forgotten.has(at))
}

/**
 * This home's own lines, gathered: the notes taken elsewhere (`came`), the
 * changes another machine gave (`heard`), the ones the person took here
 * (`took`), and every one taken or left (`settled`).
 */
function ownOf(lines: readonly Read[]): {
  cameFrom: Set<string>
  heard: Set<string>
  took: Set<string>
  settled: Set<string>
} {
  const own = { cameFrom: new Set<string>(), heard: new Set<string>(), took: new Set<string>() }
  const settled = new Set<string>()
  for (const one of lines) {
    if (one.kind === 'came') own.cameFrom.add(named(one.line.came))
    else if (one.kind === 'heard') own.heard.add(one.line.heard)
    else if (one.kind === 'took') {
      own.took.add(one.line.took)
      settled.add(one.line.took)
    } else if (one.kind === 'left') settled.add(one.line.left)
  }
  return { ...own, settled }
}

/** Whether two notes reach the same scopes. */
function sameScopes(a: Note, b: Note): boolean {
  const of = (one: Note) =>
    [...new Set(scopesOf(one))]
      .map((s) => JSON.stringify(s))
      .sort()
      .join('\n')
  return of(a) === of(b)
}

/** Whether one retirement comes before another: by when, then by who and why, so any two are ordered. */
function earlier(a: Retired, b: Retired): boolean {
  return (
    (a.at.localeCompare(b.at) || a.by.localeCompare(b.by) || a.because.localeCompare(b.because)) < 0
  )
}
