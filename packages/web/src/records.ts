import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs } from './surface.ts'

// The records this machine's public name needs, looked at now, for another
// machine of the person's that links to it as an owner: what `tade host
// domain` says here — A, AAAA, DNSSEC and CAA, each against what the zone's
// own servers and the world's resolvers answer — in the same words
// (`domainHead`, `domainSays`).
//
// **Asked when somebody is looking, never on a clock**, which is the look's own
// rule (`wire/web-domain.ts`): the owner asks only while somebody there has
// Settings › Remotes open on this machine, once for each opening and again on
// its Look again — and the look is asking the world, so it is not asked on the
// owner's beat with what the machine is (`machine.ts`). A look already under
// way answers every ask that arrives while it runs, so two windows looking at
// once ask the world once.
//
// **An owner's, and only at this machine's own door** (`here`): whoever holds
// the SSH key can already run `tade host domain` here. A phone's session is
// refused it however much it was granted — **but the person's own**
// (`Route.theirs`, `theirsOf`), on any door, off this machine's asked a trusted
// origin and the passkey; the look's own rule (one in flight, `RECORDS_MS`)
// holds whoever asks. What it says is Tade's own sentences
// and the records to add or take away, as zone file lines; it writes nothing.

/** A sentence this machine's Tade wrote, bounded. */
const Said = z.string().max(600)
/** A record as a zone file line. */
const Record = z.string().max(600)

/** How many records one answer carries: there are four kinds. */
export const RECORDS_MOST = 8

const LineSchema = z.object({
  record: z.enum(['A', 'AAAA', 'DNSSEC', 'CAA']),
  state: z.enum(['right', 'missing', 'wrong', 'unseen', 'later', 'cannot']),
  said: Said,
  add: Record.nullable(),
  remove: z.array(Record).max(16),
  loud: z.boolean(),
})

/** The answer, as this machine gives it and another reads it: for its shape, every value bounded. */
export const RecordsAnswerSchema = z.object({
  /** This machine's own clock when the look came back. */
  at: z.string().max(40),
  /** The public name looked at, or null where it has none. */
  name: z.string().max(253).nullable(),
  /** The line about the zone (`domainHead`); null where nothing was looked at. */
  head: Said.nullable(),
  /** A line per record, in the order they are done (`domainSays`). */
  lines: z.array(LineSchema).max(RECORDS_MOST),
  /** Why nothing was looked at — no public name, a window that does not dial, a look that ran out of time. */
  cannot: Said.nullable(),
})
export type RecordsAnswer = z.infer<typeof RecordsAnswerSchema>

/** The window's half: its public name's records, looked at now. Never throws. */
export type WebRecords = () => Promise<RecordsAnswer>

/** The route. `records` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function recordsHere(
  req: IncomingMessage,
  device: Device,
  records: WebRecords | undefined,
): Promise<{ body: RecordsAnswer } | { refusal: Refusal }> {
  if (records === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  if (!z.strictObject({}).safeParse(got.body).success) return { refusal: refuse('malformed') }
  return { body: recordsFor(await records()) }
}

/** An answer within its bounds, cut rather than refused, so the other machine never refuses the whole. */
export function recordsFor(all: RecordsAnswer): RecordsAnswer {
  const said = (text: string | null) => (text === null ? null : cut(text, 600))
  return {
    at: all.at,
    name: all.name === null ? null : cut(all.name, 253),
    head: said(all.head),
    lines: all.lines.slice(0, RECORDS_MOST).map((one) => ({
      ...one,
      said: cut(one.said, 600),
      add: said(one.add),
      remove: one.remove.slice(0, 16).map((gone) => cut(gone, 600)),
    })),
    cannot: said(all.cannot),
  }
}

/** A string at most `most` long, with an ellipsis where it was cut. */
function cut(text: string, most: number): string {
  return text.length <= most ? text : `${text.slice(0, most - 1)}…`
}
