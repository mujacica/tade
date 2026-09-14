import { describe, expect, it } from 'vitest'
import { finishedFrom, ruleMet, workedFrom } from '../src/done.ts'
import type { EventType, WilcoEvent } from '../src/events.ts'
import { IDLE_REASON } from '../src/state.ts'

let seq = 0
function event(type: EventType, task: string, detail: Record<string, unknown> = {}): WilcoEvent {
  seq++
  return {
    seq,
    ts: `2026-09-15T09:00:${String(seq).padStart(2, '0')}Z`,
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: null,
    detail,
  }
}

describe('when a task is finished', () => {
  it('is what the journal last said, and who said it', () => {
    const finished = finishedFrom([
      event('task_done', 'app/refunds', { by: 'agent', summary: 'Charges once.' }),
      event('turn_done', 'app/search'),
      event('task_done', 'app/refunds', { by: 'you' }),
    ])
    expect([...finished.keys()]).toEqual(['app/refunds'])
    expect(finished.get('app/refunds')).toMatchObject({ by: 'you', summary: '' })
  })

  it('counts an agent as having worked only once it ends a turn after it started', () => {
    expect(
      workedFrom([
        event('run_started', 'app/refunds'),
        event('turn_done', 'app/refunds'),
        event('turn_done', 'app/search'),
        // Started again: nothing done in this run yet.
        event('run_started', 'app/search'),
      ]),
    ).toEqual(new Set(['app/refunds']))
  })

  it('meets its own rule only on evidence of that rule', () => {
    const idle = {
      state: 'blocked' as const,
      reason: IDLE_REASON,
      workspace: 'checkout' as const,
      worked: true,
    }
    expect(ruleMet('idle', idle)).toBe(true)
    // Opened and waiting, having done nothing: not a job finished.
    expect(ruleMet('idle', { ...idle, worked: false })).toBe(false)
    // Stopped for an approval is a question, not a turn that ended.
    expect(ruleMet('idle', { ...idle, reason: 'wants approval: bash' })).toBe(false)

    const review = { ...idle, state: 'review' as const, workspace: 'worktree' as const }
    expect(ruleMet('committed', review)).toBe(true)
    expect(ruleMet('committed', { ...review, workspace: 'checkout' })).toBe(false)
    expect(ruleMet('merged', review)).toBe(false)
    expect(ruleMet('merged', { ...review, state: 'merged' })).toBe(true)
    // Nothing Wilco sees can say these: they are said.
    expect(ruleMet('said', review)).toBe(false)
    expect(ruleMet('manual', { ...review, state: 'merged' })).toBe(false)
  })
})
