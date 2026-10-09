import {
  describeQueueState,
  joined as joinedHere,
  type QueueState,
  saidBy,
  TaskState,
} from '@tade/core'
import { describe, expect, it } from 'vitest'
import { shortClockOf } from '../src/assets/figures.js'
import {
  CHECK_STATES,
  checkMark,
  FRESH_MARKS,
  findingMark,
  freshMark,
  joined,
  originSaid,
  queueMark,
  queueSaid,
  REVIEW_STATES,
  reviewMark,
  TASK_STATES,
  taskMark,
} from '../src/assets/glyphs.js'

// What a state looks like, and the three properties that make the page readable
// to somebody who is not looking at the colour.
//
// 1. **Every state has a word.** A glyph with no word is colour-coding with
//    extra steps, and the word is what an `sr-only` span and a chip both use.
// 2. **The pairs that would collide differ in shape.** *Wants you* against
//    *working*, and *failed* against *finished*, are the two that matter —
//    violet/amber and red/green are exactly the pairs somebody may not be able
//    to tell apart.
// 3. **The queue's words are the domain's.** `queueSaid` is a copy of
//    `describeQueueState`, and the same table runs through both here.

describe('a task’s state', () => {
  it('has a drawing for every state the domain has', () => {
    for (const state of TaskState.options) {
      expect(Object.keys(TASK_STATES), state).toContain(state)
      expect(taskMark(state).word, state).not.toBe('')
    }
    // And no drawing for a state that does not exist, which is how a renamed
    // state fails here rather than silently drawing a question mark for ever.
    expect(Object.keys(TASK_STATES).sort()).toEqual([...TaskState.options].sort())
  })

  it('names a state nothing here knows rather than drawing nothing', () => {
    expect(taskMark('invented').word).toBe('invented')
    expect(taskMark('').word).toBe('unknown')
  })

  it('tells the colliding pairs apart by shape as well as by hue', () => {
    // 1.4.1, and also what the window already does: a colour is not an answer.
    expect(taskMark('blocked').glyph).not.toBe(taskMark('working').glyph)
    expect(taskMark('failed').glyph).not.toBe(taskMark('review').glyph)
    expect(taskMark('blocked').word).not.toBe(taskMark('working').word)
    expect(taskMark('failed').word).not.toBe(taskMark('review').word)
  })

  it('gives every state a tone, and nothing a tone it does not have', () => {
    const tones = new Set(Object.values(TASK_STATES).map((mark) => mark.tone))
    for (const tone of tones) expect(tone).toMatch(/^t-/)
  })
})

describe('a check rollup', () => {
  it('never draws unknown as a pass', () => {
    // A check nobody ran here is not a check that passed, and a rollup is what
    // a run *here* adds up to.
    expect(checkMark('unknown').word).toBe('not run here')
    expect(checkMark('unknown').glyph).toBe('—')
    expect(checkMark('unknown').tone).not.toBe(checkMark('pass').tone)
  })

  it('answers unknown for a word nothing here knows', () => {
    expect(checkMark('weird')).toEqual(CHECK_STATES.unknown)
  })

  it('tells green from red by glyph as well as by hue', () => {
    expect(checkMark('pass').glyph).not.toBe(checkMark('fail').glyph)
  })
})

describe('a review', () => {
  it('has a drawing for each of the forge’s four states', () => {
    expect(Object.keys(REVIEW_STATES).sort()).toEqual(['closed', 'draft', 'merged', 'open'])
    for (const state of Object.keys(REVIEW_STATES)) expect(reviewMark(state).word).toBe(state)
  })
})

describe('a judge’s finding', () => {
  const finding = (over: Record<string, unknown> = {}) => ({
    accounted: false,
    verdict: null,
    ...over,
  })

  it('is two different waits before anybody has read it, and says which', () => {
    // An unanswered finding waits on the agent; an answered one waits on a
    // person. Only the second is *wants you*, and drawing them the same way
    // would put every finding in somebody's morning.
    expect(findingMark(finding()).word).toBe('not answered yet')
    expect(findingMark(finding({ accounted: true })).word).toBe('wants reading')
    expect(findingMark(finding({ accounted: true })).tone).toBe('t-wants')
    expect(findingMark(finding()).tone).not.toBe('t-wants')
  })

  it('is the verdict once somebody has written one, whatever the account said', () => {
    expect(findingMark(finding({ accounted: true, verdict: { was: 'confirmed' } })).word).toBe(
      'confirmed',
    )
    expect(
      findingMark(finding({ accounted: false, verdict: { was: 'false positive' } })).word,
    ).toBe('false positive')
  })
})

describe('where queued work stands', () => {
  const table: { said: string; state: QueueState }[] = [
    { said: 'ready', state: { kind: 'ready' } },
    { said: 'waiting on one', state: { kind: 'waiting', on: ['a'] } },
    { said: 'waiting on three', state: { kind: 'waiting', on: ['a', 'b', 'c'] } },
    {
      said: 'held',
      state: { kind: 'held', on: 'a', because: 'upstream failed', changed: ['b'], by: ['b'] },
    },
    { said: 'paused', state: { kind: 'paused', all: false, parked: false } },
    { said: 'paused with the queue', state: { kind: 'paused', all: true, parked: false } },
    { said: 'parked', state: { kind: 'paused', all: false, parked: true } },
  ]

  for (const row of table) {
    it(`says the same words in both copies: ${row.said}`, () => {
      // The wire carries a moment as a string and the domain as a number, so
      // the clock is the one argument that differs; everything else must agree
      // exactly, because one wording of a state is the whole point.
      const here = describeQueueState(row.state, () => 'CLOCK')
      expect(queueSaid(wire(row.state), () => 'CLOCK')).toBe(here)
    })
  }

  it('says the same words for a scheduled start, through each copy’s own clock', () => {
    const at = Date.parse('2026-10-08T14:30:00.000Z')
    const here = describeQueueState({ kind: 'scheduled', at }, (ms) =>
      shortClockOf(new Date(ms).toISOString()),
    )
    expect(queueSaid({ kind: 'scheduled', at: new Date(at).toISOString() }, shortClockOf)).toBe(
      here,
    )
  })

  it('joins a list the way the domain joins one', () => {
    for (const items of [[], ['a'], ['a', 'b'], ['a', 'b', 'c']]) {
      expect(joined(items), items.join('|')).toBe(joinedHere(items))
    }
  })

  it('marks held work and nothing else as wrong', () => {
    expect(queueMark({ kind: 'held', because: 'x' }).tone).toBe('t-failed')
    expect(queueMark({ kind: 'ready' }).tone).toBe('t-working')
    // Parked work keeps a quiet drawing: it is a hold somebody chose, not a
    // failure, and it stays in the queue so they can pick it back up.
    expect(queueMark({ kind: 'paused', all: false, parked: true }).word).toBe('parked')
  })
})

/** The same state as it crosses the wire: a moment becomes a string. */
function wire(state: QueueState): Record<string, unknown> {
  if (state.kind === 'scheduled') return { ...state, at: new Date(state.at).toISOString() }
  return { ...state }
}

describe('whose a task is', () => {
  it('says what the domain says, for each origin it knows', () => {
    // `saidBy` is the domain's sentence about the same fact. The wordings are
    // not identical — this is a page and that is a prompt — so what is held is
    // that neither invents an origin the other does not have.
    for (const kind of ['you', 'orchestrator', 'extension', 'schedule'] as const) {
      expect(originSaid({ kind, name: 'dependencies' })).not.toBe('')
      expect(saidBy({ kind, name: 'dependencies' })).not.toBe('')
    }
    expect(originSaid({ kind: 'you', name: '' })).toBe('you')
  })

  it('falls back to a name for an origin with none', () => {
    expect(originSaid({ kind: 'extension', name: '' })).toBe('an extension')
    expect(originSaid({ kind: 'schedule', name: '' })).toBe('a schedule')
  })
})

describe('how the page stands to the machine', () => {
  it('has a drawing for each of the five standings, each with a word', () => {
    expect(Object.keys(FRESH_MARKS).sort()).toEqual([
      'closed',
      'live',
      'reconnecting',
      'stale',
      'unreachable',
    ])
    for (const kind of Object.keys(FRESH_MARKS)) expect(freshMark(kind).word).not.toBe('')
  })

  it('never says a standing is nothing running', () => {
    for (const mark of Object.values(FRESH_MARKS)) {
      for (const word of ['nothing', 'stopped', 'idle', 'empty']) {
        expect(mark.word.toLowerCase(), mark.word).not.toContain(word)
      }
    }
  })

  it('answers unreachable for a standing nothing here knows', () => {
    // The safe default: a page that cannot name its own state must not claim
    // to be live.
    expect(freshMark('invented')).toEqual(FRESH_MARKS.unreachable)
  })
})
