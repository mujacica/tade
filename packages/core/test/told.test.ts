import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import type { Note } from '../src/memory.ts'
import {
  changedFrom,
  type Holding,
  heldIn,
  type KeepingLook,
  keepingDue,
  saidChanged,
  type ToldPrint,
  unheardNotes,
} from '../src/told.ts'

// What the orchestrator was told, what its conversation holds, and when Tade
// does something to that conversation — never across a turn, never while
// somebody is writing to it.

const told: ToldPrint = { tools: 't1', instructions: 'i1', notes: 'n1' }

const holding = (over: Partial<Holding> = {}): Holding => ({
  told,
  stale: [],
  known: true,
  since: 0,
  ...over,
})

const look = (over: Partial<KeepingLook> = {}): KeepingLook => ({
  busy: false,
  typing: false,
  compacts: true,
  holding: holding(),
  percent: 40,
  threshold: 80,
  ...over,
})

let seq = 0
const event = (type: TadeEvent['type'], detail: Record<string, unknown>): TadeEvent =>
  ({
    seq: ++seq,
    ts: new Date(seq * 1000).toISOString(),
    type,
    urgency: 'routine',
    task: null,
    lane: null,
    detail,
  }) as TadeEvent

describe('what changed in what it is told', () => {
  it('names each part that differs, and nothing that does not', () => {
    expect(changedFrom(told, { ...told, notes: 'n2' })).toEqual(['notes'])
    expect(changedFrom(told, { tools: 't2', instructions: 'i1', notes: 'n2' })).toEqual([
      'tools',
      'notes',
    ])
    expect(changedFrom(told, told)).toEqual([])
  })

  it('is every part when nothing was ever written down: it cannot be said to be the same', () => {
    expect(changedFrom(null, told)).toEqual(['tools', 'instructions', 'notes'])
  })

  it('reads as a person would say it', () => {
    expect(saidChanged(['tools'])).toBe('tools changed')
    expect(saidChanged(['tools', 'notes'])).toBe('tools and notes changed')
    expect(saidChanged(['tools', 'instructions', 'notes'])).toBe(
      'tools, instructions and notes changed',
    )
    expect(saidChanged(['tools', 'instructions', 'notes'], false)).toBe(
      'what it held before was never written down',
    )
  })
})

describe('what the conversation holds, out of the journal', () => {
  it('is the newest launch it took whole', () => {
    const events = [
      event('orchestrator_told', { ...told, holds: true }),
      event('orchestrator_told', { tools: 't2', instructions: 'i2', notes: 'n2', holds: true }),
    ]
    expect(heldIn(events)).toEqual({ tools: 't2', instructions: 'i2', notes: 'n2' })
  })

  it('passes over a launch a pinning harness did not take, to what it still holds', () => {
    const events = [
      event('orchestrator_told', { ...told, holds: true }),
      event('orchestrator_told', { tools: 't2', instructions: 'i2', notes: 'n2', holds: false }),
    ]
    expect(heldIn(events)).toEqual(told)
  })

  it('is what a compaction told it, whatever came before', () => {
    const events = [
      event('orchestrator_told', { tools: 't0', instructions: 'i0', notes: 'n0', holds: true }),
      event('orchestrator_told', { ...told, holds: false }),
      event('orchestrator_compacted', { ...told, why: 'told', changed: ['tools'] }),
    ]
    expect(heldIn(events)).toEqual(told)
  })

  it('is unknown, never empty, when nothing was written down', () => {
    expect(heldIn([])).toBeNull()
    expect(heldIn([event('orchestrator_told', { tools: 't1', holds: true })])).toBeNull()
  })
})

describe('the notes a running conversation has not heard', () => {
  const note = (by: string, at: number): Note => ({
    text: `${by} at ${at}`,
    scope: null,
    by,
    at: new Date(at).toISOString(),
  })

  it('leaves out only what it wrote itself since it was told', () => {
    const notes = [note('orchestrator', 1_000), note('orchestrator', 3_000), note('you', 3_000)]
    expect(unheardNotes(notes, 2_000).map((one) => one.text)).toEqual([
      'orchestrator at 1000',
      'you at 3000',
    ])
  })
})

describe('when Tade does something to the conversation', () => {
  it('does nothing in the middle of a turn', () => {
    expect(keepingDue(look({ busy: true, percent: 95 }))).toBeNull()
    expect(keepingDue(look({ busy: true, holding: holding({ stale: ['tools'] }) }))).toBeNull()
  })

  it('does nothing while somebody is writing to it', () => {
    expect(keepingDue(look({ typing: true, percent: 95 }))).toBeNull()
    expect(keepingDue(look({ typing: true, holding: holding({ stale: ['notes'] }) }))).toBeNull()
  })

  it('does nothing before it has started', () => {
    expect(keepingDue(look({ holding: null, percent: 95 }))).toBeNull()
  })

  it('compacts at the threshold, and not below it', () => {
    expect(keepingDue(look({ percent: 79 }))).toBeNull()
    expect(keepingDue(look({ percent: 80 }))).toEqual({
      act: 'compact',
      why: 'context',
      percent: 80,
    })
  })

  it('leaves it to the harness at 0, and when nobody has said how full it is', () => {
    expect(keepingDue(look({ threshold: 0, percent: 99 }))).toBeNull()
    expect(keepingDue(look({ percent: null }))).toBeNull()
  })

  it('brings what it holds up to date first, however short it is', () => {
    expect(
      keepingDue(look({ percent: 95, holding: holding({ stale: ['tools'], known: false }) })),
    ).toEqual({ act: 'compact', why: 'told', changed: ['tools'], known: false })
  })

  it('says so where its harness cannot be asked, rather than doing nothing in silence', () => {
    expect(keepingDue(look({ compacts: false, percent: 90 }))).toEqual({
      act: 'say',
      why: 'context',
    })
    expect(keepingDue(look({ compacts: false, holding: holding({ stale: ['notes'] }) }))).toEqual({
      act: 'say',
      why: 'told',
    })
  })
})
