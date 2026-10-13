import {
  INBOX_STATES,
  nothingHandedSays,
  SOURCE_NEEDS_YOU,
  SOURCE_STATES,
  WAITING_STATES,
} from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  approveWhy,
  byDoor,
  calmSaid,
  chipsOf,
  DOOR_ORDER,
  doorsOf,
  emptySays,
  factsSplit,
  figureSaid,
  fromSaid,
  groupSaid,
  heldTaskOf,
  heroSaid,
  inboxPage,
  KINDS,
  omittedSaid,
  provenanceOf,
  STANDS,
  settledSaid,
  standingOfRequest,
  startsSaid,
  unsentSaid,
  workOf,
  workSaid,
} from '../src/assets/pages/inbox-shape.js'
import type { IntakeIn, SourceIn } from '../src/factory.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { EVERY, input, intake, NOW, reach, source } from './fixtures.ts'

// What the inbox page draws, against **real projected rows** rather than
// shapes a test assembled: every group, wait, order and sentence goes through
// `snapshotOf`, so a field the projection renames is a red test here rather
// than an empty card on a phone. And the page's rules of honesty, each in its
// form: what waits on a person is the domain's list and nobody else's,
// `proposed` and `started` never share a part, and an empty inbox says which
// nothing it is.

const minutes = (n: number) => NOW - n * 60_000

type Work = IntakeIn['work'][number]
const work = (task: string, over: Partial<Work> = {}): Work => ({
  task,
  parked: false,
  started: false,
  finished: false,
  held: null,
  state: null,
  ...over,
})

/** A request in a state, arrived `ago` minutes before the fixtures' moment. */
const one = (id: string, state: IntakeIn['state'], ago: number, over: Partial<IntakeIn> = {}) =>
  intake({
    item: `github:${id}`,
    externalId: id,
    state,
    at: minutes(ago),
    approve: state === 'proposed' ? `sentry/github-${id}` : '',
    tasks: [`sentry/github-${id}`],
    work: [work(`sentry/github-${id}`, { parked: state === 'proposed' })],
    revision: 'r1',
    taken: 'r1',
    ...over,
  })

/** The rows a device granted these reads is handed. */
function rows(intakes: IntakeIn[], sources: SourceIn[] = [source()], granted = EVERY) {
  const made = snapshotOf(input({ reach: reach(granted), intake: intakes, sources }), NOW)
  return { intake: made.intake, sources: made.sources }
}

/** The page over these requests and doors, counted against the fixtures' own moment. */
function page(
  intakes: IntakeIn[],
  sources: SourceIn[] = [source()],
  known: (id: string) => boolean = () => true,
) {
  const made = rows(intakes, sources)
  return inboxPage(made.intake, made.sources, NOW, NOW, known)
}

const spread = () => [
  one('1', 'proposed', 30),
  one('2', 'proposed', 300),
  one('3', 'held', 90, {
    work: [
      work('sentry/github-3', { started: true, held: 'it asked a question', state: 'blocked' }),
    ],
  }),
  one('4', 'failure', 2000, { tasks: [], work: [] }),
  one('5', 'noticed', 2, { tasks: [], work: [] }),
  one('6', 'accepted', 20),
  one('7', 'started', 60, { work: [work('sentry/github-7', { started: true, state: 'working' })] }),
  one('8', 'started', 900, {
    work: [work('sentry/github-8', { started: true, finished: true, state: 'review' })],
  }),
  one('9', 'refused', 4000, { tasks: [], work: [] }),
]

describe('what waits on a person', () => {
  it('is the domain’s own list of states, and nobody else’s', () => {
    expect(Object.keys(KINDS).sort()).toEqual([...WAITING_STATES].sort())
    const made = page(spread())
    expect(made.waiting).toBe(4)
    expect(made.groups.flatMap((group) => group.cards.map((card) => card.state)).sort()).toEqual([
      'failure',
      'held',
      'proposed',
      'proposed',
    ])
  })

  it('is grouped by what it needs, approving first, a kind with none left out', () => {
    expect(page(spread()).groups.map((group) => group.kind)).toEqual([
      'proposed',
      'held',
      'failure',
    ])
    expect(
      page([one('1', 'failure', 5, { tasks: [], work: [] })]).groups.map((g) => g.kind),
    ).toEqual(['failure'])
  })

  it('puts the one that has waited longest at the head of its group, and says how long', () => {
    const [approve] = page(spread()).groups
    expect(approve?.cards.map((card) => card.key)).toEqual(['github:2', 'github:1'])
    expect(approve?.oldestSaid).toBe('5h 0m')
    expect(approve === undefined ? '' : groupSaid(approve)).toBe('2 · oldest 5h 0m')
  })

  it('ages against the page’s clock, so a page that is not live never counts up', () => {
    const made = rows([one('1', 'proposed', 30)])
    const later = inboxPage(made.intake, made.sources, NOW, NOW + 3_600_000)
    expect(later.groups[0]?.cards[0]?.waitedSaid).toBe('30m')
  })

  it('says the oldest of every kind beside the lead’s count', () => {
    const made = page(spread())
    expect(heroSaid(made)).toEqual({ label: 'wait on you', under: 'oldest arrived 1d 9h ago' })
  })
})

describe('the one press on each', () => {
  const action = (row: IntakeIn, known: (id: string) => boolean = () => true) =>
    page([row], [source()], known).groups[0]?.cards[0]?.action

  it('goes to approving beside what it would start, never approving blind from a list', () => {
    expect(action(one('1', 'proposed', 5))).toEqual({
      word: 'Review and approve',
      name: null,
      href: '/i/github/1',
    })
  })

  it('goes to the held task where its own controls are, while it is on this device', () => {
    const held = one('3', 'held', 5, {
      work: [work('sentry/github-3', { started: true, held: 'it asked', state: 'blocked' })],
    })
    expect(action(held)).toEqual({ word: 'Open', name: 'github-3', href: '/t/sentry/github-3' })
    // A task that is gone is not a place to go: the request says what holds it.
    expect(action(held, () => false)).toEqual({
      word: 'See what is holding it',
      name: null,
      href: '/i/github/3',
    })
  })

  it('goes to the request where Tade gave up, which says why it stopped', () => {
    expect(action(one('4', 'failure', 5, { tasks: [], work: [] }))?.word).toBe('See why it stopped')
  })

  it('is not offered on anything that does not wait on a person', () => {
    const made = page(spread())
    for (const row of [...made.moving, ...made.settled]) expect(row.action).toBeNull()
  })
})

describe('where everything stands', () => {
  it('divides every request once, and the parts add up to all of them', () => {
    const made = page(spread())
    const by = Object.fromEntries(made.parts.map((part) => [part.key, part.n]))
    expect(by).toEqual({ approve: 2, stuck: 2, moving: 3, done: 1, refused: 1 })
    expect(made.parts.reduce((sum, part) => sum + part.n, 0)).toBe(made.total)
    expect(made.parts.map((part) => part.key)).toEqual(Object.keys(STANDS))
  })

  it('never puts proposed and started in one part: one waits on you, one is an agent spending', () => {
    const made = page([one('1', 'proposed', 5), one('7', 'started', 5)])
    const of = (key: string) => made.parts.find((part) => part.key === key)
    expect(of('approve')?.n).toBe(1)
    expect(of('moving')?.n).toBe(1)
    expect(STANDS.approve.tone).not.toBe(STANDS.moving.tone)
  })

  it('calls work finished only where every task of it is, which is the mark’s own rule', () => {
    const half = one('7', 'started', 5, {
      work: [
        work('sentry/a', { started: true, finished: true }),
        work('sentry/b', { started: true }),
      ],
    })
    expect(page([half]).moving.map((row) => row.key)).toEqual(['github:7'])
    expect(page([half]).moving[0]?.mark.word).toBe('started')
  })

  it('lists what is on its way and what is settled newest first', () => {
    const made = page(spread())
    expect(made.moving.map((row) => row.key)).toEqual(['github:5', 'github:6', 'github:7'])
    expect(made.settled.map((row) => row.key)).toEqual(['github:8', 'github:9'])
  })

  it('says every state the domain has somewhere on the page', () => {
    const made = page(INBOX_STATES.map((state, at) => one(String(at), state, at + 1)))
    const drawn = [
      ...made.groups.flatMap((group) => group.cards),
      ...made.moving,
      ...made.settled,
    ].map((row) => row.state)
    expect(drawn.sort()).toEqual([...INBOX_STATES].sort())
  })
})

describe('a request, in a card or a row', () => {
  it('goes by the source’s id where this device may not read its title, never the id as a title', () => {
    const made = rows([one('1', 'proposed', 5)], [source()], [])
    const card = inboxPage(made.intake, made.sources, NOW, NOW).groups[0]?.cards[0]
    expect(card?.name).toBe('github 1')
    expect(card?.named).toBe(false)
    // …and the line under it does not say the id a second time.
    expect(card?.from).toBe('sentry')
  })

  it('says where it came from, and leaves out a handle it was not granted rather than dashing it', () => {
    const granted = rows([one('1', 'proposed', 5)]).intake[0]
    const withheld = rows([one('1', 'proposed', 5)], [source()], []).intake[0]
    expect(fromSaid(granted)).toBe('github 1 · @octocat-Vb2 · sentry')
    expect(fromSaid(withheld)).toBe('github 1 · sentry')
  })

  it('says what approving would start, and nothing where nothing worked it out', () => {
    const made = rows([one('1', 'proposed', 5), one('2', 'proposed', 5, { would: null })]).intake
    const said = Object.fromEntries(made.map((row) => [row.item, startsSaid(row.would)]))
    expect(said['github:1']).toBe('starts 1 task in a worktree')
    expect(said['github:2']).toBeNull()
  })

  it('counts and places the tasks approving would start', () => {
    const start = (workspace: 'checkout' | 'worktree') => ({
      task: 'p/t',
      project: 'p',
      workspace,
      done: 'said',
      produces: null,
      touches: [],
      after: [],
      parked: true,
    })
    const would = (starts: unknown[]) => ({
      starts,
      grant: [],
      limits: [],
      problems: [],
      warnings: [],
    })
    expect(startsSaid(would([]))).toBe('starts nothing')
    expect(startsSaid(would([start('worktree'), start('worktree')]))).toBe(
      'starts 2 tasks in worktrees',
    )
    expect(startsSaid(would([start('checkout')]))).toBe('starts 1 task in the checkout')
    expect(startsSaid(would([start('checkout'), start('worktree')]))).toBe('starts 2 tasks')
  })
})

describe('the doors', () => {
  const doors = () => [
    source({ source: 'cli', state: 'off', lookedAt: null, every: '', until: null }),
    source({ source: 'github', state: 'rate-limited', until: NOW + 15 * 60_000 }),
    source({ source: 'linear', state: 'found', until: null, trouble: null }),
    source({ source: 'slack', state: 'trouble', until: null, trouble: 'refused' }),
    source({ source: 'zendesk', state: 'unreachable', until: null, trouble: 'unreachable' }),
  ]

  it('are drawn broken first, the one that clears itself next, and the shut last', () => {
    expect(page([], doors()).doors.map((door) => door.name)).toEqual([
      'slack',
      'zendesk',
      'github',
      'linear',
      'cli',
    ])
  })

  it('know every state the domain has, the two somebody must fix first', () => {
    expect([...DOOR_ORDER].sort()).toEqual([...SOURCE_STATES].sort())
    expect(DOOR_ORDER.slice(0, SOURCE_NEEDS_YOU.length).sort()).toEqual(
      [...SOURCE_NEEDS_YOU].sort(),
    )
  })

  it('call broken exactly the ones the domain says somebody has to fix', () => {
    const all = SOURCE_STATES.map((state) => source({ source: state, state }))
    const drawn = doorsOf(rows([], all).sources, NOW, NOW)
    expect(
      drawn
        .filter((door) => door.broken)
        .map((door) => door.state)
        .sort(),
    ).toEqual([...SOURCE_NEEDS_YOU].sort())
  })

  it('say when a spent budget clears, and when the others last looked', () => {
    const by = new Map(page([], doors()).doors.map((door) => [door.name, door]))
    expect(by.get('github')?.when).toBe('clears in 15m')
    expect(by.get('linear')?.when).toBe('looked 30m ago')
    expect(by.get('linear')?.facts).toBe(
      'looked 30m ago · every 10m · 7 handed over · sentry, tade',
    )
    // A door that never looked has no moment, and its state says why.
    expect(by.get('cli')?.when).toBeNull()
  })

  it('count the projects this device may not be told of rather than naming them', () => {
    const narrowed = doorsOf(
      rows([], [source()]).sources.map((row) => ({
        ...row,
        projects: ['sentry'],
        projectsElsewhere: 2,
      })),
      NOW,
      NOW,
    )
    expect(narrowed[0]?.facts).toContain('sentry +2')
  })
})

describe('an empty inbox', () => {
  it('says the broken door first, even where the window listed a rate limit above it', () => {
    const made = rows(
      [],
      [
        source({ source: 'github', state: 'rate-limited' }),
        source({ source: 'slack', state: 'trouble', because: 'slack refused the token' }),
      ],
    )
    expect(emptySays(byDoor(made.sources))).toBe('slack refused the token')
  })

  it('agrees with the domain’s own answer, which is where the sentences are', () => {
    const doors = [source({ source: 'cli', state: 'off' }), source({ state: 'off' })]
    expect(emptySays(byDoor(rows([], doors).sources))).toBe(nothingHandedSays(doors))
  })

  it('says where everything went when nothing waits, rather than only that nothing does', () => {
    const made = page([
      one('6', 'accepted', 5),
      one('8', 'started', 5, {
        work: [work('sentry/github-8', { started: true, finished: true })],
      }),
      one('9', 'refused', 5, { tasks: [], work: [] }),
    ])
    expect(calmSaid(made)).toBe('1 on its way, 1 finished, 1 refused.')
    expect(calmSaid(page([]))).toBe('Nothing has been handed over.')
  })
})

describe('the bar and the lines around the lead', () => {
  it('says how many wait in violet, that none do in grey, and nothing before a page', () => {
    expect(figureSaid(null)).toEqual({ word: '', tone: null })
    expect(figureSaid(page([]))).toEqual({ word: '', tone: null })
    expect(figureSaid(page([one('6', 'accepted', 5)]))).toEqual({
      word: 'nothing waits on you',
      tone: null,
    })
    expect(figureSaid(page([one('1', 'proposed', 5)]))).toEqual({
      word: '1 waits on you',
      tone: 't-wants',
    })
    expect(heroSaid(page([one('6', 'accepted', 5)]))).toEqual({
      label: 'nothing waits on you',
      under: null,
    })
  })

  it('says what the page was not sent, and that every figure is of what it holds', () => {
    expect(omittedSaid(0, 12)).toBeNull()
    expect(omittedSaid(3, 40)).toBe(
      '3 more requests not sent to this device; every figure here is of the 40 it holds',
    )
    expect(settledSaid(1, false)).toBe('Show 1 settled request')
    expect(settledSaid(2, true)).toBe('Hide the 2 settled requests')
  })
})

describe('one request', () => {
  const row = (over: Partial<IntakeIn> = {}, granted = EVERY) =>
    rows([intake(over)], [source()], granted).intake[0]

  it('washes violet while it waits for a yes and red while it stopped, and nothing otherwise', () => {
    expect(standingOfRequest(row(), NOW).wash).toBe('wants')
    expect(standingOfRequest(row({ state: 'held' }), NOW).wash).toBe('failed')
    expect(standingOfRequest(row({ state: 'failure' }), NOW).wash).toBe('failed')
    expect(standingOfRequest(row({ state: 'accepted' }), NOW).wash).toBeNull()
  })

  it('says its state in the glyph’s own word, and when it arrived', () => {
    const standing = standingOfRequest(row(), NOW)
    expect(standing.word).toBe('Proposed')
    expect(standing.arrived).toBe('arrived 4h 30m ago')
  })

  it('says an edit since the work was made, with both revisions', () => {
    expect(standingOfRequest(row(), NOW).moved).toContain('it is at 2026-10-08T11:00:00.000Z now')
    expect(standingOfRequest(row({ taken: intake().revision }), NOW).moved).toBeNull()
  })

  it('puts who and what first and the record under a fold, until a failure makes tries matter', () => {
    const calm = row()
    const split = factsSplit(provenanceOf(calm, true), calm)
    expect(split.first.map(([label]) => label)).toEqual([
      'source',
      'their id',
      'asked by',
      'project',
      'allowed by',
      'workflow',
    ])
    expect(split.more.map(([label]) => label)).toContain('its hash')
    const tried = row({ attempts: 2 })
    expect(factsSplit(provenanceOf(tried, true), tried).first.map(([label]) => label)).toContain(
      'tried',
    )
  })

  it('tells a handle nobody said from one this device may not read', () => {
    const asked = (one: ReturnType<typeof row>, may: boolean) =>
      new Map(provenanceOf(one, may)).get('asked by')
    expect(asked(row(), true)).toBe('@octocat-Vb2')
    expect(asked(row({}, []), false)).toBe('not granted')
    expect(asked(row({ who: '' }), true)).toBe('—')
  })

  it('draws what it made by the step’s mark, linked only where the task is here', () => {
    const done = workOf({
      task: 'sentry/a',
      parked: false,
      started: true,
      finished: true,
      held: null,
      state: 'review',
    })
    expect(done.mark.word).toBe('finished')
    expect(done.href).toBeNull()
    expect(
      workOf(
        {
          task: 'sentry/a',
          parked: true,
          started: false,
          finished: false,
          held: null,
          state: null,
        },
        () => true,
      ).href,
    ).toBe('/t/sentry/a')
  })

  it('says held before finished before started before parked, and which nothing it knows', () => {
    const base = {
      task: 't',
      parked: true,
      started: true,
      finished: true,
      held: 'a reason',
      state: null,
    }
    expect(workSaid(base)).toBe('held: a reason')
    expect(workSaid({ ...base, held: null })).toBe('finished')
    expect(workSaid({ ...base, held: null, finished: false })).toBe('an agent has been on it')
    expect(workSaid({ ...base, held: null, finished: false, started: false })).toBe(
      'parked, waiting to be approved',
    )
    expect(workSaid({ ...base, held: null, finished: false, started: false, parked: false })).toBe(
      'nothing here knows its state',
    )
  })

  it('says a reply that did not go back, how often, and why', () => {
    expect(unsentSaid({ saying: 'finished', attempts: 1, problem: null })).toEqual({
      said: 'Could not say “finished”, 1 time',
      why: 'nothing said why',
    })
    expect(unsentSaid({ saying: 'finished', attempts: 2, problem: '403' }).said).toBe(
      'Could not say “finished”, 2 times',
    )
  })

  it('says where it came from in chips, telling a handle nobody said from one not granted', () => {
    const said = (one: ReturnType<typeof row>, may: boolean) =>
      chipsOf(one, may).map((chip) => chip.said)
    expect(said(row(), true)).toEqual([
      'github 1402',
      '@octocat-Vb2',
      'sentry',
      'reproduce-and-fix@3',
    ])
    expect(said(row({}, []), false)).toContain('asked by: not granted')
    expect(said(row({ who: '' }), true)).toEqual(['github 1402', 'sentry', 'reproduce-and-fix@3'])
    expect(said(row({ stamp: null }), true).at(-1)).toBe('one task')
    expect(chipsOf(row({ stamp: null }), true).at(-1)?.mono).toBe(false)
  })

  it('opens the task a held request is held on, only while that task is here', () => {
    const held = row({
      state: 'held',
      work: [work('sentry/github-1402', { started: true, held: 'it asked', state: 'blocked' })],
    })
    expect(heldTaskOf(held, () => true)).toBe('sentry/github-1402')
    expect(heldTaskOf(held, () => false)).toBeNull()
    // Held by failed deliveries rather than by a task: nothing to open.
    expect(heldTaskOf(row({ state: 'held', attempts: 2 }), () => true)).toBeNull()
    expect(heldTaskOf(row(), () => true)).toBeNull()
  })

  it('says why approving is not offered only where a yes is waited on, and never for a press not granted', () => {
    const proposed = row()
    expect(approveWhy(proposed, true, { kind: 'yes' })).toBe('')
    expect(approveWhy(proposed, false, { kind: 'no', why: '' })).toBe(
      'the parked task this would approve is not on this device',
    )
    expect(approveWhy(proposed, true, { kind: 'no', why: 'it is already picked up' })).toBe(
      'it is already picked up',
    )
    // A device without the act sees no control and no sentence about one.
    expect(approveWhy(proposed, false, { kind: 'off', why: '' })).toBe('')
    // The rest say where they stand in the line above; not a second time here.
    expect(approveWhy(row({ state: 'accepted' }), false, { kind: 'no', why: '' })).toBe('')
  })
})
