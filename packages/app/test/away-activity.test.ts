import type { TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { ACTIVITY_TYPES, activityIn } from '../src/away-activity.ts'

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
    expect(activityIn(events, TASK, 10).activity).toEqual([
      { id: '1', at: Date.parse('2026-10-08T14:01:00.000Z'), kind: 'used', what: 'Edit', ok: null },
      { id: '1', at: Date.parse('2026-10-08T14:00:00.000Z'), kind: 'started', what: '', ok: null },
    ])
  })

  it('carries a name and never the call it came with', () => {
    const {
      activity: [asked],
    } = activityIn(
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
    expect(asked).toEqual({
      id: '1',
      at: expect.any(Number),
      kind: 'asked',
      what: 'Bash',
      ok: null,
    })
    expect(JSON.stringify(asked)).not.toContain('testperson')
  })

  it('reads no name at all for a kind that is not about one', () => {
    // `run_started` carries the working directory; `what` stays empty.
    const {
      activity: [started],
    } = activityIn(
      [event({ type: 'run_started', detail: { cwd: '/Users/testperson/work/app' } })],
      TASK,
      10,
    )
    expect(started?.what).toBe('')
  })

  it('says how a turn and a check went', () => {
    const {
      activity: [check, turn],
    } = activityIn(
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
      ).activity,
    ).toEqual([])
  })

  it('stops at the budget, and says the number the moments before it are read from', () => {
    const events = Array.from({ length: 50 }, (_, n) => event({ seq: n + 1, type: 'turn_done' }))
    const read = activityIn(events, TASK, 5)
    expect(read.activity.map((one) => one.id)).toEqual(['50', '49', '48', '47', '46'])
    expect(read.earlier).toBe('46')
  })

  it('reads nothing further back than its making, which is its first moment', () => {
    const events = [
      event({ seq: 7, type: 'tool_call', task: 'app/other' }),
      event({ seq: 8, type: 'task_created' }),
      event({ seq: 9, type: 'turn_done' }),
    ]
    expect(activityIn(events, TASK, 5)).toEqual({
      activity: [expect.objectContaining({ id: '9' }), expect.objectContaining({ kind: 'made' })],
      earlier: null,
    })
  })

  it('says where what it held begins, where it ran out of lines before the budget', () => {
    const events = [10, 11, 12].map((seq) => event({ seq, type: 'turn_done' }))
    expect(activityIn(events, TASK, 5).earlier).toBe('10')
    expect(activityIn([], TASK, 5)).toEqual({ activity: [], earlier: null })
  })

  it('looks no further back than it was told to, whatever it found, and says where it stopped', () => {
    const events = [
      event({ seq: 1, type: 'task_created' }),
      ...Array.from({ length: 100 }, (_, n) =>
        event({ seq: n + 2, type: 'turn_done', task: 'app/other' }),
      ),
    ]
    expect(activityIn(events, TASK, 5, 100)).toEqual({ activity: [], earlier: '2' })
    expect(activityIn(events, TASK, 5, 101).activity).toHaveLength(1)
  })
})

describe('the kinds a moment is made of', () => {
  it('is exactly the journal types that make one', () => {
    expect(ACTIVITY_TYPES).toContain('task_created')
    expect(ACTIVITY_TYPES).toContain('tool_call')
    expect(ACTIVITY_TYPES).not.toContain('said')
    expect(ACTIVITY_TYPES).not.toContain('usage')
  })
})
