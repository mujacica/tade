import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { ON_ANOTHER_MACHINE } from '../../src/faces.ts'
import { probing, Timings } from '../../src/timing.ts'
import { FACE_FRAME } from '../../src/wire/face-screen.ts'
import { FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// What a second face costs the machine (`wire/face-screen.ts`): its frames,
// and nothing else — no look of its own, no lane read for it, no frame drawn
// on a beat that found nothing.
//
// Two things are held, the window's own way. What one frame costs, as the
// quickest one seen (`Span.best`, the figure about the code rather than about
// the machine), under a ceiling with the argument `screens.test.ts` makes for
// its own. And how often it draws, counted against the beats themselves,
// never a sleep: a starved runner takes fewer beats and draws fewer frames,
// which passes.

/**
 * Milliseconds a second face's frame may cost: the subjects' facts at its
 * size, then the drawing. Twice the budget `screens.test.ts` gives the drawing
 * alone (eight times the worst runner seen), because this is both halves — and
 * the size it is drawn at, 132 × 39, is the Duo's large screen sideways.
 */
const A_FACE_FRAME_MS = 80

describe('what a second face costs', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })

  it('draws a frame at its own size for what drawing a screen costs', async () => {
    const timings = new Timings(true)
    const stop = probing(timings)
    try {
      const app = await start()
      const second = new FakeTerminal()
      second.columns = 132
      second.rows = 39
      const attached = app.attach(second, { capabilities: ON_ANOTHER_MACHINE })
      await until('the second face to draw', () =>
        screenOf(second.written).some((row) => row.includes('refunds')),
      )
      // A few more, so the quickest is one of several rather than the first,
      // which built every subject's kept answers for the first time.
      for (let more = 0; more < 4; more++) {
        const was = timings.span(FACE_FRAME)?.count ?? 0
        attached.draw()
        await until('another frame of the second face', () => {
          return (timings.span(FACE_FRAME)?.count ?? 0) > was
        })
      }
      const best = timings.span(FACE_FRAME)?.best ?? Number.POSITIVE_INFINITY
      expect(best, `${best.toFixed(2)}ms for the second face's quickest frame`).toBeLessThan(
        A_FACE_FRAME_MS,
      )
      attached.detach()
    } finally {
      stop()
    }
  })

  it('draws nothing on beats that found nothing, and writes nothing to its terminal', async () => {
    let beats = 0
    const asked = client.pendingApprovals.bind(client)
    client.pendingApprovals = (() => {
      beats++
      return asked()
    }) as typeof client.pendingApprovals
    const timings = new Timings(true)
    const stop = probing(timings)
    try {
      terminal.resize(160, 60)
      const app = await start({ frameMs: 250, beatMs: 2_000 })
      const second = new FakeTerminal()
      second.columns = 132
      second.rows = 39
      const attached = app.attach(second, { capabilities: ON_ANOTHER_MACHINE })
      await until('the second face to draw', () => second.written.includes('refunds'))
      const settling = beats + 1
      await until('the window to settle', () => beats >= settling)
      const frames = timings.span(FACE_FRAME)?.count ?? 0
      const bytes = second.written.length
      const quiet = beats + 2
      await until('two quiet beats', () => beats >= quiet)
      const drew = (timings.span(FACE_FRAME)?.count ?? 0) - frames
      expect(
        drew,
        `${drew} frames of the second face over two beats that found nothing`,
      ).toBeLessThanOrEqual(1)
      // A frame it did draw was the same rows, so pi-tui wrote none of them.
      expect(second.written.length - bytes).toBe(0)
      attached.detach()
    } finally {
      stop()
    }
  })
})
