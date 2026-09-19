import type { TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  addEnded,
  addNews,
  agentEnded,
  eventNews,
  NEWS_MAX,
  taskNews,
  unended,
  withNews,
} from '../src/inbox.ts'

const clock = (at: number) => `t${at}`

/** A journal line, as the workbench writes it. */
function event(over: Partial<TadeEvent> & { type: TadeEvent['type'] }): TadeEvent {
  return {
    seq: 1,
    ts: '2026-09-15T09:00:00Z',
    urgency: 'notable',
    task: 'app/refunds',
    lane: null,
    run: null,
    detail: {},
    ...over,
  }
}

describe('news for the orchestrator', () => {
  it('is what moved while the window watched, in words', () => {
    const before = [
      { task: 'app/refunds', state: 'working' as const },
      { task: 'app/reload', state: 'working' as const },
      { task: 'app/docs', state: 'review' as const },
    ]
    const after = [
      { task: 'app/refunds', state: 'review' as const, reason: '2 commits ahead, tests green' },
      { task: 'app/reload', state: 'failed' as const, reason: 'agent exited with code 1' },
      { task: 'app/docs', state: 'merged' as const },
      // New since the last look: not something that happened, only something seen.
      { task: 'app/fresh', state: 'review' as const },
    ]
    expect(taskNews(before, after)).toEqual([
      // Work to look at is not the same as finished: that is the task's own rule.
      'app/refunds has work to review: 2 commits ahead, tests green',
      'app/reload failed: agent exited with code 1',
      'app/docs was merged',
    ])
  })

  it('says a task finished, and who said so', () => {
    const done = (detail: Record<string, unknown>) => ({
      seq: 1,
      ts: '2026-09-15T09:00:00Z',
      type: 'task_done' as const,
      urgency: 'notable' as const,
      task: 'app/refunds',
      lane: null,
      run: null,
      detail,
    })
    expect(eventNews(done({ by: 'agent', summary: 'Refunds charge once.' }))).toBe(
      'app/refunds finished (its agent said so): Refunds charge once.',
    )
    expect(eventNews(done({ by: 'rule', rule: 'merged' }))).toBe(
      'app/refunds finished (its rule, merged, was met)',
    )
    expect(eventNews(done({ by: 'you' }))).toBe('app/refunds finished (the person marked it)')
    expect(eventNews({ ...done({}), type: 'turn_done' })).toBeNull()
  })

  it('says an agent is gone however it went', () => {
    // Stopped: the window's /stop, its cleanup, tade_run_stop, tade_run_cleanup.
    expect(agentEnded(event({ type: 'run_exited', detail: { stopped: true } }))).toEqual({
      task: 'app/refunds',
      why: 'stopped',
      knows: 1,
    })
    // Nobody stopped it: it quit, crashed, or its lane went out from under it.
    expect(agentEnded(event({ type: 'run_exited', detail: { code: 1 } }))?.why).toBe(
      'it exited on its own, code 1',
    )
    expect(agentEnded(event({ type: 'run_exited', detail: { code: 0 } }))?.why).toBe(
      'it exited on its own',
    )
    expect(agentEnded(event({ type: 'run_exited', detail: { code: null } }))?.why).toBe(
      'its lane went',
    )
    expect(agentEnded(event({ type: 'task_removed' }))?.why).toBe(
      'the task was removed, worktree and all',
    )
    // Its own lane closed, which is how an agent nobody supervised ends.
    expect(agentEnded(event({ type: 'lane_closed', lane: 'app/refunds/agent' }))?.why).toBe(
      'its lane was closed',
    )
    // A shell or a terminal closing is not an agent going anywhere.
    expect(agentEnded(event({ type: 'lane_closed', lane: 'app/refunds/shell-1' }))).toBeNull()
    // Not an ending, and not one without a task to hang it on.
    expect(agentEnded(event({ type: 'turn_done' }))).toBeNull()
    expect(agentEnded(event({ type: 'run_exited', task: null }))).toBeNull()
  })

  it('is one line per agent, whatever the journal wrote on the way', () => {
    // Removing writes three events between them, and one agent went: the one
    // that knows most is what is said, wherever it lands in the order.
    const gone = (type: 'run_exited' | 'lane_closed' | 'task_removed', detail = {}) =>
      agentEnded(event({ type, lane: 'app/refunds/agent', detail }))
    let news = addEnded([], gone('run_exited', { stopped: true })!, 1)
    news = addEnded(news, gone('lane_closed')!, 2)
    expect(news[0]?.text).toBe('app/refunds: its agent is gone (stopped)')
    news = addEnded(news, gone('task_removed')!, 3)
    expect(news).toHaveLength(1)
    expect(news[0]?.text).toBe(
      'app/refunds: its agent is gone (the task was removed, worktree and all)',
    )

    // And one that is working again is not gone: nothing is said about it.
    news = addEnded(news, { task: 'app/search', why: 'stopped', knows: 1 }, 4)
    expect(unended(news, 'app/refunds').map((one) => one.ended?.task)).toEqual(['app/search'])
  })

  it('tells the orchestrator what went and sends it to ask what is left', () => {
    const stopped = { task: 'app/refunds', why: 'stopped', knows: 1 }
    const one = withNews('where are we', addEnded([], stopped, 5), clock)
    expect(one).toContain(
      '- t5 app/refunds: its agent is gone (stopped). tade_status says what is running.',
    )

    // A batch — the cleanup button closing three — is one line with a count,
    // said where the last of them went, and every task and reason in it.
    let news = addNews([], 'app/docs finished (its agent said so)', 1)
    news = addEnded(news, stopped, 2)
    news = addEnded(
      news,
      { task: 'app/search', why: 'the task was removed, worktree and all', knows: 2 },
      3,
    )
    news = addEnded(news, { task: 'app/docs', why: 'it exited on its own, code 1', knows: 1 }, 4)
    const lines = withNews('where are we', news, clock).split('\n')
    expect(lines[1]).toBe('- t1 app/docs finished (its agent said so)')
    expect(lines[2]).toBe(
      '- t4 3 agents are gone: app/refunds (stopped), app/search (the task was removed, worktree and all), app/docs (it exited on its own, code 1). tade_status says what is running.',
    )
    expect(lines.at(-2)).toBe('What they said:')
    expect(lines.at(-1)).toBe('where are we')
  })

  it('keeps a thing said twice in a row once, and only the latest few', () => {
    let news = addNews([], 'app/reload failed', 1)
    news = addNews(news, 'app/reload failed', 2)
    expect(news).toEqual([{ at: 1, text: 'app/reload failed' }])
    for (let n = 0; n < NEWS_MAX + 5; n++) news = addNews(news, `item ${n}`, n)
    expect(news).toHaveLength(NEWS_MAX)
    expect(news.at(-1)?.text).toBe(`item ${NEWS_MAX + 4}`)
  })

  it('goes before what was said, which keeps its own heading and its own words', () => {
    expect(withNews('fix the refund test', [], clock)).toBe('fix the refund test')
    expect(withNews('Fix the refund test', [{ at: 5, text: 'app/reload failed' }], clock)).toBe(
      [
        'Since you last heard from Tade:',
        '- t5 app/reload failed',
        '',
        'What they said:',
        'Fix the refund test',
      ].join('\n'),
    )
  })
})
