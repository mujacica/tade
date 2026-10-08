import { appliesTo, type Note } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { inScope, notesOf, projector } from '../src/reading.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { EVERY, input, NOW, note, reach, task } from './fixtures.ts'

describe('the projector', () => {
  it('answers from what it holds and builds nothing per question', () => {
    const one = input({ reach: reach(EVERY) })
    const held = projector(one, NOW)
    expect(held.snapshot()).toBe(held.snapshot())
    expect(held.rev).toBe(12)
  })

  it('advances on a beat that changed something, and not otherwise', () => {
    const one = input({ reach: reach(EVERY) })
    const held = projector(one, NOW)
    expect(held.beat(one, NOW + 2_000)).toBeNull()
    expect(held.rev).toBe(12)
    const delta = held.beat({ ...one, notes: [] }, NOW + 4_000)
    expect(delta?.rev).toBe(13)
    expect(held.rev).toBe(13)
    expect(held.snapshot().notes).toEqual([])
  })

  it('keeps its own revision whatever the caller puts on the input', () => {
    // The server owns its lifetime; a caller that forgot to carry `rev`
    // forward must not reset the stream's cursor underneath its clients.
    const one = input({ reach: reach(EVERY) })
    const held = projector(one, NOW)
    held.beat({ ...one, notes: [] }, NOW + 2_000)
    held.beat({ ...one, notes: [], findings: [] }, NOW + 4_000)
    expect(held.rev).toBe(14)
  })

  it('answers the notes route from the input of its last beat', () => {
    const one = input({ reach: reach(EVERY) })
    const held = projector(one, NOW)
    expect(held.notes('sentry')).toMatchObject({ total: 2 })
    held.beat({ ...one, notes: [] }, NOW + 2_000)
    expect(held.notes('sentry').rows).toEqual([])
  })

  it('ticks without advancing anything', () => {
    const held = projector(input({ reach: reach(EVERY) }), NOW)
    const beat = held.tick(NOW + 2_000)
    expect(beat.rev).toBe(12)
    expect(beat.set).toEqual({})
    expect(held.rev).toBe(12)
  })
})

describe('notes in one scope', () => {
  const one = input({
    reach: reach(EVERY),
    notes: [
      note({ scope: null, text: 'about everything', at: '2026-10-01T00:00:00.000Z' }),
      note({ scope: 'sentry', text: 'about the project', at: '2026-10-02T00:00:00.000Z' }),
      note({
        scope: 'sentry/away-projection',
        text: 'about the task',
        at: '2026-10-03T00:00:00.000Z',
      }),
      note({ scope: 'sentry/other', text: 'about a sibling', at: '2026-10-04T00:00:00.000Z' }),
    ],
  })

  it('follows `appliesTo`: the project’s, the task’s and everything’s', () => {
    const page = notesOf(one, 'sentry/away-projection')
    expect(page.rows.map((row) => row.text?.words)).toEqual([
      'about the task',
      'about the project',
      'about everything',
    ])
  })

  it('never leaks a sibling task’s note', () => {
    expect(notesOf(one, 'sentry/away-projection').rows.map((row) => row.scope)).not.toContain(
      'sentry/other',
    )
  })

  it('answers the count and nothing else when notes were not granted', () => {
    const page = notesOf({ ...one, reach: reach([]) }, null)
    expect(page.rows).toEqual([])
    expect(page).toMatchObject({ total: 1, omitted: 1 })
  })

  it('gives a note the same id here as in a snapshot', () => {
    const page = notesOf(one, 'sentry')
    const snapshot = snapshotOf(one, NOW)
    for (const row of page.rows) {
      const same = snapshot.notes.find((other) => other.id === row.id)
      expect(same?.text?.words).toBe(row.text?.words)
    }
  })

  it('tells two notes written in the same millisecond apart', () => {
    const twice = input({
      reach: reach(EVERY),
      notes: [
        note({ at: '2026-10-05T00:00:00.000Z', text: 'first' }),
        note({ at: '2026-10-05T00:00:00.000Z', text: 'second' }),
      ],
    })
    const ids = notesOf(twice, 'sentry').rows.map((row) => row.id)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('the scope rule is `appliesTo`’s', () => {
  // The copy cannot drift: if core changes how a note's scope reaches a task,
  // this is what goes red.
  const scopes = [null, 'sentry', 'sentry/away-projection', 'tade', 'tade/window']
  it('agrees with it over every pairing', () => {
    for (const noted of scopes)
      for (const asked of scopes) {
        const entry = { text: 'x', scope: noted, by: 'voice', at: '2026-10-01T00:00:00.000Z' }
        expect(inScope(noted, asked), `${noted} seen from ${asked}`).toBe(
          appliesTo(entry as Note, asked),
        )
      }
  })
})

describe('a projector over a reach that may read one project', () => {
  it('never holds a row from another one', () => {
    const held = projector(
      input({
        reach: reach(EVERY, ['tade']),
        tasks: [task(), task({ id: 'tade/window', project: 'tade' })],
      }),
      NOW,
    )
    expect(held.snapshot().tasks.map((row) => row.id)).toEqual(['tade/window'])
  })
})
