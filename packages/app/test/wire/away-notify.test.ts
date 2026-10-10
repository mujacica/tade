import { ConfigSchema } from '@tade/core'
import { AUTH_BYTES, generateVapid, P256DH_BYTES, readPushes } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { COOKIE, closeAll, DEVICE, type Machine, machine, paired, waitFor } from './away-harness.ts'

// Notifications, through a real listener, against a real paired device.
//
// **Everything here is real but the phone and the push service.** The window
// is the window, the routes are the routes, the device list and the
// subscription file are files on disk — what is left out is the one thing
// nothing offline can have, which is a browser that agreed and a push service
// that accepts. `packages/web/test/push-out.test.ts` checks the protocol
// against `node:crypto`, `wire/web-push.test.ts` checks the beat against a
// push service that is not one, and real delivery is a manual step
// (`packages/web/test/browser-plan.ts`).
//
// What this file is for is the wiring nothing else can see: that the setting
// is what makes the table, that the table is what makes the routes, and that
// with it off a crafted call meets the `404` of a path nobody built rather
// than a `403` naming a setting.

afterEach(closeAll)

const ENDPOINT = 'https://web.push.apple.com/QDzVM4rMVZ1l0bT8VvPaDQ'
const KEYS = {
  p256dh: Buffer.alloc(P256DH_BYTES, 4).toString('base64url'),
  auth: Buffer.alloc(AUTH_BYTES, 7).toString('base64url'),
}

/** One machine with notifications turned on, or off, and a paired phone. */
async function listening(push: boolean): Promise<Machine> {
  const one = await machine({
    acting: false,
    config: ({ root, port }) =>
      ConfigSchema.parse({
        projects: { app: { root } },
        surfaces: {
          web: {
            enabled: true,
            port,
            install: true,
            push,
            // A key already written, because generating one is a config write
            // and this file is about the routes. `wire/web-push.test.ts` is
            // where minting one is driven.
            push_key: generateVapid().privateKey,
          },
        },
      }),
  })
  await paired(one.home, one.port, [])
  await one.away.open()
  return one
}

/** One `POST` to a notification route, with everything the guard asks of one. */
function notify(
  port: number,
  what: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const text = JSON.stringify(body)
  return fetch(`http://127.0.0.1:${port}/api/notify/${what}`, {
    method: 'POST',
    headers: {
      cookie: COOKIE,
      origin: `http://127.0.0.1:${port}`,
      'content-type': 'application/json',
      'x-tade-csrf': 'x'.repeat(43),
      'sec-fetch-site': 'same-origin',
    },
    body: text,
  }).then(async (res) => ({
    status: res.status,
    body: (await res.text().then((said) => (said === '' ? {} : JSON.parse(said)))) as Record<
      string,
      unknown
    >,
  }))
}

describe('what the listener serves where notifications are on', () => {
  it('tells a page the machine offers them, with the public key to use', async () => {
    const one = await listening(true)
    const answer = await fetch(`http://127.0.0.1:${one.port}/api/devices`, {
      headers: {
        cookie: COOKIE,
        host: `127.0.0.1:${one.port}`,
      },
    })
    expect(answer.status).toBe(200)
    const told = (await answer.json()) as {
      shell: { notifying: { offered: boolean; key: string } }
    }
    expect(told.shell.notifying.offered).toBe(true)
    // The **public** half, 65 bytes of base64url, which is what a browser
    // needs for `applicationServerKey` — and the one value in this subsystem
    // that is meant to leave the machine.
    expect(Buffer.from(told.shell.notifying.key, 'base64url')).toHaveLength(P256DH_BYTES)
  })

  it('takes a subscription, writes the row under that device, and says so', async () => {
    const one = await listening(true)
    const answer = await notify(one.port, 'subscribe', { endpoint: ENDPOINT, ...KEYS })
    expect(answer.status).toBe(200)
    expect(answer.body.said).toContain('web.push.apple.com')
    const { pushes } = await readPushes(one.home)
    expect(pushes).toHaveLength(1)
    expect(pushes[0]).toMatchObject({ device: DEVICE, endpoint: ENDPOINT, forgotten: null })
    // The audit line, written **beside** the answer and never before it.
    const lines = await waitFor(one.client, 'web_subscribed')
    expect(lines[0]).toMatchObject({ type: 'web_subscribed' })
    // No endpoint in the journal: it is a URL at somebody else's service with
    // a per-device token in its path.
    expect(JSON.stringify(lines)).not.toContain('QDzVM4rMVZ1l0bT8VvPaDQ')
  })

  it('forgets it again, and says so when there was nothing to forget', async () => {
    const one = await listening(true)
    const first = await notify(one.port, 'forget', {})
    expect(first.status).toBe(200)
    expect(first.body.did).toBe(false)
    await notify(one.port, 'subscribe', { endpoint: ENDPOINT, ...KEYS })
    const second = await notify(one.port, 'forget', {})
    expect(second.body.did).toBe(true)
    const { pushes } = await readPushes(one.home)
    expect(pushes[0]?.forgotten).toBe('taken back on the device')
  })

  it('refuses a body that names a device, a path or anything undeclared', async () => {
    const one = await listening(true)
    for (const over of [
      { device: '00112233445566bb' },
      { path: '/etc/passwd' },
      { endpoint: 'https://10.0.0.1/x' },
      { endpoint: 'http://push.example/x' },
      { p256dh: 'short' },
    ]) {
      const answer = await notify(one.port, 'subscribe', { endpoint: ENDPOINT, ...KEYS, ...over })
      expect(answer.status, JSON.stringify(over)).toBe(400)
    }
    const { pushes } = await readPushes(one.home)
    expect(pushes).toEqual([])
  })
})

describe('what it serves where they are off', () => {
  it('serves no route at all, which is a 404 and not a 403', async () => {
    // **Absence is the enforcement.** An off capability is not a thing to
    // probe: a `403` saying *turn notifications on* would tell whoever holds a
    // stolen session that there is a notification route and what the setting
    // is called.
    const one = await listening(false)
    for (const what of ['subscribe', 'forget', 'send', 'test']) {
      const answer = await notify(one.port, what, {})
      expect(answer.status, what).toBe(404)
    }
  })

  it('tells a page nothing is offered, and hands it no key', async () => {
    const one = await listening(false)
    const answer = await fetch(`http://127.0.0.1:${one.port}/api/devices`, {
      headers: {
        cookie: COOKIE,
        host: `127.0.0.1:${one.port}`,
      },
    })
    const told = (await answer.json()) as { shell: { notifying: unknown } }
    expect(told.shell.notifying).toEqual({ offered: false, key: '' })
  })
})
