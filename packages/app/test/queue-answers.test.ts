import { describe, expect, it } from 'vitest'
import { changedSays, nowSays } from '../src/queue.ts'

// What a change to queued work answers with: where each piece stands once the
// queue has looked again, in a sentence that says what happens next and
// whether anybody is needed for it. The window's tests reach the waiting and
// held answers through a real queue; every other state is here.

const clock = (at: number) => String(at)

describe('where queued work stands after a change', () => {
  it('says what happens next for every state there is', () => {
    expect(nowSays('app/a', null, clock)).toBe('app/a is not queued any more')
    expect(nowSays('app/a', { kind: 'waiting', on: ['app/b', 'app/c'] }, clock)).toBe(
      'app/a waits on app/b and app/c, and starts by itself once they have finished',
    )
    expect(nowSays('app/a', { kind: 'scheduled', at: 5 }, clock)).toBe('app/a starts at 5')
    expect(nowSays('app/a', { kind: 'paused', all: false }, clock)).toBe('app/a is paused')
    expect(nowSays('app/a', { kind: 'paused', all: true }, clock)).toBe(
      "app/a is paused with its project's queue",
    )
    expect(nowSays('app/a', { kind: 'paused', all: false, parked: true }, clock)).toBe(
      'app/a is parked, and starts only once it is picked up again',
    )
    expect(nowSays('app/a', { kind: 'ready' }, clock)).toBe(
      'app/a is next, and starts as soon as its project has room',
    )
  })

  it('says which holds heal by themselves and which wait for an answer', () => {
    expect(
      nowSays(
        'app/a',
        { kind: 'held', on: null, because: 'a.ts is changed and not committed', changed: ['a.ts'] },
        clock,
      ),
    ).toBe(
      'app/a is held: a.ts is changed and not committed. That heals by itself — the first look that finds those files settled starts it',
    )
    expect(nowSays('app/a', { kind: 'held', on: null, because: 'git failed' }, clock)).toBe(
      'app/a is held: git failed. It stays held until it is answered: wait tries it again, or start it anyway',
    )
  })

  it('is one sentence about one piece, and lines about several', () => {
    expect(changedSays('Done.', [], ['app/a is paused'])).toBe('Done. app/a is paused.')
    expect(changedSays('Done.', ['app/b'], [])).toBe('Done. Started app/b.')
    expect(changedSays('Done: the queue is back on.', ['app/b'], ['app/a is paused'])).toBe(
      'Done: the queue is back on. Started app/b.\n- app/a is paused',
    )
    expect(changedSays('Done.', [], ['app/a is paused', 'app/c is next'])).toBe(
      'Done.\n- app/a is paused\n- app/c is next',
    )
  })
})
