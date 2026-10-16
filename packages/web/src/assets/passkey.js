// This device's passkey, from the page's side: made once in the minutes after
// pairing, used before acting from the public name, and never asked for
// anywhere else (`src/passkeys.ts` is the machine's half).
//
// **A press and only a press starts a ceremony.** Nothing here calls
// `navigator.credentials` on load, on a beat or after a refusal: Safari
// rate-limits a page that asks repeatedly with a backoff that can leave a
// promise hanging (WebKit bug 273712), and a burst of asks followed by a
// switch of apps has put the Face ID sheet inside another home-screen app and
// stopped passkeys working in every web app until a restart (WebKit bug
// 291258). One ceremony at a time, abandoned after `GIVE_UP_MS`.
//
// **The challenge is fetched before the press, and the press goes straight to
// the authenticator.** Safari before 17.4 allowed a ceremony only inside a
// gesture, and a `fetch` in between spent part of it; 17.4 dropped the rule
// but kept a focus check. So a fresh challenge is held while the bar is up
// (`ready`), replaced before the machine's five minutes run out, and the
// press's first act is `create()` or `get()` with nothing awaited before it.
//
// **The machine decides which ceremony**, and this page only draws what it
// was told on `/api/devices` (`you.passkey`): whether acting from here asks,
// whether this device made one, whether its last proof counts now — by the
// machine's clock, never this page's — and until when it may still make one.
// A drawing hint, like `scopes` beside it; the gate is `proven` at every act.
//
// **The Signal API is never called** (`PublicKeyCredential.signal*`): on iOS 26
// it deletes the passkeys of other accounts on the same name (WebKit bug
// 322267).

/** How old a held challenge may be at a press. The machine's are five minutes. */
export const FRESH_MS = 4 * 60_000

/** How long a ceremony may take before this page stops waiting for it. */
export const GIVE_UP_MS = 150_000

/**
 * How long after a challenge could not be had before the bar asks again on its
 * own: the beat is five seconds, and a phone with no signal must not post every
 * one of them. A press asks at once whatever this says.
 */
export const RETRY_MS = 30_000

/** Whether a scope list holds anything a passkey would be asked for: more than reading. */
export function actsAtAll(scopes) {
  return Array.isArray(scopes) && scopes.some((one) => one !== 'read')
}

/**
 * Which of the three bars this device needs, or null — pure, so a test holds
 * every row of it.
 *
 * - `make`: no passkey yet and the minutes after pairing are still running.
 *   Drawn whatever the device may do, because what it may do is granted at the
 *   machine afterwards and this is the one chance to make one.
 * - `use`: a passkey whose last proof has run out, on a device that may act.
 * - `missed`: no passkey and the chance gone, on a device that may act — it
 *   reads, and acting needs pairing again. Said, because a press that is
 *   refused for ever with nothing saying why is the silence this page exists
 *   to avoid.
 */
export function passkeyNeed(you) {
  const passkey = you?.passkey
  if (passkey === null || passkey === undefined || passkey.asks !== true) return null
  // **The machine's answers, never this page's clock**: a phone's clock is
  // somebody else's, and an hour of drift would draw a bar the act then
  // contradicts. A proof that runs out with the page open is said by the act
  // it refuses, which asks `/api/devices` again (`boot.js`).
  if (passkey.made !== true) {
    if (typeof passkey.makeBy === 'string') return 'make'
    return actsAtAll(you.scopes) ? 'missed' : null
  }
  if (passkey.proven === true) return null
  return actsAtAll(you.scopes) ? 'use' : null
}

/** The bar for a need, in the page's own words. `said` is the last thing that went wrong. */
export function passkeyBar(need, you, now, state) {
  if (need === null) return null
  const hours = you.passkey.hours
  const lasts = `Using it lets this device act from here for ${hours === 1 ? 'an hour' : `${hours} hours`}; reading never asks.`
  if (need === 'missed') {
    return {
      key: 'passkey-missed',
      tone: 'is-stale',
      glyph: '◆',
      // Short enough for a phone's one line; the rest is behind the `?`.
      lead: 'No passkey: reading only',
      under:
        'This device can read from here and not act: it made no passkey in the minutes after it paired, which is the only time one can be made. Pair it again at the machine to act from here.',
    }
  }
  const by = Date.parse(you.passkey.makeBy ?? '')
  const left = Number.isNaN(by) || by <= now ? '' : ` It can be made for ${minutes(by - now)} more.`
  const busy = state.busy === true
  return {
    key: `passkey-${need}`,
    tone: 'is-stale',
    glyph: '◆',
    lead: busy
      ? 'Waiting for the passkey…'
      : need === 'make'
        ? 'Make a passkey to act'
        : 'Use your passkey to act',
    under: `${state.said ?? ''}${state.said ? ' ' : ''}${lasts}${need === 'make' ? left : ''}`,
    press: { said: need === 'make' ? 'Make passkey' : 'Use passkey', does: state.does },
  }
}

function minutes(ms) {
  const n = Math.max(1, Math.ceil(ms / 60_000))
  return n === 1 ? 'a minute' : `${n} minutes`
}

/**
 * The passkey half of the page: what it holds between presses, and the press.
 *
 * `ask` is `boot.js`'s, so the token and the same-origin rules are the page's
 * own; `freshen` asks `/api/devices` again, which is how a proof reaches the
 * bar; `paint` draws. `credentials` is `navigator.credentials` unless a test
 * hands over another.
 */
export function passkeys({
  ask,
  freshen,
  paint,
  credentials = () => navigator.credentials,
  now = () => Date.now(),
}) {
  let held = null
  let fetching = false
  /** When a challenge last could not be had, or null. */
  let missed = null
  let busy = false
  let said = ''
  let need = null

  async function fetchChallenge() {
    if (fetching) return
    fetching = true
    try {
      const got = await ask('POST', '/api/passkey/challenge', {})
      held =
        got.status === 200 && got.body !== null && typeof got.body.ceremony === 'string'
          ? { ceremony: got.body.ceremony, options: got.body.options, at: now() }
          : null
      missed = held === null ? now() : null
      // Nothing to offer any more: the minutes after pairing ran out with the
      // page open. Asked again, so the bar becomes the one that says so.
      if (got.status === 404) await freshen()
    } finally {
      fetching = false
    }
  }

  async function press() {
    if (busy) return
    const using = held
    if (using === null || now() - using.at > FRESH_MS) {
      said = 'Getting ready — press again in a moment.'
      void fetchChallenge().then(paint)
      paint()
      return
    }
    // Spent here, whatever comes of it: the machine takes a challenge on its
    // answer, so a second press with this one would only be refused.
    held = null
    busy = true
    said = ''
    let made = null
    const stop = typeof AbortController === 'function' ? new AbortController() : null
    const timer = setTimeout(() => stop?.abort(), GIVE_UP_MS)
    try {
      // **Nothing awaited before this line**, which is the whole of the press.
      const signal = stop === null ? {} : { signal: stop.signal }
      made =
        using.ceremony === 'create'
          ? await credentials().create({ publicKey: creationIn(using.options), ...signal })
          : await credentials().get({ publicKey: requestIn(using.options), ...signal })
    } catch (error) {
      said = refusedBy(error)
    } finally {
      clearTimeout(timer)
    }
    if (made === null || made === undefined) {
      busy = false
      if (said === '') said = 'No passkey was used.'
      void fetchChallenge().then(paint)
      paint()
      return
    }
    const answered = await ask('POST', '/api/passkey/answer', answerOf(made, using.ceremony))
    busy = false
    said =
      answered.status === 200
        ? ''
        : answered.status === 0
          ? 'The machine did not answer.'
          : 'That passkey was not accepted.'
    if (answered.status === 200) await freshen()
    else void fetchChallenge().then(paint)
    paint()
  }

  return {
    /** The bar to draw now, or nothing. */
    bars(you, at = now()) {
      need = passkeyNeed(you)
      const bar = passkeyBar(need, you, at, { busy, said, does: () => void press() })
      return bar === null ? [] : [bar]
    },
    /**
     * Hold a fresh challenge while a bar with a press is up — fetched now and
     * before the machine's runs out, so a press never waits on the network.
     */
    ready() {
      if (need !== 'make' && need !== 'use') return
      if (busy || (held !== null && now() - held.at <= FRESH_MS)) return
      if (held === null && missed !== null && now() - missed < RETRY_MS) return
      void fetchChallenge()
    },
    press,
  }
}

/**
 * What the browser's refusal of a ceremony means, in the page's words. Its
 * name is the whole of what it says: *not allowed* is a cancel, a timeout or
 * a page without focus, and the specification keeps them apart on purpose.
 */
export function refusedBy(error) {
  const name = typeof error?.name === 'string' ? error.name : ''
  if (name === 'NotAllowedError') return 'No passkey was used.'
  if (name === 'AbortError') return 'The passkey took too long.'
  if (name === 'SecurityError') return 'This address cannot use a passkey.'
  if (name === 'InvalidStateError') return 'This device already has a passkey here.'
  return `No passkey was used${name === '' ? '' : ` (${name})`}.`
}

/** base64url, as the machine writes it, to the bytes the authenticator takes. */
export function bytesOf(text) {
  const padded = String(text).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  const out = new Uint8Array(raw.length)
  for (let at = 0; at < raw.length; at++) out[at] = raw.charCodeAt(at)
  return out
}

/** Bytes back to base64url, unpadded, as the machine reads it. */
export function textOf(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  let raw = ''
  for (const byte of bytes) raw += String.fromCharCode(byte)
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * What the machine sent, as `create()` takes it. Written out rather than
 * `PublicKeyCredential.parseCreationOptionsFromJSON`, which Safari only has
 * from 18.4.
 */
export function creationIn(options) {
  return {
    ...options,
    challenge: bytesOf(options.challenge),
    user: { ...options.user, id: bytesOf(options.user.id) },
  }
}

/** What the machine sent, as `get()` takes it. */
export function requestIn(options) {
  return {
    ...options,
    challenge: bytesOf(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((one) => ({
      ...one,
      id: bytesOf(one.id),
    })),
  }
}

/**
 * The credential, as exactly the fields the machine reads and no others: its
 * body is strict, so `toJSON()`'s extras (and its absence before Safari 18.4)
 * are both kept out by building it here.
 */
export function answerOf(made, ceremony) {
  const response = made.response
  if (ceremony === 'create') {
    const transports =
      typeof response.getTransports === 'function'
        ? response
            .getTransports()
            .filter((one) => typeof one === 'string' && one.length <= 32)
            .slice(0, 8)
        : null
    return {
      id: textOf(made.rawId),
      type: 'public-key',
      response: {
        clientDataJSON: textOf(response.clientDataJSON),
        attestationObject: textOf(response.attestationObject),
        ...(transports === null ? {} : { transports }),
      },
    }
  }
  return {
    id: textOf(made.rawId),
    type: 'public-key',
    response: {
      clientDataJSON: textOf(response.clientDataJSON),
      authenticatorData: textOf(response.authenticatorData),
      signature: textOf(response.signature),
      userHandle:
        response.userHandle === null || response.userHandle === undefined
          ? null
          : textOf(response.userHandle),
    },
  }
}
