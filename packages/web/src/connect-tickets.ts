import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { digestMatches, digestOf } from './sessions.ts'
import { ticketValue } from './tickets.ts'

// The tickets a press on the connect pages carries on this machine's own door
// (`connected.ts`), in `<home>/connect-tickets.jsonl`, `0600`.
//
// **Why there is one at all.** That door is loopback, and loopback is every
// account on this machine, not only yours: with nothing but the cross-site
// layers a press asks, any process here could send an exact `Origin`, JSON and
// no `Sec-Fetch-Site` — none of which a program outside a browser is held to —
// and replace an App, a signing secret or a token with its own. What a session
// would have proved is that the press is the person's, and the door does not
// prove it. A ticket does: it is printed by `tade web connect`, minted by the
// window's Open or Copy on Settings › Intake, or asked for by another machine
// of the person's over its owner session (`/api/connect`, which `tade remote
// connect` there carries on every press), so whoever holds one is running as
// you or holds your SSH key — the reach that can already edit `config.yaml`.
//
// What keeps it the same size of thing as a pairing code (`pending.ts`):
//
// - **The digest is written, never the ticket.** The ticket is in the link's
//   fragment, which a browser sends nowhere, and the page sends it with each
//   press; the file holds nothing anybody could present.
// - **On a disk, because the window is not the only one minting**: the CLI is
//   another process, and the server that answers may be `tade serve`. `0600`,
//   narrowed on every write, so another account reads nothing — and an agent
//   here, which runs as you, reads digests it cannot press with.
// - **An hour, and pressed as often as the page needs** — making an App,
//   keeping what its page showed, installing it — since one page is one
//   person's next few minutes and a reload keeps its fragment. Never burned at
//   a press, because the page is the one that holds it; a new one is a new
//   link, and the oldest go once more than `TICKETS_HELD` are outstanding.

/** What the file is called, under the home. */
export const CONNECT_TICKETS_FILE = 'connect-tickets.jsonl'

/** How long a ticket is good for: one sitting with the pages, making and installing an app. */
export const CONNECT_TICKET_MS = 60 * 60_000

/** How many may be outstanding: links printed and opened again and again forget their oldest. */
export const TICKETS_HELD = 16

/** Where it is. Never inside a project: nothing Tade writes is. */
export function connectTicketsPath(home: string): string {
  return join(home, CONNECT_TICKETS_FILE)
}

/** A ticket's shape, as `ticketValue` mints one: 160 bits, base64url. */
const SHAPE = /^[A-Za-z0-9_-]{27}$/

const Line = z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/), until: z.number() })
type Held = z.infer<typeof Line>

/** The lines that are still good, a bad one skipped rather than thrown over. */
async function held(home: string, now: number): Promise<Held[]> {
  let text: string
  try {
    text = await readFile(connectTicketsPath(home), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: Held[] = []
  for (const one of text.split('\n')) {
    if (one.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(one)
    } catch {
      continue
    }
    const line = Line.safeParse(parsed)
    if (line.success && line.data.until > now) out.push(line.data)
  }
  return out
}

/**
 * Mint a ticket for the connect pages: its digest written down, the ticket
 * handed back for the link's fragment and nowhere else.
 */
export async function mintConnectTicket(
  home: string,
  now: number,
): Promise<{ ticket: string; until: number }> {
  const ticket = ticketValue()
  const until = now + CONNECT_TICKET_MS
  const kept = [...(await held(home, now)), { digest: digestOf(ticket), until }].slice(
    -TICKETS_HELD,
  )
  const path = connectTicketsPath(home)
  await mkdir(dirname(path), { recursive: true })
  // Written whole beside it and moved into place, so a reader finds the old
  // file or the new one and never half of either; created `0600` rather than
  // narrowed afterwards, and narrowed again in case somebody widened it.
  // Its own name each time, so two mints at once never share one.
  const next = `${path}.${randomBytes(6).toString('hex')}.next`
  await writeFile(next, kept.map((one) => `${JSON.stringify(one)}\n`).join(''), { mode: 0o600 })
  await rename(next, path)
  await chmod(path, 0o600).catch(() => {})
  return { ticket, until }
}

/**
 * Whether `presented` is a ticket minted here that has not run out. A file
 * that could not be read throws, so it is said as the server's own trouble
 * rather than as a press with no ticket.
 */
export async function connectTicketHolds(
  home: string,
  presented: string | null,
  now: number,
): Promise<boolean> {
  if (presented === null || !SHAPE.test(presented)) return false
  const lines = await held(home, now)
  // Every line compared, in constant time each, so how long it takes says
  // nothing about which one it was.
  let found = false
  for (const one of lines) if (digestMatches(presented, one.digest)) found = true
  return found
}

/** The link to the pages with a ticket on it: in the fragment, which a browser sends nowhere. */
export function ticketed(url: string, ticket: string): string {
  return `${url}#ticket=${ticket}`
}
