import { attentionFor, DEFAULT_ATTENTION } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  type Change,
  changesBetween,
  changesFor,
  HAPPENINGS,
  keyOf,
  NOTICE_TAG,
  NOTICE_TITLE,
  type Noticing,
  noticeFor,
  type TaskNow,
  wasOf,
} from '../src/noticed.ts'
import type { Reach } from '../src/reach.ts'

// What is worth waking a phone for, and — the half that matters more — what a
// notification is allowed to say.
//
// The payload test is the one this file exists for. `PUSH_SAYS_NOTHING` is a
// sentence in the domain, and a sentence is not a guarantee: what is asserted
// here is that nothing of the work reaches the bytes unless both halves of the
// details decision are true, over a task whose every string is something a
// payload must never carry.

const SETTINGS = DEFAULT_ATTENTION.push

function task(over: Partial<TaskNow> = {}): TaskNow {
  return {
    id: 'checkout/stripe-v15',
    project: 'checkout',
    state: 'working',
    waiting: false,
    finished: false,
    queue: '',
    title: 'Move to Stripe v15',
    ...over,
  }
}

/** The world as the last beat saw it: every task, as it was then. */
function before(...tasks: TaskNow[]) {
  return new Map(tasks.map((one) => [one.id, wasOf(one)]))
}

function noticing(over: Partial<Noticing> = {}): Noticing {
  return {
    now: 1_000_000,
    settings: SETTINGS,
    sentInLastHour: 0,
    lastInputAt: null,
    // 14:00, which is outside every default quiet hours.
    localHour: 14,
    details: false,
    already: new Set(),
    ...over,
  }
}

describe('what changed between two beats', () => {
  it('finds each of the five transitions, and names it', () => {
    const cases: [Partial<TaskNow>, Partial<TaskNow>, string][] = [
      [{}, { waiting: true, state: 'blocked' }, 'wants'],
      [{}, { state: 'blocked' }, 'stuck'],
      [{ queue: 'waiting' }, { queue: 'held' }, 'held'],
      [{}, { state: 'failed' }, 'red'],
      [{}, { finished: true }, 'done'],
      [{}, { state: 'merged' }, 'done'],
    ]
    for (const [was, now, what] of cases) {
      const changes = changesBetween(before(task(was)), [task(now)])
      expect(
        changes.map((one) => one.what),
        what,
      ).toEqual([what])
    }
  })

  it('says nothing about a state that has not changed', () => {
    // A task blocked for an hour is not news, and a loop over what is blocked
    // *now* would send that hour's worth every beat.
    const blocked = task({ state: 'blocked' })
    expect(changesBetween(before(blocked), [blocked])).toEqual([])
    const waiting = task({ state: 'blocked', waiting: true })
    expect(changesBetween(before(waiting), [waiting])).toEqual([])
  })

  it('says nothing about a task the last beat had never seen', () => {
    // The whole of *nothing is caught up*: a window that has just opened would
    // otherwise notify about everything that was already true, which is the
    // one shape that gets a feature turned off in its first minute.
    expect(changesBetween(new Map(), [task({ state: 'blocked', waiting: true })])).toEqual([])
  })

  it('answers one transition per task, and the one somebody wants first', () => {
    // Blocked *and* an approval waiting is one notification and it is the
    // approval: it is the only one of the five where work is standing still
    // until a person answers.
    const changes = changesBetween(before(task()), [
      task({ state: 'blocked', waiting: true, finished: true }),
    ])
    expect(changes.map((one) => one.what)).toEqual(['wants'])
  })

  it('never says done twice, in either order', () => {
    // Both directions, because *finished* and *merged* are two things that
    // each mean the work is done and a rule written as two conditions is two
    // buzzes about one piece of work.
    const marked = task({ finished: true })
    const landed = task({ state: 'merged' })
    expect(changesBetween(before(task()), [marked]).map((one) => one.what)).toEqual(['done'])
    expect(changesBetween(before(marked), [task({ finished: true, state: 'merged' })])).toEqual([])
    expect(changesBetween(before(task()), [landed]).map((one) => one.what)).toEqual(['done'])
    expect(changesBetween(before(landed), [task({ finished: true, state: 'merged' })])).toEqual([])
  })

  it('says nothing about a task that has gone', () => {
    // A row the projection dropped — revoked reach, a closed project — is not
    // a transition: there is nothing to say and nobody to say it about.
    expect(changesBetween(before(task()), [])).toEqual([])
  })
})

describe('what a notification is allowed to say', () => {
  /** A task whose every string is something a payload must never carry. */
  const secret = task({
    id: 'acme-private/rotate-the-signing-key',
    title: 'Rotate the production signing key for acme.example',
  })

  it('carries a count and Tade’s own words, and nothing of the work', () => {
    const changes = changesBetween(before(secret), [{ ...secret, waiting: true }])
    const decided = noticeFor(changes, noticing())
    expect(decided.send).toBe(true)
    if (!decided.send) return
    const bytes = JSON.stringify(decided.notice)
    for (const leak of [
      'acme-private',
      'rotate-the-signing-key',
      'Rotate the production',
      'acme.example',
      'signing key',
    ]) {
      expect(bytes, leak).not.toContain(leak)
    }
    expect(decided.notice.title).toBe(NOTICE_TITLE)
    expect(decided.notice.tag).toBe(NOTICE_TAG)
    expect(decided.notice.body).toBe('Work wants your answer')
    // Three fields and no more: a `url` or a `data` would be a project and a
    // task in something a push service keeps and a lock screen draws.
    expect(Object.keys(decided.notice).sort()).toEqual(['body', 'tag', 'title'])
  })

  it('names the work only where details are on, and never more than the name', () => {
    const changes = changesBetween(before(secret), [{ ...secret, waiting: true }])
    const decided = noticeFor(changes, noticing({ details: true }))
    expect(decided.send).toBe(true)
    if (!decided.send) return
    expect(decided.notice.body).toBe(
      'Rotate the production signing key for acme.example wants your answer',
    )
    // The *name* and not the id: a task id is a project and a slug, and the
    // project is the half nobody asked to put on a lock screen.
    expect(decided.notice.body).not.toContain('acme-private/')
  })

  it('stays generic with details on where the work has no name', () => {
    const unnamed = task({ title: '' })
    const changes = changesBetween(before(unnamed), [{ ...unnamed, waiting: true }])
    const decided = noticeFor(changes, noticing({ details: true }))
    expect(decided.send).toBe(true)
    if (decided.send) expect(decided.notice.body).toBe('Work wants your answer')
  })

  it('coalesces several into one, with no name in it whatever the setting says', () => {
    // Three task names on a lock screen is the whole of what somebody who
    // picked up the phone would read, so a count is the only honest plural.
    const was = before(task({ id: 'a/one' }), task({ id: 'a/two' }), task({ id: 'a/three' }))
    const changes = changesBetween(was, [
      task({ id: 'a/one', waiting: true }),
      task({ id: 'a/two', waiting: true }),
      task({ id: 'a/three', state: 'failed' }),
    ])
    const decided = noticeFor(changes, noticing({ details: true }))
    expect(decided.send).toBe(true)
    if (!decided.send) return
    expect(decided.notice.body).toBe('2 want your answer, and 1 other')
    expect(decided.notice.body).not.toContain('Move to Stripe')
  })

  it('leads with the worst, in the order somebody would want them', () => {
    const was = before(task({ id: 'a/one' }), task({ id: 'a/two' }))
    const decided = noticeFor(
      changesBetween(was, [
        task({ id: 'a/one', finished: true }),
        task({ id: 'a/two', state: 'blocked' }),
      ]),
      noticing(),
    )
    expect(decided.send).toBe(true)
    // `stuck` is ahead of `done` in `HAPPENINGS`, so it is the clause.
    if (decided.send) expect(decided.notice.body).toContain('has stopped and needs you')
    expect(HAPPENINGS.indexOf('stuck')).toBeLessThan(HAPPENINGS.indexOf('done'))
  })

  it('says one thing in the singular and several in the plural', () => {
    const was = before(task({ id: 'a/one' }), task({ id: 'a/two' }))
    const one = noticeFor(changesBetween(was, [task({ id: 'a/one', state: 'failed' })]), noticing())
    expect(one.send && one.notice.body).toBe('Work has gone red')
    const both = noticeFor(
      changesBetween(was, [
        task({ id: 'a/one', state: 'failed' }),
        task({ id: 'a/two', state: 'failed' }),
      ]),
      noticing(),
    )
    expect(both.send && both.notice.body).toBe('2 have gone red')
  })
})

describe('what one device may be told about', () => {
  const across = () =>
    changesBetween(
      before(task({ id: 'a/one', project: 'a' }), task({ id: 'b/two', project: 'b' })),
      [
        task({ id: 'a/one', project: 'a', waiting: true }),
        task({ id: 'b/two', project: 'b', state: 'failed' }),
      ],
    )

  it('is everything, for a device that reads every project', () => {
    const reach: Reach = { device: 'd', projects: { kind: 'every' }, granted: [] }
    expect(changesFor(across(), reach)).toHaveLength(2)
  })

  it('is the projects it reads, and a count is still a fact about the others', () => {
    // A phone granted one project of five must not be told — even as a count —
    // that something in the other four wants you. The collections are built
    // once for every device, so this is the only place that narrowing can
    // happen.
    const reach: Reach = { device: 'd', projects: { kind: 'listed', names: ['a'] }, granted: [] }
    const mine = changesFor(across(), reach)
    expect(mine.map((one) => one.task)).toEqual(['a/one'])
  })

  it('is nothing for a device granted no project at all', () => {
    const reach: Reach = { device: 'd', projects: { kind: 'listed', names: [] }, granted: [] }
    expect(changesFor(across(), reach)).toEqual([])
  })
})

describe('everything that stops one being sent', () => {
  const changes: Change[] = [{ task: 'a/one', project: 'a', what: 'wants', title: 'One' }]

  it('sends nothing when nothing changed', () => {
    const decided = noticeFor([], noticing())
    expect(decided).toEqual({ send: false, why: 'nothing changed' })
  })

  it('sends nothing while somebody is at the keyboard', () => {
    // Wider than voice's rule on purpose: voice drops *the focused task*,
    // because its question is which lane has your attention. A notification is
    // for somebody who is not here at all.
    const decided = noticeFor(changes, noticing({ lastInputAt: 1_000_000 - 30_000 }))
    expect(decided).toEqual({ send: false, why: 'you are at the keyboard' })
    // And sends again once the window has passed.
    const later = noticeFor(
      changes,
      noticing({ lastInputAt: 1_000_000 - SETTINGS.focusWindowMs - 1 }),
    )
    expect(later.send).toBe(true)
  })

  it('sends nothing inside quiet hours, wrapping midnight', () => {
    for (const hour of [22, 23, 0, 3, 7]) {
      expect(noticeFor(changes, noticing({ localHour: hour })).send, String(hour)).toBe(false)
    }
    for (const hour of [8, 12, 21]) {
      expect(noticeFor(changes, noticing({ localHour: hour })).send, String(hour)).toBe(true)
    }
  })

  it('reads the quiet hours and the budget a person wrote for the earbud', () => {
    // The two personal halves of attention are facts about the person, not
    // about the surface: a second set of quiet hours for phones is the drift
    // `attentionFor` exists to prevent.
    const settings = attentionFor('push', { quiet: '09:00-17:00', budget: 1 })
    expect(noticeFor(changes, noticing({ settings, localHour: 12 })).send).toBe(false)
    expect(noticeFor(changes, noticing({ settings, localHour: 20 })).send).toBe(true)
    const spent = noticeFor(changes, noticing({ settings, localHour: 20, sentInLastHour: 1 }))
    expect(spent).toEqual({ send: false, why: 'hourly budget of 1 reached' })
  })

  it('stops at the budget rather than over it, the way voice does', () => {
    const at = noticing({ sentInLastHour: SETTINGS.budget })
    expect(noticeFor(changes, at).send).toBe(false)
    const under = noticing({ sentInLastHour: SETTINGS.budget - 1 })
    expect(noticeFor(changes, under).send).toBe(true)
  })

  it('sends nothing where every change has already been sent', () => {
    const already = new Set(changes.map(keyOf))
    expect(noticeFor(changes, noticing({ already }))).toEqual({ send: false, why: 'already sent' })
  })

  it('sends only what is new, and says which keys it used', () => {
    const two: Change[] = [...changes, { task: 'a/two', project: 'a', what: 'red', title: 'Two' }]
    const decided = noticeFor(two, noticing({ already: new Set([keyOf(changes[0] as Change)]) }))
    expect(decided.send).toBe(true)
    if (!decided.send) return
    expect(decided.keys).toEqual(['a/two\nred'])
    expect(decided.notice.body).toBe('Work has gone red')
  })

  it('keys a change by the task and what happened, so the same thing twice is once', () => {
    // A task that goes red, is fixed and goes red again is two notifications; a
    // task that is blocked across twenty beats is one.
    expect(keyOf({ task: 'a/one', project: 'a', what: 'red', title: 'x' })).toBe('a/one\nred')
    expect(keyOf({ task: 'a/one', project: 'a', what: 'stuck', title: 'x' })).not.toBe('a/one\nred')
  })
})
