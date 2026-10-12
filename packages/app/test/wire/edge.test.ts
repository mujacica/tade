import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EDGE_MS, EdgeHold } from '../../src/wire/edge.ts'

// A selection dragged off the end of what it is in: the thing under it scrolls
// on its own clock, and a hand moving out there only says how far.

interface Held {
  area: string
  rows: number
}

function holding() {
  const steps: Held[] = []
  const edge = new EdgeHold<Held>(
    (held) => steps.push(held),
    (was, now) => was.area === now.area && Math.sign(was.rows) === Math.sign(now.rows),
  )
  return { steps, edge }
}

describe('a drag held past an edge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('steps at once, and then on its own clock until it is let go', () => {
    const { steps, edge } = holding()
    edge.hold({ area: 'pane', rows: -1 })
    expect(steps).toHaveLength(1)
    vi.advanceTimersByTime(EDGE_MS * 3)
    expect(steps).toHaveLength(4)
    edge.letGo()
    vi.advanceTimersByTime(EDGE_MS * 3)
    expect(steps).toHaveLength(4)
  })

  it('scrolls at its own rate however often the hand out there moves', () => {
    // Every cell the hand crosses past the edge is an event, and each one used
    // to start the clock again with a step of its own: thirty moves in one
    // tick of the clock were thirty steps.
    const { steps, edge } = holding()
    for (let i = 0; i < 30; i++) edge.hold({ area: 'pane', rows: 1 + (i % 3) })
    expect(steps).toHaveLength(1)
    // The next step goes as far as the pointer is now.
    vi.advanceTimersByTime(EDGE_MS)
    expect(steps).toEqual([
      { area: 'pane', rows: 1 },
      { area: 'pane', rows: 3 },
    ])
  })

  it('starts again, at once, the other way or somewhere else', () => {
    const { steps, edge } = holding()
    edge.hold({ area: 'pane', rows: 2 })
    edge.hold({ area: 'pane', rows: -2 })
    edge.hold({ area: 'terminal', rows: -2 })
    expect(steps.map((held) => `${held.area} ${held.rows}`)).toEqual([
      'pane 2',
      'pane -2',
      'terminal -2',
    ])
    // One clock, not three.
    vi.advanceTimersByTime(EDGE_MS)
    expect(steps).toHaveLength(4)
  })

  it('starts again once a step found nowhere left to go and let go', () => {
    const steps: number[] = []
    const edge: EdgeHold<number> = new EdgeHold<number>(
      (rows) => {
        steps.push(rows)
        edge.letGo()
      },
      () => true,
    )
    edge.hold(1)
    vi.advanceTimersByTime(EDGE_MS * 2)
    expect(steps).toEqual([1])
    // The next move out there looks again rather than waiting on a clock that stopped.
    edge.hold(1)
    expect(steps).toEqual([1, 1])
  })
})
