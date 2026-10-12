import { ConfigSchema, settingsOf } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import type { From, Outcome } from '../src/acting.ts'
import type { SettingCall, WebConfiguring } from '../src/configuring.ts'
import { allowDevice, appendDevice, grantDevice } from '../src/devices.ts'
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

/** A device paired here, granted what a test says **at the machine**. */
async function device(
  one: Running,
  scopes: string[],
  reads: string[],
): Promise<{ cookie: string; csrf: string; device: string }> {
  const paired = await pair(one)
  await allowDevice(one.home, paired.device, scopes, new Date())
  await grantDevice(one.home, paired.device, reads, new Date())
  return paired
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
  it('answers a device that was not granted it with that, and nothing else', async () => {
    const one = await start({}, { settings: ROWS })
    const who = await device(one, ['read'], ['titles', 'lanes'])
    const answer = await read(one, who)
    expect(answer.status).toBe(200)
    expect(said(answer)).toEqual({ granted: false, groups: [], withheld: 0 })
  })

  it('never puts a key or a machine path in the bytes, granted or not', async () => {
    const one = await start({}, { settings: ROWS })
    const who = await device(one, ['read'], ['settings'])
    const answer = await read(one, who)
    expect(answer.status).toBe(200)
    expect((said(answer) as { granted: boolean }).granted).toBe(true)
    expect(answer.text).toContain('surfaces.window.editor')
    expect(answer.text).not.toContain(KEY)
    expect(answer.text).not.toContain('/Users/kim')
  })
})

describe('with changing turned off', () => {
  it('has no route, whatever the device was granted and the window handed over', async () => {
    // Absence is the enforcement: a `404` and never a `403` naming a setting.
    const made = window_()
    const one = await start({}, { configuring: made.configuring, settings: ROWS })
    const who = await device(one, ['read', 'configure'], ['settings'])
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
    const who = await device(one, ['read', 'configure'], ['settings'])
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

  it('refuses a never path as a path nobody built, and writes that down too', async () => {
    const made = window_()
    const one = await start({ configuring: true }, { configuring: made.configuring })
    const who = await device(one, ['read', 'configure'], ['settings'])
    for (const path of ['approvals.mode', 'surfaces.web.acting', 'extensions.jev.key']) {
      const answer = await change(one, who, { ...BODY, path, value: '' })
      expect(answer.status, path).toBe(404)
      expect(said(answer).error, path).toBe('not_offered')
      expect(answer.text, path).not.toContain(path)
    }
    expect(made.calls).toEqual([])
    const refused = one.told.filter((told) => told.type === 'web_did')
    expect(refused.map((told) => told.detail.setting)).toEqual([
      'approvals.mode',
      'surfaces.web.acting',
      'extensions.jev.key',
    ])
    for (const told of refused) expect(told.detail.state).toBe('refused')
  })

  it('needs configure at the door, and says so in the journal under the device', async () => {
    const made = window_()
    const one = await start({ configuring: true, acting: true }, { configuring: made.configuring })
    const who = await device(
      one,
      ['read', 'answer', 'steer', 'agents', 'projects'],
      ['settings', 'titles'],
    )
    const answer = await change(one, who)
    expect(answer.status).toBe(403)
    expect(made.calls).toEqual([])
    expect(one.told.find((told) => told.type === 'web_did')?.detail).toMatchObject({
      device: who.device,
      tool: 'setting',
      state: 'refused',
    })
  })

  it('needs the reading grant beside the scope', async () => {
    const made = window_()
    const one = await start({ configuring: true }, { configuring: made.configuring })
    const who = await device(one, ['read', 'configure'], ['titles'])
    const answer = await change(one, who)
    expect(answer.status).toBe(403)
    expect(said(answer).error).toBe('out_of_scope')
    expect(made.calls).toEqual([])
  })

  it('stops answering a device revoked a second ago', async () => {
    const made = window_()
    const one = await start({ configuring: true }, { configuring: made.configuring })
    const who = await device(one, ['read', 'configure'], ['settings'])
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
