import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  answerOf,
  bytesOf,
  creationIn,
  FRESH_MS,
  passkeyBar,
  passkeyNeed,
  passkeys,
  RETRY_MS,
  refusedBy,
  requestIn,
  textOf,
} from '../src/assets/passkey.js'
import { verifyMade, verifyProved } from '../src/webauthn.ts'
import { SoftAuthenticator } from './authenticator.ts'

// The page's half of a passkey, run against a browser that is not one: which
// bar is drawn for which answer, that a press goes straight to the
// authenticator with nothing awaited first, and that what the page sends is
// exactly what the machine reads — held by handing the page's own JSON to the
// machine's own verifier.

const NOW = Date.parse('2026-10-16T12:00:00Z')
const HOUR = 3_600_000
const at = (ms: number) => new Date(NOW + ms).toISOString()

function you(passkey: Record<string, unknown> | null, scopes = ['read', 'steer']) {
  return {
    scopes,
    passkey:
      passkey === null
        ? null
        : {
            asks: true,
            made: false,
            proven: false,
            until: null,
            makeBy: null,
            hours: 12,
            ...passkey,
          },
  }
}

describe('which bar a device is drawn', () => {
  const rows: [string, ReturnType<typeof you>, string | null][] = [
    ['nothing asked here', you({ asks: false }), null],
    ['no passkey field at all', you(null), null],
    ['the minutes after pairing', you({ makeBy: at(60_000) }), 'make'],
    ['the minutes after pairing, reading only', you({ makeBy: at(60_000) }, ['read']), 'make'],
    ['the minutes gone, may act', you({ makeBy: null }), 'missed'],
    ['the minutes gone, reading only', you({ makeBy: null }, ['read']), null],
    ['a proof still good', you({ made: true, proven: true, until: at(HOUR) }), null],
    ['a proof run out, may act', you({ made: true, until: at(-1) }), 'use'],
    // The machine's word over this page's clock, whichever way they disagree.
    ['a proof run out by the machine’s clock', you({ made: true, until: at(HOUR) }), 'use'],
    ['a proof good by the machine’s clock', you({ made: true, proven: true, until: at(-1) }), null],
    ['a proof run out, reading only', you({ made: true, until: at(-1) }, ['read']), null],
  ]
  for (const [what, device, need] of rows) {
    it(`${what}: ${need ?? 'none'}`, () => {
      expect(passkeyNeed(device)).toBe(need)
    })
  }

  it('offers a press to make one or use one, and none where only pairing again helps', () => {
    const does = () => {}
    const make = passkeyBar('make', you({ makeBy: at(4 * 60_000) }), NOW, { does })
    expect(make?.press?.said).toBe('Make passkey')
    expect(make?.under).toContain('4 minutes more')
    expect(make?.under).toContain('12 hours')
    const use = passkeyBar('use', you({ made: true }), NOW, { does })
    expect(use?.press?.said).toBe('Use passkey')
    expect(use?.lead).toContain('passkey')
    const missed = passkeyBar('missed', you({}), NOW, { does })
    expect(missed?.press).toBeUndefined()
    expect(missed?.under).toContain('Pair it again')
    expect(passkeyBar('use', you({ made: true }), NOW, { busy: true, does })?.lead).toBe(
      'Waiting for the passkey…',
    )
    expect(
      passkeyBar('use', you({ made: true }), NOW, { said: 'No passkey was used.', does })?.under,
    ).toMatch(/^No passkey was used\. /)
    expect(passkeyBar(null, you({}), NOW, { does })).toBeNull()
  })
})

describe('a ceremony the browser refused', () => {
  it('is said by what the browser named it, and never by its message', () => {
    const named = (name: string) => Object.assign(new Error('a message nobody reads'), { name })
    expect(refusedBy(named('NotAllowedError'))).toBe('No passkey was used.')
    expect(refusedBy(named('AbortError'))).toBe('The passkey took too long.')
    expect(refusedBy(named('SecurityError'))).toBe('This address cannot use a passkey.')
    expect(refusedBy(named('InvalidStateError'))).toBe('This device already has a passkey here.')
    expect(refusedBy(named('UnknownError'))).toBe('No passkey was used (UnknownError).')
    expect(refusedBy(null)).toBe('No passkey was used.')
  })
})

describe('the bytes the authenticator takes and gives', () => {
  it('turns base64url into bytes and back, whatever the length', () => {
    for (let n = 0; n < 40; n++) {
      const raw = randomBytes(n)
      const text = raw.toString('base64url')
      expect(Buffer.from(bytesOf(text)).equals(raw)).toBe(true)
      expect(textOf(raw)).toBe(text)
      expect(textOf(new Uint8Array(raw).buffer)).toBe(text)
    }
  })

  it('hands create() and get() bytes where they take bytes, and nothing else changed', () => {
    const made = creationIn({
      challenge: 'AAEC',
      rp: { id: 'tade.example.com', name: 'Tade' },
      user: { id: 'ZGV2aWNl', name: 'iPhone', displayName: 'iPhone' },
    }) as { challenge: Uint8Array; user: { id: Uint8Array; name: string }; rp: unknown }
    expect([...made.challenge]).toEqual([0, 1, 2])
    expect(Buffer.from(made.user.id).toString()).toBe('device')
    expect(made.user.name).toBe('iPhone')
    expect(made.rp).toEqual({ id: 'tade.example.com', name: 'Tade' })
    const asked = requestIn({
      challenge: 'AAEC',
      rpId: 'tade.example.com',
      allowCredentials: [{ type: 'public-key', id: 'AQID', transports: ['internal'] }],
    }) as { allowCredentials: { id: Uint8Array; transports: string[] }[] }
    expect([...(asked.allowCredentials[0]?.id ?? [])]).toEqual([1, 2, 3])
    expect(asked.allowCredentials[0]?.transports).toEqual(['internal'])
  })
})

/** A `PublicKeyCredential`, as a browser hands one to the page, out of what a soft authenticator made. */
function credentialOf(body: {
  id: string
  response: Record<string, unknown>
}): Record<string, unknown> {
  const buffer = (text: unknown) => new Uint8Array(Buffer.from(String(text), 'base64url')).buffer
  const response = body.response
  return {
    id: body.id,
    rawId: buffer(body.id),
    type: 'public-key',
    response: {
      clientDataJSON: buffer(response.clientDataJSON),
      ...(response.attestationObject === undefined
        ? {
            authenticatorData: buffer(response.authenticatorData),
            signature: buffer(response.signature),
            userHandle: response.userHandle === null ? null : buffer(response.userHandle),
          }
        : {
            attestationObject: buffer(response.attestationObject),
            getTransports: () => ['internal', 'hybrid', 'x'.repeat(40)],
          }),
    },
  }
}

describe('what the page sends is what the machine reads', () => {
  const RP = 'tade.example.com'
  const ORIGIN = `https://${RP}`

  it('is a passkey the machine takes, made and then used', () => {
    const box = new SoftAuthenticator()
    const made = { challenge: randomBytes(32).toString('base64url'), origin: ORIGIN, rpId: RP }
    const sent = answerOf(credentialOf(box.make(made)), 'create')
    // A transport longer than the machine takes is left out, not sent to be refused.
    expect((sent.response as { transports: string[] }).transports).toEqual(['internal', 'hybrid'])
    const kept = verifyMade(sent, made)
    expect(kept.ok).toBe(true)
    if (!kept.ok) return
    const used = { challenge: randomBytes(32).toString('base64url'), origin: ORIGIN, rpId: RP }
    const proof = answerOf(credentialOf(box.prove(used)), 'get')
    expect(
      verifyProved(proof, { ...used, credential: kept.credential, device: 'a'.repeat(16) }),
    ).toEqual({ ok: true, counter: 0 })
  })
})

describe('a press', () => {
  const options = { challenge: 'AAEC', rp: { id: 'x' }, user: { id: 'AQ', name: 'n' } }

  /** The page's half, over a fake browser and a fake machine. */
  function page(over: { create?: () => Promise<unknown>; answer?: number } = {}) {
    const calls: string[] = []
    let clock = NOW
    const freshened: number[] = []
    const ctl = passkeys({
      ask: async (_method, path) => {
        calls.push(path)
        if (path === '/api/passkey/challenge') {
          return { status: 200, body: { ceremony: 'create', options } }
        }
        return { status: over.answer ?? 200, body: {} }
      },
      freshen: async () => {
        freshened.push(clock)
      },
      paint: () => {},
      credentials: () => ({
        create: () => {
          calls.push('create')
          return (over.create ?? (() => Promise.resolve(credentialOf(made()))))()
        },
        get: () => {
          calls.push('get')
          return Promise.reject(new Error('not this one'))
        },
      }),
      now: () => clock,
    })
    return { ctl, calls, freshened, tick: (ms: number) => (clock += ms) }
  }

  const made = () =>
    new SoftAuthenticator().make({ challenge: 'AAEC', origin: 'https://x', rpId: 'x' })
  const making = you({ makeBy: at(10 * 60_000) })
  const settle = () => new Promise((done) => setTimeout(done, 0))

  it('holds a challenge only while a bar with a press is up', async () => {
    const { ctl, calls } = page()
    ctl.ready()
    expect(calls).toEqual([])
    ctl.bars(making, NOW)
    ctl.ready()
    ctl.ready()
    await settle()
    expect(calls).toEqual(['/api/passkey/challenge'])
  })

  it('waits before asking again on its own where a challenge could not be had', async () => {
    const calls: string[] = []
    let clock = NOW
    const ctl = passkeys({
      ask: async (_method, path) => {
        calls.push(path)
        return { status: 0, body: null }
      },
      freshen: async () => {},
      paint: () => {},
      now: () => clock,
    })
    ctl.bars(making, NOW)
    ctl.ready()
    await settle()
    ctl.ready()
    await settle()
    expect(calls).toHaveLength(1)
    clock += RETRY_MS
    ctl.ready()
    await settle()
    expect(calls).toHaveLength(2)
  })

  it('goes straight to the authenticator, with nothing awaited first', async () => {
    const { ctl, calls, freshened } = page()
    ctl.bars(making, NOW)
    ctl.ready()
    await settle()
    const pressed = ctl.press()
    // Synchronously, inside the press: the gesture is still the press's.
    expect(calls.at(-1)).toBe('create')
    await pressed
    expect(calls).toEqual(['/api/passkey/challenge', 'create', '/api/passkey/answer'])
    expect(freshened).toHaveLength(1)
  })

  it('never starts a ceremony on a challenge about to run out, and fetches another', async () => {
    const { ctl, calls, tick } = page()
    ctl.bars(making, NOW)
    ctl.ready()
    await settle()
    tick(FRESH_MS + 1)
    await ctl.press()
    expect(calls).not.toContain('create')
    expect(ctl.bars(making)[0]?.under).toMatch(/^Getting ready/)
    await settle()
    expect(calls.filter((one) => one === '/api/passkey/challenge')).toHaveLength(2)
  })

  it('says so when no passkey was used, or the machine refused it, and asks no further', async () => {
    const cancelled = page({
      create: () =>
        Promise.reject(Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })),
    })
    cancelled.ctl.bars(making, NOW)
    cancelled.ctl.ready()
    await settle()
    await cancelled.ctl.press()
    expect(cancelled.ctl.bars(making, NOW)[0]?.under).toMatch(/^No passkey was used\./)
    expect(cancelled.calls).not.toContain('/api/passkey/answer')
    expect(cancelled.freshened).toEqual([])

    const refused = page({ answer: 403 })
    refused.ctl.bars(making, NOW)
    refused.ctl.ready()
    await settle()
    await refused.ctl.press()
    expect(refused.ctl.bars(making, NOW)[0]?.under).toMatch(/^That passkey was not accepted\./)
    expect(refused.freshened).toEqual([])
  })

  it('runs one ceremony at a time, however often it is pressed', async () => {
    let finish: (value: unknown) => void = () => {}
    const { ctl, calls } = page({ create: () => new Promise((done) => (finish = done)) })
    ctl.bars(making, NOW)
    ctl.ready()
    await settle()
    const first = ctl.press()
    await ctl.press()
    await ctl.press()
    expect(calls.filter((one) => one === 'create')).toHaveLength(1)
    expect(ctl.bars(making, NOW)[0]?.lead).toBe('Waiting for the passkey…')
    finish(credentialOf(made()))
    await first
  })
})
