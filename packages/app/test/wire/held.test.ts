import { describe, expect, it } from 'vitest'
import type { Skin } from '../../src/skin.ts'
import type { Wiring } from '../../src/wire/context.ts'
import type { Fitting } from '../../src/wire/fitting.ts'
import { Held } from '../../src/wire/held.ts'

// A look reads a lane's lines and cuts a screen out of them. The wheel can move
// while that read is under way, and what the look answers is drawn over
// whatever the notch drew meanwhile — so it has to be cut where the wheel is
// when the read comes back, not where it was when the look began.

const ROWS = 10

/** A lane `depth` lines deep, `line 1` … `line <depth>`, whose reads wait for `letGo`. */
function laneOf(depth: number) {
  let letGo = () => {}
  const answered = new Promise<void>((resolve) => (letGo = resolve))
  const wire = {
    state: { paneScroll: 0, terminalScroll: 0 },
    put(state: Wiring['state']) {
      wire.state = state as typeof wire.state
    },
    live: {
      async capture(_lane: string, lines: number) {
        await answered
        const first = Math.max(1, depth - lines + 1)
        return Array.from({ length: depth - first + 1 }, (_, i) => `line ${first + i}`).join('\n')
      },
    },
  }
  const fitting = { rows: () => ROWS, laneRows: () => ROWS } as unknown as Fitting
  const held = new Held(wire as unknown as Wiring, fitting, { colour: false } as Skin)
  return { wire, held, letGo }
}

/** The screen `back` lines above the newest of a lane `depth` deep. */
function screenAt(depth: number, back: number): string {
  const last = depth - back
  return Array.from({ length: ROWS }, (_, i) => `line ${last - ROWS + 1 + i}`).join('\n')
}

describe('a look the wheel moved under', () => {
  it('is cut where the wheel is when it comes back, not where it was when it began', async () => {
    const lane = laneOf(400)
    lane.wire.state.terminalScroll = 3
    const look = lane.held.read('terminal', 't1', ROWS, {
      lines: 400,
      cursor: { back: 0, column: 0 },
    })
    // A notch lands while the read is under way.
    lane.wire.state = { ...lane.wire.state, terminalScroll: 5 }
    lane.letGo()
    expect(await look).toBe(screenAt(400, 5))
  })

  it('is cut where it was asked for when the read does not reach where the wheel went', async () => {
    const lane = laneOf(2000)
    lane.wire.state.terminalScroll = 3
    const look = lane.held.read('terminal', 't1', ROWS, {
      lines: 2000,
      cursor: { back: 0, column: 0 },
    })
    // Further than the read went: the next look reads that far.
    lane.wire.state = { ...lane.wire.state, terminalScroll: 1500 }
    lane.letGo()
    expect(await look).toBe(screenAt(2000, 3))
  })
})
