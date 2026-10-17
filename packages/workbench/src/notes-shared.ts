import { createHash } from 'node:crypto'
import { MACHINE_NAMED, printable } from '@tade/core'
import { type Answer, LinkError, SIGNED_OUT } from '@tade/remotes-core'
import type { Given, Memory, Took } from './memory.ts'

// Notes are shared between homes (REMOTE-TADE.md §4.5, §9.6): the person's
// words reach both orchestrators and every agent on every machine they are
// linked to, whichever machine they were said to. `memory.jsonl` on each is
// the union of every one's lines — nothing is ever rewritten there and every
// word about a note names it, so the union is the same notes on both sides
// whatever order the lines arrive in (`memory.ts`' fold). Nothing else is
// shared: the journal, the tasks and the config stay each machine's own.
//
// **One exchange, both ways, asked by the machine that holds the link** — the
// Mac's window, as an owner, over the remote's own door (`POST
// /api/notes/share`, `here`): a remote is never able to call the Mac, so each
// exchange carries what the remote lacks there and brings back what this
// machine lacks. It opens with a look — a sum over the digests of every line —
// and where the two sums are the same, which is nearly always, that one small
// request is all of it. Otherwise the remote says which lines it has, by
// digest and never by their words, and as many rounds follow as it takes:
// each gives what is not there and asks for what is not here, bounded to what
// one request may carry (`GIVE_BYTES`, the far side's `BODY_MAX` less room)
// and one answer (`ANSWER_BYTES`).
//
// **Where a note was taken travels beside it, and is written down by whoever
// takes it** (a `came` line): the machine the giver names, or the giver itself
// for a note it took down. It is said only where somebody asks about a note.

/** What one request may give, in bytes of lines: the far side reads no more than 64 KB of body. */
export const GIVE_BYTES = 48 * 1024

/** The longest line given: a note longer than this stays where it was taken, and is counted. */
export const LINE_MOST = 32_000

/** How many lines one request asks for. */
export const WANT_MOST = 500

/** What one answer gives, in bytes of lines, before it leaves the rest for the next round. */
export const ANSWER_BYTES = 1024 * 1024

/** The most rounds one exchange takes before it leaves the rest for the next. */
const ROUNDS_MOST = 64

/**
 * One request of an exchange. `sum` opens it, and asks the far side for every
 * digest it holds where its own sum differs; the rounds after leave it out.
 */
export interface NotesAsk {
  /** What the machine asking calls itself: where a note it took down was taken. */
  from: string
  sum?: string
  /** Lines the far side does not have. */
  give: Given[]
  /** Digests of lines this side does not have. */
  want: string[]
}

/** What the far side answers each request. */
export interface NotesAnswer {
  /** What the far side calls itself. */
  machine: string
  /** The far side's sum, after it took what it was given. */
  sum: string
  /** Every digest the far side holds — only where it was asked with a sum that is not its own. */
  have?: string[]
  /** The lines asked for, as many as fit one answer. */
  lines: Given[]
  /** How many lines it took from what it was given. */
  took: number
  /** How many it would not take, as not one of the file's kinds. */
  refused: number
}

/** The sum of a home's lines: the same on two homes exactly when they hold the same lines. */
export function sumOf(digests: readonly string[]): string {
  return createHash('sha256')
    .update([...digests].sort().join('\n'))
    .digest('hex')
}

/**
 * The far half, answered on the remote's own door: take what was given — the
 * giver named as `giver` where a note does not say — then answer what was
 * asked for, and, opened with a sum that is not this side's, every digest it
 * holds.
 */
export function answerNotes(
  memory: Memory,
  ask: NotesAsk,
  giver: string,
  machine: string,
  now: number = Date.now(),
): NotesAnswer {
  const took: Pick<Took, 'lines' | 'refused'> =
    ask.give.length > 0 ? memory.take(ask.give, giver, now) : { lines: 0, refused: 0 }
  const here = memory.shared()
  const sum = sumOf(here.map((one) => one.digest))
  const byDigest = new Map(here.map((one) => [one.digest, one]))
  const lines: Given[] = []
  let bytes = 0
  for (const digest of ask.want) {
    const one = byDigest.get(digest)
    if (one === undefined) continue
    bytes += one.line.length
    if (bytes > ANSWER_BYTES && lines.length > 0) break
    lines.push({ line: one.line, ...(one.from ? { from: one.from } : {}) })
  }
  return {
    machine,
    sum,
    ...(ask.sum !== undefined && ask.sum !== sum ? { have: here.map((one) => one.digest) } : {}),
    lines,
    took: took.lines,
    refused: took.refused,
  }
}

/** What one exchange came to, from the side that asked. */
export interface Exchanged {
  /** Both sides held the same lines when it began: nothing moved. */
  same: boolean
  /** Lines written here. */
  took: number
  /** Of those, notes. */
  notes: number
  /** Lines the far side took. */
  gave: number
  /** Lines either side would not take, as not one of the file's kinds. */
  refused: number
  /** Lines left for the next exchange: too long to give, or past the rounds one exchange takes. */
  left: number
}

/**
 * A remote that answered and would not share notes — an older Tade, a session
 * it no longer knows, an answer that is not one — as against one that could
 * not be reached, which is its link's to say.
 */
export class NotesRefused extends LinkError {}

/**
 * The near half, run by the window that holds the link: the look, then the
 * rounds. `call` is one request to the far side's door; it throws where the
 * link could not make one. `name` is what the remote is called here, which is
 * where a note it took down is said to have been taken.
 */
export async function shareNotes(
  memory: Memory,
  call: (ask: NotesAsk) => Promise<Answer>,
  opts: { from: string; name: string; now?: () => number },
): Promise<Exchanged> {
  const now = opts.now ?? Date.now
  const ask = async (body: NotesAsk) => answerOf(await call(body), opts.name)
  const here = memory.shared()
  const sum = sumOf(here.map((one) => one.digest))
  const first = await ask({ from: opts.from, sum, give: [], want: [] })
  const out: Exchanged = {
    same: first.sum === sum,
    took: 0,
    notes: 0,
    gave: 0,
    refused: 0,
    left: 0,
  }
  if (out.same) return out
  if (first.have === undefined) {
    throw new NotesRefused('failed', `${opts.name} did not say which notes it holds`)
  }
  const theirs = new Set(first.have)
  const ours = new Set(here.map((one) => one.digest))
  const tooLong = here.filter((one) => !theirs.has(one.digest) && one.line.length > LINE_MOST)
  let give = here.filter((one) => !theirs.has(one.digest) && one.line.length <= LINE_MOST)
  let want = first.have.filter((digest) => !ours.has(digest))
  for (let round = 0; round < ROUNDS_MOST && (give.length > 0 || want.length > 0); round++) {
    const sending = within(give, GIVE_BYTES)
    const asking = want.slice(0, WANT_MOST)
    const answer = await ask({
      from: opts.from,
      give: sending.map((one) => ({ line: one.line, ...(one.from ? { from: one.from } : {}) })),
      want: asking,
    })
    give = give.slice(sending.length)
    out.gave += answer.took
    out.refused += answer.refused
    const took = memory.take(answer.lines, opts.name, now())
    out.took += took.lines
    out.notes += took.notes
    out.refused += took.refused
    const came = new Set(took.here)
    // Asked for and not answered — the answer was full — is asked again; asked
    // for and not there any more is not, or the rounds would never end.
    const unanswered = asking.filter((digest) => !came.has(digest))
    want = [...(answer.lines.length > 0 ? unanswered : []), ...want.slice(asking.length)]
    if (sending.length === 0 && answer.lines.length === 0) break
  }
  out.left = tooLong.length + give.length + want.length
  return out
}

/** As many of the lines, in order, as fit `bytes` — and always the first, which `LINE_MOST` keeps inside it. */
function within<T extends { line: string }>(lines: readonly T[], bytes: number): T[] {
  const out: T[] = []
  let used = 0
  for (const one of lines) {
    // Each line is quoted once more in the body, and carries where it was taken.
    const cost = JSON.stringify(one.line).length + 160
    if (out.length > 0 && used + cost > bytes) break
    used += cost
    out.push(one)
  }
  return out
}

/**
 * What the far side answered, as this side reads it: a refusal in words, or
 * the answer with every line a string, every name one a note may carry, and
 * every digest one this side could have made. Anything else is not taken.
 */
function answerOf(answer: Answer, name: string): NotesAnswer {
  if (answer.status !== 200) throw new NotesRefused('failed', refusedSays(answer, name))
  const body = answer.body as Partial<NotesAnswer> | null
  const lines = Array.isArray(body?.lines) ? body.lines : null
  const have = body?.have
  if (
    body === null ||
    typeof body.sum !== 'string' ||
    lines === null ||
    (have !== undefined && !(Array.isArray(have) && have.every(isDigest)))
  ) {
    throw new NotesRefused('failed', `${name} answered with something that is not its notes`)
  }
  return {
    machine: typeof body.machine === 'string' ? printable(body.machine) : '',
    sum: body.sum,
    ...(have !== undefined ? { have } : {}),
    lines: lines.flatMap((one: unknown) => {
      const given = one as Partial<Given> | null
      if (typeof given?.line !== 'string') return []
      const from = typeof given.from === 'string' && MACHINE_NAMED.test(given.from)
      return [{ line: given.line, ...(from ? { from: given.from } : {}) }]
    }),
    took: typeof body.took === 'number' ? body.took : 0,
    refused: typeof body.refused === 'number' ? body.refused : 0,
  }
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)
}

/** A share the remote answered and would not take, in words. */
function refusedSays(answer: Answer, name: string): string {
  if (answer.status === 404) {
    return `${name}'s Tade does not share notes: it is older than this one, or its window is not open there — update it, or open it`
  }
  if (answer.status === 401 || answer.status === 204) return SIGNED_OUT
  const said = (answer.body as { said?: unknown } | null)?.said
  return `${name} would not share notes (${answer.status})${typeof said === 'string' ? `: ${printable(said)}` : ''}`
}
