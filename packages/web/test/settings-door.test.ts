import { ConfigSchema, settingsOf } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { From, Outcome } from '../src/acting.ts'
import type { SettingCall, WebConfiguring } from '../src/configuring.ts'
import { appendDevice } from '../src/devices.ts'
import { readReceipts } from '../src/receipts.ts'
import { CSRF_HEADER } from '../src/request.ts'
import { type Answer, ask, closeAll, pair, type Running, said, start } from './harness.ts'

// The door, for a setting: every layer a request goes through before the
// window is reached, asked of a real listener over a real socket — the
// sibling of `acting.test.ts`. `configured.test.ts` is the decision and
// `configuring.test.ts` is what a device is shown; this is what only a socket
// can be wrong about.

const KEY = 'jev_live_7fd1c0a9e2b84f6d93a51c2e8b7d4f00'

const ROWS = settingsOf(
  ConfigSchema.parse({
    projects: { app: { root: '/Users/kim/src/app' } },
    surfaces: { window: { editor: 'code' } },
  }),
  [{ path: 'extensions.jev.key', title: 'Jev API key', means: '', value: KEY, from: null }],
)

const BODY = {
  path: 'surfaces.window.editor',
  was: 'code',
  value: 'zed',
  confirm: true,
  key: 'abcdefgh12345678',
  rev: 0,
}

function window_(): { configuring: WebConfiguring; calls: { call: SettingCall; from: From }[] } {
  const calls: { call: SettingCall; from: From }[] = []
  return {
    calls,
    configuring: {
      unlocked: () => true,
      change: (call, from) => {
        calls.push({ call, from })
        return Promise.resolve<Outcome>({ did: true, rev: call.value, said: 'Editor: Saved.' })
      },
    },
  }
}

/** A device paired here: every one reads and does everything. */
async function device(one: Running): Promise<{ cookie: string; csrf: string; device: string }> {
  return await pair(one)
}

function change(
  one: Running,
  who: { cookie: string; csrf: string },
  body: Record<string, unknown> = BODY,
): Promise<Answer> {
  return ask(one, '/api/settings/change', {
    method: 'POST',
    headers: {
      cookie: who.cookie,
      origin: one.origin,
      'content-type': 'application/json',
      [CSRF_HEADER]: who.csrf,
    },
    body: JSON.stringify(body),
  })
}

function read(one: Running, who: { cookie: string }): Promise<Answer> {
  return ask(one, '/api/settings', { headers: { cookie: who.cookie } })
}

afterEach(closeAll)

describe('reading the settings', () => {
  it('never puts a key or a machine path in the bytes', async () => {
    const one = await start({}, { settings: ROWS })
    const who = await device(one)
    const answer = await read(one, who)
    expect(answer.status).toBe(200)
    expect(answer.text).toContain('surfaces.window.editor')
    expect(answer.text).not.toContain(KEY)
    expect(answer.text).not.toContain('/Users/kim')
  })
})

describe('with changing turned off', () => {
  it('has no route, whatever the window handed over', async () => {
    // Absence is the enforcement: a `404` and never a `403` naming a setting.
    const made = window_()
    const one = await start({}, { configuring: made.configuring, settings: ROWS })
    const who = await device(one)
    const answer = await change(one, who)
    expect(answer.status).toBe(404)
    expect(said(answer).error).toBe('no_such')
    expect(made.calls).toEqual([])
    expect((await readReceipts(one.home)).receipts).toEqual([])
  })
})

describe('with changing turned on', () => {
  it('changes an open setting as the device, and writes the line under it', async () => {
    const made = window_()
    const one = await start({ configuring: true }, { configuring: made.configuring })
    const who = await device(one)
    const answer = await change(one, who)
    expect(answer.status).toBe(200)
    expect(said(answer)).toEqual({ did: true, rev: 'zed', said: 'Editor: Saved.' })
    expect(made.calls).toEqual([
      {
        call: { path: 'surfaces.window.editor', was: 'code', value: 'zed' },
        from: { how: 'remote', device: who.device },
      },
    ])
    const line = one.told.find((told) => told.type === 'web_did')
    // The path is in the detail as `setting` and never on the event's `task`:
    // a setting is not a task, and every fold keyed by task would read one.
    expect(line).toEqual({
      type: 'web_did',
      detail: {
        device: who.device,
        tool: 'setting',
        state: 'changed surfaces.window.editor',
        why: 'done',
        setting: 'surfaces.window.editor',
      },
    })
  })

  it('changes a never path too, as the device: every paired device is the person’s own', async () => {
    const made = window_()
    const one = await start({ configuring: true }, { configuring: made.configuring })
    const who = await device(one)
    for (const path of ['approvals.mode', 'surfaces.web.acting']) {
      const answer = await change(one, who, {
        ...BODY,
        path,
        key: `abcdefgh1234567${path.length % 10}`,
      })
      expect(answer.status, path).toBe(200)
    }
    expect(made.calls.map((one) => one.call.path)).toEqual([
      'approvals.mode',
      'surfaces.web.acting',
    ])
    for (const call of made.calls) expect(call.from).toEqual({ how: 'remote', device: who.device })
  })

  it('stops answering a device revoked a second ago', async () => {
    const made = window_()
    const one = await start({ configuring: true }, { configuring: made.configuring })
    const who = await device(one)
    await appendDevice(one.home, {
      kind: 'revoked',
      device: who.device,
      at: new Date().toISOString(),
      why: 'revoked at the machine',
    })
    const answer = await change(one, who)
    expect(answer.status).toBe(401)
    expect(made.calls).toEqual([])
  })
})
