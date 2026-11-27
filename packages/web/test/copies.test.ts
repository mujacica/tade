import { describe, expect, it } from 'vitest'
import { applyCopy, copiesOf, emptyStore, rowsOf, streamPath } from '../src/assets/store.js'
import { Copies, copiesFor, copiesHeldOf, copyOf } from '../src/copies.ts'
import { applyDelta } from '../src/delta.ts'
import type { Snapshot } from '../src/protocol.ts'
import { projector } from '../src/reading.ts'
import { input, NOW, reach, task } from './fixtures.ts'

// Every other machine's copy, as a door passes it on: whole the first time,
// its change after, gone when it is no longer held — and a change a page's
// copy can apply to exactly what it was last sent.

const EPOCH = '7f3a9c21-0000-4000-8000-000000000000'

function snapshot(over: { rev?: number; epoch?: string; title?: string } = {}): Snapshot {
  const made = projector(
    input({
      reach: reach(),
      lifetime: { epoch: over.epoch ?? EPOCH, rev: over.rev ?? 12, openedAt: 1_000_000 },
      tasks: [task({ title: over.title ?? 'Fix the parser' })],
    }),
    NOW,
  ).snapshot()
  return made
}

describe('who is sent the copies', () => {
  it('is every paired phone, and never another machine’s link', () => {
    expect(copiesFor(false)).toBe(true)
    expect(copiesFor(true)).toBe(false)
  })
})

describe('what a copy leaves out', () => {
  it('leaves out the conversation and the notes, which are one already', () => {
    const copy = copyOf(snapshot())
    expect(copy.chat).toEqual([])
    expect(copy.notes).toEqual([])
    expect(copy.pages.notes.total).toBe(0)
    expect(copy.tasks.length).toBeGreaterThan(0)
  })
})

describe('the frames a beat makes', () => {
  it('is whole the first time a machine is heard', () => {
    const copies = new Copies()
    const frames = copies.beat([{ name: 'ipax', projection: snapshot() }])
    expect(frames.map((one) => one.kind)).toEqual(['whole'])
  })

  it('is nothing for a machine never heard', () => {
    expect(new Copies().beat([{ name: 'ipax', projection: null }])).toEqual([])
  })

  it('is nothing where the window handed over the same projection', () => {
    const copies = new Copies()
    const held = snapshot()
    copies.beat([{ name: 'ipax', projection: held }])
    expect(copies.beat([{ name: 'ipax', projection: held }])).toEqual([])
  })

  it('is a change that turns what the page holds into what the machine said', () => {
    const copies = new Copies()
    const [first] = copies.beat([{ name: 'ipax', projection: snapshot() }])
    if (first?.kind !== 'whole') throw new Error('the first should be whole')
    const next = snapshot({ rev: 13, title: 'Fix the parser for good' })
    const [moved] = copies.beat([{ name: 'ipax', projection: next }])
    if (moved?.kind !== 'change') throw new Error('it should be a change')
    expect(moved.from).toBe(first.snapshot.fresh.rev)
    expect(applyDelta(first.snapshot, moved.delta).tasks).toEqual(copyOf(next).tasks)
  })

  it('keeps the page’s revision where only the moment moved, so the next change applies', () => {
    const copies = new Copies()
    const [first] = copies.beat([{ name: 'ipax', projection: snapshot() }])
    if (first?.kind !== 'whole') throw new Error('the first should be whole')
    // The same work at a later revision: nothing for the page.
    expect(copies.beat([{ name: 'ipax', projection: snapshot({ rev: 13 }) }])).toEqual([])
    const [moved] = copies.beat([{ name: 'ipax', projection: snapshot({ rev: 14, title: 'x' }) }])
    if (moved?.kind !== 'change') throw new Error('it should be a change')
    expect(moved.from).toBe(first.snapshot.fresh.rev)
  })

  it('is whole again after that machine restarted, whose revisions say nothing of the last', () => {
    const copies = new Copies()
    copies.beat([{ name: 'ipax', projection: snapshot() }])
    const again = snapshot({ epoch: '0b1e0000-0000-4000-8000-000000000000', rev: 1 })
    expect(copies.beat([{ name: 'ipax', projection: again }]).map((one) => one.kind)).toEqual([
      'whole',
    ])
  })

  it('says a machine is gone once it is no longer handed over', () => {
    const copies = new Copies()
    copies.beat([{ name: 'ipax', projection: snapshot() }])
    expect(copies.beat([])).toEqual([{ v: 1, machine: 'ipax', kind: 'gone' }])
    expect(copies.wholes()).toEqual([])
  })

  it('opens a stream with every copy whole, at what the page would hold', () => {
    const copies = new Copies()
    copies.beat([
      { name: 'ipax', projection: snapshot() },
      { name: 'box', projection: snapshot({ title: 'another' }) },
    ])
    expect(copies.wholes().map((one) => one.machine)).toEqual(['ipax', 'box'])
    expect(copies.opening().every((text) => text.startsWith('event: machine\n'))).toBe(true)
  })
})

describe('what the page holds of each, frame by frame', () => {
  /** The frames as the page parses them off the stream. */
  const wire = (frames: unknown[]) => frames.map((one) => JSON.parse(JSON.stringify(one)))

  it('ends at exactly what the machine said, whole and then changed', () => {
    const copies = new Copies()
    const store = emptyStore()
    for (const frame of wire(copies.beat([{ name: 'ipax', projection: snapshot() }]))) {
      expect(applyCopy(store, frame)).toBeNull()
    }
    const next = snapshot({ rev: 13, title: 'Fix the parser for good' })
    for (const frame of wire(copies.beat([{ name: 'ipax', projection: next }]))) {
      expect(applyCopy(store, frame)).toBeNull()
    }
    const [held] = copiesOf(store)
    expect(held?.machine).toBe('ipax')
    expect(rowsOf(held?.copy ?? emptyStore(), 'tasks')).toEqual(copyOf(next).tasks)
    expect(held?.copy.behind).toBe(false)
    // The door's own tree is not touched by another machine's.
    expect(store.had).toBe(false)
  })

  it('keeps a copy as it was, marked behind, for a change it was not made from', () => {
    const store = emptyStore()
    const copies = new Copies()
    for (const frame of wire(copies.beat([{ name: 'ipax', projection: snapshot() }]))) {
      applyCopy(store, frame)
    }
    const [moved] = wire(
      copies.beat([{ name: 'ipax', projection: snapshot({ rev: 13, title: 'y' }) }]),
    )
    expect(applyCopy(store, { ...moved, from: 3 })).toBeNull()
    const [held] = copiesOf(store)
    expect(held?.copy.behind).toBe(true)
    expect(rowsOf(held?.copy ?? emptyStore(), 'tasks')[0]?.title?.words).toBe('Fix the parser')
  })

  it('lets go of a machine that is gone, and refuses a version it does not speak', () => {
    const store = emptyStore()
    const copies = new Copies()
    for (const frame of wire(copies.beat([{ name: 'ipax', projection: snapshot() }]))) {
      applyCopy(store, frame)
    }
    for (const frame of wire(copies.beat([]))) applyCopy(store, frame)
    expect(copiesOf(store)).toEqual([])
    expect(applyCopy(store, { v: 99, machine: 'ipax', kind: 'gone' })).toMatch(/version/)
  })
})

describe('a stream that opens again', () => {
  const two = () => {
    const copies = new Copies()
    copies.beat([
      { name: 'ipax', projection: snapshot({ rev: 12 }) },
      { name: 'box', projection: snapshot({ rev: 3, title: 'another' }) },
    ])
    return copies
  }
  const at = (copies: Copies, machine: string) => {
    const [frame] = copies.resumed(null).filter((one) => one.machine === machine)
    if (frame?.kind !== 'whole') throw new Error(`no copy of ${machine}`)
    return { epoch: frame.snapshot.fresh.epoch, rev: frame.snapshot.fresh.rev }
  }

  it('is not sent a copy the page holds at the revision it was last sent', () => {
    const copies = two()
    const held = new Map([['ipax', at(copies, 'ipax')]])
    expect(copies.resumed(held).map((one) => `${one.kind} ${one.machine}`)).toEqual(['whole box'])
  })

  it('is sent whole a copy the page holds at another revision or epoch, and told of one gone', () => {
    const copies = two()
    const ipax = at(copies, 'ipax')
    const held = new Map([
      ['ipax', { ...ipax, rev: ipax.rev - 1 }],
      ['box', { ...at(copies, 'box'), epoch: '00000000-0000-4000-8000-000000000000' }],
      ['laptop', { epoch: EPOCH, rev: 1 }],
    ])
    expect(copies.resumed(held).map((one) => `${one.kind} ${one.machine}`)).toEqual([
      'whole ipax',
      'whole box',
      'gone laptop',
    ])
  })

  it('is sent every copy whole where the page holds none, or fell behind', () => {
    expect(two().resumed(new Map())).toHaveLength(2)
    expect(two().resumed(null)).toHaveLength(2)
  })

  it('reads what the page says it holds out of the address the page makes, and nothing else', () => {
    const store = emptyStore()
    const copies = two()
    for (const frame of copies.resumed(null)) applyCopy(store, frame)
    const path = streamPath(store)
    expect(path.startsWith('/api/stream?held=')).toBe(true)
    expect(copiesHeldOf(path)).toEqual(
      new Map([
        ['ipax', at(copies, 'ipax')],
        ['box', at(copies, 'box')],
      ]),
    )
    // A copy that fell behind is the one the page wants whole, so it is not claimed.
    const box = store.copies.get('box')
    if (box !== undefined) box.behind = true
    expect([...copiesHeldOf(streamPath(store)).keys()]).toEqual(['ipax'])
    expect(streamPath(emptyStore())).toBe('/api/stream')
    // A name with a colon in it is read whole.
    expect(copiesHeldOf(`/api/stream?held=${encodeURIComponent(`${EPOCH}:4:a:b`)}`)).toEqual(
      new Map([['a:b', { epoch: EPOCH, rev: 4 }]]),
    )
  })

  it('leaves out what does not read, and reads no more than thirty-two', () => {
    const bad = [`../x:1:ipax`, `${EPOCH}:-1:ipax`, `${EPOCH}:1:`, `${EPOCH}:1:${'x'.repeat(121)}`]
    const query = bad.map((one) => `held=${encodeURIComponent(one)}`).join('&')
    expect(copiesHeldOf(`/api/stream?${query}`).size).toBe(0)
    const many = Array.from({ length: 40 }, (_, n) => `held=${EPOCH}:1:m${n}`).join('&')
    expect(copiesHeldOf(`/api/stream?${many}`).size).toBe(32)
    expect(copiesHeldOf('/api/stream').size).toBe(0)
  })
})
