import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { probing, Timings } from '../../src/timing.ts'
import { FAR_FRAME, SOON_MS } from '../../src/wire/far-faces.ts'
import { type FakeTerminal, screenOf, until, windowUnderTest } from './harness.ts'

// What a phone that draws its own copy of the window costs the machine
// (`wire/far-faces.ts`, §10 T3 of the Duo plan): a fold of its face, made on a
// draw the heart asks for or on the beat, and never a frame drawn.
//
// Held the window's own way, as `faces.probe.test.ts` holds a second face.
// What one fold costs, as the quickest seen (`Span.best`, the figure about the
// code rather than about the machine), under a ceiling. And how often one is
// made, counted against what asked for it — the beats themselves, and the
// clock only as a rate with a ceiling — never a sleep: a starved runner takes
// fewer beats and makes fewer folds, which passes.
//
// The phone is driven through the window's own half of the away door
// (`App.windowDoor`), which is what the listener is handed; with no listener
// open, what a fold sends goes to no stream, and what it costs is the same.

/**
 * Milliseconds a phone's fold may cost: the subjects' facts at its size, the
 * lane it watches, and what moved since what it holds — no drawing, which the
 * phone does. Half what `screens.test.ts` gives the drawing alone, which this
 * leaves out, and about forty times the quickest fold seen on a laptop at a
 * load of 48 (0.55 ms), at 132 × 39, the Duo's large screen sideways.
 */
const A_FAR_FOLD_MS = 20

/** A phone's size, sideways on the large screen. */
const PHONE = { columns: 132, rows: 39 }

describe('what a phone drawing its own window costs', () => {
  let terminal: FakeTerminal
  let client: Workbench
  const { start } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
  })

  /** Count the window's looks at status, which is its beat. */
  function counting(): { beats(): number } {
    let beats = 0
    const asked = client.pendingApprovals.bind(client)
    client.pendingApprovals = (() => {
      beats++
      return asked()
    }) as typeof client.pendingApprovals
    return { beats: () => beats }
  }

  it('folds a phone’s face for what a second face’s frame costs', async () => {
    const timings = new Timings(true)
    const stop = probing(timings)
    try {
      const app = await start()
      await until('the window to draw', () =>
        screenOf(terminal.written).some((row) => row.includes('refunds')),
      )
      const door = app.windowDoor()
      let { rev } = door.look('phone', { ...PHONE, rev: null })
      await until('the phone’s first fold', () => (timings.span(FAR_FRAME)?.count ?? 0) > 0)
      // A few more, so the quickest is one of several rather than the first,
      // which built every subject's kept answers for the first time.
      for (let more = 0; more < 4; more++) {
        const was = timings.span(FAR_FRAME)?.count ?? 0
        rev = door.look('phone', { ...PHONE, rev }).rev
        await until('another fold for the phone', () => (timings.span(FAR_FRAME)?.count ?? 0) > was)
      }
      const best = timings.span(FAR_FRAME)?.best ?? Number.POSITIVE_INFINITY
      expect(best, `${best.toFixed(2)}ms for the phone’s quickest fold`).toBeLessThan(A_FAR_FOLD_MS)
      door.leave('phone')
    } finally {
      stop()
    }
  })

  it('makes one fold for a burst of asks, and at most one a gap after', async () => {
    const timings = new Timings(true)
    const stop = probing(timings)
    const { beats } = counting()
    try {
      const app = await start({ frameMs: 250, beatMs: 2_000 })
      const door = app.windowDoor()
      let { rev } = door.look('phone', { ...PHONE, rev: null })
      await until('the phone’s first fold', () => (timings.span(FAR_FRAME)?.count ?? 0) > 0)
      const folds = timings.span(FAR_FRAME)?.count ?? 0
      const from = performance.now()
      const beatsFrom = beats()
      // Twenty asks at once, as a burst of draws on the machine would be:
      // every look asks for a frame for the phones.
      for (let ask = 0; ask < 20; ask++) rev = door.look('phone', { ...PHONE, rev }).rev
      // The first fold was just made, so the gap holds the burst back to one
      // fold once it is up: waited on by the count, and what was made bounded
      // by the time that passed, a fold a gap and the beat's own.
      await until('the fold the gap held back', () => (timings.span(FAR_FRAME)?.count ?? 0) > folds)
      const made = (timings.span(FAR_FRAME)?.count ?? 0) - folds
      const took = performance.now() - from
      const allowed = Math.floor(took / SOON_MS) + 2 + (beats() - beatsFrom)
      expect(
        made,
        `${made} folds for twenty asks over ${took.toFixed(0)}ms (${allowed} allowed)`,
      ).toBeLessThanOrEqual(allowed)
      expect(made, 'twenty asks are never twenty folds').toBeLessThan(20)
      door.leave('phone')
    } finally {
      stop()
    }
  })

  it('folds at most once a beat while nothing moves, and nothing once the phone leaves', async () => {
    const timings = new Timings(true)
    const stop = probing(timings)
    const { beats } = counting()
    try {
      terminal.resize(160, 60)
      const app = await start({ frameMs: 250, beatMs: 2_000 })
      const door = app.windowDoor()
      door.look('phone', { ...PHONE, rev: null })
      await until('the phone’s first fold', () => (timings.span(FAR_FRAME)?.count ?? 0) > 0)
      const settling = beats() + 1
      await until('the window to settle', () => beats() >= settling)
      const folds = timings.span(FAR_FRAME)?.count ?? 0
      const quiet = beats() + 2
      await until('two quiet beats', () => beats() >= quiet)
      // The beat keeps the phone's look and the lane it watches read, so it
      // asks for one; a fold on every one of the window's eight frames a beat
      // would be the phones on a timer of their own.
      const made = (timings.span(FAR_FRAME)?.count ?? 0) - folds
      expect(made, `${made} folds over two beats that found nothing`).toBeLessThanOrEqual(3)
      door.leave('phone')
      const gone = timings.span(FAR_FRAME)?.count ?? 0
      const after = beats() + 2
      await until('two beats with no phone', () => beats() >= after)
      expect((timings.span(FAR_FRAME)?.count ?? 0) - gone, 'folds with no phone looking').toBe(0)
    } finally {
      stop()
    }
  })
})
