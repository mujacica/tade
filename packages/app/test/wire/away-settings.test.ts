import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
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
// did it and never the window or the person.

afterEach(closeAll)

async function ready(): Promise<Machine> {
  const one = await machine({ settings: true })
  await paired(one.home, one.port)
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
    const one = await ready()
    const answer = await change(one.port, EDITOR)
    expect(answer.status).toBe(200)
    expect(answer.body.did).toBe(true)
    expect(answer.body.rev).toBe('zed')
    expect(editorIn(one)).toBe('zed')
  })

  it('is recorded as the device, by id, and never as the window or the person', async () => {
    const one = await ready()
    await change(one.port, EDITOR)
    const changed = await waitFor(one.client, 'config_changed')
    expect(changed.map((line) => line.detail)).toEqual([
      {
        path: 'surfaces.window.editor',
        was: '',
        now: 'zed',
        by: `device ${DEVICE}`,
        hlc: expect.any(String),
      },
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
    const one = await ready()
    const first = await change(one.port, EDITOR)
    const again = await change(one.port, EDITOR)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect(await waitFor(one.client, 'config_changed')).toHaveLength(1)
  })

  it('refuses a screen drawn against another value, and leaves the file alone', async () => {
    const one = await ready()
    const answer = await change(one.port, { ...EDITOR, was: 'vim' })
    expect(answer.status).toBe(409)
    expect(answer.body.error).toBe('gone')
    expect(answer.body.rev).toBe('')
    expect(editorIn(one)).toBeUndefined()
  })

  it('refuses a body that does not say it meant it', async () => {
    const one = await ready()
    const answer = await change(one.port, { ...EDITOR, confirm: false })
    expect(answer.status).toBe(400)
    expect(editorIn(one)).toBeUndefined()
  })
})

describe('what a device reads', () => {
  it('lists the window’s own settings, the changeable ones with what they echo', async () => {
    const one = await ready()
    const answer = await read(one.port)
    expect(answer.status).toBe(200)
    const rows = (answer.body.groups as { settings: { path: string; may: string }[] }[]).flatMap(
      (group) => group.settings,
    )
    // Every paired device is the person's own and reaches every tier, as the
    // keyboard does: an `asked` setting is changeable from it too.
    expect(rows.filter((row) => row.may === 'change').map((row) => row.path)).toEqual(
      expect.arrayContaining([
        'surfaces.window.sidebar_width',
        'surfaces.window.strip_height',
        'surfaces.window.editor',
        'projects.app.push',
        'agents.commit',
      ]),
    )
    // The project's root is a machine path, and is not in what left.
    expect(JSON.stringify(answer.body)).not.toContain(one.home)
  })
})
