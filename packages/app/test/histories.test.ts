import { matchesFilter, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { readHistories } from '../src/histories.ts'

// The whole-history lists the window reads once it is up. What they are held
// to: every list is cut at the moment the tail was read, so a line appended
// while they are read is the subscription's to count and never theirs as well;
// and a list that cannot be read is an empty one and a sentence, never a
// window that does not open or one that says nothing.

const event = (seq: number, type: string, task: string | null = 'app/refunds'): TadeEvent =>
  ({
    seq,
    ts: '2026-10-11T09:00:00.000Z',
    type,
    urgency: 'routine',
    task,
    lane: null,
    run: null,
    detail: type === 'usage' ? { tokens: 1, usd: 0 } : {},
  }) as TadeEvent

type Filter = { limit?: number; types?: readonly string[] }

/**
 * A journal that answers like the workbench does, over `lines`, failing the
 * reads `fail` picks — and `then` run after each read, which is how a line is
 * appended between two of them.
 */
function journal(
  lines: TadeEvent[],
  fail: (filter: Filter) => boolean = () => false,
  then: (filter: Filter) => void = () => {},
) {
  return {
    events: async (filter: Filter = {}) => {
      if (fail(filter)) throw new Error('database disk image is malformed')
      const matched = lines.filter((one) => matchesFilter(one, filter as never))
      then(filter)
      return filter.limit ? matched.slice(-filter.limit) : matched
    },
  }
}

describe('reading the journal once the window is up', () => {
  it('cuts every list at the tail, so a line appended meanwhile is not counted here', async () => {
    const lines = [event(1, 'usage'), event(2, 'run_started'), event(3, 'task_done')]
    // Appended the moment the tail has been read, so every list after it sees them.
    const client = journal(lines, undefined, (filter) => {
      if (filter.limit !== undefined) lines.push(event(4, 'usage'), event(5, 'task_done'))
    })
    const read = await readHistories(client as never)
    expect(read.upTo).toBe(3)
    expect(read.recent.map((one) => one.seq)).toEqual([1, 2, 3])
    expect(read.usage.map((one) => one.seq)).toEqual([1])
    expect(read.told.map((one) => one.seq)).toEqual([2, 3])
    expect(read.failed).toEqual([])
  })

  it('takes the inbox’s lines out of the queue’s and finishing’s, each once and in order', async () => {
    const lines = [
      event(1, 'intake_received'),
      event(2, 'run_started'),
      event(3, 'usage'),
      event(4, 'task_done'),
      event(5, 'turn_done'),
      event(6, 'watch_found'),
      event(7, 'queue_changed'),
    ]
    const read = await readHistories(journal(lines) as never)
    // `run_started` is in both lists, and is still one line here.
    expect(read.inbox.map((one) => [one.seq, one.type])).toEqual([
      [1, 'intake_received'],
      [2, 'run_started'],
      [4, 'task_done'],
      [6, 'watch_found'],
      [7, 'queue_changed'],
    ])
  })

  it('keeps the tool calls that overruled the checks, and no other tool call', async () => {
    const call = (seq: number, tool: string): TadeEvent => ({
      ...event(seq, 'tool_call'),
      detail: { tool },
    })
    const lines = [call(1, 'status'), call(2, 'checks_override'), call(3, 'checks_run')]
    const read = await readHistories(journal(lines) as never)
    expect(read.overrides.map((one) => one.seq)).toEqual([2])
  })

  it('reads a list it cannot read as nothing, and says which', async () => {
    const client = journal(
      [event(1, 'usage'), event(2, 'task_done')],
      (filter) => filter.types?.includes('usage') === true,
    )
    const read = await readHistories(client as never)
    expect(read.usage).toEqual([])
    expect(read.told.map((one) => one.seq)).toEqual([2])
    expect(read.failed).toHaveLength(1)
    expect(read.failed[0]).toContain('what was spent')
    expect(read.failed[0]).toContain('database disk image is malformed')
  })

  it('cuts nothing when the tail itself cannot be read, and stands the newest line in for it', async () => {
    const client = journal(
      [event(1, 'usage'), event(5, 'task_done')],
      (filter) => filter.limit !== undefined,
    )
    const read = await readHistories(client as never)
    expect(read.recent).toEqual([])
    expect(read.usage.map((one) => one.seq)).toEqual([1])
    expect(read.upTo).toBe(5)
    expect(read.failed[0]).toContain('what happened lately')
  })
})
