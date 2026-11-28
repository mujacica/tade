import {
  AWAY_ITSELF,
  type AwayAnswer,
  type AwayAsk,
  type PendingCode,
  pairingUrl,
  readDevices,
  type Tickets,
  type Told,
  type WebAway,
  writeCode,
} from '@tade/web'
import { deviceViews, type PanelFacts, publicOf } from './web-panel.ts'
import { revokeEvery, revokeOne, type Sessions } from './web-sessions.ts'

// This machine's away view, answered for a tab of another machine's AWAY VIEW
// panel (`@tade/web`'s `away-there.ts` is the route and carries the argument).
//
// **Every press is this machine's own door, and nothing new.** A code is the
// one `tade web pair` writes (`writeCode`): the digest in the device list, the
// secret only in the link handed back once, nobody asked when it is used —
// the press there was the yes, as the command over SSH is. A sign-out is the
// panel's `revokeOne`, everything its `revokeEvery`, so the stream a revoked
// device holds closes here at once. What is answered is the panel's own facts
// (`PanelFacts`, `deviceViews`, `publicOf`), so the tab there and the panel
// here draw one machine the same way.
//
// **Written down as the device's**, a `web_did` line a press, its verb and
// whether it was done — never the link, never the secret.

export interface AwayThereDeps {
  home: string
  facts: () => PanelFacts
  sessions: () => Sessions
  tickets: Tickets
  log: (line: Told) => Promise<void>
}

/** The window's `WebAway`. Never throws: what failed is the answer's `problem`. */
export function awayThereFrom(deps: AwayThereDeps): WebAway {
  return async (asked, device) => {
    let code: AwayAnswer['code'] = null
    let cannot: string | null = null
    let problem: string | null = null
    const pressed = 'press' in asked ? (asked as Pressed) : null
    if (pressed !== null) {
      try {
        const done = await press(deps, pressed)
        code = done.code
        cannot = done.cannot
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err)
      }
      // The window's own writer, which says a line it could not write rather than throwing.
      await deps.log({
        type: 'web_did',
        detail: {
          device,
          verb: `away ${pressed.press}`,
          state: problem !== null ? 'failed' : cannot !== null ? 'refused' : 'done',
        },
      })
    }
    return answerOf(deps, code, cannot, problem)
  }
}

/** A press, rather than a look. */
type Pressed = Extract<AwayAsk, { press: string }>

/** One press, done by this machine's own doors. */
async function press(
  deps: AwayThereDeps,
  asked: Pressed,
): Promise<{ code: AwayAnswer['code']; cannot: string | null }> {
  const facts = deps.facts()
  if (asked.press === 'code') {
    if (!facts.listening) return { code: null, cannot: 'the away view is off there' }
    const base = pairingUrl(facts.surface)
    if (base === null) {
      return { code: null, cannot: 'no network: nothing could reach that machine' }
    }
    const now = facts.now
    const written = await writeCode(deps.home, { host: new URL(base).host, label: '' }, now)
    return {
      code: {
        url: `${base}#t=${written.secret}`,
        device: written.device,
        secondsLeft: Math.max(0, Math.ceil((written.until - now) / 1000)),
      },
      cannot: null,
    }
  }
  if (asked.press === 'revoke') {
    const known = facts.devices.some((one) => one.id === asked.device && one.revoked === null)
    const pending = (await readDevices(deps.home)).pending.some((one) => one.id === asked.device)
    if (!known && !pending) return { code: null, cannot: 'no such device is paired there' }
    await revokeOne(deps.sessions(), asked.device)
    return { code: null, cannot: null }
  }
  await revokeEvery(deps.sessions(), deps.tickets)
  return { code: null, cannot: null }
}

/** What the tab draws: the panel's own facts, read again after any press. */
async function answerOf(
  deps: AwayThereDeps,
  code: AwayAnswer['code'],
  cannot: string | null,
  problem: string | null,
): Promise<AwayAnswer> {
  const facts = deps.facts()
  const shown = publicOf(facts)
  // The one file a handler may read: the codes written and not yet claimed.
  // One that could not be read is said, never answered as no code outstanding.
  let pending: readonly PendingCode[] = []
  try {
    pending = (await readDevices(deps.home)).pending
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    problem ??= `its device list could not be read: ${why}`
  }
  const codes = pending
    .filter((one) => one.until > facts.now)
    .map((one) => ({ device: one.id, secondsLeft: Math.ceil((one.until - facts.now) / 1000) }))
  return {
    at: new Date(facts.now).toISOString(),
    listening: facts.listening,
    bind: facts.surface.bind,
    bound: [...facts.bound],
    reachable: facts.listening ? reachableOf(facts) : [],
    public: shown === null ? null : { name: shown.name, up: shown.up, lines: [...shown.lines] },
    devices: deviceViews(facts, AWAY_ITSELF),
    codes,
    code,
    streams: facts.streams,
    problem: problem ?? facts.problem,
    cannot,
  }
}

/** Where a phone could reach it: the address a code would carry, or nothing. */
function reachableOf(facts: PanelFacts): string[] {
  const base = pairingUrl(facts.surface)
  return base === null ? [] : [new URL(base).host]
}
