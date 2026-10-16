import { randomBytes } from 'node:crypto'
import type { Device } from './devices.ts'
import { hostOf, proven } from './guard.ts'
import type { Origin, Surface } from './surface.ts'
import { ALGORITHMS, relyingParty, userIdOf } from './webauthn.ts'

// A passkey per device, and the proof it gives before acting from the public
// name (REMOTE-TADE.md §4.4, V5): the challenges this machine sets, what a
// device is offered, and what the page is told about where it stands.
//
// **Made once, in the minutes after pairing, and never later** (`ENROL_MS`).
// A passkey is only worth what stood behind making it, and the one moment
// something did is the pairing: a code shown at the machine, claimed seconds
// ago. Later, the only thing standing behind a request is the session — which
// is exactly the credential a passkey is there to doubt — so a session copied
// off a phone that never made one could make its own and act. A device that
// let the minutes pass, or paired before this asked, reads until it pairs
// again, and `PASSKEY_BEFORE_ACTING` says so where the hours are set.
//
// **One per device, and its own.** The user id is the device's id, so two of
// the person's devices sharing one keychain make two passkeys rather than the
// second quietly replacing the first, which iOS does for one relying party and
// one user — and the first device could then never prove itself again.
//
// **Only the public listener asks** (`proven`, `guard.ts`), and only it
// offers: a passkey's relying party is the name, which is what the public
// listener has and a LAN address never did.

/** How long after pairing a device may make its passkey. */
export const ENROL_MS = 15 * 60_000

/** How long a challenge this machine set may be answered. */
export const CHALLENGE_MS = 5 * 60_000

/** How many answers that did not hold one device gets, and over how long. */
export const PROVE_TRIES = 5
export const PROVE_WINDOW_MS = 10 * 60_000

/** How long the browser is told to wait for the person, in milliseconds. */
const ASK_MS = 120_000

/** The two ceremonies: making the passkey, and using it. */
export type Ceremony = 'create' | 'get'

/** A challenge this machine set, as it is checked when it is answered. */
export interface Challenge {
  ceremony: Ceremony
  /** 32 random bytes, base64url, exactly as handed out. */
  challenge: string
  until: number
  /** The `Origin` it was set for, exactly. The answer must be made there. */
  origin: string
  rpId: string
}

/**
 * The challenges outstanding: **one per device**, taken on its answer whatever
 * came of it.
 *
 * In memory, like a pairing ticket and for its reason: a window that restarts
 * has set none, and the page asks for another. Asking again replaces the one
 * before, so two answers in flight cannot both find one; the map is keyed by
 * a device that holds a session, so it is as long as the device list.
 */
export class Challenges {
  private readonly held = new Map<string, Challenge>()

  /** A new challenge for this device, replacing any it had. */
  set(device: string, ceremony: Ceremony, origin: string, rpId: string, now: number): Challenge {
    for (const [id, one] of this.held) if (now >= one.until) this.held.delete(id)
    const challenge = {
      ceremony,
      challenge: randomBytes(32).toString('base64url'),
      until: now + CHALLENGE_MS,
      origin,
      rpId,
    }
    this.held.set(device, challenge)
    return challenge
  }

  /**
   * The one this device was set, **taken** — before anything about the answer
   * is looked at — or null where there is none or it ran out.
   */
  take(device: string, now: number): Challenge | null {
    const one = this.held.get(device) ?? null
    this.held.delete(device)
    return one === null || now >= one.until ? null : one
  }

  clear(): void {
    this.held.clear()
  }
}

/**
 * Whether a request is where a passkey is asked for: the public listener, with
 * the hours above nought, on a host that is a name.
 *
 * **Not the scheme**, which a read cannot say: a browser sends no `Origin` on a
 * same-origin `GET`, so `/api/devices` arriving through Caddy's plaintext
 * socket reads as `http` while the page is `https`. The two passkey routes
 * are mutations, whose `Origin` is the page's own, and ask `https` themselves
 * (`passkeyed.ts`).
 */
export function asks(origin: Origin, surface: Surface): boolean {
  if (origin.listener !== 'public' || surface.passkeyMs <= 0) return false
  return relyingParty(origin.host)
}

/** Which ceremony this device may begin now, or null for neither. */
export function ceremonyFor(device: Device, now: number): Ceremony | null {
  if (device.passkey !== null) return 'get'
  return now < device.pairedAt + ENROL_MS ? 'create' : null
}

/** The relying party for a device: the host its session is bound to, without a port. */
export function rpIdOf(device: Device): string {
  return (hostOf(device.host) ?? '').toLowerCase()
}

/**
 * What the page is told about this device's passkey, on `/api/devices`.
 *
 * A drawing hint, like `scopes` beside it: what decides is `proven` at the act.
 * Moments as ISO strings, so the page compares them with its own clock and the
 * machine's word for when is the one it draws.
 */
export interface PasskeyStanding {
  /** Whether acting from where this request came in asks for a passkey. */
  asks: boolean
  /** Whether this device has made one. */
  made: boolean
  /**
   * Whether its last proof lets it act now, by **this machine's** clock — the
   * page draws from this and never from its own, because a phone's clock is
   * somebody else's. A proof that runs out while a page is open is said by
   * the act it refuses (`unproven`), which asks this again.
   */
  proven: boolean
  /** Until when the last proof lets it act, or null: words, never the decision. */
  until: string | null
  /** Until when it may still make one, or null where it may not. */
  makeBy: string | null
  /** The setting, in hours, so the page can say how long a proof lasts. */
  hours: number
}

export function passkeyStanding(
  device: Device,
  origin: Origin,
  surface: Surface,
  now: number,
): PasskeyStanding {
  const asked = asks(origin, surface)
  const passkey = device.passkey
  const enrolBy = device.pairedAt + ENROL_MS
  return {
    asks: asked,
    made: passkey !== null,
    proven: asked && passkey !== null && proven(origin, passkey.proved, surface, now),
    until:
      asked && passkey !== null && passkey.proved <= now
        ? new Date(passkey.proved + surface.passkeyMs).toISOString()
        : null,
    makeBy: asked && passkey === null && now < enrolBy ? new Date(enrolBy).toISOString() : null,
    hours: surface.passkeyMs / 3_600_000,
  }
}

/**
 * What `navigator.credentials.create()` is handed, as JSON the page turns into
 * bytes (`passkey.js`).
 *
 * `attestation: 'none'` because nothing here reads which make of authenticator
 * it is; `userVerification: 'required'` because a tap is not a person; a
 * resident key *preferred*, which is what a passkey is and what a security key
 * may decline. No `authenticatorAttachment`: a phone's own, a security key and
 * another phone are all the person's.
 */
export function creationOptions(device: Device, challenge: Challenge): Record<string, unknown> {
  const name = device.label.trim() === '' ? 'this device' : device.label.slice(0, 64)
  return {
    challenge: challenge.challenge,
    rp: { id: challenge.rpId, name: 'Tade' },
    user: { id: userIdOf(device.id), name, displayName: name },
    pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
    timeout: ASK_MS,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
  }
}

/** What `navigator.credentials.get()` is handed: this device's passkey and no other. */
export function requestOptions(device: Device, challenge: Challenge): Record<string, unknown> {
  const passkey = device.passkey
  return {
    challenge: challenge.challenge,
    rpId: challenge.rpId,
    allowCredentials:
      passkey === null
        ? []
        : [
            {
              type: 'public-key',
              id: passkey.id,
              ...(passkey.transports.length === 0 ? {} : { transports: [...passkey.transports] }),
            },
          ],
    userVerification: 'required',
    timeout: ASK_MS,
  }
}
