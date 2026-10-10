import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import {
  type AppState,
  initialState,
  type ScheduleView,
  type TaskSnapshot,
  toggleSection,
  withProjects,
  withTasks,
} from '../src/model.ts'
import { describeSchedule, scheduleMakes } from '../src/queue.ts'
import { hush, unhush, wasHushed } from '../src/schedules-view.ts'
import { renderApp } from '../src/view.ts'

// SCHEDULES: the standing rules, apart from the queued work.
//
// One file rather than a corner of `queue-view.test.ts`, for the reason the
// section exists at all: what a rule is and what a piece of queued work is are
// two subjects, and the whole bug was them being read as one. What the queue
// shows of *its* list stays there.

/** The same row without its colour, for reading what a narrow side said. */
const plain = (row: string) =>
  row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

const frame = (over: Partial<Frame> = {}): Frame => ({
  width: 120,
  height: 44,
  screen: '',
  clock: (at: number) => new Date(at).toISOString().slice(11, 16),
  ...over,
})

const AT = Date.parse('2026-09-13T14:00:00Z')

const rule = (over: Partial<ScheduleView> = {}): ScheduleView => ({
  id: 'deps-weekly',
  name: 'deps weekly',
  project: 'checkout',
  said: '',
  kind: 'agent',
  does: 'starts an agent',
  prompt: 'update the dependencies',
  when: 'every Monday at 09:00',
  once: false,
  next: [AT],
  paused: false,
  by: 'you',
  missed: 'once',
  runs: [],
  ...over,
})

const watch = (
  over: Partial<ScheduleView>,
  look: { problem?: string; found?: number; fresh?: number; makes?: 'agent' | 'ask' } = {},
): ScheduleView =>
  rule({
    id: 'new-sentry-errors',
    name: 'New Sentry errors',
    kind: 'watch',
    does: 'looks with sentry.new-errors, and starts work on what it finds',
    prompt: '',
    when: 'every hour',
    by: 'extension:sentry',
    watch: {
      id: 'sentry.new-errors',
      turnedOnBy: 'you',
      found: look.makes ?? 'agent',
      most: 2,
      looks: [
        {
          at: AT,
          found: look.found ?? 3,
          fresh: look.fresh ?? 2,
          left: 0,
          problem: look.problem ?? null,
          trouble: null,
          until: null,
          said: null,
        },
      ],
      findings: [],
    },
    ...over,
  })

const working: TaskSnapshot[] = [
  { task: 'checkout/bump-mailer', state: 'working', lane: 'checkout/bump-mailer/agent' },
]

const window = (over: Partial<AppState> = {}, projects = ['checkout']): AppState => ({
  ...withTasks(withProjects(initialState(), projects), working),
  project: 'checkout',
  folded: ['changes', 'files', 'notes', 'where'],
  ...over,
})

/**
 * The side, read as text. Dragged wide by default, because what a rule's row
 * says is the subject here and a 29-column side spends its columns on `…` —
 * `narrowly` is for the rules that are about running out of room.
 */
const sideOf = (state: AppState, over: Partial<Frame> = {}) =>
  renderApp({ ...state, sizes: { sidebarWidth: 52, ...state.sizes } }, frame(over)).map((row) =>
    // The side and nothing right of it, so joining the rows of a wrapped
    // sentence back together does not join the divider in with them.
    plain(row).slice(0, 52),
  )

/** The same at the side's own width, which is where a ladder has to give ground. */
const narrowly = (state: AppState, over: Partial<Frame> = {}) =>
  renderApp(state, frame(over)).map((row) => plain(row).slice(0, 34))

describe('what a standing rule makes when it fires', () => {
  it('is work or a sentence, and never read off the kind alone', () => {
    // The difference between an agent at three in the morning and something to
    // read in the morning. A watch answers with what it does about what it
    // *finds*: looking costs nothing and is not the news.
    expect(scheduleMakes(rule())).toBe('agents')
    expect(scheduleMakes(rule({ kind: 'ask', does: 'asks the orchestrator' }))).toBe('tells')
    // A watch answers with what it does about what it finds, never with the fact
    // that it looks: one that starts an agent per finding and one that leaves a
    // sentence are the same kind of thing and not the same news.
    expect(scheduleMakes(watch({}))).toBe('agents')
    expect(scheduleMakes(watch({}, { makes: 'ask' }))).toBe('tells')
  })

  it('says which project it is in, where every project’s rules are listed at once', () => {
    // The orchestrator's list is every project's, and the same watch runs in
    // several of them under one name: two lines reading "New Sentry errors"
    // are two lines nobody can tell apart, and an id is not an answer to which
    // repository a thing is watching.
    const said = describeSchedule(watch({}), (at) => new Date(at).toISOString().slice(11, 16))
    expect(said).toContain('New Sentry errors, in checkout')
    expect(said).toContain('last looked')
  })
})

describe('the schedules down the side', () => {
  it('is there with nothing on a clock, folded, and its heading says why', () => {
    const rows = sideOf(window(), { width: 160 })
    const heading = rows.find((row) => row.includes('SCHEDULES')) ?? ''
    expect(heading).toContain('▸ SCHEDULES')
    expect(heading).toContain('nothing on a clock')
    // Folded is one row and no more: nothing of the list under it.
    expect(rows.filter((row) => row.includes('SCHEDULES')).length).toBe(1)
    // Opened on purpose, it says what there is to do about it — wrapped into the
    // room there is, which is what the open section has over its own heading.
    const open = sideOf(toggleSection(window(), 'schedules', true), { width: 160 })
    // The bar down the side's own edge taken out, so a wrapped sentence joins
    // back into the sentence rather than into the bar.
    const body = open.join(' ').replace(/[▕█]/g, ' ').replace(/\s+/g, ' ')
    expect(body).toContain('nothing here runs on a clock — the Extensions page turns a watch on')
  })

  it('says how often each fires and whether firing makes work', () => {
    const rows = sideOf(window(), { schedules: [rule(), watch({})] })
    const at = (text: string) => rows.findIndex((row) => row.includes(text))
    expect(at('SCHEDULES')).toBeGreaterThan(-1)
    expect(rows[at('SCHEDULES')]).toMatch(/SCHEDULES +\(?2\)?/)
    // The rule under its name, and what firing comes to pinned at the right.
    expect(rows[at('↻ deps weekly') + 1]).toContain('every Monday at')
    expect(rows[at('↻ deps weekly') + 1]).toContain('agents')
    // A watch gets a row for its last look, because looking has an outcome.
    expect(rows[at('◎ New Sentry') + 2]).toContain('14:00 · 2 new')
  })

  it('says a paused rule is paused, and keeps no look beside it', () => {
    const rows = sideOf(window(), {
      schedules: [watch({ paused: true }, { problem: 'it is down' })],
    })
    const at = rows.findIndex((row) => row.includes('New Sentry'))
    expect(rows[at]).toContain('paused')
    // Its mark is only paused: a watch that is off is not a watch in trouble.
    expect(rows[at]).toContain('‖')
    expect(rows.some((row) => row.includes('could not look'))).toBe(false)
  })

  it('says which project each rule is in, on every row or on none', () => {
    const many = ['checkout', 'search']
    const here = { schedules: [rule(), watch({})] }
    // A side with room for the project beside the longest rule says it on every
    // row: a column that turns up on some of them reads as noise.
    const wide = sideOf(window({}, many), here)
    expect(wide.filter((row) => row.includes('checkout · every')).length).toBe(2)
    // Too narrow for that, and the project is what goes — never how often it
    // fires, which is the fact somebody came to the row for.
    const narrow = narrowly(window({}, many), here)
    expect(narrow.some((row) => row.includes('checkout · every'))).toBe(false)
    expect(narrow.some((row) => row.includes('every Monday'))).toBe(true)
    // And one project never pays for it at any width.
    const alone = sideOf(window(), here)
    expect(alone.some((row) => row.includes('checkout · every'))).toBe(false)
  })
})

describe('a watch that could not look', () => {
  const broken = { schedules: [watch({}, { problem: 'Sentry answered 429: slow down' })] }

  it('says so in words, with the reason and a × to hush it', () => {
    const rows = sideOf(window(), broken)
    const at = rows.findIndex((row) => row.includes('New Sentry'))
    // The mark needs you, the heading counts it, and the reason is on its own
    // row rather than cut to whatever was left of the one above it.
    expect(rows[at]).toContain('!')
    expect(rows.find((row) => row.includes('SCHEDULES'))).toContain('1 not looking')
    expect(rows[at + 2]).toContain('could not look 14:00')
    expect(rows[at + 3]).toContain('Sentry answered 429')
    expect(rows[at + 3]).toContain('×')
  })

  it('hushed, loses its reason and keeps its mark and its count', () => {
    const hushed = window({
      hushed: ['new-sentry-errors\u0000Sentry answered 429: slow down'],
    })
    const rows = sideOf(hushed, broken)
    expect(rows.some((row) => row.includes('Sentry answered 429'))).toBe(false)
    expect(rows.some((row) => row.includes('could not look'))).toBe(false)
    // Hushing a reason is being told you have read it, never that it is fine.
    expect(rows.find((row) => row.includes('New Sentry'))).toContain('!')
    expect(rows.find((row) => row.includes('SCHEDULES'))).toContain('1 not looking')
  })

  it('says a different reason, and the same one again after a look that worked', () => {
    const state = hush(window(), 'new-sentry-errors', 'Sentry answered 429: slow down')
    expect(wasHushed(state, 'new-sentry-errors', 'Sentry answered 429: slow down')).toBe(true)
    // Keyed by the reason, so one failing the same way every ten minutes is said
    // once rather than every ten minutes — and a different reason is different
    // news.
    expect(wasHushed(state, 'new-sentry-errors', 'the token expired')).toBe(false)
    // Another watch's trouble is its own.
    expect(wasHushed(state, 'ci-on-this-branch', 'Sentry answered 429: slow down')).toBe(false)
    // Hushing twice writes nothing twice.
    expect(hush(state, 'new-sentry-errors', 'Sentry answered 429: slow down')).toBe(state)
    // A look that worked drops it: trouble that comes back after it was over is
    // trouble somebody has to hear about, in the same words or not.
    const looked = unhush(state, 'new-sentry-errors')
    expect(wasHushed(looked, 'new-sentry-errors', 'Sentry answered 429: slow down')).toBe(false)
    expect(sideOf(looked, broken).some((row) => row.includes('Sentry answered 429'))).toBe(true)
    // Nothing to drop is not a new state.
    expect(unhush(looked, 'new-sentry-errors')).toBe(looked)
  })
})
