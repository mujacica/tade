import { describe, expect, it } from 'vitest'
import { projector } from '../src/reading.ts'
import { input, NOW, reach } from './fixtures.ts'

describe('the projector', () => {
  it('answers from what it holds and builds nothing per question', () => {
    const one = input({ reach: reach() })
    const held = projector(one, NOW)
    expect(held.snapshot()).toBe(held.snapshot())
    expect(held.rev).toBe(12)
  })

  it('advances on a beat that changed something, and not otherwise', () => {
    const one = input({ reach: reach() })
    const held = projector(one, NOW)
    expect(held.beat(one, NOW + 2_000)).toBeNull()
    expect(held.rev).toBe(12)
    const delta = held.beat({ ...one, notes: [] }, NOW + 4_000)
    expect(delta?.rev).toBe(13)
    expect(held.rev).toBe(13)
    expect(held.snapshot().notes).toEqual([])
  })

  it('keeps its own revision whatever the caller puts on the input', () => {
    // The server owns its lifetime; a caller that forgot to carry `rev`
    // forward must not reset the stream's cursor underneath its clients.
    const one = input({ reach: reach() })
    const held = projector(one, NOW)
    held.beat({ ...one, notes: [] }, NOW + 2_000)
    held.beat({ ...one, notes: [], findings: [] }, NOW + 4_000)
    expect(held.rev).toBe(14)
  })

  it('ticks without advancing anything', () => {
    const held = projector(input({ reach: reach() }), NOW)
    const beat = held.tick(NOW + 2_000)
    expect(beat.rev).toBe(12)
    expect(beat.set).toEqual({})
    expect(held.rev).toBe(12)
  })
})
