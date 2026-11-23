import { LOST_AFTER_MS, type MachineSeen } from '@tade/core'
import { heldFor } from '@tade/remotes-core'
import { describe, expect, it } from 'vitest'
import { linkedState, MachinesSeen } from '../../src/wire/machines-seen.ts'

// What the window holds of the person's other machines, and the lines it
// writes: a machine that links here, by its beats and its goodbye, lost past
// its slack; a machine this one links to, by its link; and what an earlier
// window wrote, read back so an old word never stands for ever.

const T = Date.parse('2026-11-22T14:00:00.000Z')

function holder(earlier: readonly MachineSeen[] = []) {
  let now = T
  const lines: Record<string, string>[] = []
  const said: string[] = []
  const seen = new MachinesSeen({
    append: async (line) => {
      lines.push(line.detail)
    },
    read: async () => earlier,
    now: () => now,
    say: (one) => said.push(one),
    draw: () => {},
  })
  return {
    seen,
    lines,
    said,
    at: (moved: number) => {
      now = T + moved
    },
  }
}

describe('a machine that links here', () => {
  it('is up on its first beat, closed on its goodbye, and writes a line only for each change', () => {
    const { seen, lines } = holder()
    seen.heard('mac', { state: 'up', slept: null }, T)
    seen.heard('mac', { state: 'up', slept: null }, T + 10_000)
    seen.heard('mac', { state: 'closed' }, T + 12_000)
    expect(lines.map((one) => [one.machine, one.way, one.state])).toEqual([
      ['mac', 'from', 'up'],
      ['mac', 'from', 'closed'],
    ])
    expect(seen.rows()).toEqual([
      { name: 'mac', way: 'from', state: 'closed', since: T + 12_000, host: null },
    ])
  })

  it('is lost on the beat after its slack runs out with no goodbye, since it was last heard', () => {
    const { seen, lines, at } = holder()
    seen.heard('mac', { state: 'up', slept: null }, T)
    at(LOST_AFTER_MS)
    seen.beat()
    expect(lines).toHaveLength(1)
    at(LOST_AFTER_MS + 1)
    seen.beat()
    expect(lines.at(-1)).toEqual({
      machine: 'mac',
      way: 'from',
      state: 'lost',
      since: new Date(T).toISOString(),
    })
    seen.beat()
    expect(lines).toHaveLength(2)
  })

  it('names a machine by its label as text, never as escapes', () => {
    const { seen, lines } = holder()
    seen.heard('mac\u001b[31mred', { state: 'up', slept: null }, T)
    expect(lines[0]?.machine).not.toContain('\u001b')
  })

  it('gives one an earlier window last saw up its slack from now, and calls it lost if it stays quiet', async () => {
    const { seen, lines, at } = holder([
      { machine: 'mac', way: 'from', state: 'up', at: T - 86_400_000, since: null },
    ])
    await seen.seed()
    expect(seen.rows()[0]?.state).toBe('up')
    at(LOST_AFTER_MS + 1)
    seen.beat()
    expect(lines.map((one) => one.state)).toEqual(['lost'])
  })
})

describe('a machine this one links to', () => {
  it('is up while its link is live, closed after its goodbye, lost without one, and nothing while dialled', () => {
    const { seen, lines } = holder()
    const idle = heldFor('vps')
    seen.linked(idle)
    expect(lines).toEqual([])
    const live = { ...idle, heardAt: T, link: { kind: 'live' as const, since: T } }
    seen.linked(live)
    seen.linked(live)
    const lost = {
      ...live,
      link: {
        kind: 'down' as const,
        since: T + 1,
        tries: 1,
        problem: 'timed out' as const,
        said: '',
      },
    }
    seen.linked(lost)
    seen.linked({ ...lost, link: { kind: 'dialling' as const, since: T + 2, tries: 1 } })
    seen.linked({ ...lost, bye: 'closed' })
    expect(lines.map((one) => [one.machine, one.way, one.state])).toEqual([
      ['vps', 'to', 'up'],
      ['vps', 'to', 'lost'],
      ['vps', 'to', 'closed'],
    ])
    expect(linkedState({ ...idle, link: { kind: 'ended', since: T, said: '' } })).toBeNull()
    // Closed and still not answering is still closed, not lost.
    seen.linked(lost)
    expect(lines).toHaveLength(3)
  })
})

describe('what each machine said of its figures', () => {
  const HOST = { at: '2026-11-22T13:59:58.000Z', cpu: 12 }

  it('keeps a machine that links here’s figures from its word, and the last ones past its goodbye', () => {
    const { seen, lines } = holder()
    seen.heard('mac', { state: 'up', slept: null }, T, HOST as never)
    expect(seen.rows()[0]?.host).toEqual(HOST)
    seen.heard('mac', { state: 'up', slept: null }, T + 10_000, null)
    expect(seen.rows()[0]?.host).toEqual(HOST)
    seen.heard('mac', { state: 'closed' }, T + 12_000)
    expect(seen.rows()[0]).toMatchObject({ state: 'closed', host: HOST })
    // A figure is a sample, and a sample is never a journal line.
    expect(lines.every((one) => !('host' in one))).toBe(true)
  })

  it('reads a machine this one links to’s figures off its own snapshot, kept while its link is down', () => {
    const { seen } = holder()
    const live = {
      ...heldFor('vps'),
      heardAt: T,
      link: { kind: 'live' as const, since: T },
      projection: { host: HOST } as never,
    }
    seen.linked(live)
    expect(seen.rows()[0]).toMatchObject({ name: 'vps', way: 'to', state: 'up', host: HOST })
    seen.linked({
      ...live,
      projection: null,
      link: { kind: 'down', since: T + 1, tries: 1, problem: 'timed out', said: '' },
    })
    expect(seen.rows()[0]).toMatchObject({ state: 'lost', host: HOST })
  })

  it('hands this machine’s own figures over as they are, and none where it has no watch', () => {
    const { seen } = holder()
    expect(seen.host()).toBeNull()
    const watched = new MachinesSeen({
      append: async () => {},
      read: async () => [],
      now: () => T,
      say: () => {},
      draw: () => {},
      here: () => HOST as never,
    })
    expect(watched.host()).toEqual(HOST)
  })
})
