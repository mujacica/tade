import type { TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { activityIn } from '../src/away-activity.ts'

// What one task has been doing, as the away view's agent page takes it out of
// the journal: a kind, a moment, and at most one name — never a detail spread
// in, because a detail carries whatever its writer put there.

const TASK = 'app/migration'

function event(over: Partial<TadeEvent> & Pick<TadeEvent, 'type'>): TadeEvent {
  return {
    seq: 1,
    ts: '2026-10-08T14:00:00.000Z',
    task: TASK,
    urgency: 'routine',
    detail: {},
    ...over,
  } as TadeEvent
}

describe('what a task has been doing', () => {
  it('reads newest first, and only this task', () => {
    const events = [
      event({ type: 'run_started', ts: '2026-10-08T14:00:00.000Z' }),
      event({ type: 'tool_call', task: 'app/other', detail: { tool: 'Bash' } }),
      event({ type: 'tool_call', ts: '2026-10-08T14:01:00.000Z', detail: { tool: 'Edit' } }),
    ]
    expect(activityIn(events, TASK, 10)).toEqual([
      { at: Date.parse('2026-10-08T14:01:00.000Z'), kind: 'used', what: 'Edit', ok: null },
      { at: Date.parse('2026-10-08T14:00:00.000Z'), kind: 'started', what: '', ok: null },
    ])
  })

  it('carries a name and never the call it came with', () => {
    const [asked] = activityIn(
      [
        event({
          type: 'permission_request',
          detail: {
            tool: 'Bash',
            summary: 'Bash: cat /Users/testperson/.ssh/id_rsa',
            input: { command: 'cat /Users/testperson/.ssh/id_rsa' },
          },
        }),
      ],
      TASK,
      10,
    )
    expect(asked).toEqual({ at: expect.any(Number), kind: 'asked', what: 'Bash', ok: null })
    expect(JSON.stringify(asked)).not.toContain('testperson')
  })

  it('reads no name at all for a kind that is not about one', () => {
    // `run_started` carries the working directory; `what` stays empty.
    const [started] = activityIn(
      [event({ type: 'run_started', detail: { cwd: '/Users/testperson/work/app' } })],
      TASK,
      10,
    )
    expect(started?.what).toBe('')
  })

  it('says how a turn and a check went', () => {
    const [check, turn] = activityIn(
      [
        event({ type: 'turn_done', detail: { status: 'error' } }),
        event({ type: 'check_ran', detail: { check: 'tests', state: 'fail' } }),
      ],
      TASK,
      10,
    )
    expect(check).toMatchObject({ kind: 'checked', what: 'tests', ok: false })
    expect(turn).toMatchObject({ kind: 'turn', ok: false })
  })

  it('leaves out what is not a moment worth telling', () => {
    expect(
      activityIn(
        [event({ type: 'usage' }), event({ type: 'warning' }), event({ type: 'said' })],
        TASK,
        10,
      ),
    ).toEqual([])
  })

  it('stops at the budget and one more, so the page can say there was more', () => {
    const events = Array.from({ length: 50 }, () => event({ type: 'turn_done' }))
    expect(activityIn(events, TASK, 5)).toHaveLength(6)
  })

  it('looks no further back than it was told to, whatever it found', () => {
    const events = [
      event({ type: 'task_created' }),
      ...Array.from({ length: 100 }, () => event({ type: 'turn_done', task: 'app/other' })),
    ]
    expect(activityIn(events, TASK, 5, 100)).toEqual([])
    expect(activityIn(events, TASK, 5, 101)).toHaveLength(1)
  })
})
