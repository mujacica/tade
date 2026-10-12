import type { ListSection } from '@tade/extensions-core'
import type { KeptSchedule } from '@tade/workbench/schedules'
import { describe, expect, it } from 'vitest'
import { initialState } from '../../src/model.ts'
import { Extensions } from '../../src/wire/extensions.ts'
import { Kept } from '../../src/wire/kept.ts'
import { Schedules } from '../../src/wire/schedules.ts'

// What a subject keeps between frames, and the one way it can go wrong: a
// field that says what *was* true. Each kept answer is held here to the two
// halves of that — it is not made again while nothing it is made of moved,
// and it is made again the moment anything did.

describe('an answer kept between frames', () => {
  it('is made once while its key is the same, and again when any part is not', () => {
    const kept = new Kept<string>()
    let made = 0
    const make = () => `made ${++made}`
    const state = { a: 1 }
    for (let frame = 0; frame < 30; frame++) expect(kept.of([state, 7, 120], make)).toBe('made 1')
    // A part that is equal but not the same one is a change: identity is the
    // whole of the contract, and an equal copy is something somebody rebuilt.
    expect(kept.of([{ a: 1 }, 7, 120], make)).toBe('made 2')
    expect(kept.of([{ a: 1 }, 8, 120], make)).toBe('made 3')
    expect(kept.of([state, 8, 80], make)).toBe('made 4')
    expect(kept.of([state, 8, 80, 'one more'], make)).toBe('made 5')
  })

  it('is made again when it says it has stopped being true', () => {
    const kept = new Kept<{ until: number }>()
    let made = 0
    const make = () => ({ until: 1_000 * ++made })
    let now = 0
    const expired = (answer: { until: number }) => now >= answer.until
    expect(kept.of([], make, expired)).toEqual({ until: 1_000 })
    now = 999
    expect(kept.of([], make, expired)).toEqual({ until: 1_000 })
    now = 1_000
    expect(kept.of([], make, expired)).toEqual({ until: 2_000 })
  })
})

describe('the schedules the SMART QUEUE shows', () => {
  const created = '2026-10-11T09:00:00.000Z'
  const hourly: KeptSchedule = {
    id: 'release-notes',
    name: 'Release notes',
    project: 'app',
    said: 'every hour',
    when: { every: '1h' },
    does: { kind: 'agent', prompt: 'Draft them.' },
    missed: 'once',
    by: 'you',
    created,
    paused: false,
  } as KeptSchedule

  function world() {
    let schedules: KeptSchedule[] = [hourly]
    let asked = 0
    let revision = 0
    let now = Date.parse(created) + 10 * 60_000
    const live = {
      get revision() {
        return revision
      },
      runsOf: () => ({ ran: 0, runs: [] }),
      watchedOf: () => undefined,
    }
    const wire = {
      opts: {
        client: {
          schedules: () => {
            asked++
            return schedules.map((one) => ({ ...one }))
          },
        },
      },
      state: initialState(),
      live,
      now: () => now,
      put: () => {},
      draw: () => {},
    }
    const subject = new Schedules(wire as never, {
      news: () => {},
      tell: async () => {},
      advanceQueue: () => {},
    })
    return {
      subject,
      asked: () => asked,
      set: (next: KeptSchedule[]) => {
        schedules = next
      },
      journalMoved: () => {
        revision++
      },
      at: (moment: number) => {
        now = moment
      },
    }
  }

  it('is made once a journal move, however many frames ask', () => {
    const one = world()
    const first = one.subject.views()
    for (let frame = 0; frame < 30; frame++) expect(one.subject.views()).toBe(first)
    expect(one.asked()).toBe(1)
    expect(first.map((view) => view.name)).toEqual(['Release notes'])
  })

  it('shows a change to a schedule as soon as the journal says one happened', () => {
    const one = world()
    one.subject.views()
    // Every change to a schedule writes `schedule_changed`, and every event
    // the window records moves `Live.revision`.
    one.set([{ ...hourly, name: 'Notes for the release', paused: true }])
    one.journalMoved()
    const after = one.subject.views()
    expect(after.map((view) => [view.name, view.paused])).toEqual([['Notes for the release', true]])
  })

  it('moves on to the run after next the moment the next one comes due', () => {
    const one = world()
    const [before] = one.subject.views()
    const next = before?.next[0] ?? Number.NaN
    expect(next).toBe(Date.parse(created) + 60 * 60_000)
    one.at(next - 1)
    expect(one.subject.views()[0]?.next[0]).toBe(next)
    expect(one.asked()).toBe(1)
    // Nothing in the journal moved, and it is still made again: the clock is
    // part of what a schedule's view is made of, from exactly this moment.
    one.at(next)
    expect(one.subject.views()[0]?.next[0]).toBe(next + 60 * 60_000)
    expect(one.asked()).toBe(2)
  })
})

describe('the lists extensions keep down the side', () => {
  const section = (titles: string[]): ListSection => ({
    id: 'review.mine',
    extension: 'review',
    title: 'REVIEWS',
    filters: [],
    filter: '',
    rows: titles.map((title, at) => ({ id: String(at), title })),
    problem: null,
    summarises: false,
    at: 0,
  })

  it('are made once an answer, and again the moment the extensions answer again', async () => {
    let now = 0
    let answer = [section(['#418 fix the double charge'])]
    let drawn = 0
    const host = {
      statuses: async () => [],
      lists: async () => answer,
      list: () => [],
    }
    const wire = {
      opts: { extensions: host, extensionWorkbench: {} },
      state: initialState(),
      now: () => now,
      draw: () => {
        drawn++
      },
    }
    const subject = new Extensions(wire as never, {} as never)
    const asked = async () => {
      const was = drawn
      subject.askExtensions()
      while (drawn === was) await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await asked()
    const first = subject.facts().lists
    expect(first?.[0]?.rows.map((row) => row.title)).toEqual(['#418 fix the double charge'])
    // Every row of every section, made again per frame, was the cost.
    for (let frame = 0; frame < 30; frame++) expect(subject.facts().lists).toBe(first)

    answer = [section(['#418 fix the double charge', '#419 a second review'])]
    now += 5_000
    await asked()
    expect(subject.facts().lists?.[0]?.rows.map((row) => row.title)).toEqual([
      '#418 fix the double charge',
      '#419 a second review',
    ])
  })

  it('are not drawn again, nor made again, when the extensions answer what they did', async () => {
    // Every five seconds the extensions are asked again, and every answer
    // used to be a frame and a new list: on a window nobody touched, a beat of
    // its own. Paced by the asking, never by a sleep.
    let now = 0
    let asks = 0
    let drawn = 0
    const host = {
      statuses: async () => [{ extension: 'review', item: { text: '2 open' }, viewable: false }],
      lists: async () => {
        asks++
        // A new answer every time, as the host's is: only what it says is the same.
        return [section(['#418 fix the double charge'])]
      },
      list: () => [],
    }
    const wire = {
      opts: { extensions: host, extensionWorkbench: {} },
      state: initialState(),
      now: () => now,
      draw: () => {
        drawn++
      },
    }
    const subject = new Extensions(wire as never, {} as never)
    const answered = async () => {
      const was = asks
      subject.askExtensions()
      while (asks === was) await new Promise((resolve) => setTimeout(resolve, 1))
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await answered()
    expect(drawn).toBe(1)
    const first = subject.facts().lists
    for (let beat = 0; beat < 5; beat++) {
      now += 5_000
      await answered()
    }
    expect(drawn, 'an answer the same as the last was drawn').toBe(1)
    expect(subject.facts().lists, 'the side’s rows were made again for the same answer').toBe(first)
  })
})
