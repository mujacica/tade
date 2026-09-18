import { describe, expect, it } from 'vitest'
import { addNews, eventNews, NEWS_MAX, taskNews, withNews } from '../src/inbox.ts'

const clock = (at: number) => `t${at}`

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
