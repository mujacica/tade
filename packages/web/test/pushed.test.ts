import { describe, expect, it } from 'vitest'
import { type From, NotOffered, NotThere, type Outcome } from '../src/acting.ts'
import { ENDPOINT_BOUND } from '../src/endpoint.ts'
import {
  admitPush,
  carryPush,
  PUSHINGS,
  readForget,
  readSubscribe,
  type Subscribed,
} from '../src/pushed.ts'
import { AUTH_BYTES, P256DH_BYTES, type PushCall, type WebPushing } from '../src/pushing.ts'
import { namesOnly, type Reach } from '../src/reach.ts'
import type { Scope, Surface } from '../src/surface.ts'

// Subscribing and forgetting, end to end, with a window that answers whatever
// the test wants it to — and **no sockets**, for the reason the three siblings
// have none.
//
// The two things this file is for: the shapes that must not parse (every field
// somebody would try to smuggle, and the two keys at a length a browser never
// produces), and the gate's third check, which is the one that is not already
// done by the guard.

const SURFACE: Surface = {
  enabled: true,
  bind: 'loopback',
  port: 7654,
  trustedHosts: ['studio.yak-bebop.ts.net'],
  acting: false,
  talking: false,
  drafting: false,
  installing: true,
  keepsView: false,
  pushing: true,
  pushDetails: false,
}

const DEVICE = '00112233445566aa'

/** A subscription as a browser hands one over: both keys at their real length. */
const BODY = {
  endpoint: 'https://web.push.apple.com/QDzVM4rMVZ1l0bT8VvPaDQ',
  p256dh: Buffer.alloc(P256DH_BYTES, 4).toString('base64url'),
  auth: Buffer.alloc(AUTH_BYTES, 7).toString('base64url'),
}

/** A window that does what the test says, and remembers being asked. */
function window_(
  over: {
    subscribe?: (call: PushCall, from: From) => Promise<Outcome>
    forget?: (from: From) => Promise<Outcome>
    unlocked?: boolean
  } = {},
): { pushing: WebPushing; calls: { verb: string; call?: PushCall; from: From }[] } {
  const calls: { verb: string; call?: PushCall; from: From }[] = []
  return {
    calls,
    pushing: {
      unlocked: () => over.unlocked ?? true,
      subscribe: (call, from) => {
        calls.push({ verb: 'subscribe', call, from })
        return (
          over.subscribe?.(call, from) ??
          Promise.resolve<Outcome>({ did: true, rev: '', said: 'will be told' })
        )
      },
      forget: (from) => {
        calls.push({ verb: 'forget', from })
        return (
          over.forget?.(from) ??
          Promise.resolve<Outcome>({ did: true, rev: '', said: 'will not be told' })
        )
      },
    },
  }
}

function ctx(over: Partial<Subscribed> = {}): Subscribed {
  return {
    pushing: window_().pushing,
    surface: SURFACE,
    unlocked: true,
    rev: 4,
    reach: namesOnly(DEVICE) as Reach,
    scopes: ['read'] as Scope[],
    origin: { scheme: 'http', host: 'localhost' },
    device: DEVICE,
    now: 1_000,
    request: 'req-1',
    ...over,
  }
}

describe('what a body may be', () => {
  it('reads a subscription a browser actually hands over', () => {
    const read = readSubscribe(BODY)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.pushing.verb).toBe('subscribe')
    // **The host and never the endpoint** in what is written down: which push
    // service a phone uses is worth reading back, and the rest of the URL is a
    // per-device token at that service.
    expect(read.pushing.said).toBe('will be told through web.push.apple.com')
    expect(read.pushing.said).not.toContain('QDzVM4rMVZ1l0bT8VvPaDQ')
  })

  it('takes no device id, so one phone can never subscribe another', () => {
    // The binding: the row is written under the session's own device, and
    // there is no field here that could name a different one.
    expect(readSubscribe({ ...BODY, device: '00112233445566bb' }).ok).toBe(false)
  })

  it('takes no path, no command and nothing else nobody declared', () => {
    for (const name of [
      'path',
      'file',
      'cwd',
      'cmd',
      'command',
      'prompt',
      'setting',
      'scopes',
      'url',
      'title',
      'body',
      'task',
      'project',
    ]) {
      expect(readSubscribe({ ...BODY, [name]: 'anything' }).ok, name).toBe(false)
    }
  })

  it('refuses a key at a length no browser produces, at its decoded length', () => {
    // The bound that matters is in **bytes**: 65 and 16 per RFC 8291. A text
    // length check would take a key that is one character short of a valid
    // one, and the symptom is a payload a phone silently drops weeks later.
    for (const over of [
      { p256dh: Buffer.alloc(P256DH_BYTES - 1, 4).toString('base64url') },
      { p256dh: Buffer.alloc(P256DH_BYTES + 1, 4).toString('base64url') },
      { auth: Buffer.alloc(AUTH_BYTES - 1, 7).toString('base64url') },
      { auth: Buffer.alloc(AUTH_BYTES + 1, 7).toString('base64url') },
      { p256dh: '' },
      { auth: '' },
      // Not base64url at all: standard base64's two characters and its
      // padding, which `Buffer` would happily decode to the right length.
      { p256dh: `${Buffer.alloc(P256DH_BYTES, 4).toString('base64').slice(0, -1)}=` },
    ]) {
      expect(readSubscribe({ ...BODY, ...over }).ok, JSON.stringify(over).slice(0, 40)).toBe(false)
    }
  })

  it('refuses an endpoint the sender would refuse, and says so now', () => {
    // Checked here as well as at the send, so a device learns now that its
    // push service is one Tade will not post to — rather than subscribing
    // successfully and never being told anything.
    for (const endpoint of [
      'http://push.example/x',
      'https://127.0.0.1/x',
      'https://localhost/x',
      'https://push.example:9200/x',
    ]) {
      const read = readSubscribe({ ...BODY, endpoint })
      expect(read.ok, endpoint).toBe(false)
      if (!read.ok) expect(read.why, endpoint).toContain('that endpoint')
    }
    // Over the bound the schema refuses it first, which is the right order:
    // the bound is what keeps a megabyte out of the file, so it is checked
    // before anything tries to read the value as a URL.
    const long = readSubscribe({
      ...BODY,
      endpoint: `https://push.example/${'x'.repeat(ENDPOINT_BOUND)}`,
    })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.why).toBe('not a subscription')
  })

  it('reads a forget as nothing at all, and refuses a body with anything in it', () => {
    expect(readForget({}).ok).toBe(true)
    // An id especially: a device forgets its own and there is nothing else it
    // could name, so a field here is a refusal rather than one quietly ignored.
    for (const body of [{ device: DEVICE }, { endpoint: BODY.endpoint }, { all: true }]) {
      expect(readForget(body).ok, JSON.stringify(body)).toBe(false)
    }
  })

  it('names its two entries after the methods on the interface', () => {
    expect(Object.keys(PUSHINGS).sort()).toEqual(['forget', 'subscribe'])
  })
})

describe('the gate', () => {
  const subscribing = (() => {
    const read = readSubscribe(BODY)
    if (!read.ok) throw new Error('fixture')
    return read.pushing
  })()

  it('lets a paired device with read through from this machine', () => {
    expect(admitPush(subscribing, ctx()).ok).toBe(true)
  })

  it('refuses it where the setting was turned off a second ago', () => {
    expect(admitPush(subscribing, ctx({ unlocked: false })).ok).toBe(false)
    expect(admitPush(subscribing, ctx({ surface: { ...SURFACE, pushing: false } })).ok).toBe(false)
  })

  it('refuses a device that may not even read', () => {
    const refused = admitPush(subscribing, ctx({ scopes: [] as Scope[] }))
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.why).toContain('needs read')
  })

  it('refuses it off a trusted origin, which the guard’s own layer does not cover', () => {
    // **The check this door has that the route table cannot give it.** The
    // route needs `read`, so the guard's trusted-origin layer — which only
    // runs above `read` — never fires. Without this, a session that crossed a
    // network in the clear could hand this machine an endpoint of its
    // choosing, which is the one thing `endpoint.ts` exists about.
    const refused = admitPush(
      subscribing,
      ctx({ origin: { scheme: 'http', host: '192.168.1.10' } }),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.why).toContain('not a trusted origin')
    // And an https host the config names is fine, which is how a phone behind
    // `tailscale serve` subscribes.
    expect(
      admitPush(subscribing, ctx({ origin: { scheme: 'https', host: 'studio.yak-bebop.ts.net' } }))
        .ok,
    ).toBe(true)
    // An https host it does not name is somebody else's name resolving here.
    expect(
      admitPush(subscribing, ctx({ origin: { scheme: 'https', host: 'evil.example' } })).ok,
    ).toBe(false)
  })
})

describe('carrying one out', () => {
  it('subscribes, and writes the audit line with the host in it', async () => {
    const win = window_()
    const told = await carryPush('subscribe', BODY, ctx({ pushing: win.pushing }))
    expect(told.refusal).toBeNull()
    expect(told.body).toEqual({ did: true, rev: '', said: 'will be told' })
    expect(win.calls[0]?.call).toEqual(BODY)
    // **Provenance is an argument, not a prompt line**: the window writes the
    // row under this device, and a remote act recorded as the person's own
    // would make `historyFrom` count it as theirs.
    expect(win.calls[0]?.from).toEqual({ how: 'remote', device: DEVICE })
    expect(told.did).toEqual({
      device: DEVICE,
      tool: 'subscribe',
      task: '',
      state: 'will be told through web.push.apple.com',
      why: 'done',
    })
  })

  it('forgets, and says so when there was nothing to forget', async () => {
    const win = window_({
      forget: () => Promise.resolve({ did: false, rev: '', said: 'was not being told' }),
    })
    const told = await carryPush('forget', {}, ctx({ pushing: win.pushing }))
    expect(told.refusal).toBeNull()
    expect(told.did.why).toBe('nothing to do')
  })

  it('writes the audit line for a refusal too, which is the case it matters most in', async () => {
    const told = await carryPush('subscribe', BODY, ctx({ unlocked: false }))
    expect(told.refusal?.error).toBe('locked')
    expect(told.did).toMatchObject({ device: DEVICE, tool: 'subscribe', state: 'refused' })
  })

  it('answers a name nothing is wired to with a 404, learning nothing either way', async () => {
    const told = await carryPush('send', BODY, ctx())
    expect(told.refusal?.error).toBe('no_such')
  })

  it('carries Tade’s own clause into the audit line for a refused endpoint', async () => {
    // The line somebody debugging a self-hosted push service needs, and it is
    // Tade's words rather than the phone's.
    const told = await carryPush('subscribe', { ...BODY, endpoint: 'https://10.0.0.1/x' }, ctx())
    expect(told.refusal?.error).toBe('malformed')
    expect(told.did.why).toContain('address rather than a name')
  })

  it('turns a window’s refusals into answers rather than a 500', async () => {
    for (const [error, kind] of [
      [new NotThere('that device is no longer paired'), 'no_such'],
      [new NotOffered('notifications are off'), 'not_offered'],
    ] as const) {
      const win = window_({ subscribe: () => Promise.reject(error) })
      const told = await carryPush('subscribe', BODY, ctx({ pushing: win.pushing }))
      expect(told.refusal?.error, kind).toBe(kind)
      expect(told.warning).toBeNull()
    }
  })

  it('says what broke in a warning, and never in the answer', async () => {
    const win = window_({ subscribe: () => Promise.reject(new Error('the disk is full')) })
    const told = await carryPush('subscribe', BODY, ctx({ pushing: win.pushing }))
    expect(told.refusal?.error).toBe('broke')
    expect(told.warning).toContain('the disk is full')
    // The browser gets a sentence and an id, never a stack trace.
    expect(JSON.stringify(told.refusal)).not.toContain('the disk is full')
  })
})
