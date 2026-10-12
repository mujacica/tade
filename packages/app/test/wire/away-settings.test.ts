import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { readDevices } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { AWAY_CONTROLS, awayPanel } from '../../src/panels/away/state.ts'
import {
  COOKIE,
  change,
  closeAll,
  DEVICE,
  KEY,
  type Machine,
  machine,
  paired,
  waitFor,
} from './away-harness.ts'

// A setting changed from a phone, end to end: a real listener, the real
// `Settings.write`, the home's real `config.yaml` and the real journal.
//
// What only this can say: that the value a device echoes is the value the
// window lists, that the file actually changes, that the record says a device
// did it and never the window or the person — and that a setting a request is
// not enough for leaves the file exactly as it was.

afterEach(closeAll)

async function ready(scopes: readonly string[], granted: readonly string[]): Promise<Machine> {
  const one = await machine({ settings: true })
  await paired(one.home, one.port, scopes, granted)
  await one.away.open()
  await one.refresh()
  return one
}

function fileOf(one: Machine): Record<string, unknown> {
  return parse(readFileSync(join(one.home, 'config.yaml'), 'utf8')) as Record<string, unknown>
}

function editorIn(one: Machine): unknown {
  const surfaces = fileOf(one).surfaces as { window?: { editor?: unknown } } | undefined
  return surfaces?.window?.editor
}

function read(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/settings',
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, cookie: COOKIE, 'sec-fetch-site': 'same-origin' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () =>
          done({
            status: res.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          }),
        )
      },
    )
    req.on('error', failed)
    req.end()
  })
}

const EDITOR = {
  path: 'surfaces.window.editor',
  was: '',
  value: 'zed',
  confirm: true,
  key: KEY,
  rev: 0,
}

describe('a device changing a setting a request is enough for', () => {
  it('writes the home’s file through the one door, and the window uses it', async () => {
    const one = await ready(['configure'], ['settings'])
    const answer = await change(one.port, EDITOR)
    expect(answer.status).toBe(200)
    expect(answer.body.did).toBe(true)
    expect(answer.body.rev).toBe('zed')
    expect(editorIn(one)).toBe('zed')
  })

  it('is recorded as the device, by id, and never as the window or the person', async () => {
    const one = await ready(['configure'], ['settings'])
    await change(one.port, EDITOR)
    const changed = await waitFor(one.client, 'config_changed')
    expect(changed.map((line) => line.detail)).toEqual([
      { path: 'surfaces.window.editor', was: '', now: 'zed', by: `device ${DEVICE}` },
    ])
    const did = await waitFor(one.client, 'web_did')
    expect(did[0]?.detail).toMatchObject({
      device: DEVICE,
      tool: 'setting',
      setting: 'surfaces.window.editor',
      state: 'changed surfaces.window.editor',
    })
    // Not on the event's task: a setting is not a task.
    expect(did[0]?.task ?? null).toBeNull()
    // And never a `said` line: a device's words are not the person's.
    expect(await one.client.events({ types: ['said'] })).toEqual([])
  })

  it('answers a repeat out of the record rather than writing twice', async () => {
    const one = await ready(['configure'], ['settings'])
    const first = await change(one.port, EDITOR)
    const again = await change(one.port, EDITOR)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(await waitFor(one.client, 'config_changed')).toHaveLength(1)
  })

  it('refuses a screen drawn against another value, and leaves the file alone', async () => {
    const one = await ready(['configure'], ['settings'])
    const answer = await change(one.port, { ...EDITOR, was: 'vim' })
    expect(answer.status).toBe(409)
    expect(answer.body.error).toBe('gone')
    expect(answer.body.rev).toBe('')
    expect(editorIn(one)).toBeUndefined()
  })

  it('refuses a body that does not say it meant it', async () => {
    const one = await ready(['configure'], ['settings'])
    const answer = await change(one.port, { ...EDITOR, confirm: false })
    expect(answer.status).toBe(400)
    expect(editorIn(one)).toBeUndefined()
  })
})

describe('what a device can never change', () => {
  it('leaves an asked setting and a never setting exactly as the file had them', async () => {
    const one = await ready(['configure'], ['settings'])
    const before = readFileSync(join(one.home, 'config.yaml'), 'utf8')
    for (const [path, value] of [
      ['checks.before', 'nothing'],
      ['agents.commit', 'never'],
      ['approvals.mode', 'bypass'],
      ['surfaces.web.acting', 'false'],
      ['surfaces.web.settings', 'false'],
      ['projects.app.root', '/tmp'],
    ] as const) {
      const answer = await change(one.port, { ...EDITOR, path, value })
      expect(answer.status, path).toBe(404)
    }
    expect(readFileSync(join(one.home, 'config.yaml'), 'utf8')).toBe(before)
    expect(await one.client.events({ types: ['config_changed'] })).toEqual([])
  })

  it('needs both halves granted at the machine', async () => {
    for (const [scopes, granted] of [
      [['configure'], []],
      [['answer', 'steer'], ['settings']],
    ] as const) {
      const one = await ready(scopes, granted)
      const answer = await change(one.port, EDITOR)
      expect(answer.status, `${scopes} ${granted}`).toBe(403)
      expect(editorIn(one)).toBeUndefined()
    }
  })
})

describe('what a granted device reads', () => {
  it('lists the window’s own settings, the changeable ones with what they echo', async () => {
    const one = await ready([], ['settings'])
    const answer = await read(one.port)
    expect(answer.status).toBe(200)
    expect(answer.body.granted).toBe(true)
    const rows = (answer.body.groups as { settings: { path: string; may: string }[] }[]).flatMap(
      (group) => group.settings,
    )
    expect(rows.filter((row) => row.may === 'change').map((row) => row.path)).toEqual([
      'surfaces.window.sidebar_width',
      'surfaces.window.strip_height',
      'surfaces.window.editor',
      'projects.app.push',
    ])
    // The project's root is a machine path, and is not in what left.
    expect(JSON.stringify(answer.body)).not.toContain(one.home)
  })

  it('reads nothing for a device that was not granted it', async () => {
    const one = await ready(['configure'], [])
    const answer = await read(one.port)
    expect(answer.body).toEqual({ granted: false, groups: [], withheld: 0 })
  })
})

describe('the two grants, which are keypresses at this machine', () => {
  async function press(one: Machine, control: string): Promise<void> {
    const submit = one.away.submits().away
    if (submit === undefined) throw new Error('the away panel has no submit')
    await submit(awayPanel(), control)
  }

  it('grants reading and changing one press each, composing with what was there', async () => {
    const one = await ready(['answer'], ['titles'])
    await one.away.reread()
    one.show()
    expect(one.away.panel()?.away?.configuring).toBe(true)
    expect(one.away.panel()?.away?.devices[0]).toMatchObject({
      mayReadSettings: false,
      mayConfigure: false,
    })

    await press(one, `${AWAY_CONTROLS.settings}${DEVICE}`)
    expect(one.news.at(-1)).toBe('iPhone can read the settings')
    await press(one, `${AWAY_CONTROLS.configure}${DEVICE}`)
    expect(one.news.at(-1)).toBe('iPhone can change the settings a request is enough for')
    const held = (await readDevices(one.home)).devices[0]
    expect(held?.granted).toEqual(['titles', 'settings'])
    expect(held?.scopes).toEqual(expect.arrayContaining(['read', 'answer', 'configure']))
    expect(one.away.panel()?.away?.devices[0]).toMatchObject({
      mayReadSettings: true,
      mayConfigure: true,
    })
    // And the very next request from the phone can change one.
    expect((await change(one.port, EDITOR)).status).toBe(200)

    // Pressed again, changing is taken back and nothing else with it.
    await press(one, `${AWAY_CONTROLS.configure}${DEVICE}`)
    expect(one.news.at(-1)).toBe('iPhone can no longer change a setting')
    const after = (await readDevices(one.home)).devices[0]
    expect(after?.scopes).not.toContain('configure')
    expect(after?.scopes).toContain('answer')
    expect(
      (await change(one.port, { ...EDITOR, was: 'zed', value: 'vim', key: 'otherkey12345678' }))
        .status,
    ).toBe(403)
  })

  it('refuses the changing grant while the setting is off, and never draws its chip', async () => {
    const one = await machine()
    await paired(one.home, one.port, [])
    await one.away.open()
    await one.away.reread()
    one.show()
    expect(one.away.panel()?.away?.configuring).toBe(false)
    await press(one, `${AWAY_CONTROLS.configure}${DEVICE}`)
    expect(one.away.panel()?.away?.problem).toContain('Let a paired device change a setting')
    expect((await readDevices(one.home)).devices[0]?.scopes).not.toContain('configure')
    // Reading needs no setting: nothing it grants can change anything.
    await press(one, `${AWAY_CONTROLS.settings}${DEVICE}`)
    expect((await readDevices(one.home)).devices[0]?.granted).toEqual(['settings'])
  })
})
