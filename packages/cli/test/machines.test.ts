import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { feedDir } from '@tade/core'
import { ensureMachine } from '@tade/workbench/machine-file'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { run } from '../src/program.ts'

// `tade machines`, and `tade remote status` and `list` beside it, run in this
// worker the way `bin.ts` runs them, over a home of its own: every machine as
// this one knows it — up, closed or lost and since when, where the two stand
// after their last exchange, and how much of each one's journal is kept here,
// relayed ones included — read from the files alone, with no window open.

const DEVICE = '0123456789abcdef'
const REMOTE = (name: string) =>
  [
    `  ${name}:`,
    '    ssh: far',
    `    device: ${DEVICE}`,
    `    session: ${DEVICE}.abcdefghijklmnopqrstuv`,
    '    csrf: abcdefghijklmnopqrstuv',
    '    host: localhost:7699',
  ].join('\n')

const VPS = '22222222-2222-4222-8222-222222222222'
const LAPTOP = '33333333-3333-4333-8333-333333333333'
const EPOCH = { id: 'aaaaaaaaaaaaaaaa', at: '2026-11-20T10:00:00.000Z' }

let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
})
afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
})

async function tade(home: string, ...args: string[]) {
  Object.assign(process.env, { TADE_HOME: home, HOME: home })
  const out: string[] = []
  const err: string[] = []
  const code = await run(['node', 'tade', ...args], {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  })
  return { code, out: out.join('\n'), err: err.join('\n') }
}

/** A copy of another machine's journal kept here, with where the two last stood. */
function copy(home: string, id: string, name: string, lines: number, sync?: object) {
  const dir = feedDir(home, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'feed.json'),
    JSON.stringify({
      machine: id,
      name,
      epoch: EPOCH,
      forks: name === 'vps' ? [{ epoch: 'b', kept: 'x', why: 'epoch', at: '' }] : [],
    }),
  )
  writeFileSync(
    join(dir, 'events.jsonl'),
    `${Array.from({ length: lines }, (_, n) => `{"seq":${n + 1}}`).join('\n')}\n`,
  )
  if (sync) writeFileSync(join(dir, 'sync.json'), JSON.stringify(sync))
}

function home(): string {
  const dir = tmp('tade-machines-')
  writeFileSync(join(dir, 'config.yaml'), ['remotes:', REMOTE('vps'), REMOTE('box'), ''].join('\n'))
  const seen = (seq: number, ts: string, detail: object) =>
    JSON.stringify({
      seq,
      ts,
      type: 'machine_seen',
      urgency: 'routine',
      task: null,
      lane: null,
      run: null,
      detail,
    })
  writeFileSync(
    join(dir, 'events.jsonl'),
    `${[
      seen(1, '2026-11-22T09:00:00.000Z', { machine: 'vps', way: 'to', state: 'up' }),
      seen(2, '2026-11-22T13:10:00.000Z', { machine: 'vps', way: 'to', state: 'closed' }),
      seen(3, '2026-11-22T12:00:00.000Z', { machine: 'mac2', way: 'from', state: 'lost' }),
    ].join('\n')}\n`,
  )
  copy(dir, VPS, 'vps', 12, {
    id: VPS,
    name: 'vps',
    called: 'vps',
    way: 'to',
    state: {
      word: 'behind',
      here: 'a',
      there: 'b',
      behind: 3,
      ahead: 0,
      forks: 0,
      conflicts: 1,
      differ: ['feeds'],
      at: Date.parse('2026-11-22T13:05:00Z'),
    },
  })
  // Only relayed here: it never linked to this machine nor this one to it.
  copy(dir, LAPTOP, 'laptop', 4)
  return dir
}

describe('tade machines', () => {
  it('says every machine: how it was last seen, where the two stand, and how much of its journal is kept here', async () => {
    const dir = home()
    await ensureMachine(dir, Date.parse('2026-11-22T08:00:00Z'))
    const said = await tade(dir, 'machines')
    expect(said.code, said.err).toBe(0)
    const lines = said.out.split('\n')
    expect(lines[0]).toMatch(
      /^this machine {2}\S+ {2}id [0-9a-f-]{36}, journal epoch [0-9a-f]{16}$/,
    )
    expect(said.out).toContain(
      'vps  closed 2026-11-22 13:10, said goodbye · 1 conflict · behind by 3 lines (as of 2026-11-22 13:05) · 12 journal lines kept here · 1 copy set aside by a fork',
    )
    expect(said.out).toContain('box  not linked yet · not compared yet')
    expect(said.out).toContain(
      'mac2  lost 2026-11-22 12:00 — no goodbye: asleep, or off the network · not compared yet',
    )
    expect(said.out).toContain(
      'laptop  relayed through another machine · 4 journal lines kept here',
    )
    expect(said.out).toContain('no window is open on this home')
    const json = JSON.parse((await tade(dir, 'machines', '--json')).out) as {
      window: boolean
      rows: {
        name: string
        way: string
        state: string | null
        lines: number
        sync: { word: string } | null
      }[]
    }
    expect(json.window).toBe(false)
    expect(
      json.rows.map((one) => [one.name, one.way, one.state, one.lines, one.sync?.word ?? null]),
    ).toEqual([
      ['box', 'to', null, 0, null],
      ['vps', 'to', 'closed', 12, 'behind'],
      ['mac2', 'from', 'lost', 0, null],
      ['laptop', 'relayed', null, 4, null],
    ])
  })

  it('says a home Tade never opened has no id yet', async () => {
    const dir = tmp('tade-machines-new-')
    writeFileSync(join(dir, 'config.yaml'), '')
    const said = await tade(dir, 'machines')
    expect(said.out).toContain('no id yet')
    expect(said.out).toContain('no other machines')
  })
})

describe('tade remote status and list', () => {
  it('say a machine is closed or lost, not only whether its link was up, and where the two stand', async () => {
    const dir = home()
    const status = await tade(dir, 'remote', 'status')
    expect(status.code, status.err).toBe(0)
    expect(status.out).toContain(
      'vps  closed 2026-11-22 13:10, said goodbye · 1 conflict · behind by 3 lines',
    )
    expect(status.out).toContain('box  not linked yet  (ssh far)')
    const json = JSON.parse((await tade(dir, 'remote', 'status', 'vps', '--json')).out) as {
      remotes: { name: string; state: string; synced: string }[]
    }
    expect(json.remotes[0]).toMatchObject({
      name: 'vps',
      state: 'closed',
      synced: expect.stringContaining('behind by 3 lines'),
    })
    const listed = await tade(dir, 'remote', 'list')
    expect(listed.out).toContain(
      'vps  ssh far  device 0123456789abcdef  localhost:7699  closed 2026-11-22 13:10, said goodbye',
    )
  })
})
