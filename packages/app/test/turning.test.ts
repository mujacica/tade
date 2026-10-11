import { describe, expect, it } from 'vitest'
import { initialState, SPIN_MS, spinner, turnedSince, turning, withTasks } from '../src/model.ts'

// What makes a look a frame: something on screen turning, and having turned
// since the frame that is there. The window asks this on every look, which is
// up to thirty a second with a lane printing in front of you — and the one
// thing it may never do is decide a frame is not news when a spinner moved.
// `test/wire/frame.probe.test.ts` holds the same rule through the real window.

describe('whether anything on screen turns', () => {
  it('is true while an agent works, in this project or another', () => {
    const state = withTasks(initialState(), [
      { task: 'app/one', state: 'working' },
      { task: 'app/two', state: 'review' },
    ])
    expect(turning(state)).toBe(true)
    // Another project's tab wears its agents' marks, the spinner among them,
    // and the right of the top row counts every project's working.
    expect(turning({ ...state, project: 'elsewhere' })).toBe(true)
    expect(turning(withTasks(initialState(), [{ task: 'app/two', state: 'review' }]))).toBe(false)
  })

  it('is true while the orchestrator thinks, or one of its tools runs', () => {
    const quiet = initialState()
    expect(turning(quiet)).toBe(false)
    expect(turning({ ...quiet, transcript: { ...quiet.transcript, thinking: 1_000 } })).toBe(true)
    expect(
      turning({
        ...quiet,
        transcript: {
          ...quiet.transcript,
          entries: [
            {
              kind: 'tool',
              id: 't1',
              tool: 'tade_status',
              detail: '',
              state: 'running',
              result: '',
              progress: null,
              at: 1_000,
            },
          ],
        },
      }),
    ).toBe(true)
  })
})

describe('whether a look is worth a frame', () => {
  const working = withTasks(initialState(), [{ task: 'app/one', state: 'working' }])

  it('is a spinner showing another frame than the one on screen', () => {
    // Drawn at the start of a spinner frame, looked at again inside it: the
    // same glyph, and drawing it again is a frame nobody can see.
    expect(turnedSince(working, 1_000, 1_000 + SPIN_MS - 1)).toBe(false)
    expect(turnedSince(working, 1_000, 1_000 + SPIN_MS)).toBe(true)
    expect(spinner(1_000)).not.toBe(spinner(1_000 + SPIN_MS))
  })

  it('caps a look that comes thirty times a second at the ten the spinner moves', () => {
    // A lane printing in front of you asks for a look every 33ms. Every one
    // of them used to be a frame while anything worked.
    let drawn = Number.NEGATIVE_INFINITY
    let frames = 0
    for (let now = 0; now < 1_000; now += 33) {
      if (!turnedSince(working, drawn, now)) continue
      frames++
      drawn = now
    }
    expect(frames).toBe(1_000 / SPIN_MS)
  })

  it('is never, while nothing turns', () => {
    const still = withTasks(initialState(), [{ task: 'app/one', state: 'review' }])
    expect(turnedSince(still, 0, 10_000)).toBe(false)
    // The first frame there ever was is behind every moment.
    expect(turnedSince(working, Number.NEGATIVE_INFINITY, 0)).toBe(true)
  })
})
