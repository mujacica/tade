import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { FleetJournals } from '../../src/wire/fleet-journals.ts'

// Other machines' journals, as the copies under this home have them, folded
// into what search says of their rows: a task's work and a project's tasks,
// labelled with the machine. Read in the background and never waited for;
// what could not be read is said once and the last answer kept.

const VPS = '22222222-2222-4222-8222-222222222222'
const NOW = Date.parse('2026-11-23T12:00:00.000Z')

let seq = 0
const line = (type: string, task: string, detail: Record<string, unknown> = {}) =>
  JSON.stringify({
    seq: ++seq,
    ts: '2026-11-23T11:00:00.000Z',
    type,
    urgency: 'routine',
    task,
    lane: null,
    detail,
  })

/** A home holding a copy of the vps's journal, as an exchange leaves one. */
function home(lines: string[]): string {
  const at = tmp('tade-fleet-journals-')
  const dir = join(at, 'machines', VPS)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'feed.json'),
    JSON.stringify({
      machine: VPS,
      name: 'box',
      epoch: { id: '0123456789abcdef', at: '2026-11-22T10:00:00.000Z' },
      forks: [],
    }),
  )
  writeFileSync(join(dir, 'events.jsonl'), `${lines.join('\n')}\n`)
  return at
}

function journals(at: string) {
  const said: string[] = []
  let drawn = 0
  const one = new FleetJournals({
    home: at,
    now: () => NOW,
    idOf: (remote) => (remote === 'vps' ? VPS : null),
    say: (text) => said.push(text),
    draw: () => {
      drawn++
    },
  })
  return { one, said, drawn: () => drawn }
}

async function waitFor(check: () => boolean): Promise<void> {
  const end = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('other machines’ journals, for search', () => {
  it('says what a task there did and which tasks a project there named, labelled with the machine', async () => {
    const { one, drawn } = journals(
      home([
        line('task_created', 'api/migrate'),
        line('state_change', 'api/migrate', { state: 'blocked' }),
        line('failed', 'api/migrate', { error: 'the schema lock was held' }),
        line('task_created', 'api/backfill'),
        line('task_created', 'web/landing'),
      ]),
    )
    // Nothing read yet: nothing said, and nothing waited for.
    expect(one.aboutTask('vps', 'api/migrate')).toBe('')
    one.look()
    await waitFor(() => drawn() > 0)
    expect(one.aboutProject('vps', 'api')).toBe(
      'on vps, its journal names: api/backfill, api/migrate',
    )
    expect(one.aboutTask('vps', 'api/migrate')).toBe(
      [
        'on vps: blocked, as its journal last said',
        'on vps: failed: the schema lock was held',
      ].join('\n'),
    )
    // A machine whose journal is not kept here says nothing.
    expect(one.aboutTask('laptop', 'api/migrate')).toBe('')
    expect(one.aboutProject('vps', 'nothing')).toBe('')
  })

  it('reads again only once its last reading is old', async () => {
    const at = home([line('task_created', 'api/one')])
    const { one, drawn } = journals(at)
    one.look()
    await waitFor(() => drawn() === 1)
    writeFileSync(join(at, 'machines', VPS, 'events.jsonl'), `${line('task_created', 'api/two')}\n`)
    one.look()
    expect(one.aboutProject('vps', 'api')).toBe('on vps, its journal names: api/one')
  })

  it('says once that the copies could not be read, and keeps what it had', async () => {
    const at = home([])
    // A folder where the copy's lines should be: a look that cannot read, which is not "no lines".
    const lines = join(at, 'machines', VPS, 'events.jsonl')
    rmSync(lines)
    mkdirSync(lines)
    const { one, said } = journals(at)
    one.look()
    await waitFor(() => said.length > 0)
    expect(said[0]).toContain("other machines' journals could not be read for search")
  })
})
