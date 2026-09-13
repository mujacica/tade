import { describe, expect, it } from 'vitest'
import { type BriefTask, composeBrief } from '../src/brief.ts'

// The hard part of a brief is leaving things out. These assert what it refuses
// to say as much as what it says.

const task = (over: Partial<BriefTask> & Pick<BriefTask, 'task' | 'state'>): BriefTask => ({
  waiting: null,
  reason: '',
  ...over,
})

describe('composeBrief', () => {
  it('greets by the local hour', () => {
    const empty: BriefTask[] = []
    expect(composeBrief(empty, { localHour: 8 }).greeting).toBe('Morning')
    expect(composeBrief(empty, { localHour: 14 }).greeting).toBe('Afternoon')
    expect(composeBrief(empty, { localHour: 21 }).greeting).toBe('Evening')
  })

  it('leads with what is stopped, and says what stopped it', () => {
    const brief = composeBrief(
      [
        task({ task: 'checkout/stripe-v15', state: 'blocked', waiting: 'bash: npm i stripe@15' }),
        task({ task: 'search/pagination', state: 'review' }),
      ],
      { localHour: 8 },
    )
    expect(brief.spoken).toBe(
      'Morning. stripe-v15 is blocked on bash: npm i stripe@15 and pagination is done and wants your eyes.',
    )
  })

  it('orders them by how much they need you', () => {
    const brief = composeBrief(
      [
        task({ task: 'a/review', state: 'review' }),
        task({ task: 'b/failed', state: 'failed', reason: 'three times on the same error' }),
        task({ task: 'c/blocked', state: 'blocked', waiting: 'a decision' }),
      ],
      { localHour: 8 },
    )
    expect(brief.clauses.map((c) => c.split(' ')[0])).toEqual(['blocked', 'failed', 'review'])
  })

  it('counts what is moving instead of listing it', () => {
    // Nine tasks progressing need no decision from you, so they are a number.
    const working = Array.from({ length: 9 }, (_, i) =>
      task({ task: `p/t${i}`, state: 'working' as const }),
    )
    const brief = composeBrief(working, { localHour: 8 })
    expect(brief.spoken).toBe('Morning. 9 still working.')
  })

  it('says plainly when there is nothing to say', () => {
    expect(composeBrief([], { localHour: 8 }).spoken).toBe('Morning. nothing running.')
  })

  it('mentions what is waiting, rather than calling it nothing', () => {
    // "Nothing running" while three tasks sit waiting to be started is true
    // and useless.
    const brief = composeBrief(
      [
        task({ task: 'a/b', state: 'queued' }),
        task({ task: 'a/c', state: 'queued' }),
        task({ task: 'a/d', state: 'parked' }),
      ],
      { localHour: 8 },
    )
    expect(brief.spoken).toBe('Morning. nothing running, 2 waiting to start and 1 parked.')
  })

  it('adds at most one proposal, and only when there is room', () => {
    const short = composeBrief([task({ task: 'a/b', state: 'working' })], {
      localHour: 8,
      proposal: 'want the integration suite before every payments PR?',
    })
    expect(short.spoken).toContain('integration suite')

    // A brief already full of decisions does not also get a suggestion.
    const busy = composeBrief(
      Array.from({ length: 5 }, (_, i) =>
        task({ task: `p/t${i}`, state: 'blocked' as const, waiting: 'a decision' }),
      ),
      { localHour: 8, proposal: 'want a rule for that?' },
    )
    expect(busy.spoken).not.toContain('want a rule')
  })

  it('reads as one sentence however many things there are', () => {
    const one = composeBrief([task({ task: 'a/b', state: 'review' })], { localHour: 8 })
    expect(one.spoken).toBe('Morning. b is done and wants your eyes.')
    const two = composeBrief(
      [task({ task: 'a/b', state: 'review' }), task({ task: 'c/d', state: 'working' })],
      { localHour: 8 },
    )
    expect(two.spoken).toContain(' and ')
  })
})
