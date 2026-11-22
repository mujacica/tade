import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { feedDir } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, SPAWNING_MS, screenOf, until, windowUnderTest } from './harness.ts'

// Queued work on this machine waiting on work on another, through the whole
// window: B here after A on vps never starts while the copy of vps's journal
// here says A has not finished — link down, copy behind, it is the same — and
// starts on the queue's next look once A's `task_done` reaches the copy. A
// machine silent for days is said on B's card with the wait offered to be
// dropped, and only a press drops it. The copy is written the way the exchange
// keeps one (`feeds.ts`), so nothing here depends on a link.

const VPS = '11111111-2222-4333-8444-555555555555'
const DAY = 86_400_000

let seq = 0
function line(type: string, task: string, at: number): string {
  seq++
  return JSON.stringify({
    seq,
    ts: new Date(at).toISOString(),
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: null,
    detail: {},
  })
}

function copyOfVps(home: string, lines: string[], heard: number): void {
  const dir = feedDir(home, VPS)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'feed.json'),
    JSON.stringify({
      machine: VPS,
      name: 'ipax',
      epoch: { id: '0123456789abcdef', at: '2026-11-01T00:00:00.000Z' },
      forks: [],
    }),
  )
  writeFileSync(join(dir, 'events.jsonl'), lines.map((one) => `${one}\n`).join(''))
  writeFileSync(
    join(dir, 'sync.json'),
    JSON.stringify({ id: VPS, name: 'ipax', called: 'vps', way: 'to', state: { at: heard } }),
  )
}

describe('queued work waiting on work on another machine', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    home = wired.home
  })
  const onScreen = (text: string) => screenOf(terminal.written).some((row) => row.includes(text))

  async function queueB(): Promise<void> {
    await client.createTask({
      project: 'app',
      slug: 'billing',
      intent: 'billing, once the migration on vps is in',
      by: 'you',
      start: {
        after: [{ task: 'vps:api/migrate', why: 'it needs the new table' }],
        prompt: 'Build billing.',
        touches: [],
      },
    })
  }

  it('never starts while vps’s copy has no task_done, and starts within a beat once it has', async () => {
    terminal.columns = 140
    terminal.rows = 45
    const now = Date.now()
    copyOfVps(home, [line('task_created', 'api/migrate', now - 60_000)], now)
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await queueB()
    await until('b waits on vps, and says when vps was last heard', async () =>
      (await window.queueTools().describe()).includes(
        'app/billing — after vps:api/migrate (vps:api/migrate: vps last heard',
      ),
    )
    // Looks go by, and b stays where it is.
    await window.queueTools().advance()
    await window.queueTools().advance()
    expect(client.runs().some((run) => run.task === 'app/billing')).toBe(false)
    copyOfVps(
      home,
      [line('task_created', 'api/migrate', now - 60_000), line('task_done', 'api/migrate', now)],
      now,
    )
    // Written once its agent is running: what started it, and what it waited on.
    await until(
      'b started by the queue',
      async () =>
        (await client.log.read({ types: ['queue_started'], task: 'app/billing' })).length > 0,
      SPAWNING_MS,
    )
    const [started] = await client.log.read({ types: ['queue_started'], task: 'app/billing' })
    expect(started?.detail.after).toEqual(['vps:api/migrate'])
  }, 120_000)

  it('says on its card that vps has been silent for days, and drops the wait only when pressed', async () => {
    terminal.columns = 140
    terminal.rows = 45
    const then = Date.now() - 3 * DAY - 60_000
    copyOfVps(home, [line('task_created', 'api/migrate', then)], then)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await queueB()
    await until('billing in the queue', () => onScreen('billing'))
    const row = find('billing')
    click(row.col + 2, row.row)
    await until('its card says vps has been silent', () =>
      onScreen('vps not heard from in 3 days — the wait can be dropped, by you'),
    )
    // Said, and nothing dropped by itself.
    expect((await client.log.read({ types: ['queue_changed'], task: 'app/billing' })).length).toBe(
      0,
    )
    const drop = find('Drop the wait')
    click(drop.col + 1, drop.row)
    await until('b waits on nothing, and starts', () =>
      client.runs().some((run) => run.task === 'app/billing'),
    )
    const [changed] = await client.log.read({ types: ['queue_changed'], task: 'app/billing' })
    expect(changed?.detail).toMatchObject({ by: 'you', dropped: ['vps:api/migrate'] })
  }, 120_000)

  it('says on the card of work placed here why it was sent from the machine it was asked on', async () => {
    terminal.columns = 140
    terminal.rows = 45
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const later = new Date(Date.now() + DAY).toISOString()
    await client.createTask({
      project: 'app',
      slug: 'nightly',
      intent: 'the nightly report',
      by: 'you',
      start: { after: [], prompt: 'Build it.', touches: [], at: later },
    })
    // What the take writes as it makes it (`web-take.ts`).
    await client.log.append({
      type: 'task_taken',
      task: 'app/nightly',
      detail: {
        from: 'mac',
        was: 'app/nightly',
        placed: 'placed on vps from mac: it waits for later and nothing ties it to mac',
      },
    })
    await until('nightly in the queue', () => onScreen('nightly'))
    const row = find('nightly')
    click(row.col + 2, row.row)
    await until('its card says why it is here', () =>
      onScreen('placed on vps from mac: it waits for later and nothing ties it to mac.'),
    )
  }, 120_000)
})
