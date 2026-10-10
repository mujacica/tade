import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import type { From, Outcome, ParkCall, WebActing } from '../src/acting.ts'
import { allowDevice, appendDevice, readDevices } from '../src/devices.ts'
import { receiptsPath } from '../src/receipts.ts'
import { CSRF_HEADER } from '../src/request.ts'
import {
  type Answer,
  actingStub,
  ask,
  closeAll,
  pair,
  type Running,
  said,
  start,
} from './harness.ts'

// The door, for an act: every layer a request has to get through before a verb
// is reached, asked of a real listener over a real socket.
//
// **`acts.test.ts` is the gate and `acted.test.ts` is the decision; this is the
// door.** What is here is what only a socket can be wrong about: a cross-site
// form post dressed as a verb, a `Host` nobody bound, a path that exists only
// when a setting is on, a session that was signed out between the draw and the
// tap, and the bytes a refusal carries. Loopback and `port: 0` throughout.

const BODY = {
  task: 'tade/away-action-gate',
  parked: true,
  was: 'p0',
  key: 'abcdefgh12345678',
  rev: 0,
}

/** A window that parks whatever it is told to, and remembers being asked. */
function window_(
  over: { park?: (call: ParkCall, from: From) => Promise<Outcome>; unlocked?: boolean } = {},
): { acting: WebActing; calls: { call: ParkCall; from: From }[] } {
  const calls: { call: ParkCall; from: From }[] = []
  return {
    calls,
    acting: actingStub({
      unlocked: () => over.unlocked ?? true,
      park: (call, from) => {
        calls.push({ call, from })
        return (
          over.park?.(call, from) ??
          Promise.resolve<Outcome>({ did: true, rev: 'p1', said: 'set aside' })
        )
      },
    }),
  }
}

/**
 * A listener with acting on, a device paired, and that device granted `steer`
 * **at the machine** — which is the only door a scope widens through.
 */
async function ready(
  opts: { acting?: WebActing } = {},
): Promise<{ one: Running; cookie: string; csrf: string; device: string }> {
  const made = opts.acting ?? window_().acting
  const one = await start({ acting: true }, { acting: made })
  const paired = await pair(one)
  await allowDevice(one.home, paired.device, ['read', 'steer'], new Date())
  return { one, ...paired }
}

/** One act, with everything a browser sends and nothing it does not. */
function act(
  one: Running,
  who: { cookie: string; csrf: string },
  body: Record<string, unknown> = BODY,
  over: { headers?: Record<string, string>; path?: string } = {},
): Promise<Answer> {
  return ask(one, over.path ?? '/api/act/park', {
    method: 'POST',
    headers: {
      cookie: who.cookie,
      origin: one.origin,
      'content-type': 'application/json',
      [CSRF_HEADER]: who.csrf,
      ...over.headers,
    },
    body: JSON.stringify(body),
  })
}

afterEach(closeAll)

describe('with acting turned off', () => {
  it('has no route at all, so a crafted call is the `404` of a path nobody built', async () => {
    // **The read-only bypass, and the answer to it is absence.** Not a `403`
    // naming a setting, which tells whoever holds a stolen session that there
    // is a verb and what to turn on. `404`, like every other path that is not
    // there.
    const one = await start()
    const paired = await pair(one)
    await allowDevice(one.home, paired.device, ['read', 'steer'], new Date())
    const answer = await act(one, paired)
    expect(answer.status).toBe(404)
    expect(said(answer).error).toBe('no_such')
  })

  it('writes no record of an act, because there was none', async () => {
    const one = await start()
    const paired = await pair(one)
    await act(one, paired)
    await expect(readFile(receiptsPath(one.home), 'utf8')).rejects.toThrow()
  })

  it('has no route even where the window handed over a `WebActing`', async () => {
    // The setting decides the table, so a window that wired acting up while
    // the setting said no serves nothing. Both halves, and the stricter wins.
    const made = window_()
    const one = await start({ acting: false }, { acting: made.acting })
    const paired = await pair(one)
    await allowDevice(one.home, paired.device, ['read', 'steer'], new Date())
    expect((await act(one, paired)).status).toBe(404)
    expect(made.calls).toEqual([])
  })
})

describe('with acting turned on but nothing wired up', () => {
  it('answers `404` rather than a `500`, and reaches nothing', async () => {
    const one = await start({ acting: true })
    const paired = await pair(one)
    await allowDevice(one.home, paired.device, ['read', 'steer'], new Date())
    expect((await act(one, paired)).status).toBe(404)
  })
})

describe('a crafted call', () => {
  it('cannot be a cross-site form post, whatever else it gets right', async () => {
    // §8.6's decision, asserted on a verb: a simple-request `POST` with a form
    // content type is the shape that tries, and it is refused before anything
    // about the act is read.
    const { one, cookie, csrf } = await ready()
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const answer = await act(one, { cookie, csrf }, BODY, {
        headers: { 'content-type': type },
      })
      expect(answer.status, type).toBe(403)
      expect(said(answer).error, type).toBe('bad_origin')
    }
  })

  it('cannot come with no `Origin`, no token, or the wrong one', async () => {
    const { one, cookie, csrf } = await ready()
    const tries: [string, Record<string, string>][] = [
      ['no origin', { origin: '' }],
      ['another origin', { origin: 'http://evil.example' }],
      ['no token', { [CSRF_HEADER]: '' }],
      ['another device’s token', { [CSRF_HEADER]: 'a'.repeat(csrf.length) }],
    ]
    for (const [what, headers] of tries) {
      const answer = await act(one, { cookie, csrf }, BODY, { headers })
      expect(answer.status, what).toBe(403)
      expect(said(answer).error, what).toBe('bad_origin')
    }
  })

  it('cannot come from a `Host` nobody bound, which is the rebinding defence', async () => {
    const { one, cookie, csrf } = await ready()
    const answer = await act(one, { cookie, csrf }, BODY, {
      headers: { host: 'evil.example' },
    })
    expect(answer.status).toBe(403)
    expect(said(answer).error).toBe('bad_origin')
  })

  it('cannot come with no session at all', async () => {
    const { one, csrf } = await ready()
    const answer = await act(one, { cookie: '', csrf })
    expect(answer.status).toBe(401)
    expect(said(answer).error).toBe('no_session')
  })

  it('cannot reach a verb nobody declared, under any method', async () => {
    const { one, cookie, csrf } = await ready()
    for (const path of ['/api/act/exec', '/api/act', '/api/act/park/again', '/api/act/Park']) {
      const answer = await act(one, { cookie, csrf }, BODY, { path })
      expect(answer.status, path).toBe(404)
    }
    expect((await ask(one, '/api/act/park', { headers: { cookie } })).status).toBe(404)
  })

  it('cannot carry a body with a field nobody declared', async () => {
    const { one, cookie, csrf } = await ready()
    const answer = await act(one, { cookie, csrf }, { ...BODY, by: 'you' })
    expect(answer.status).toBe(400)
    expect(said(answer).error).toBe('malformed')
  })
})

describe('a device that may not', () => {
  it('is refused where a person never granted it the scope', async () => {
    // Pairing mints `read`, because a keypress with one question on it cannot
    // honestly grant more. Nothing a request can do widens that.
    const made = window_()
    const one = await start({ acting: true }, { acting: made.acting })
    const paired = await pair(one)
    const answer = await act(one, paired)
    expect(answer.status).toBe(403)
    expect(said(answer).error).toBe('out_of_scope')
    expect(made.calls).toEqual([])
  })

  it('is refused the moment a person takes the grant back', async () => {
    // **Revoking the feature from one device, mid-session.** The scope is read
    // out of the file on every request, so taking it back needs no restart and
    // no reconnection.
    const made = window_()
    const { one, cookie, csrf, device } = await ready({ acting: made.acting })
    expect((await act(one, { cookie, csrf })).status).toBe(200)
    await allowDevice(one.home, device, ['read'], new Date())
    const answer = await act(one, { cookie, csrf }, { ...BODY, key: 'second0012345678' })
    expect(answer.status).toBe(403)
    expect(said(answer).error).toBe('out_of_scope')
    expect(made.calls).toHaveLength(1)
  })

  it('is refused the moment the device itself is disconnected', async () => {
    const made = window_()
    const { one, cookie, csrf, device } = await ready({ acting: made.acting })
    await appendDevice(one.home, {
      kind: 'revoked',
      device,
      at: new Date().toISOString(),
      why: 'revoked at the machine',
    })
    const answer = await act(one, { cookie, csrf })
    expect(answer.status).toBe(401)
    expect(made.calls).toEqual([])
  })

  it('is refused the moment the setting goes, with no restart', async () => {
    // The live half of the setting: the route is still in the table, because
    // that was built when the window started, and `unlocked()` is what answers.
    let on = true
    const made = window_({ unlocked: false })
    const acting: WebActing = { ...made.acting, unlocked: () => on }
    const { one, cookie, csrf } = await ready({ acting })
    expect((await act(one, { cookie, csrf })).status).toBe(200)
    on = false
    const answer = await act(one, { cookie, csrf }, { ...BODY, key: 'second0012345678' })
    expect(answer.status).toBe(403)
    expect(said(answer).error).toBe('locked')
  })

  it('is refused where the window’s own reader throws, rather than answering a 500', async () => {
    const made = window_()
    const acting: WebActing = {
      ...made.acting,
      unlocked: () => {
        throw new Error('the config went')
      },
    }
    const { one, cookie, csrf } = await ready({ acting })
    const answer = await act(one, { cookie, csrf })
    expect(answer.status).toBe(403)
    expect(said(answer).error).toBe('locked')
    expect(made.calls).toEqual([])
  })
})

describe('off this machine', () => {
  /** A device paired over the trusted name, as a phone through a tunnel is. */
  async function throughTheTunnel(acting: WebActing) {
    const one = await start({ acting: true }, { acting })
    const host = 'studio.yak-bebop.ts.net'
    const paired = await pair(one, {
      headers: { host, origin: `https://${host}` },
    })
    await allowDevice(one.home, paired.device, ['read', 'steer'], new Date())
    return { one, host, ...paired }
  }

  it('goes through over the trusted https origin, which is the remote path', async () => {
    const made = window_()
    const { one, host, cookie, csrf } = await throughTheTunnel(made.acting)
    const answer = await act(one, { cookie, csrf }, BODY, {
      headers: { host, origin: `https://${host}` },
    })
    expect(answer.status).toBe(200)
    expect(made.calls).toHaveLength(1)
  })

  it('is refused over the same name in plain http, which is the downgrade', async () => {
    // **DECISIONS §4.3, re-asked at the act.** A credential that crossed a
    // network in the clear never buys an act — and the grant the person made
    // at the machine does not change that, because what is being checked is
    // the transport this particular request arrived on.
    const made = window_()
    const { one, host, cookie, csrf } = await throughTheTunnel(made.acting)
    const answer = await act(one, { cookie, csrf }, BODY, {
      headers: { host, origin: `http://${host}` },
    })
    expect(answer.status).toBe(403)
    expect(said(answer).error).toBe('locked')
    expect(made.calls).toEqual([])
  })

  it('still reads perfectly well over plain http, which is the asymmetry', async () => {
    // The point of the rule: a phone on the wifi keeps answering *is anything
    // waiting for me*. It is acting that needs a trusted origin, not reading.
    const made = window_()
    const { one, host, cookie } = await throughTheTunnel(made.acting)
    const answer = await ask(one, '/api/snapshot', {
      headers: { cookie, host, origin: `http://${host}` },
    })
    expect(answer.status).toBe(200)
  })
})

describe('an act that goes through', () => {
  it('answers with what is true now, and reaches the window once', async () => {
    const made = window_()
    const { one, cookie, csrf, device } = await ready({ acting: made.acting })
    const answer = await act(one, { cookie, csrf })
    expect(answer.status).toBe(200)
    expect(said(answer)).toEqual({ did: true, rev: 'p1', said: 'set aside' })
    expect(made.calls).toEqual([
      {
        call: { task: 'tade/away-action-gate', was: 'p0', parked: true },
        from: { how: 'remote', device },
      },
    ])
  })

  it('is in the journal under the device that took it, and under its task', async () => {
    const made = window_()
    const { one, cookie, csrf, device } = await ready({ acting: made.acting })
    await act(one, { cookie, csrf })
    const did = one.told.filter((line) => line.type === 'web_did')
    expect(did).toHaveLength(1)
    expect(did[0]?.task).toBe('tade/away-action-gate')
    // The task is on the **event**, which is the field the journal's index and
    // `historyFrom` read — so an act shows up on the task it changed rather
    // than only in a search nobody would run.
    expect(did[0]?.detail).toEqual({
      device,
      tool: 'park',
      state: 'parked',
      why: 'done',
    })
    // **Never a `said` line**, whatever else is written: `namedBy` reads those
    // to authorise a setting change, and a request from a phone is not
    // somebody's own words.
    expect(one.told.map((line) => line.type)).not.toContain('said')
  })

  it('is in the journal when it is refused at the door, too', async () => {
    // A device that asked to change something and was not allowed to is the
    // case the audit matters most in, so the line goes in even though nothing
    // happened — and it names the device, because there was a session.
    const made = window_()
    const one = await start({ acting: true }, { acting: made.acting })
    const paired = await pair(one)
    await act(one, paired)
    const did = one.told.filter((line) => line.type === 'web_did')
    expect(did).toHaveLength(1)
    expect(did[0]?.detail).toEqual({
      device: paired.device,
      tool: 'park',
      state: 'refused',
      why: 'out_of_scope',
    })
  })

  it('is in the journal when the act itself is refused, with the target on it', async () => {
    // Past the door and refused by the act gate, so the line carries the task
    // the request was about as well.
    const made = window_()
    const { one, cookie, csrf, device } = await ready({ acting: made.acting })
    const answer = await act(one, { cookie, csrf }, { ...BODY, rev: 9999 })
    expect(said(answer).error).toBe('stale')
    const did = one.told.filter((line) => line.type === 'web_did')
    expect(did).toHaveLength(1)
    expect(did[0]?.task).toBe('tade/away-action-gate')
    expect(did[0]?.detail).toEqual({ device, tool: 'park', state: 'refused', why: 'stale' })
  })

  it('never carries the key, the payload or the label into the record', async () => {
    const made = window_()
    const { one, cookie, csrf } = await ready({ acting: made.acting })
    await act(one, { cookie, csrf })
    const lines = JSON.stringify(one.told)
    expect(lines).not.toContain('abcdefgh12345678')
    expect(lines).not.toContain('parked=true')
    expect(lines).not.toContain('iPhone')
  })
})

describe('a repeat over the wire', () => {
  it('runs once for two presses that arrive together', async () => {
    const made = window_({
      park: () =>
        new Promise<Outcome>((done) =>
          setTimeout(() => done({ did: true, rev: 'p1', said: 'set aside' }), 15),
        ),
    })
    const { one, cookie, csrf } = await ready({ acting: made.acting })
    const [first, second] = await Promise.all([
      act(one, { cookie, csrf }),
      act(one, { cookie, csrf }),
    ])
    expect(made.calls).toHaveLength(1)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(said(first)).toEqual(said(second))
  })

  it('answers a captured request from a new lifetime without doing it again', async () => {
    // **The replay across a restart.** The device list and the receipts
    // outlive the window; the epoch does not. So a second listener over the
    // same home still knows this device, and still knows what came of the
    // request it is being handed again — which is what makes a captured
    // `POST` an answer rather than a second act.
    const made = window_()
    const { one, cookie, csrf, device } = await ready({ acting: made.acting })
    const first = await act(one, { cookie, csrf })
    expect(first.status).toBe(200)
    await one.server.close()

    const next = await start({ acting: true }, { acting: made.acting, home: one.home })
    expect(next.epoch).not.toBe(one.epoch)
    expect((await readDevices(next.home)).devices.map((held) => held.id)).toContain(device)
    // **The old listener's `Host` and `Origin`, to the new listener's socket.**
    // A session is bound to the exact host it was minted for, and `port: 0`
    // means the second listener is on another port — so a replay has to carry
    // what the captured request carried, which is what a captured request
    // would.
    const again = await act(next, { cookie, csrf }, BODY, {
      headers: { host: one.host, origin: one.origin },
    })
    expect(again.status).toBe(200)
    expect(said(again)).toEqual(said(first))
    expect(made.calls).toHaveLength(1)
  })

  it('is unsure after a restart about an act nothing recorded the end of', async () => {
    // The fail-closed half, over the wire: the window died in the middle, so
    // the next one will not do it again and says so rather than guessing.
    const died = window_({ park: () => Promise.reject(new Error('the window went')) })
    const { one, cookie, csrf } = await ready({ acting: died.acting })
    expect((await act(one, { cookie, csrf })).status).toBe(500)
    await one.server.close()

    const made = window_()
    const next = await start({ acting: true }, { acting: made.acting, home: one.home })
    const again = await act(next, { cookie, csrf }, BODY, {
      headers: { host: one.host, origin: one.origin },
    })
    expect(again.status).toBe(409)
    expect(said(again).error).toBe('unsure')
    expect(made.calls).toEqual([])
  })
})
