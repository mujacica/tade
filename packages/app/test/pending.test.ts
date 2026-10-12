import { stripTerminalSequences } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { Target } from '../src/hits.ts'
import {
  type AppState,
  initialState,
  keyAction,
  type TaskSnapshot,
  withTasks,
} from '../src/model.ts'
import { answering, stillAnswered, unanswered } from '../src/pending.ts'
import { COLOUR, PLAIN } from '../src/skin.ts'
import { Row } from '../src/ui.ts'

// A press answered before what it asked for has answered: the control held
// down while its action runs, and an approval's card gone the moment it is
// answered — and kept gone by a look that began before the answer landed.

const TASK = 'app/refunds'

/** What a look says of the agent: waiting on `request`, or on nothing. */
const look = (request: string | null, summary = 'rm -rf dist'): TaskSnapshot[] => [
  {
    task: TASK,
    state: 'blocked',
    lane: `${TASK}/agent`,
    waiting: request !== null,
    approval: request === null ? null : { tool: 'bash', summary, id: request },
  },
]

/** The agent waiting on `run-1:req-1`, in front, with nothing typed at Tade. */
const waiting = (): AppState => ({
  ...withTasks({ ...initialState(), focused: TASK, chose: true }, look('run-1:req-1')),
  dictation: null,
})

const card = (state: AppState) => state.panes.find((one) => one.task === TASK)?.approval ?? null

describe('an approval answered from the window', () => {
  it('takes its card away at once, and the mark that says it is waiting', () => {
    const answered = answering(waiting(), TASK)
    expect(card(answered)).toBeNull()
    expect(answered.panes[0]?.waiting).toBe(false)
    expect(answered.answered).toEqual({ [TASK]: 'run-1:req-1' })
  })

  it('stays gone through a look that began before the answer landed', () => {
    const answered = answering(waiting(), TASK)
    const stale = withTasks(answered, look('run-1:req-1'))
    expect(card(stale)).toBeNull()
    expect(stale.panes[0]?.waiting).toBe(false)
  })

  it('is forgotten by the first look without it, and a later request is drawn', () => {
    const landed = withTasks(answering(waiting(), TASK), look(null))
    expect(landed.answered).toEqual({})
    // The same thing asked again is waiting on you again.
    const again = withTasks(landed, look('run-1:req-2'))
    expect(card(again)).toMatchObject({ summary: 'rm -rf dist' })
  })

  it('draws another request at once, whatever it asks', () => {
    // An agent asking the very same thing twice is waiting on you twice.
    const next = withTasks(answering(waiting(), TASK), look('run-1:req-2'))
    expect(card(next)).toMatchObject({ id: 'run-1:req-2' })
    expect(next.answered).toEqual({})
  })

  it('comes back on the next look when the answer did not land', () => {
    const failed = unanswered(answering(waiting(), TASK), TASK)
    expect(failed.answered).toEqual({})
    expect(card(withTasks(failed, look('run-1:req-1')))).toMatchObject({ id: 'run-1:req-1' })
  })

  it('changes nothing where nothing was waiting', () => {
    const state = withTasks(initialState(), look(null))
    expect(answering(state, TASK)).toBe(state)
    expect(stillAnswered(state.answered, look(null))).toBe(state.answered)
  })

  it('keeps a and d for the window until the answer lands, so a second press is told', () => {
    const answered = answering(waiting(), TASK)
    expect(keyAction('a', answered)).toEqual({ kind: 'approve' })
    expect(keyAction('d', answered)).toEqual({ kind: 'deny' })
    // Once it has, they are the agent's to type again.
    const landed = { ...withTasks(answered, look(null)), dictation: null }
    expect(keyAction('a', landed)).toEqual({ kind: 'none' })
  })
})

describe('a control whose action has not answered', () => {
  const target: Target = { kind: 'action', name: 'approve' }
  const button = (pointer: { pressed?: Target; busy?: Target }, skin = COLOUR) =>
    new Row(20, skin, { hover: null, pressed: pointer.pressed ?? null, busy: pointer.busy ?? null })
      .button('Allow once', target, 'attention')
      .build().text

  it('is drawn held down, as it was while pressed', () => {
    expect(button({ busy: target })).toBe(button({ pressed: target }))
    expect(button({ busy: target })).not.toBe(button({}))
  })

  it('is drawn the same width whatever it looks like', () => {
    expect(stripTerminalSequences(button({ busy: target }, PLAIN))).toBe(
      stripTerminalSequences(button({}, PLAIN)),
    )
  })

  it('holds down only itself', () => {
    expect(button({ busy: { kind: 'action', name: 'deny' } })).toBe(button({}))
  })
})
