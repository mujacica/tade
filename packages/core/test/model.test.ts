import { describe, expect, it } from 'vitest'
import { saidBy, taskOrigin } from '../src/model.ts'

describe('who asked for a task', () => {
  it('reads back what it was written as', () => {
    for (const by of ['you', 'orchestrator', 'extension:sentry', 'schedule:deps-weekly']) {
      expect(saidBy(taskOrigin(by))).toBe(by)
    }
    expect(taskOrigin('extension:sentry')).toEqual({ kind: 'extension', name: 'sentry' })
  })

  it('takes nothing, and anything it does not know, to be you', () => {
    // Tasks made before anyone kept this were all started by a person.
    expect(taskOrigin(undefined)).toEqual({ kind: 'you', name: 'you' })
    expect(taskOrigin('extension:')).toEqual({ kind: 'you', name: 'you' })
    expect(taskOrigin('someone')).toEqual({ kind: 'you', name: 'you' })
  })
})
