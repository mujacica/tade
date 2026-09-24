import { EventType, isSample, sampledThatFit, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'

// What a journal line has to be before Tade is willing to drop it, and how
// many of them there is room for.
//
// Both are pure, and the cost of getting the first one wrong is silent and
// permanent — a `commit_seen` is gone and `git log` cannot answer again — so
// it is tested as a rule: an event in, a yes or no out.

const event = (over: Partial<TadeEvent> = {}): TadeEvent => ({
  seq: 1,
  ts: '2026-09-24T12:00:00.000Z',
  type: 'output',
  urgency: 'trace',
  task: null,
  lane: 'app/refunds/agent',
  run: null,
  detail: { bytes: 4_096 },
  ...over,
})

describe('what may be dropped', () => {
  it('is a byte count about bytes that are still in the scrollback, and nothing else', () => {
    expect(isSample(event())).toBe(true)
    expect(isSample(event({ type: 'input' }))).toBe(true)
    for (const type of EventType.options) {
      if (type === 'output' || type === 'input') continue
      expect(isSample(event({ type })), type).toBe(false)
    }
  })

  it('reads urgency as a thing about subscribers, never as a thing about the file', () => {
    // `trace` says what is dropped first when a subscriber falls behind, which
    // is a different question. `reflected` is `trace` and is the only record
    // that a finished task was looked back over — dropped, Tade would look
    // again and spend a turn per task doing it.
    expect(isSample(event({ type: 'reflected', urgency: 'trace' }))).toBe(false)
    // And the other way: a byte count somebody marked notable is still a byte
    // count about bytes that live in the lane's scrollback.
    expect(isSample(event({ urgency: 'notable' }))).toBe(true)
  })

  it('reads a name from before the rename as what it means now', () => {
    expect(isSample(event({ type: 'wilco_opened' as never }))).toBe(false)
  })
})

describe('how many samples there is room for', () => {
  const ten = Array.from({ length: 10 }, () => 10)

  it('is what the ceiling has left once the record is taken off it', () => {
    expect(sampledThatFit(0, ten, 100)).toBe(10)
    expect(sampledThatFit(50, ten, 100)).toBe(5)
    expect(sampledThatFit(95, ten, 100)).toBe(0)
  })

  it('keeps the newest, because the newest is the only one anybody looks at', () => {
    // Sizes tell them apart: room for 30 bytes takes the last three.
    expect(sampledThatFit(0, [100, 100, 10, 10, 10], 30)).toBe(3)
  })

  it('answers nothing fits rather than a negative number, when the record alone is over', () => {
    expect(sampledThatFit(500, ten, 100)).toBe(0)
    expect(sampledThatFit(500, [], 100)).toBe(0)
  })

  it('never claims room for more than there are', () => {
    expect(sampledThatFit(0, ten, 1_000_000)).toBe(10)
    expect(sampledThatFit(0, [], 1_000_000)).toBe(0)
  })
})
