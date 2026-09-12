import { describe, expect, it } from 'vitest'
import type { WilcoEvent } from '../src/events.ts'
import { describeWork, summariseWork } from '../src/summary.ts'

// "What has it been up to?" is a different question from "what moved last",
// and it is answered from the journal alone.

const NOW = Date.parse('2026-09-12T14:00:00Z')

const event = (over: Partial<WilcoEvent> = {}): WilcoEvent => ({
  seq: 1,
  ts: '2026-09-12T13:00:00.000Z',
  type: 'tool_call',
  urgency: 'routine',
  task: 'checkout/refunds',
  lane: null,
  run: 'r1',
  detail: {},
  ...over,
})

const tool = (name: string, over: Partial<WilcoEvent> = {}): WilcoEvent =>
  event({ type: 'tool_call', detail: { tool: name }, ...over })

describe('summariseWork', () => {
  it('says plainly when it has never heard of it', () => {
    const summary = summariseWork([], 'checkout/refunds', NOW)
    expect(summary.empty).toBe(true)
    expect(describeWork(summary, NOW)).toBe('Nothing recorded for refunds.')
  })

  it('ignores everything happening on other tasks', () => {
    const summary = summariseWork(
      [tool('bash'), tool('edit', { task: 'search/pagination' })],
      'checkout/refunds',
      NOW,
    )
    expect(summary.tools).toBe(1)
  })

  it('counts the work and says what kind it mostly was', () => {
    const summary = summariseWork(
      [
        tool('bash'),
        tool('bash'),
        tool('bash'),
        tool('edit'),
        tool('edit'),
        tool('read'),
        event({ type: 'turn_done', detail: { status: 'ok' } }),
        event({ type: 'turn_done', detail: { status: 'ok' } }),
      ],
      'checkout/refunds',
      NOW,
    )
    expect(summary.tools).toBe(6)
    expect(summary.turns).toBe(2)
    expect(summary.used).toEqual([
      { tool: 'bash', count: 3 },
      { tool: 'edit', count: 2 },
      { tool: 'read', count: 1 },
    ])
    expect(describeWork(summary, NOW)).toContain('6 tool calls and 2 turns, mostly bash and edit')
  })

  it('reports what it is waiting on', () => {
    const summary = summariseWork(
      [
        tool('bash'),
        event({
          type: 'permission_request',
          detail: { requestId: 'q1', summary: 'bash: npm i stripe@15' },
        }),
      ],
      'checkout/refunds',
      NOW,
    )
    expect(summary.waiting).toBe('bash: npm i stripe@15')
    expect(describeWork(summary, NOW)).toContain('waiting on bash: npm i stripe@15')
  })

  it('stops saying it is waiting once you have answered', () => {
    const answered = summariseWork(
      [
        event({ type: 'permission_request', detail: { requestId: 'q1', summary: 'bash: npm i' } }),
        event({ type: 'permission_granted', detail: { requestId: 'q1' } }),
      ],
      'checkout/refunds',
      NOW,
    )
    expect(answered.waiting).toBeNull()
  })

  it('stops waiting when the agent is gone', () => {
    const summary = summariseWork(
      [
        event({ type: 'permission_request', detail: { requestId: 'q1', summary: 'bash: npm i' } }),
        event({ type: 'run_exited', detail: { code: 1 } }),
      ],
      'checkout/refunds',
      NOW,
    )
    // Nothing is holding a question open once there is nobody to answer.
    expect(summary.waiting).toBeNull()
  })

  it('surfaces what ran that would normally have asked', () => {
    const summary = summariseWork(
      [
        tool('bash', { detail: { tool: 'bash', tier: 'hard', summary: 'git push --force' } }),
        tool('bash', { detail: { tool: 'bash', tier: 'hard', summary: 'rm -rf /tmp/x' } }),
        tool('bash'),
      ],
      'checkout/refunds',
      NOW,
    )
    // Approvals are off by default, so this is the only time you hear about it.
    expect(summary.notable).toEqual(['git push --force', 'rm -rf /tmp/x'])
    expect(describeWork(summary, NOW)).toContain('It ran git push --force, and 1 more like it.')
  })

  it('says why it failed', () => {
    const summary = summariseWork(
      [tool('bash'), event({ type: 'failed', detail: { error: 'connection refused' } })],
      'checkout/refunds',
      NOW,
    )
    expect(summary.failed).toBe('connection refused')
    expect(describeWork(summary, NOW)).toContain('It failed: connection refused.')
  })

  it('takes the latest state anything recorded', () => {
    const summary = summariseWork(
      [
        event({ type: 'state_change', detail: { state: 'working' } }),
        event({ type: 'state_change', detail: { state: 'review' } }),
      ],
      'checkout/refunds',
      NOW,
    )
    expect(summary.state).toBe('review')
    expect(describeWork(summary, NOW)).toMatch(/^refunds is review/)
  })

  it('says how long ago it last moved', () => {
    const summary = summariseWork([tool('bash')], 'checkout/refunds', NOW)
    expect(describeWork(summary, NOW)).toContain('Last moved 1h ago.')
  })

  it('copes with an agent that has done nothing yet', () => {
    const summary = summariseWork(
      [event({ type: 'run_started', detail: {} })],
      'checkout/refunds',
      NOW,
    )
    expect(describeWork(summary, NOW)).toContain('nothing done yet')
  })

  it('survives an event with a time it cannot read', () => {
    const summary = summariseWork([tool('bash', { ts: 'not a date' })], 'checkout/refunds', NOW)
    // Falls back to now rather than producing "Last moved NaN ago".
    expect(describeWork(summary, NOW)).toContain('Last moved just now.')
  })
})
