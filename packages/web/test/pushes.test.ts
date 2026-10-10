import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendPush,
  PUSHES_FILE,
  type PushLine,
  pushesIn,
  pushesPath,
  readPushes,
  sendable,
  writePushes,
} from '../src/pushes.ts'

// Which paired devices asked to be told, and the one rule this file has that
// the device list does not: **a row is only ever as good as the device it
// names.**
//
// `sendable` is what this file exists to hold. Signing a phone out has to stop
// its notifications with no network, no push service to ask and nothing to
// clean up — and the only thing that makes that true is that the sender never
// gets a list any other way.

const NOW = Date.parse('2026-10-08T12:00:00Z')
const homes: string[] = []

async function home(): Promise<string> {
  const made = await mkdtemp(join(tmpdir(), 'tade-pushes-'))
  homes.push(made)
  return made
}

afterEach(() => {
  homes.length = 0
})

const DEVICE = '00112233445566aa'
const OTHER = '00112233445566bb'

function subscribed(over: Partial<PushLine> = {}): PushLine {
  return {
    kind: 'subscribed',
    device: DEVICE,
    at: new Date(NOW).toISOString(),
    endpoint: 'https://web.push.apple.com/QDzVM4rMVZ1l0bT8VvPaDQ',
    p256dh: 'B'.repeat(87),
    auth: 'A'.repeat(22),
    ...over,
  } as PushLine
}

function lines(...of: PushLine[]): string {
  return of.map((one) => `${JSON.stringify(one)}\n`).join('')
}

describe('the subscriptions, folded out of the lines', () => {
  it('reads one per device, with the latest line winning', () => {
    const { pushes, skipped } = pushesIn(
      lines(
        subscribed(),
        subscribed({ endpoint: 'https://fcm.googleapis.com/fcm/send/new' }),
        subscribed({ device: OTHER }),
      ),
    )
    expect(skipped).toBe(0)
    expect(pushes).toHaveLength(2)
    // A browser that renewed is a later row, and the newer one is the one to
    // keep: the old endpoint stops working the moment it does.
    expect(pushes.find((one) => one.device === DEVICE)?.endpoint).toBe(
      'https://fcm.googleapis.com/fcm/send/new',
    )
  })

  it('reads a forget as a subscription that is no longer one, with the reason kept', () => {
    const { pushes } = pushesIn(
      lines(subscribed(), {
        kind: 'forgot',
        device: DEVICE,
        at: new Date(NOW).toISOString(),
        why: 'gone at the push service',
      }),
    )
    expect(pushes[0]?.forgotten).toBe('gone at the push service')
  })

  it('takes a device back where it subscribes again after forgetting', () => {
    const { pushes } = pushesIn(
      lines(
        subscribed(),
        { kind: 'forgot', device: DEVICE, at: new Date(NOW).toISOString(), why: 'signed out' },
        subscribed(),
      ),
    )
    expect(pushes[0]?.forgotten).toBeNull()
  })

  it('skips a line it cannot read rather than throwing the file over', () => {
    // A file one truncated write has damaged must still be the list of your
    // other subscriptions — `devicesIn`'s rule, for its reason.
    const text = `${lines(subscribed())}{"kind":"subscribed"\n\nnot json\n${lines(subscribed({ device: OTHER }))}`
    const { pushes, skipped } = pushesIn(text)
    expect(pushes).toHaveLength(2)
    expect(skipped).toBe(2)
  })

  it('counts a forget for a device nothing subscribed as neither', () => {
    const { pushes, skipped } = pushesIn(
      lines({ kind: 'forgot', device: DEVICE, at: new Date(NOW).toISOString(), why: 'signed out' }),
    )
    expect(pushes).toEqual([])
    expect(skipped).toBe(0)
  })

  it('refuses a row of another kind rather than making a subscription of it', () => {
    // Strict, like the device list: a row of another kind fails the parse
    // rather than becoming something that cannot be forgotten.
    for (const bad of [
      { ...subscribed(), kind: 'granted' },
      { ...subscribed(), device: 'not-hex' },
      { ...subscribed(), endpoint: '' },
      { ...subscribed(), extra: 'anything' },
      { ...subscribed(), auth: 'A'.repeat(500) },
    ]) {
      expect(pushesIn(`${JSON.stringify(bad)}\n`).skipped, JSON.stringify(bad).slice(0, 40)).toBe(1)
    }
  })
})

describe('the file itself', () => {
  it('is in the home, never in a project', async () => {
    const at = await home()
    expect(pushesPath(at)).toBe(join(at, PUSHES_FILE))
  })

  it('is created 0600, with the mode it needs rather than narrowed after', async () => {
    // The gap between creating and narrowing is a window in which a phone's
    // `auth` secret — which is what anybody holding it and the endpoint needs
    // to ring that phone — is world-readable.
    const at = await home()
    await appendPush(at, subscribed())
    const mode = (await stat(pushesPath(at))).mode & 0o777
    expect(mode & 0o077).toBe(0)
  })

  it('appends rather than rewriting, so the file is the record', async () => {
    const at = await home()
    await appendPush(at, subscribed())
    await appendPush(at, {
      kind: 'forgot',
      device: DEVICE,
      at: new Date(NOW).toISOString(),
      why: 'turned off here',
    })
    const text = await readFile(pushesPath(at), 'utf8')
    expect(text.trim().split('\n')).toHaveLength(2)
  })

  it('is no subscriptions at all where there is no file', async () => {
    expect(await readPushes(await home())).toEqual({ pushes: [], skipped: 0 })
  })

  it('reads back what was written', async () => {
    const at = await home()
    await writePushes(at, [subscribed(), subscribed({ device: OTHER })])
    const { pushes } = await readPushes(at)
    expect(pushes.map((one) => one.device).sort()).toEqual([DEVICE, OTHER])
  })
})

describe('which subscriptions may be sent to', () => {
  const paired = [
    { id: DEVICE, revoked: null },
    { id: OTHER, revoked: null },
  ]

  it('is the live ones belonging to a device that is still paired', () => {
    const { pushes } = pushesIn(lines(subscribed(), subscribed({ device: OTHER })))
    const out = sendable(pushes, paired)
    expect(out.pushes.map((one) => one.device).sort()).toEqual([DEVICE, OTHER])
    expect(out.orphaned).toEqual([])
  })

  it('refuses a subscription whose device was signed out — with no network', () => {
    // This is the whole of the binding: a phone that is off, lost or on
    // another continent stops being notified because of what is checked here,
    // and not because anything was asked of a push service.
    const { pushes } = pushesIn(lines(subscribed(), subscribed({ device: OTHER })))
    const out = sendable(pushes, [
      { id: DEVICE, revoked: 'revoked at the machine' },
      { id: OTHER, revoked: null },
    ])
    expect(out.pushes.map((one) => one.device)).toEqual([OTHER])
    // **Named rather than passed over**, so the window can write the row off
    // instead of leaving one the next reader has to interpret.
    expect(out.orphaned).toEqual([DEVICE])
  })

  it('refuses a subscription for a device no pairing ever introduced', () => {
    // The shape an agent on this machine could write into the file
    // (`DEVICES_AND_AGENTS`): a row is not an authority, and a device id
    // nobody paired is not a device.
    const { pushes } = pushesIn(lines(subscribed({ device: 'ffffffffffffffff' })))
    const out = sendable(pushes, paired)
    expect(out.pushes).toEqual([])
    expect(out.orphaned).toEqual(['ffffffffffffffff'])
  })

  it('refuses one that was forgotten, and does not call it orphaned', () => {
    const { pushes } = pushesIn(
      lines(subscribed(), {
        kind: 'forgot',
        device: DEVICE,
        at: new Date(NOW).toISOString(),
        why: 'taken back on the device',
      }),
    )
    const out = sendable(pushes, paired)
    expect(out.pushes).toEqual([])
    expect(out.orphaned).toEqual([])
  })
})
