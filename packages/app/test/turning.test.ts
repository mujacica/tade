import type { InboxRow, InboxWork } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { ActionsView, CheckView } from '../src/frame.ts'
import { initialState, SPIN_MS, spinner, withTasks } from '../src/model.ts'
import { turnedSince, turning, untilTurns } from '../src/turning.ts'

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

  // Two that are not the state's, and turned only when something else drew:
  // the ACTIONS page and the side's INTAKE section each draw a spinner of
  // their own, out of what the frame was handed.
  it('is true while a check runs on the ACTIONS page, or a run is going', () => {
    const quiet = initialState()
    expect(turning(quiet, { actions: page() })).toBe(false)
    expect(turning(quiet, { actions: null })).toBe(false)
    expect(turning(quiet, { actions: page({ checks: [check('running')] }) })).toBe(true)
    // Pressed, before the run has written anything down: `Running…` and its
    // tenths of a second, with every check still saying what it said before.
    const asked = { since: 1_000, by: 'you', done: 0, total: 1 }
    expect(turning(quiet, { actions: page({ running: asked }) })).toBe(true)
  })

  it('is true while a request down INTAKE in the project in front has work going', () => {
    const here = { ...initialState(), project: 'shop' }
    const going = request('started', [work({ started: true })])
    expect(turning(here, { intake: [going] })).toBe(true)
    // Finished, it wears the finished mark; proposed, it waits on a person.
    expect(turning(here, { intake: [request('started', [work({ finished: true })])] })).toBe(false)
    expect(turning(here, { intake: [request('proposed', [work({})])] })).toBe(false)
    // The side draws only the project in front's, and a folded heading none.
    expect(turning({ ...here, project: 'elsewhere' }, { intake: [going] })).toBe(false)
    expect(turning({ ...here, folded: ['intake'] }, { intake: [going] })).toBe(false)
  })
})

describe('when the spinner next turns', () => {
  it('is the next boundary, never the moment itself', () => {
    expect(untilTurns(1_000)).toBe(SPIN_MS)
    expect(untilTurns(1_001)).toBe(SPIN_MS - 1)
    expect(untilTurns(1_099)).toBe(1)
    for (const now of [0, 1, 37, 99, 100, 12_345, 1_760_000_000_042]) {
      const at = now + untilTurns(now)
      expect(at % SPIN_MS).toBe(0)
      // One glyph on, and only one: the frame drawn then is the next one.
      expect(Math.floor(at / SPIN_MS)).toBe(Math.floor(now / SPIN_MS) + 1)
      expect(spinner(at)).not.toBe(spinner(now))
    }
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

function check(state: string): CheckView {
  return {
    id: 'tests',
    title: null,
    run: null,
    state,
    required: true,
    skip: null,
    chosen: null,
    needs: [],
    summary: null,
    seconds: null,
    startedAt: null,
    at: null,
    commit: 'a1b2c3d',
    carried: false,
    counts: [],
    places: [],
    more: 0,
    tail: [],
  }
}

function page(over: Partial<ActionsView> = {}): ActionsView {
  return {
    task: 'shop/refunds',
    branch: 'tade/refunds',
    base: 'main',
    ahead: 1,
    behind: 0,
    dirty: 0,
    shared: false,
    commit: 'a1b2c3d',
    mine: [],
    others: [],
    review: null,
    checks: [check('passed'), check('failed')],
    rollup: 'fail',
    source: 'the commit hook',
    unread: [],
    running: null,
    notes: [],
    ...over,
  }
}

function work(over: Partial<InboxWork>): InboxWork {
  return {
    task: 'shop/req-7',
    parked: false,
    started: false,
    finished: false,
    held: null,
    state: null,
    ...over,
  }
}

function request(state: InboxRow['state'], work: InboxWork[]): InboxRow {
  return {
    item: 'cli:req-7',
    source: 'cli',
    externalId: 'req-7',
    requester: 'kim',
    project: 'shop',
    grant: 'surfaces.intake.sources.cli',
    said: [],
    unsent: [],
    template: null,
    revision: '1',
    taken: '1',
    hash: 'sha256:9f2c',
    ref: 'req-7.0001.json',
    url: '',
    watch: 'intake.cli',
    schedule: 'intake-cli',
    mode: 'propose',
    tasks: work.map((one) => one.task),
    work,
    state,
    because: '',
    attempts: 0,
    tries: 3,
    replies: 0,
    at: 1_000,
  }
}
