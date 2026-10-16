import type { IncomingMessage } from 'node:http'
import { appendDevice, type Device } from './devices.ts'
import { type ErrorKind, type Refusal, refuse } from './errors.ts'
import { Window } from './guard.ts'
import {
  asks,
  type Ceremony,
  Challenges,
  ceremonyFor,
  creationOptions,
  PROVE_TRIES,
  PROVE_WINDOW_MS,
  requestOptions,
  rpIdOf,
} from './passkeys.ts'
import { readBody } from './request.ts'
import type { Told } from './serving.ts'
import type { Origin, Surface } from './surface.ts'
import { verifyMade, verifyProved } from './webauthn.ts'

// The passkey's two routes: a challenge, and its answer — the one moment a
// device makes its passkey, and every later one it proves it may still act.
//
// **Both are this device's own credential and nothing else**, which is why
// they are `LIFECYCLE` beside pairing and signing out (`routes.ts`): `read`,
// a session, the token and an exact `Origin` like every mutation, and no
// project or task anywhere in them. A device proves itself and nobody else —
// the device is the session's, never a field of the body.
//
// The order, and what each step stops:
//
// 1. **Asked here at all**: the public listener, the hours above nought, an
//    `https` name (`asks`). Anywhere else it is the `404` of nothing to prove.
// 2. **The ceremony is the machine's choice**, out of the device record: make
//    one in the minutes after pairing, use the one it made, or neither
//    (`ceremonyFor`). The page never says which.
// 3. **The challenge is taken before the answer is read**, so a replay, two
//    answers at once and an answer to a challenge that ran out all find none.
// 4. **A device that keeps failing is slowed** (`PROVE_TRIES`): a signature
//    cannot be guessed, and an answer is still a signature check somebody
//    else's session would be paying for.
// 5. **Written down after it holds**: the `passkey` or `proved` line, then the
//    journal's `web_proved`. A refusal is written too, as `web_proved` refused.

/** What the passkey half needs of the listener, for as long as it listens. */
export interface Passkeying {
  home: string
  surface: Surface
  now: () => number
  tell: (told: Told) => void
}

/** Where one request came from, as the guard settled it. */
export interface Asked {
  req: IncomingMessage
  origin: Origin
}

/** What one request comes to: a body for the page, or a refusal. Never both. */
export type Answered = { body: Record<string, unknown> } | { refusal: Refusal }

/** The listener's passkey half: the challenges it set, and who keeps failing. */
export class Passkeys {
  private readonly ctx: Passkeying
  private readonly challenges = new Challenges()
  private readonly failures = new Window(PROVE_TRIES, PROVE_WINDOW_MS)

  constructor(ctx: Passkeying) {
    this.ctx = ctx
  }

  /**
   * One of the two routes, by its name in the table, for the session's own
   * device. `stated` is the request's `Origin` header, which the guard has
   * already held to the `Host`, scheme and port exactly: the origin the
   * browser will have written into the client data.
   */
  async carry(name: string, at: Asked, device: Device, stated: string): Promise<Answered> {
    const one: One = { device, origin: at.origin, stated }
    if (!asks(at.origin, this.ctx.surface) || rpIdOf(device) !== at.origin.host.toLowerCase()) {
      return no('not_offered')
    }
    // A passkey needs a secure context, so a request from a page that is not
    // one is a request no browser makes: the `locked` an act from it gets.
    if (at.origin.scheme !== 'https') return no('locked')
    const got = await readBody(at.req)
    if (!got.read) return { refusal: got.refusal }
    return name === 'passkey challenge' ? this.set(got.body, one) : this.check(got.body, one)
  }

  clear(): void {
    this.challenges.clear()
  }

  /** A challenge, for whichever ceremony this device may begin. */
  private set(body: unknown, one: One): Answered {
    if (!isEmpty(body)) return no('malformed')
    const { device } = one
    const now = this.ctx.now()
    const ceremony = ceremonyFor(device, now)
    // Past the minutes after pairing with nothing made: nothing to offer, and
    // the page already says *pair again* from what `/api/devices` told it.
    if (ceremony === null) return no('not_offered')
    const set = this.challenges.set(device.id, ceremony, one.stated, rpIdOf(device), now)
    const options =
      ceremony === 'create' ? creationOptions(device, set) : requestOptions(device, set)
    return { body: { ceremony, options } }
  }

  /** An answer to the challenge this device was set. */
  private async check(body: unknown, one: One): Promise<Answered> {
    const { ctx } = this
    const { device } = one
    const now = ctx.now()
    if (this.failures.over(device.id, now)) {
      return no('slow_down', this.failures.after(device.id, now))
    }
    const set = this.challenges.take(device.id, now)
    // None, or one that ran out: the page asks for another and says so.
    if (set === null) return no('stale')
    const expected = { challenge: set.challenge, origin: set.origin, rpId: set.rpId }
    if (set.ceremony === 'create') {
      // Asked again at the answer: a passkey made by another tab in between is
      // the one this device has, and a second would replace it silently.
      if (device.passkey !== null) return this.refused(device, 'create', 'it already has one')
      const made = verifyMade(body, expected)
      if (!made.ok) return this.refused(device, 'create', made.why)
      const { credential } = made
      await appendDevice(ctx.home, {
        kind: 'passkey',
        device: device.id,
        at: new Date(now).toISOString(),
        id: credential.id,
        key: credential.key,
        alg: credential.alg,
        counter: credential.counter,
        synced: credential.synced,
        transports: [...credential.transports],
      })
      ctx.tell({
        type: 'web_proved',
        detail: { device: device.id, ceremony: 'create', state: 'made', synced: credential.synced },
      })
      return { body: { made: true, until: this.until(now) } }
    }
    if (device.passkey === null) return this.refused(device, 'get', 'it has none')
    const proved = verifyProved(body, {
      ...expected,
      credential: device.passkey,
      device: device.id,
    })
    if (!proved.ok) return this.refused(device, 'get', proved.why)
    await appendDevice(ctx.home, {
      kind: 'proved',
      device: device.id,
      at: new Date(now).toISOString(),
      counter: proved.counter,
    })
    ctx.tell({
      type: 'web_proved',
      detail: { device: device.id, ceremony: 'get', state: 'proved' },
    })
    return { body: { proved: true, until: this.until(now) } }
  }

  /**
   * An answer that did not hold: counted, written down with Tade's own reason,
   * and one sentence to the page whatever the reason was — which check failed
   * is a map for whoever is guessing, and the journal is where it is read.
   */
  private refused(device: Device, ceremony: Ceremony, why: string): Answered {
    this.failures.add(device.id, this.ctx.now())
    this.ctx.tell({
      type: 'web_proved',
      detail: { device: device.id, ceremony, state: 'refused', why },
    })
    return no('unproven')
  }

  private until(now: number): string {
    return new Date(now + this.ctx.surface.passkeyMs).toISOString()
  }
}

/** One request, as the two steps read it. */
interface One {
  device: Device
  origin: Origin
  stated: string
}

function no(error: ErrorKind, after?: number): Answered {
  return { refusal: refuse(error, after === undefined ? {} : { after }) }
}

/** A body of `{}` and nothing else: a challenge names nothing, the device included. */
function isEmpty(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    Object.keys(body).length === 0
  )
}
