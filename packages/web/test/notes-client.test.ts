import { describe, expect, it } from 'vitest'
import {
  asOfLine,
  BANDS,
  bySaid,
  chartFoot,
  DAY,
  LANES,
  LONG,
  leadLine,
  notesPage,
  scopeOf,
  tallyOf,
  whenSaid,
  wholeOf,
} from '../src/assets/pages/notes-shape.js'
import type { NoteIn } from '../src/input.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { EVERY, input, NOW, note, reach } from './fixtures.ts'

// What the notes page draws, against **real projected rows** rather than shapes
// a test assembled: every place, group, band and mark goes through
// `snapshotOf`, so a field the projection renames is a red test here rather
// than a blank card on a phone. And the page's one rule, in each of its forms:
// **a note is never reworded** — its words reach the card exactly as they were
// said, a headline is only ever the summary written beside it, and nothing the
// page says about notes is made out of one.

const minutes = (n: number) => NOW - n * 60_000
const iso = (n: number) => new Date(minutes(n)).toISOString()

/** The rows a device granted everything is handed, for these notes, newest first as the store gives them. */
function rows(notes: NoteIn[]) {
  return [...snapshotOf(input({ reach: reach(EVERY), notes }), NOW).notes].reverse()
}

/** Somewhere to go for every project and task, or for none. */
const ALL = { project: () => true, task: () => true }
const NONE = { project: () => false, task: () => false }

const page = (notes: NoteIn[], places = ALL) => notesPage(rows(notes), NOW, places)

/** A note said `ago` minutes ago about `scope`, with a headline unless told otherwise. */
const said = (scope: string | null, ago: number, over: Partial<NoteIn> = {}) =>
  note({
    scope,
    at: iso(ago),
    text: `about ${scope ?? 'everything'}, ${ago} minutes ago`,
    summary: `headline ${scope ?? 'everything'} ${ago}`,
    ...over,
  })

describe('a note is never reworded', () => {
  it('carries the words exactly as they were said, case, spacing and lines included', () => {
    const text = 'Never Merge on a Thursday.\n\n  Deploys:   Tuesdays only — ask ME first.'
    const [card] = page([said('sentry', 5, { text })]).where.projects[0]?.cards ?? []
    expect(card?.words).toEqual({ words: text, more: false })
  })

  it('draws the summary as the headline, and the words as the line where there is none', () => {
    const made = page([said(null, 5), said(null, 10, { summary: '' })]).where.everywhere.cards
    expect(made.map((one) => one.headline?.words ?? null)).toEqual(['headline everything 5', null])
    // With no headline the words themselves are what the card is scanned by.
    expect(made[1]?.words?.words).toBe('about everything, 10 minutes ago')
  })

  it('folds only words that are the card’s line and longer than a few lines, never a headline', () => {
    const long = 'x'.repeat(LONG + 1)
    const made = page([
      said(null, 1, { text: long, summary: '' }),
      said(null, 2, { text: 'x'.repeat(LONG), summary: '' }),
      said(null, 3, { text: long }),
    ]).where.everywhere.cards
    expect(made.map((one) => one.long)).toEqual([true, false, false])
  })

  it('makes no sentence of its own out of a note’s words or its headline', () => {
    const made = page([
      said(null, 5, { text: 'ZEBRA-WORDS everywhere', summary: 'QUAGGA-HEAD one' }),
      said('sentry', 50, { text: 'ZEBRA-WORDS project', summary: 'QUAGGA-HEAD two' }),
      said('sentry/away', 500, { text: 'ZEBRA-WORDS task', summary: '' }),
    ])
    const { headline, words, ...rest } = made.where.everywhere.cards[0] ?? {}
    expect(headline).not.toBeNull()
    expect(words).not.toBeNull()
    // Everything the page writes about notes, with the two fields that *are*
    // a note's own taken out of every card.
    const own = (key: string, value: unknown) =>
      key === 'headline' || key === 'words' ? undefined : value
    const sentences = JSON.stringify(
      [
        made.where,
        made.when,
        made.chart,
        leadLine(made),
        tallyOf(made),
        chartFoot(made.chart),
        rest,
      ],
      own,
    )
    expect(sentences).not.toContain('ZEBRA')
    expect(sentences).not.toContain('QUAGGA')
  })
})

describe('where a note applies', () => {
  it('reads a scope as everywhere, a project, or one of its tasks', () => {
    expect(scopeOf(null)).toEqual({ kind: 'everywhere', project: null, task: null })
    expect(scopeOf('')).toEqual({ kind: 'everywhere', project: null, task: null })
    expect(scopeOf('tade')).toEqual({ kind: 'project', project: 'tade', task: null })
    expect(scopeOf('tade/away/notes')).toEqual({
      kind: 'task',
      project: 'tade',
      task: 'away/notes',
    })
  })

  it('puts everywhere first, then a project at a time, the one told something last first', () => {
    const made = page([
      said('folio', 300),
      said('tade/window', 10),
      said(null, 900),
      said('sentry', 60),
      said('tade', 400),
    ])
    expect(made.where.everywhere.n).toBe(1)
    expect(made.where.projects.map((one) => [one.name, one.n])).toEqual([
      ['tade', 2],
      ['sentry', 1],
      ['folio', 1],
    ])
    expect(made.counts).toEqual({ everywhere: 1, project: 3, task: 1 })
  })

  it('holds a project’s own notes before its tasks’, and a task’s notes together', () => {
    const [tade] = page([
      said('tade/a', 10),
      said('tade/b', 20),
      said('tade', 300),
      said('tade/a', 30),
      said('tade', 5),
    ]).where.projects
    expect(tade?.cards.map((one) => [one.scope.task ?? 'project', one.at])).toEqual([
      ['project', minutes(5)],
      ['project', minutes(300)],
      ['a', minutes(10)],
      ['a', minutes(30)],
      ['b', minutes(20)],
    ])
    expect(tade?.under).toBe('2 notes on the whole project · 3 on 2 tasks')
  })

  it('names the place on a chip: a task by its name inside its project, and in full outside it', () => {
    const [card] = page([said('tade/window', 5)]).where.projects[0]?.cards ?? []
    expect(card?.chip).toEqual({
      kind: 'task',
      word: 'window',
      of: null,
      href: '/t/tade/window',
    })
    expect(card?.place).toEqual({
      kind: 'task',
      word: 'window',
      of: 'tade',
      href: '/t/tade/window',
    })
    const [own] = page([said('tade', 5)]).where.projects[0]?.cards ?? []
    expect(own?.chip).toEqual({ kind: 'project', word: 'whole project', of: null, href: null })
    expect(own?.place).toEqual({ kind: 'project', word: 'tade', of: null, href: '/p/tade' })
    const [every] = page([said(null, 5)]).where.everywhere.cards
    expect(every?.chip).toBeNull()
    expect(every?.place.word).toBe('Everywhere')
  })

  it('links only where the page has somewhere to go', () => {
    const made = page([said('tade/gone', 5), said('tade', 6)], NONE)
    const [project] = made.where.projects
    expect(project?.href).toBeNull()
    expect(project?.cards.map((one) => one.place.href)).toEqual([null, null])
    expect(made.chart.lanes.map((one) => one.href)).toEqual([null])
  })
})

describe('when a note was said', () => {
  it('falls in the last day, the week, the month, or before', () => {
    const made = page([
      said(null, 30),
      said(null, 2 * 24 * 60),
      said(null, 10 * 24 * 60),
      said(null, 40 * 24 * 60),
    ])
    expect(made.when.map((one) => [one.key, one.n])).toEqual([
      ['day', 1],
      ['week', 1],
      ['month', 1],
      ['older', 1],
      ['unknown', 0],
    ])
    expect(made.when.map((one) => one.heading)).toEqual(BANDS.map((one) => one.heading))
  })

  it('puts a moment that will not read in its own group, never among the oldest', () => {
    const made = page([said(null, 30), said(null, 0, { at: 'not a moment' })])
    const unknown = made.when.find((one) => one.key === 'unknown')
    expect(unknown?.n).toBe(1)
    expect(unknown?.cards[0]?.age).toBeNull()
    expect(made.when.find((one) => one.key === 'older')?.n).toBe(0)
  })

  it('is new for a day, and says how many are', () => {
    const made = page([said(null, 30), said('tade', 23 * 60), said('tade', 25 * 60)])
    expect(made.where.projects[0]?.cards.map((one) => one.fresh)).toEqual([true, false])
    expect(made.fresh).toBe(2)
    expect(leadLine(made)).toBe('newest 30m ago · 2 in the last day')
    expect(leadLine(page([said(null, 3 * 24 * 60)]))).toBe('newest 3d 0h ago')
  })

  it('counts ages against the page’s clock, so a page that is not live does not count up', () => {
    const frozen = notesPage(rows([said(null, 25)]), minutes(15))
    expect(frozen.where.everywhere.cards[0]?.age).toBe('10m')
  })

  it('says the moment in the reader’s own zone, with the year only when it is not this one', () => {
    const at = Date.parse('2026-03-04T05:06:00.000Z')
    const local = new Date(at)
    const clock = `${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`
    expect(whenSaid(at, NOW)).toBe(`Mar ${local.getDate()}, ${clock}`)
    expect(whenSaid(at, Date.parse('2027-06-01T12:00:00.000Z'))).toBe(
      `Mar ${local.getDate()} ${local.getFullYear()}, ${clock}`,
    )
    expect(whenSaid(null, NOW)).toBeNull()
  })

  it('says where a note came from, and nothing for a source nobody wrote down', () => {
    expect(bySaid('voice')).toBe('spoken')
    expect(bySaid('orchestrator')).toBe('taken down by Tade')
    expect(bySaid('device dev_7f3a9c21')).toBe('from device dev_7f3a9c21')
    expect(bySaid('unknown')).toBeNull()
    expect(bySaid('')).toBeNull()
    expect(bySaid('pager')).toBe('from pager')
  })
})

describe('the picture', () => {
  it('draws a lane per place in the list’s order and a mark per note, toned now for a new one', () => {
    const chart = page([said('tade', 30), said(null, 3 * 60), said('tade', 26 * 60)]).chart
    expect(chart.lanes.map((one) => one.label)).toEqual(['Everywhere', 'tade'])
    expect(chart.lanes[1]?.marks.map((one) => [one.at, one.tone])).toEqual([
      [minutes(30), 'here'],
      [minutes(26 * 60), 'quiet'],
    ])
    // A lane says itself once, on its first mark, for a screen reader.
    expect(chart.lanes[1]?.marks.map((one) => one.said)).toEqual([
      '2 notes in the last two weeks, the newest 30m ago',
      '',
    ])
  })

  it('draws the smallest window that holds every note, so a morning is not a corner of weeks', () => {
    const span = (ago: number) => page([said(null, 5), said(null, ago)]).chart
    expect(span(20 * 60).said).toBe('the last day')
    expect(span(20 * 60).ticks.map((one) => one.said)).toEqual(['24h', '18h', '12h', '6h', 'now'])
    expect(span(10 * 24 * 60).said).toBe('the last two weeks')
    expect(span(20 * 24 * 60).said).toBe('the last four weeks')
    expect(span(60 * 24 * 60).said).toBe('the last twelve weeks')
    const day = span(20 * 60)
    expect([day.from, day.to, day.now]).toEqual([NOW - DAY, NOW, NOW])
  })

  it('counts what is older than the widest window rather than piling it at the edge', () => {
    const chart = page([
      said(null, 5),
      said('tade', 100 * 24 * 60),
      said('tade', 200 * 24 * 60),
    ]).chart
    expect(chart.said).toBe('the last twelve weeks')
    expect(chart.lanes.map((one) => one.marks.length)).toEqual([1, 0])
    expect(chart.lanes[1]?.marks).toEqual([])
    expect(chart.left).toBe(2)
    expect(chartFoot(chart)).toBe('2 older than twelve weeks not drawn')
  })

  it('counts a note whose moment will not read apart, never as an old one', () => {
    const chart = page([said(null, 5), said(null, 0, { at: 'not a moment' })]).chart
    expect(chart.lanes[0]?.marks).toHaveLength(1)
    expect([chart.left, chart.unplaced]).toEqual([0, 1])
    expect(chartFoot(chart)).toBe('1 with no moment recorded not drawn')
  })

  it('draws at most a few lanes and says how many more places the list has', () => {
    const many = Array.from({ length: LANES + 2 }, (_, at) => said(`p${at}`, at + 1))
    const chart = page(many).chart
    expect(chart.lanes).toHaveLength(LANES)
    expect(chart.more).toBe(2)
    // What is past the last lane is the list's to say, and is not counted twice.
    expect(chart.left).toBe(0)
    expect(chartFoot(chart)).toBe('2 more projects in the list')
  })
})

describe('the lead', () => {
  it('counts the three places a note can be about, and they add up to every note', () => {
    const made = page([said(null, 1), said('a', 2), said('a/b', 3), said('a/c', 4)])
    const tally = tallyOf(made)
    expect(tally.map((one) => [one.label, one.n])).toEqual([
      ['Everywhere', 1],
      ['On a project', 1],
      ['On a task', 2],
    ])
    expect(tally.reduce((sum, one) => sum + one.n, 0)).toBe(made.total)
  })
})

describe('what a group holds', () => {
  it('holds every note said there, newest first, and the page never folds one away', () => {
    const many = Array.from({ length: 40 }, (_, at) => said(null, at + 1))
    const group = page(many).where.everywhere
    expect(group.n).toBe(40)
    expect(group.cards.map((one) => one.at)).toEqual(
      many.map((one) => Date.parse(one.at as string)),
    )
  })
})

describe('the page’s own states', () => {
  it('says nothing before the first snapshot, and that Tade cannot be reached when it cannot', () => {
    expect(wholeOf(false, false, false, 0, 0)).toBeNull()
    expect(wholeOf(false, true, false, 0, 0)).toMatchObject({ kind: 'error', icon: 'alert' })
  })

  it('tells not granted from none, and says how many are there when it is not granted', () => {
    expect(wholeOf(true, false, false, 0, 41)?.line).toBe(
      '41 notes here. Grant this device notes at the machine to read them.',
    )
    expect(wholeOf(true, false, false, 0, 0)?.heading).toBe('Notes aren’t granted to this device')
    expect(wholeOf(true, false, true, 0, 0)?.heading).toBe('Nothing written down yet')
    expect(wholeOf(true, false, true, 3, 0)).toBeNull()
  })

  it('says the moment a page that is not live is as of, and nothing about notes elsewhere', () => {
    expect(asOfLine(false, '11:04')).toBe('')
    expect(asOfLine(true, '11:04')).toBe('as of 11:04')
  })

  it('carries every note a device may read, however many there are', () => {
    // The person: every screen shows everything it lists. Three hundred notes
    // is past what the snapshot used to carry, and every one of them is here.
    const notes = Array.from({ length: 300 }, (_, at) => said(at % 2 === 0 ? null : 'tade', at))
    const projected = snapshotOf(input({ reach: reach(EVERY), notes }), NOW)
    expect(projected.notes).toHaveLength(300)
    expect(projected.pages.notes).toMatchObject({ total: 300, omitted: 0, next: null })
  })

  it('withholds every note from a device not granted them, so the page has none to draw', () => {
    const notes = [said(null, 5), said('tade', 6)]
    const projected = snapshotOf(input({ reach: reach([]), notes }), NOW)
    expect(projected.notes).toEqual([])
    expect(projected.pages.notes.total).toBe(2)
  })
})
