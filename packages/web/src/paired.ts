import type { IncomingMessage, ServerResponse } from 'node:http'
import { appendDevice } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { type Asking, PAIR_TRIES, type Window } from './guard.ts'
import { inTime, labelOf, readBody } from './request.ts'
import type { Confirmed, PairingAsk, Told } from './serving.ts'
import { mint, SESSION_MS, setCookie } from './sessions.ts'
import { type Surface, scopesOn } from './surface.ts'
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
// Nothing here decides who may read what: pairing mints `read` and the
// ceiling is the origin's (`scopesOn`). Widening a device is a separate act at
// the machine with no route at all.

/** What the pairing exchange needs, and nothing else reachable from it. */
export interface Pairing {
  asking: Asking
  origin: { scheme: string; host: string }
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
  const { asking, origin, request, now, tell } = ctx
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
        warning: `the away view could not ask about a pairing: ${String(error).slice(0, 200)}`,
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

  const minted = mint()
  const scopes = scopesOn(origin, ctx.surface, ['read'])
  const until = new Date(now() + SESSION_MS)
  await appendDevice(ctx.home, {
    kind: 'paired',
    device: minted.device,
    at: new Date(now()).toISOString(),
    label: labelOf(label),
    digest: minted.digest,
    host: asking.host ?? '',
    csrf: minted.csrf,
    until: until.toISOString(),
    scopes: [...scopes],
    projects: confirmed.projects === null ? null : [...confirmed.projects],
    granted: [...confirmed.granted],
    from: asking.from,
  })
  tell({
    type: 'web_paired',
    detail: {
      device: minted.device,
      from: asking.from,
      // Never the label: a label is a person's own words about their own
      // phone, and the telemetry allow-list keeps `device` and not this.
      scopes: scopes.join(' '),
      granted: [...confirmed.granted].join(' '),
    },
  })
  res.setHeader('set-cookie', setCookie(minted.cookie, origin.scheme === 'https'))
  return ctx.json(
    { device: minted.device, scopes, csrf: minted.csrf, reads: [...confirmed.granted] },
    201,
  )
}
