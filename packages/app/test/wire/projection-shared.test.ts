import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RemoteLink, readKept, writeKept } from '@tade/remotes-core'
import { COLLECTIONS, type Pieces, type Snapshot } from '@tade/web'
import { describe, expect, it } from 'vitest'
import {
  copiesJoined,
  KEEP_EVERY_MS,
  ProjectionShared,
  ProjectionsHeld,
  TELL_EVERY_MS,
  toldOf,
} from '../../src/wire/projection-shared.ts'
import { until } from './harness.ts'

// The Mac telling ipax its projection, and ipax keeping what it is told
// (ONE-AWAY-VIEW step 2): the sender on one side, the receiver on the other,
// joined by a link that carries each piece to the receiver's own half as the
// route would — whole first, each change after, a gap told whole again, and
// what was kept read back as of its last word.

const EPOCH = '7f3a9c21-0000-4000-8000-000000000000'

/** A projection with these tasks in it, at this revision: every collection, as the wire has them. */
function snap(rev: number, titles: readonly string[], epoch = EPOCH): Snapshot {
  const empty = Object.fromEntries(COLLECTIONS.map((one) => [one, []]))
  const pages = Object.fromEntries(
    COLLECTIONS.map((one) => [one, { total: 0, omitted: 0, next: null, restarted: false }]),
  )
  return {
    ...empty,
    v: 1,
    fresh: { epoch, rev, at: new Date(1_000 + rev).toISOString() },
    you: { device: 'every machine', reads: [], talk: null },
    pages,
    machines: [],
    host: null,
    tasks: titles.map((title) => ({ id: `app/${title}`, title: { words: title, more: false } })),
  } as unknown as Snapshot
}

function home(): string {
  return mkdtempSync(join(tmpdir(), 'tade-projection-'))
}

/** A link to one machine whose door is the receiver's own half, piece by piece. */
function linkTo(held: ProjectionsHeld, label = 'laptop') {
  const asked: { kind: string; piece: number }[] = []
  let live = true
  const half = held.web()
  const link = {
    request: async (_name: string, _path: string, body: unknown) => {
      if (!live) throw new Error('the link is down')
      const piece = body as Parameters<Pieces['take']>[1]
      asked.push({ kind: piece.kind, piece: piece.piece })
      const whole = half.pieces.take('dev', piece)
      if (whole === null) {
        return { status: 200, body: { kept: half.pieces.arriving('dev') ? 'piece' : 'gap' } }
      }
      return { status: 200, body: { kept: await half.take(whole, 'dev', label) } }
    },
  } as unknown as RemoteLink
  return {
    asked,
    reach: () => ({ link, live }),
    down: () => {
      live = false
    },
  }
}

function tasksOf(held: ProjectionsHeld, name = 'laptop'): string[] {
  const copy = held.copies().find((one) => one.name === name)?.projection
  return (copy?.tasks ?? []).map((one) => one.title?.words ?? '')
}

describe('what a machine is told', () => {
  it('is its first projection whole, then each change against what it was last told', () => {
    expect(toldOf(null, snap(4, ['a']))?.kind).toBe('whole')
    const change = toldOf(snap(4, ['a']), snap(5, ['a', 'b']))
    expect(change).toMatchObject({ kind: 'change', from: 4, rev: 5 })
    expect(toldOf(snap(5, ['a']), snap(5, ['a']))).toBeNull()
    // Another lifetime of the sender's server says nothing of the last one's revisions.
    expect(
      toldOf(snap(9, ['a']), snap(1, ['a'], '0b1e0000-0000-4000-8000-000000000000'))?.kind,
    ).toBe('whole')
  })
})

describe('the Mac telling ipax, over the link', () => {
  /** A sender and its clock, told again every try until what ipax holds says so. */
  function sender(own: () => Snapshot) {
    const clock = { now: 10_000 }
    const shared = new ProjectionShared({ own, now: () => clock.now, say: () => {} })
    return {
      clock,
      shared,
      /** Beat until `ok`, two seconds of its clock a try: paced by what it waits for. */
      tellUntil: (reach: ReturnType<typeof linkTo>['reach'], what: string, ok: () => boolean) =>
        until(what, () => {
          clock.now += TELL_EVERY_MS
          shared.beat(['ipax'], reach)
          return ok()
        }),
    }
  }

  it('ends with ipax holding exactly what the Mac said, whole and then changed', async () => {
    const held = new ProjectionsHeld({ home: home(), now: () => 0, say: () => {} })
    const link = linkTo(held)
    let own = snap(4, ['a'])
    const mac = sender(() => own)
    await mac.tellUntil(link.reach, 'the whole projection', () => tasksOf(held).length === 1)
    expect(link.asked.map((one) => one.kind)).toEqual(['whole'])
    // Not again before two seconds have passed.
    mac.shared.beat(['ipax'], link.reach)
    expect(link.asked).toHaveLength(1)

    own = snap(5, ['a', 'b'])
    await mac.tellUntil(link.reach, 'its change', () => tasksOf(held).length === 2)
    expect(link.asked.map((one) => one.kind)).toEqual(['whole', 'change'])
    expect(tasksOf(held)).toEqual(['a', 'b'])
    expect(held.copies()[0]?.projection?.fresh.rev).toBe(5)
  })

  it('tells it whole again after a gap: a receiver that holds nothing', async () => {
    const held = new ProjectionsHeld({ home: home(), now: () => 0, say: () => {} })
    let own = snap(4, ['a'])
    const mac = sender(() => own)
    await mac.tellUntil(
      linkTo(held).reach,
      'the whole projection',
      () => tasksOf(held).length === 1,
    )

    // The receiver restarted and holds nothing: a change is a gap, and the
    // next telling is whole.
    const fresh = new ProjectionsHeld({ home: home(), now: () => 0, say: () => {} })
    const again = linkTo(fresh)
    own = snap(5, ['a', 'b'])
    await mac.tellUntil(again.reach, 'it whole', () => tasksOf(fresh).length === 2)
    expect(again.asked.map((one) => one.kind)).toEqual(['change', 'whole'])
  })

  it('tells it whole again once a link that was down is back', async () => {
    const held = new ProjectionsHeld({ home: home(), now: () => 0, say: () => {} })
    const link = linkTo(held)
    const mac = sender(() => snap(4, ['a']))
    await mac.tellUntil(link.reach, 'the whole projection', () => tasksOf(held).length === 1)
    mac.shared.beat(['ipax'], () => ({ ...link.reach(), live: false }))
    await mac.tellUntil(link.reach, 'it whole again', () => link.asked.length === 2)
    expect(link.asked.map((one) => one.kind)).toEqual(['whole', 'whole'])
  })

  it('tells a machine whose link is down nothing, and tells nobody while it has no projection', () => {
    const held = new ProjectionsHeld({ home: home(), now: () => 0, say: () => {} })
    const link = linkTo(held)
    link.down()
    const shared = new ProjectionShared({ own: () => snap(4, ['a']), now: () => 0, say: () => {} })
    shared.beat(['ipax'], link.reach)
    const none = new ProjectionShared({ own: () => null, now: () => 0, say: () => {} })
    none.beat(['ipax'], linkTo(held).reach)
    expect(held.copies()).toEqual([])
  })
})

describe('what ipax keeps of the Mac', () => {
  it('refuses a change it is not at, and text that is not a projection', () => {
    const held = new ProjectionsHeld({ home: home(), now: () => 0, say: () => {} })
    const said: string[] = []
    const strict = new ProjectionsHeld({ home: home(), now: () => 0, say: (one) => said.push(one) })
    expect(held.take({ kind: 'change', epoch: EPOCH, rev: 5, from: 4, text: '{}' }, 'laptop')).toBe(
      'gap',
    )
    expect(strict.take({ kind: 'whole', epoch: EPOCH, rev: 4, text: 'not json' }, 'laptop')).toBe(
      'refused',
    )
    expect(said).toHaveLength(1)
    expect(strict.copies()).toEqual([])
  })

  it('writes it down at most every thirty seconds, and reads it back as of then', async () => {
    const where = home()
    let now = 50_000
    const held = new ProjectionsHeld({ home: where, now: () => now, say: () => {} })
    held.take(
      { kind: 'whole', epoch: EPOCH, rev: 4, text: JSON.stringify(snap(4, ['a'])) },
      'laptop',
    )
    held.beat()
    await until('it kept', async () => (await readKept(where, 'laptop')) !== null)
    held.take(
      { kind: 'whole', epoch: EPOCH, rev: 5, text: JSON.stringify(snap(5, ['a', 'b'])) },
      'laptop',
    )
    held.beat()
    expect((await readKept(where, 'laptop'))?.projection.fresh.rev).toBe(4)
    now += KEEP_EVERY_MS
    await until('it kept again', async () => {
      held.beat()
      return (await readKept(where, 'laptop'))?.projection.fresh.rev === 5
    })

    const back = new ProjectionsHeld({ home: where, now: () => now, say: () => {} })
    await back.open()
    expect(tasksOf(back)).toEqual(['a', 'b'])
    // As of when it was told, in this machine's clock — never when it was read back.
    expect(back.heardAt('laptop')).toBe(50_000)
  })

  it('says once that a machine whose name makes no folder is drawn and not kept', async () => {
    const said: string[] = []
    const held = new ProjectionsHeld({
      home: home(),
      now: () => KEEP_EVERY_MS,
      say: (one) => said.push(one),
    })
    const told = {
      kind: 'whole',
      epoch: EPOCH,
      rev: 4,
      text: JSON.stringify(snap(4, ['a'])),
    } as const
    held.take(told, '★★★')
    held.beat()
    await until('it said', async () => said.length > 0)
    expect(said).toEqual(['★★★ is drawn here but not kept: its name makes no folder in this home'])
    expect(tasksOf(held, '★★★')).toEqual(['a'])
  })

  it('reads back what is kept under its folder, and holds it by its own name once told again', async () => {
    const where = home()
    await writeKept(where, 'mac-mini', { projection: snap(4, ['a']), heardAt: 1, cursor: null })
    const held = new ProjectionsHeld({ home: where, now: () => 2, say: () => {} })
    await held.open()
    expect(held.copies().map((one) => one.name)).toEqual(['mac-mini'])
    held.take(
      { kind: 'whole', epoch: EPOCH, rev: 5, text: JSON.stringify(snap(5, ['b'])) },
      'Mac Mini',
    )
    expect(held.copies().map((one) => one.name)).toEqual(['Mac Mini'])
  })
})

describe('the copies the page is handed', () => {
  it('is what the links hold, and what one that links here told for any other', () => {
    const linked = [{ name: 'ipax', projection: snap(1, ['live']) }]
    const told = [
      { name: 'ipax', projection: snap(1, ['kept']) },
      { name: 'laptop', projection: snap(1, ['told']) },
    ]
    expect(copiesJoined(told, linked).map((one) => one.name)).toEqual(['ipax', 'laptop'])
    expect(copiesJoined(told, linked)[0]?.projection?.tasks[0]?.title?.words).toBe('live')
  })
})
