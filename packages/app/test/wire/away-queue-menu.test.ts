import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { taskDir } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { act, COOKIE, closeAll, type Machine, machine, paired, revOf } from './away-harness.ts'

// Queued work's menu from away — what the side's ⋯ and a long-press on a piece
// of queued work open — each press all the way through a real listener to the
// window's own door, and the menu itself the window's `queueMenuItems`.
//
// **Each press is sent as the menu says to send it**: its verb, and the change
// its item carries (`with`), read out of the menu's own answer — so a menu that
// mapped an item to the wrong choice fails here rather than on a phone. What
// each leaves behind is read off the journal and the task's folder, never the
// answer.

afterEach(closeAll)

interface Item {
  id: string
  label: string
  off: string | null
  act: { kind: string; verb?: string; with?: Record<string, string> }
}

/** A machine with one piece of queued work, ready to start, and a device paired. */
async function queuedOn(): Promise<Machine> {
  const one = await machine()
  await paired(one.home, one.port)
  await one.away.open()
  one.queued(one.task)
  one.queuedPane(one.task, { kind: 'ready' })
  await one.refresh()
  return one
}

/** The menu a device is answered for one task, as the page reads it. */
function menuOf(one: Machine, task = one.task): Promise<{ status: number; items: Item[] }> {
  const [project, name] = task.split('/')
  return new Promise((done, failed) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: one.port,
        path: `/api/agent/${project}/${name}/menu`,
        method: 'GET',
        headers: {
          host: `127.0.0.1:${one.port}`,
          cookie: COOKIE,
          'sec-fetch-site': 'same-origin',
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { items: Item[] }
          done({ status: res.statusCode ?? 0, items: body.items })
        })
      },
    )
    req.on('error', failed)
    req.end()
  })
}

/** A key per press, as the page mints one per press. */
let pressed = 0
function keyOf(): string {
  pressed += 1
  return `queue-press-${pressed}`.padEnd(16, '0')
}

/** One item pressed, as `agent-menu.js` sends it: the item's verb, what it carries, the row's revision. */
function press(one: Machine, item: Item, extra: Record<string, unknown> = {}) {
  if (item.act.kind !== 'verb' || item.act.verb === undefined) {
    throw new Error(`${item.id} is not a press that sends an act`)
  }
  return act(one.port, item.act.verb, {
    task: one.task,
    was: revOf(one, one.task),
    key: keyOf(),
    rev: 0,
    ...(item.act.with ?? {}),
    ...extra,
  })
}

function itemOf(items: readonly Item[], id: string): Item {
  const found = items.find((one) => one.id === id)
  if (found === undefined) throw new Error(`no ${id} on the menu: ${items.map((one) => one.id)}`)
  return found
}

describe('queued work’s menu, from away', () => {
  it('is the window’s own queued-work menu, each choice carrying the queue’s verb', async () => {
    const one = await queuedOn()
    const menu = await menuOf(one)
    expect(menu.status).toBe(200)
    expect(menu.items.map((item) => item.id)).toEqual([
      'open',
      'queue-start',
      'queue-first',
      'queue-pause',
      'queue-wait',
      'queue-after',
      'queue-retell',
      'rename',
      'queue-remove',
    ])
    for (const [id, change] of [
      ['queue-start', 'start'],
      ['queue-first', 'first'],
      ['queue-pause', 'pause'],
      ['queue-wait', 'wait'],
    ] as const) {
      expect(itemOf(menu.items, id).act, id).toEqual({
        kind: 'verb',
        verb: 'queue',
        with: { change },
      })
    }
    expect(itemOf(menu.items, 'queue-remove').act).toEqual({ kind: 'verb', verb: 'remove' })
    // Off where the window has it off, with the window's word; the machine's
    // own two said as the machine's, never sent.
    expect(itemOf(menu.items, 'queue-wait').off).toBe('not held')
    expect(itemOf(menu.items, 'queue-after')).toMatchObject({
      off: 'what it waits on is changed at the machine',
      act: { kind: 'here' },
    })
  })

  it('reaches the queue’s own door with each press, written as the device', async () => {
    const one = await queuedOn()
    const items = (await menuOf(one)).items

    const started = await press(one, itemOf(items, 'queue-start'))
    expect(started.status).toBe(200)
    expect(started.body.said).toBe('starts now, past its project’s limit if it must')
    await one.refresh()

    const first = await press(one, itemOf(items, 'queue-first'))
    expect(first.status).toBe(200)
    await one.refresh()

    const paused = await press(one, itemOf(items, 'queue-pause'))
    expect(paused.status).toBe(200)
    expect(paused.body.said).toBe('paused')
    await one.refresh()

    // Paused, the window's menu offers Resume in Pause's place, and it is a press too.
    one.queuedPane(one.task, { kind: 'paused', all: false })
    const resume = itemOf((await menuOf(one)).items, 'queue-resume')
    expect(resume.act).toEqual({ kind: 'verb', verb: 'queue', with: { change: 'resume' } })
    const resumed = await press(one, resume)
    expect(resumed.status).toBe(200)
    expect(resumed.body.said).toBe('back on')

    const lines = await one.client.events({ types: ['queue_changed'] })
    expect(lines.map((line) => [line.detail.change, line.detail.by])).toEqual([
      ['start', 'device 00112233445566aa'],
      ['order', 'device 00112233445566aa'],
      ['pause', 'device 00112233445566aa'],
      ['resume', 'device 00112233445566aa'],
    ])
    // A choice written down, and no agent: what starts is the window's next pass.
    expect(await one.client.events({ types: ['run_started'] })).toEqual([])
  })

  it('removes queued work from the person’s own device through its Remove', async () => {
    const one = await queuedOn()
    const remove = itemOf((await menuOf(one)).items, 'queue-remove')
    const removed = await press(one, remove, { confirm: true })
    expect(removed.status).toBe(200)
    expect(existsSync(taskDir(one.home, one.task))).toBe(false)
  })
})
