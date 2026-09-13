import { describe, expect, it } from 'vitest'
import type { WilcoEvent } from '../src/events.ts'
import { needsReflection, reflectionPrompt } from '../src/reflect.ts'

// Looking back at a task that finished.
//
// The hard part is not noticing that something finished; it is not asking
// about it again tomorrow, and every day after that.

const event = (over: Partial<WilcoEvent>): WilcoEvent => ({
  seq: 1,
  ts: '2026-09-13T12:00:00Z',
  type: 'reflected',
  urgency: 'trace',
  task: null,
  lane: null,
  run: null,
  detail: {},
  ...over,
})

describe('which tasks are worth looking back at', () => {
  it('picks the ones that are actually done', () => {
    const tasks = [
      { task: 'app/refunds', state: 'merged' as const },
      { task: 'app/search', state: 'working' as const },
      // `review` wants your eyes; it is not finished until it lands.
      { task: 'app/pagination', state: 'review' as const },
    ]
    expect(needsReflection(tasks, [])).toEqual(['app/refunds'])
  })

  it('never asks twice about the same task', () => {
    const tasks = [{ task: 'app/refunds', state: 'merged' as const }]
    const journal = [event({ task: 'app/refunds' })]
    // Otherwise a finished task would be reflected on every two seconds for as
    // long as it stays in the list, which is forever.
    expect(needsReflection(tasks, journal)).toEqual([])
  })

  it('remembers across a restart, because the journal does', () => {
    const tasks = [{ task: 'app/refunds', state: 'merged' as const }]
    const journal = [event({ task: 'app/refunds', seq: 1 })]
    expect(needsReflection(tasks, journal)).toEqual([])
    // Nothing is held in memory: a window opened tomorrow reads the same file
    // and reaches the same answer.
    expect(needsReflection(tasks, [...journal])).toEqual([])
  })

  it('ignores a reflection recorded against something else', () => {
    const tasks = [{ task: 'app/refunds', state: 'merged' as const }]
    expect(needsReflection(tasks, [event({ task: 'app/search' })])).toEqual(['app/refunds'])
  })
})

describe('what it is asked', () => {
  it('scopes the lesson to the project, so it can go quiet later', () => {
    const prompt = reflectionPrompt('checkout/refunds')
    expect(prompt).toContain('checkout/refunds has finished')
    expect(prompt).toContain('scope it to checkout')
  })

  it('makes saying nothing the easy answer', () => {
    // Asked "what did you learn", a model always finds something. The prompt
    // has to work against that, because an unnecessary lesson costs context in
    // every prompt after it.
    const prompt = reflectionPrompt('checkout/refunds')
    expect(prompt).toContain('Most finished tasks teach nothing')
    expect(prompt).toContain('would have changed what you did')
  })
})
