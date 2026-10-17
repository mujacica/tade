import { describe, expect, it } from 'vitest'
import { deskThere } from '../src/desk-there.ts'
import { deskKey, deskOf } from '../src/landing.ts'
import { diffClick, diffPanel } from '../src/panels/diff/state.ts'
import { landingKey, landingPanel } from '../src/panels/landing/state.ts'

// Another machine's work on this window's landing desk (`desk-there.ts`): read
// out of its projection for its shape, placed by that machine's own answer,
// ordered with this machine's by one rule — and its change, once read, offers
// nothing that acts on this machine.

const NOW = Date.parse('2026-10-17T09:00:00Z')

/** A projected row as another machine's away view sends one, on its own desk. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tade/fix',
    project: 'tade',
    state: 'review',
    finished: true,
    wantsYou: false,
    checks: { state: 'pass', failed: [], missing: [], overridden: false },
    review: { state: 'open', url: null },
    size: { commits: 2, added: 10, removed: 3 },
    conflicts: [],
    movedAt: new Date(NOW - 60_000).toISOString(),
    spend: { usd: 1.25, hasCost: true },
    landing: { rank: 0, tier: 'ready', why: null, also: 0, findings: null },
    ...over,
  }
}

describe('another machine’s work on the desk', () => {
  it('is what that machine’s own desk holds, placed by its answer, in this machine’s clock', () => {
    const [one] = deskThere('vps', { tasks: [row(), row({ id: 'tade/off', landing: null })] }, 500)
    expect(one).toMatchObject({
      machine: 'vps',
      project: 'tade',
      landing: { tier: 'ready', why: null, also: 0 },
      usd: 1.25,
      review: 'open',
      facts: { task: 'tade/fix', checks: 'pass', waitingSince: NOW - 60_000 + 500 },
    })
    // Work not on its own desk is not on this one either.
    expect(deskThere('vps', { tasks: [row({ landing: null })] }, 0)).toEqual([])
  })

  it('reads every string as text, and drops a row whose shape it cannot read', () => {
    const [one] = deskThere(
      'vps',
      {
        tasks: [
          row({
            project: 'tade\u001b[2J',
            landing: { rank: 0, tier: 'theirs', why: 'a\u001b[31m red', also: 2 },
          }),
          row({ state: 'not a state' }),
          row({ landing: { tier: 'somewhere' } }),
          'not a row',
        ],
      },
      0,
    )
    expect(one?.project).not.toContain('\u001b')
    expect(one?.landing.why).not.toContain('\u001b')
    expect(deskThere('vps', { tasks: [row({ state: 'not a state' })] }, 0)).toEqual([])
    expect(deskThere('vps', null, 0)).toEqual([])
  })

  it('is ordered with this machine’s work by one rule, and named so it never mixes with a task here', () => {
    const there = deskThere('vps', { tasks: [row()] }, 0)
    const desk = deskOf({
      world: { projects: [] } as never,
      finished: new Set(),
      waiting: new Set(),
      work: () => null,
      findings: null,
      usd: () => null,
      there,
    })
    expect(desk.map((one) => [one.task, one.machine])).toEqual([['tade/fix', 'vps']])
    expect(deskKey(desk[0] as never)).toBe('tade/fix on vps')
    expect(deskKey({ task: 'tade/fix' })).toBe('tade/fix')
  })

  it('opens its change in the patch reader on that machine, and goes to its agent there', () => {
    const desk = deskOf({
      world: { projects: [] } as never,
      finished: new Set(),
      waiting: new Set(),
      work: () => null,
      findings: null,
      usd: () => null,
      there: deskThere('vps', { tasks: [row()] }, 0),
    })
    const read = landingKey(landingPanel(), 'enter', '', {
      desk,
      deskFiles: { 'tade/fix on vps': ['a.ts'] },
    })
    expect(read.panel).toMatchObject({ kind: 'diff', task: 'tade/fix', machine: 'vps' })
    expect(landingKey(landingPanel(), undefined, 'a', { desk })).toMatchObject({
      choice: 'there:vps:tade/fix',
    })
    // Not read yet, or not mirrored here: it stays, and says which.
    const stays = landingKey(landingPanel(), 'enter', '', { desk, deskFiles: {} })
    expect(stays.panel).toMatchObject({ kind: 'landing' })
    expect((stays.panel as { said: string }).said).toContain('fix on vps')
  })

  it('offers nothing in the patch reader that would act on this machine', () => {
    const there = diffPanel('tade/fix', ['a.ts'], 0, 'vps')
    expect(diffClick(there, 'editor')).toMatchObject({ panel: there })
    expect(diffClick(there, 'editor')).not.toMatchObject({ submit: true })
    expect(diffClick(there, 'ask')).not.toMatchObject({ submit: true })
    const here = diffPanel('app/fix', ['a.ts'], 0)
    expect(diffClick(here, 'editor')).toMatchObject({ submit: true, choice: 'editor' })
  })
})
