import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { taskDir } from '@tade/core'
import { GRANTS, SCOPES } from '@tade/web'
import { afterEach, describe, expect, it } from 'vitest'
import { act, COOKIE, closeAll, KEY, type Machine, machine, paired, rowOf } from './away-harness.ts'

// The rest of an agent's menu from away, each all the way through a real
// listener to the window's own doors: start, rename and remove, and the menu
// itself — the window's list, cut to what a device may ask.
//
// **What each act leaves behind is read off the truth**: the registry's lane,
// the task file and its folder, and the journal — never off the answer. A
// device narrower than a verb needs is refused at the gate and reaches no door.

afterEach(closeAll)

/** Every scope, and every reading grant: the person's own device. */
const EVERYTHING = { scopes: [...SCOPES], granted: [...GRANTS] }

async function ready(scopes: readonly string[], granted: readonly string[] = []): Promise<Machine> {
  const one = await machine()
  await paired(one.home, one.port, scopes, granted)
  await one.away.open()
  await one.refresh()
  return one
}

/** One `GET` as the page sends it. */
function read(
  port: number,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { host: `127.0.0.1:${port}`, cookie: COOKIE, 'sec-fetch-site': 'same-origin' },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const said = Buffer.concat(chunks).toString('utf8')
          done({
            status: res.statusCode ?? 0,
            body: said === '' ? {} : (JSON.parse(said) as Record<string, unknown>),
          })
        })
      },
    )
    req.on('error', failed)
    req.end()
  })
}

function menuPath(task: string): string {
  const [project, name] = task.split('/')
  return `/api/agent/${project}/${name}/menu`
}

describe('the rest of an agent’s menu, from away', () => {
  it('starts an agent that never ran, saying nothing to it, through the window’s own door', async () => {
    const one = await ready(['read', 'agents'])
    const row = rowOf(one, one.task)
    expect(row.lane).toBe('none')
    expect(row.can.map((each) => each.verb)).toContain('start')
    const started = await act(one.port, 'start', { task: one.task, was: row.rev, key: KEY, rev: 0 })
    expect(started.status).toBe(200)
    expect(started.body.said).toContain('nothing said to it')
    // The registry's lane is alive, and the journal says one run started.
    expect(one.lane(one.task)).toBe(true)
    expect(await one.client.events({ types: ['run_started'], task: one.task })).toHaveLength(1)
  })

  it('renames an agent, written as the device rather than as you', async () => {
    const one = await ready(['read', 'agents'])
    const row = rowOf(one, one.task)
    const named = await act(one.port, 'rename', {
      task: one.task,
      was: row.rev,
      key: KEY,
      rev: 0,
      title: 'the ledger migration',
    })
    expect(named.status).toBe(200)
    const lines = await one.client.events({ types: ['task_named'], task: one.task })
    expect(lines.at(-1)?.detail).toMatchObject({
      title: 'the ledger migration',
      by: 'device 00112233445566aa',
    })
  })

  it('removes an agent for the person’s own device, and refuses it to one granted only `agents`', async () => {
    const narrow = await ready(['read', 'agents'])
    const before = rowOf(narrow, narrow.task)
    const refused = await act(narrow.port, 'remove', {
      task: narrow.task,
      was: before.rev,
      key: KEY,
      rev: 0,
      confirm: true,
    })
    expect(refused.status).toBe(403)
    expect(refused.body.error).toBe('out_of_scope')
    // Refused at the gate: its folder is where it was.
    expect(existsSync(taskDir(narrow.home, narrow.task))).toBe(true)

    const theirs = await ready(EVERYTHING.scopes, EVERYTHING.granted)
    const row = rowOf(theirs, theirs.task)
    const removed = await act(theirs.port, 'remove', {
      task: theirs.task,
      was: row.rev,
      key: KEY,
      rev: 0,
      confirm: true,
    })
    expect(removed.status).toBe(200)
    expect(existsSync(taskDir(theirs.home, theirs.task))).toBe(false)
    expect(await theirs.client.events({ types: ['task_removed'], task: theirs.task })).toHaveLength(
      1,
    )
  })

  it('answers the window’s own menu, cut to what the device may ask', async () => {
    const theirs = await ready(EVERYTHING.scopes, EVERYTHING.granted)
    const whole = await read(theirs.port, menuPath(theirs.task))
    expect(whole.status).toBe(200)
    const ids = (whole.body.items as { id: string }[]).map((one) => one.id)
    for (const id of [
      'open',
      'start',
      'stop',
      'mark-done',
      'rename',
      'model',
      'thinking',
      'harness',
      'account',
      'park',
      'remove',
    ]) {
      expect(ids, id).toContain(id)
    }
    // Off where the window has it off, with the window's word.
    const stop = (whole.body.items as { id: string; off: string | null }[]).find(
      (one) => one.id === 'stop',
    )
    expect(stop?.off).toBe('not running')

    const narrow = await ready(['read', 'steer'])
    const cut = await read(narrow.port, menuPath(narrow.task))
    const left = (cut.body.items as { id: string }[]).map((one) => one.id)
    // Park and mark finished are steer's; start, rename, remove and the rest are not.
    expect(left).toContain('park')
    expect(left).toContain('mark-done')
    for (const id of ['start', 'stop', 'rename', 'model', 'account', 'harness', 'remove']) {
      expect(left, id).not.toContain(id)
    }
  })

  it('says nothing about a task this device does not read', async () => {
    const one = await ready(['read', 'agents'])
    const none = await read(one.port, '/api/agent/app/nobody/menu')
    expect(none.status).toBe(200)
    expect(none.body).toMatchObject({ here: false, items: [] })
  })
})
