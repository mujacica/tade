import type { IncomingMessage, ServerResponse } from 'node:http'
import { appendDevice, readDevices } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { type Asking, PAIR_TRIES, type Window } from './guard.ts'
import { claimWritten } from './pending.ts'
import type { Grant } from './reach.ts'
import { inTime, labelOf, readBody } from './request.ts'
import type { Confirmed, PairingAsk, Told } from './serving.ts'
import { mint, SESSION_MS, setCookie } from './sessions.ts'
import { type Origin, type Scope, type Surface, scopesOn } from './surface.ts'
import { couldBeTicket, type Tickets } from './tickets.ts'

// The pairing exchange: the one route that mints a credential, and the one
// route with no credential to present.
//
// **Its own file because the ordering is the whole design and it should be
// readable on one screen.** `server.ts` is the listener; this is the five
// steps that let a phone in, in the order that makes a replay, a concurrent
// attempt, a refusal, a deadline and a throw all find nothing:
//
// 1. the rate limit, counted **before** the ticket is looked at, so a stream
//    of guesses costs a map entry rather than a scan;
// 2. the body, bounded;
// 3. the ticket **claimed** — which burns it — before anybody at the machine
//    is asked;
// 4. the person asked, with a deadline, where *nobody answered* is an answer;
// 5. the device written down, once, only after a yes.
//
// A code `tade web pair` wrote is the same five with the fourth already done:
// running the command was the yes (`pending.ts`), so step 3 burns it on the
// disk too, and step 5 writes what the terminal let it have.
//
// Nothing here decides who may read what: pairing mints what the person at
// the machine let it have (`Confirmed`) — `read` alone when that is unsaid —
// and the ceiling is the origin's (`scopesOn`), so a device on a plaintext
// address reads and nothing more whatever was let. Widening or narrowing one
// later is a separate act at the machine with no route at all.

/** What the pairing exchange needs, and nothing else reachable from it. */
export interface Pairing {
  asking: Asking
  origin: Origin
  /** The id of the one journal line that would hold a `broke`'s detail. */
  request: string
  tickets: Tickets
  confirm: (ask: PairingAsk) => Promise<Confirmed>
  confirmMs: number
  home: string
  surface: Surface
  /** The per-address rate limit, counted before anything is looked at. */
  pairing: Window
  now: () => number
  tell: (told: Told) => void
  /** A refusal worth a journal line, in the listener's own words. */
  said: (why: string) => void
  answer: (refusal: Refusal) => void
  json: (body: unknown, status?: number) => void
}

/**
 * Pairing: the one route that mints a credential.
 *
 * The order is the whole of it. The rate limit is counted **before** the
 * ticket is looked at, so a stream of guesses costs a map entry rather than a
 * scan; the ticket is **claimed** — which burns it — before anybody at the
 * machine is asked, so a refusal, a deadline, a crash and a replay all find
 * nothing; and the device is written down only once the person has said yes.
 */
export async function carryPairing(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Pairing,
): Promise<void> {
  const { asking, request, now, tell } = ctx
  if (ctx.pairing.over(asking.from, now())) {
    ctx.said(`pairing refused: ${PAIR_TRIES} tries already`)
    return ctx.answer(refuse('slow_down', { after: ctx.pairing.after(asking.from, now()) }))
  }
  ctx.pairing.add(asking.from, now())

  const got = await readBody(req)
  if (!got.read) return ctx.answer(got.refusal)
  if (typeof got.body !== 'object' || got.body === null || Array.isArray(got.body)) {
    return ctx.answer(refuse('malformed'))
  }
  const asked = got.body as Record<string, unknown>
  if (!couldBeTicket(asked.ticket)) return ctx.answer(refuse('malformed'))
  const label = typeof asked.label === 'string' ? asked.label : ''

  const claim = ctx.tickets.claim(asked.ticket, now())
  // A value this window never minted may be a code the terminal wrote
  // (`pending.ts`): the person who ran `tade web pair` has already said yes,
  // so it goes its own way, and is burned on its claim just the same.
  if (!claim.ok && claim.why === 'unknown') return carryWritten(res, asked.ticket, label, ctx)
  if (!claim.ok) {
    tell({ type: 'web_denied', detail: { why: claim.why, from: asking.from } })
    // The same answer to the phone whichever it was. Which it was is in the
    // journal, where a `used` is somebody replaying and an `unknown` is
    // somebody guessing, and the phone learns neither.
    return ctx.answer(refuse('no_session'))
  }

  let confirmed: Confirmed
  try {
    confirmed = await inTime(
      ctx.confirm({ label: labelOf(label), from: asking.from, host: asking.host ?? '' }),
      ctx.confirmMs,
      // A deadline is an **answer**, not a failure: nobody was there. The
      // ticket is already burned, so there is nothing to undo and no retry
      // against the same secret — which is the whole reason the claim
      // happens before this await rather than after it.
      { let: false, why: 'nobody answered' } satisfies Confirmed,
    )
  } catch (error) {
    // The window's own `confirm` threw. Also not a retry, and also already
    // burned; what it is, is a bug in the window worth a line somebody can
    // read, and a sentence with an id for the phone.
    tell({
      type: 'warning',
      detail: {
        message: `the away view could not ask about a pairing: ${String(error).slice(0, 200)}`,
        request,
      },
    })
    return ctx.answer(refuse('broke', { request }))
  }

  if (!confirmed.let) {
    tell({ type: 'web_denied', detail: { why: confirmed.why, from: asking.from } })
    // A refusal and nobody answering are the same answer here and two lines
    // in the journal: the phone cannot tell them apart, which is right —
    // "there is nobody at that machine" is a fact about somebody's day.
    return ctx.answer(refuse('no_session'))
  }

  return letIn(res, ctx, { ...confirmed, label: labelOf(label) }, null)
}

/**
 * A code the terminal wrote: claimed, burned on the disk, and the device it
 * becomes written down — with nobody asked, because running `tade web pair`
 * was the asking (`pending.ts`).
 *
 * The burn is the `claimed` line, appended **before** anything is decided
 * about the claim and before the device is: a refusal, a crash and a restart
 * all find a spent code. The memory half (`Tickets.spend`) happened inside
 * `claimWritten`, before this function's first `await`.
 */
async function carryWritten(
  res: ServerResponse,
  presented: string,
  label: string,
  ctx: Pairing,
): Promise<void> {
  const { asking, now, tell } = ctx
  const claim = claimWritten(
    presented,
    (await readDevices(ctx.home)).pending,
    ctx.tickets,
    asking.host ?? '',
    now(),
  )
  const burn = claim.ok ? claim.code : claim.burn
  if (burn !== null) {
    try {
      await appendDevice(ctx.home, {
        kind: 'claimed',
        device: burn.id,
        at: new Date(now()).toISOString(),
        from: asking.from.slice(0, 64),
      })
    } catch (error) {
      // Nothing is minted on a code whose burn could not be written down: a
      // restart would find it claimable again, and fail-closed is the order.
      tell({
        type: 'warning',
        detail: {
          message: `the away view could not burn a written pairing code: ${String(error).slice(0, 200)}`,
          request: ctx.request,
        },
      })
      return ctx.answer(refuse('broke', { request: ctx.request }))
    }
  }
  if (!claim.ok) {
    // `unknown` is a value that matched nothing anywhere — somebody guessing —
    // so it is the window's own line; anything else was a written code.
    const detail: Record<string, string> = { why: claim.why, from: asking.from }
    if (claim.why !== 'unknown') detail.code = 'terminal'
    tell({ type: 'web_denied', detail })
    return ctx.answer(refuse('no_session'))
  }
  const code = claim.code
  return letIn(
    res,
    ctx,
    {
      projects: code.projects,
      granted: code.granted as readonly Grant[],
      scopes: code.scopes as readonly Scope[],
      // The terminal's name for it where it gave one, the phone's otherwise.
      label: code.label === '' ? labelOf(label) : code.label,
    },
    code.id,
  )
}

/**
 * The device written down and the cookie set: the last step, once somebody
 * has let it in.
 *
 * `id` is a written code's own, so the code and the device it became are one
 * id in the list; null mints one. **Never an owner**: nothing a request can do
 * writes `owner` (`owner.ts`).
 */
async function letIn(
  res: ServerResponse,
  ctx: Pairing,
  given: {
    projects: readonly string[] | null
    granted: readonly Grant[]
    scopes?: readonly Scope[]
    label: string
  },
  id: string | null,
): Promise<void> {
  const { asking, origin, now, tell } = ctx
  const minted = mint(id ?? undefined)
  const device = minted.device
  const scopes = scopesOn(origin, ctx.surface, given.scopes ?? ['read'])
  const until = new Date(now() + SESSION_MS)
  await appendDevice(ctx.home, {
    kind: 'paired',
    device,
    at: new Date(now()).toISOString(),
    label: given.label,
    digest: minted.digest,
    host: asking.host ?? '',
    csrf: minted.csrf,
    until: until.toISOString(),
    scopes: [...scopes],
    projects: given.projects === null ? null : [...given.projects],
    granted: [...given.granted],
    from: asking.from,
  })
  tell({
    type: 'web_paired',
    detail: {
      device,
      from: asking.from,
      // Never the label: a label is a person's own words about their own
      // phone, and the telemetry allow-list keeps `device` and not this.
      scopes: scopes.join(' '),
      granted: [...given.granted].join(' '),
      // Which door let it in, as a word: the window's question, or a code the
      // terminal wrote — the strip says the second, since nobody here was asked.
      code: id === null ? 'window' : 'terminal',
    },
  })
  res.setHeader('set-cookie', setCookie(minted.cookie, origin.scheme === 'https'))
  return ctx.json({ device, scopes, csrf: minted.csrf, reads: [...given.granted] }, 201)
}
