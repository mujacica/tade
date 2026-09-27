import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import { sameTarget, type Target } from '../src/hits.ts'
import {
  type AppState,
  focusTask,
  initialState,
  markOf,
  type QueuedView,
  queuedCount,
  queueOf,
  queueTree,
  queueViewOf,
  type ScheduleView,
  showPlan,
  showQueue,
  type TaskSnapshot,
  tasksOf,
  toggleSection,
  withProjects,
  withTasks,
} from '../src/model.ts'
import { queueEmptySays } from '../src/queue.ts'
import { narrowing, type QueueView, WHOLE_QUEUE } from '../src/queue-view.ts'
import { draw, renderApp } from '../src/view.ts'

// The SMART QUEUE: what it holds, what it shows of that, and how the side
// draws it.
//
// One file rather than a corner of `model.test.ts` and a corner of
// `view.test.ts`, because the two halves are one subject: what `shownBy` leaves
// out is what the controls above the list are for, and a change to either is a
// change to both. `queue.test.ts` is the queue's *words* — what it says to the
// orchestrator and to the journal — and stays where it is.

/** The same row without its colour, for comparing positions against columns. */
const plain = (row: string) =>
  row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

const frame = (over: Partial<Frame> = {}): Frame => ({
  width: 80,
  height: 24,
  screen: '',
  ...over,
})

/** The window every drawing here is measured against: three agents, nothing queued. */
const quietWindow = (): AppState =>
  withTasks(withProjects(initialState(), ['checkout', 'search']), [
    {
      task: 'checkout/stripe-v15',
      state: 'blocked',
      lane: 'checkout/stripe-v15/agent',
      waiting: true,
    },
    { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
    { task: 'search/pagination', state: 'review' },
  ])

describe('what the smart queue holds', () => {
  const queued = (
    task: string,
    state: QueuedView['state'],
    at: number | null = null,
  ): TaskSnapshot => ({
    task,
    state: 'queued',
    queued: { state, after: [], prompt: '', touches: [], at },
  })
  const plan: TaskSnapshot[] = [
    { task: 'app/working', state: 'working' },
    queued('app/later', { kind: 'scheduled', at: 2_000 }, 2_000),
    queued('app/soon', { kind: 'scheduled', at: 1_000 }, 1_000),
    queued('app/stopped', { kind: 'paused', all: false }),
    queued('app/after', { kind: 'waiting', on: ['app/working'] }),
    queued('app/stuck', { kind: 'held', on: 'app/working', because: 'app/working failed' }),
    queued('app/next', { kind: 'ready' }),
  ]

  it('is apart from the agents: what needs deciding first, then what starts soonest', () => {
    const state = withTasks(initialState(), plan)
    expect(tasksOf(state).map((task) => task.name)).toEqual(['working'])
    expect(queueOf(state).map((task) => task.name)).toEqual([
      'stuck',
      'next',
      'after',
      'soon',
      'later',
      'stopped',
    ])
    expect(queuedCount(state)).toBe(6)
    // Held is a decision nobody has made: it counts as waiting on you.
    expect(markOf(state.panes.find((pane) => pane.task === 'app/stuck') ?? plan[0]!)).toBe(
      'needs-you',
    )
  })

  it('shows how much of the tree, and work on a clock is work', () => {
    const state = withTasks(initialState(), plan)
    const shown = (view: Partial<QueueView>) =>
      queueOf(showQueue(state, view)).map((task) => task.name)
    // The scope is a position in the tree, and the only question there is.
    // `next` is its front: the one with room, the one whose only wait is an
    // agent working now — it starts when that agent finishes — and the two
    // waiting for a clock, which start by themselves too. Held and paused work
    // will not, so neither is next.
    expect(shown({})).toEqual(['stuck', 'next', 'after', 'soon', 'later', 'stopped'])
    expect(shown({ scope: 'next' })).toEqual(['next', 'after', 'soon', 'later'])
    // And nothing hides work waiting for a time: it starts once, when its time
    // comes, which is what everything else in this list does. The switch that
    // used to hide it was there because the schedules were listed beside it.
    expect(queuedCount(state)).toBe(6)
  })

  it('remembers what each project is showing, and only what was narrowed', () => {
    const state = withTasks(withProjects(initialState(), ['app', 'infra']), plan)
    expect(queueViewOf(state)).toEqual(WHOLE_QUEUE)
    const narrowed = showQueue(state, { scope: 'next' })
    expect(queueViewOf(narrowed)).toEqual({ scope: 'next' })
    // One project's choice is that project's: the other is untouched.
    expect(queueViewOf({ ...narrowed, project: 'infra' })).toEqual(WHOLE_QUEUE)
    expect(narrowing(WHOLE_QUEUE)).toBe(false)
    expect(narrowing({ scope: 'next' })).toBe(true)
  })

  it('says why nothing is next in the words of the reason there is nothing', () => {
    const says = (tasks: TaskSnapshot[], view: Partial<QueueView> = { scope: 'next' }) =>
      queueEmptySays(showQueue(withTasks(initialState(), tasks), view))
    expect(says([{ task: 'app/working', state: 'working' }])).toBe('nothing is queued')
    expect(
      says([
        { task: 'app/working', state: 'working' },
        queued('app/stuck', { kind: 'held', on: 'app/working', because: 'it failed' }),
      ]),
    ).toBe('nothing is next: stuck is held')
    // Behind held work is not next: what is at the front is what is stopping it.
    expect(
      says([
        queued('app/stuck', { kind: 'held', on: 'app/gone', because: 'it failed' }),
        queued('app/stopped', { kind: 'paused', all: false }),
      ]),
    ).toBe('nothing is next: what is at the front is held or paused')
    expect(says([queued('app/stopped', { kind: 'paused', all: false })])).toBe(
      'nothing is next: stopped is paused',
    )
    // Work waiting for a time is next like the rest of the front — it starts by
    // itself — so it is in the list, and this is never asked about it.
    expect(
      queueOf(
        showQueue(
          withTasks(initialState(), [queued('app/soon', { kind: 'scheduled', at: 1_000 }, 1_000)]),
          { scope: 'next' },
        ),
      ).map((task) => task.name),
    ).toEqual(['soon'])
    // And nothing here counts the schedules any more: they are their own
    // section, so a queue with nothing queued in it says so whatever is on a
    // clock next door.
    expect(says([])).toBe('nothing is queued')
    // `all` leaves nothing out, so an empty list is empty.
    expect(says(plan, {})).toBe('nothing is queued')
  })

  it('orders the queue by the resolved tree, each piece under what it waits on', () => {
    const chain: TaskSnapshot[] = [
      { task: 'app/fix', state: 'failed', reason: 'tests failed' },
      { task: 'app/mailer', state: 'working' },
      queued('app/typos', { kind: 'ready' }),
      queued('app/emails', { kind: 'waiting', on: ['app/refunds', 'app/mailer'] }),
      queued('app/refunds', { kind: 'held', on: 'app/fix', because: 'app/fix failed' }),
      queued('app/thanks', { kind: 'waiting', on: ['app/emails'] }),
    ]
    // What each waits on is in its plan, which is what the tree is read from.
    const withAfter = chain.map((task) =>
      task.queued
        ? {
            ...task,
            queued: {
              ...task.queued,
              after:
                task.task === 'app/emails'
                  ? [
                      { task: 'app/refunds', why: 'it emails what it returns' },
                      { task: 'app/mailer', why: 'send() changes' },
                    ]
                  : task.task === 'app/thanks'
                    ? [{ task: 'app/emails', why: 'it follows the email' }]
                    : task.task === 'app/refunds'
                      ? [{ task: 'app/fix', why: 'both change charge.ts' }]
                      : [],
            },
          }
        : task,
    )
    const state = withTasks(initialState(), withAfter)
    const tree = queueTree(state)
    // The held one is at the front of its path; what waits on it follows it,
    // however deep, before the work that only waits for room.
    expect(tree.map((row) => row.pane.name)).toEqual(['refunds', 'emails', 'thanks', 'typos'])
    expect(tree.map((row) => row.depth)).toEqual([0, 1, 2, 0])
    expect(tree.map((row) => row.parent)).toEqual([null, 'app/refunds', 'app/emails', null])
    // Next is the front of the tree that will start by itself: the one with
    // room. The held one needs a decision, and what is behind it is behind it.
    expect(queueOf(showQueue(state, { scope: 'next' })).map((task) => task.name)).toEqual(['typos'])
  })
})

describe('the smart queue down the side', () => {
  // A plan under way: one held, what waits on it, and one that only needs room.
  const plan: TaskSnapshot[] = [
    { task: 'checkout/fix-charge', state: 'failed', reason: 'tests failed twice' },
    {
      task: 'checkout/add-refunds',
      state: 'queued',
      queued: {
        state: { kind: 'held', on: 'checkout/fix-charge', because: 'checkout/fix-charge failed' },
        after: [{ task: 'checkout/fix-charge', why: 'both change charge.ts' }],
        prompt: 'add refunds',
        touches: [],
        at: null,
      },
    },
    {
      task: 'checkout/refund-emails',
      state: 'queued',
      queued: {
        state: { kind: 'waiting', on: ['checkout/add-refunds'] },
        after: [{ task: 'checkout/add-refunds', why: 'it emails what refund() returns' }],
        prompt: 'email the customer',
        touches: [],
        at: null,
      },
    },
    {
      task: 'checkout/docs-typos',
      state: 'queued',
      queued: { state: { kind: 'ready' }, after: [], prompt: 'fix typos', touches: [], at: null },
    },
  ]

  const queued = (over: Partial<AppState> = {}): AppState => ({
    ...withTasks(withProjects(initialState(), ['checkout']), plan),
    project: 'checkout',
    folded: ['changes', 'files', 'notes', 'where'],
    ...over,
  })

  /** A schedule in the project, which after the split is never in the queue's list. */
  const nightly: ScheduleView = {
    id: 'perf-nightly',
    name: 'perf nightly',
    project: 'checkout',
    said: '',
    kind: 'agent',
    does: 'starts an agent',
    prompt: 'run the benchmarks',
    when: 'every day at 02:00',
    once: false,
    next: [2_000],
    paused: false,
    by: 'you',
    missed: 'once',
    runs: [],
  }

  it('draws the scope as a pair, and nothing else over the queue', () => {
    const controls = (over: Partial<AppState> = {}, over2: Partial<Frame> = {}) =>
      renderApp(queued(over), frame({ width: 100, height: 40, ...over2 }))
        .map(plain)
        .find((row) => row.includes('all') && row.includes('next')) ?? ''
    // One question, one pair, one of them always on.
    expect(controls()).toContain('<all> [next]')
    // And the switch that used to sit beside it is gone: a schedule in the
    // project is not something the queue has a control over any more.
    expect(controls({}, { schedules: [nightly] })).not.toContain('timed')
  })

  it('keeps the schedules out of the queue and in a section of their own', () => {
    const rows = renderApp(queued(), frame({ width: 100, height: 60, schedules: [nightly] })).map(
      plain,
    )
    const at = (text: string) => rows.findIndex((row) => row.includes(text))
    // Two headings, in this order, and the schedule is under the second.
    expect(at('SMART QUEUE')).toBeGreaterThan(-1)
    expect(at('SCHEDULES')).toBeGreaterThan(at('SMART QUEUE'))
    // Its name is cut to the side's room, as every name down the side is.
    expect(at('↻ perf night')).toBeGreaterThan(at('SCHEDULES'))
    // The queue's own count is work, and only work: three pieces, not four.
    expect(rows[at('SMART QUEUE')]).toMatch(/SMART QUEUE +\(?3\)?/)
    expect(rows[at('SCHEDULES')]).toMatch(/SCHEDULES +\(?1\)?/)
    // What it does when it fires, which is the thing worth a column of its own.
    expect(rows[at('↻ perf night') + 1]).toContain('agents')
  })

  it('is there with no clockwork in it, folded, and says so', () => {
    const rows = renderApp(queued(), frame({ width: 160, height: 40 })).map(plain)
    const heading = rows.find((row) => row.includes('SCHEDULES')) ?? ''
    expect(heading).toContain('▸ SCHEDULES')
    expect(heading).toContain('nothing on a clock')
    // Folded is one row and no more.
    expect(rows.filter((row) => row.includes('SCHEDULES')).length).toBe(1)
  })

  it('shifts each piece right of what it waits on, and joins them with a line', () => {
    const rows = renderApp(queued(), frame({ width: 100, height: 40 })).map(plain)
    const side = (name: string) => rows.findIndex((row) => row.includes(name))
    // Down the side in the order the tree gives: the held one, what waits on
    // it under it, then the work that only waits for room.
    expect(side('add-refunds')).toBeLessThan(side('refund-emails'))
    expect(side('refund-emails')).toBeLessThan(side('docs-typos'))
    const child = rows[side('refund-emails')] ?? ''
    // Hanging off what it waits on, and further right than it.
    expect(child).toContain('╰─')
    expect(child.indexOf('refund-emails')).toBeGreaterThan(
      (rows[side('add-refunds')] ?? '').indexOf('add-refunds'),
    )
    // The line carries on through the room between the two tabs.
    expect(
      rows.slice(side('add-refunds'), side('refund-emails')).some((row) => row.includes('│')),
    ).toBe(true)
  })

  it('puts a piece in the column its priority gives it, however deep the chain', () => {
    // Six deep, in a side too narrow for the indent alone.
    const deep: TaskSnapshot[] = [
      { task: 'keys/one', state: 'working', lane: 'keys/one/agent' },
      ...['two', 'three', 'four', 'five', 'six'].map((task, i) => ({
        task: `keys/${task}`,
        state: 'queued' as const,
        queued: {
          state: {
            kind: 'waiting' as const,
            on: [`keys/${['one', 'two', 'three', 'four', 'five'][i]}`],
          },
          after: [
            { task: `keys/${['one', 'two', 'three', 'four', 'five'][i]}`, why: 'it follows' },
          ],
          prompt: 'do it',
          touches: [],
          at: null,
        },
      })),
    ]
    const state: AppState = {
      ...withTasks(withProjects(initialState(), ['keys']), deep),
      project: 'keys',
      folded: ['changes', 'files', 'notes', 'where'],
    }
    const drawn = draw(state, frame({ width: 96, height: 44 }))
    const rows = drawn.rows.map(plain)
    const at = (name: string) => {
      const row = rows.find((one) => one.includes(`◌ ${name}`)) ?? ''
      return row.indexOf(`◌ ${name}`)
    }
    // A column each, all the way down: never two of them folded into one.
    const columns = ['two', 'three', 'four', 'five', 'six'].map(at)
    for (const column of columns) expect(column).toBeGreaterThan(0)
    for (let i = 1; i < columns.length; i++) {
      expect(columns[i]).toBe((columns[i - 1] ?? 0) + 2)
    }
    // Which means the tree reaches past the side, so there is a bar to reach
    // the rest of it — and it lies along the bottom of the side.
    const bar = drawn.hits.filter(
      (hit) =>
        hit.target.kind === 'scrollbar' && hit.target.area === 'sidebar' && hit.target.across,
    )
    expect(bar.length).toBe(1)

    // Dragged sideways, every row moves by the same columns: the tree keeps
    // its shape, and the names the indent had pushed off the edge arrive.
    const moved = draw({ ...state, across: 8 }, frame({ width: 96, height: 44 })).rows.map(plain)
    const rowOf = (name: string) => rows.findIndex((one) => one.includes(`◌ ${name}`))
    // The deepest one, which the indent had pushed furthest right, is eight
    // columns further left — mark, stem and all.
    const last = rowOf('six')
    expect((rows[last] ?? '').indexOf('◌ six') - (moved[last] ?? '').indexOf('◌ six')).toBe(8)
    // And nothing went the other way: the whole tree moved together.
    for (const name of ['two', 'three', 'four', 'five']) {
      const row = rowOf(name)
      const before = (rows[row] ?? '').indexOf(name)
      const after = (moved[row] ?? '').indexOf(name)
      expect(after).toBeLessThan(before)
    }
  })

  it('never puts a bar along the bottom of a side whose tree already fits', () => {
    const drawn = draw(queued(), frame({ width: 140, height: 44 }))
    expect(
      drawn.hits.some(
        (hit) =>
          hit.target.kind === 'scrollbar' && hit.target.area === 'sidebar' && hit.target.across,
      ),
    ).toBe(false)
  })

  it('draws the chain a piece of queued work is in, and lets you click along it', () => {
    const drawn = draw(focusTask(queued(), 'checkout/refund-emails'), {
      ...frame({ width: 140, height: 44 }),
    })
    const text = drawn.rows.map(plain).join('\n')
    expect(text).toContain('THE CHAIN IT IS IN')
    // A box per piece of the path, the one in front of you drawn heavier.
    expect(text).toContain('┏')
    expect(text).toContain('fix-charge')
    expect(text).toContain('WHY IT WAITS')
    expect(text).toContain('it emails what refund() returns')
    // Every box in the chain is a way to go to what it is a box of.
    const drawnBoxes = new Set(
      drawn.rows
        .map((row, i) => (/[╭┏][─━]{3}/.test(plain(row)) ? i : -1))
        .filter((row) => row >= 0),
    )
    expect(drawnBoxes.size).toBeGreaterThan(0)
    const clicks = drawn.hits.filter(
      (hit) =>
        hit.target.kind === 'task' &&
        hit.target.task === 'checkout/fix-charge' &&
        drawnBoxes.has(hit.row),
    )
    expect(clicks.length).toBeGreaterThan(0)
  })

  it('says why it waits as the chain it is, in the order it runs', () => {
    const drawn = draw(focusTask(queued(), 'checkout/refund-emails'), {
      ...frame({ width: 140, height: 44 }),
    })
    // What the middle of the window holds, without the sidebar beside it.
    const rows = drawn.rows.map((row) => plain(row).replace(/^.*?[▕█]│/, ''))
    const from = rows.findIndex((row) => row.includes('WHY IT WAITS'))
    const why = rows.slice(from + 1, from + 6).map((row) => row.slice(2).trimEnd())
    // The front of the chain first, then what waits on it, shifted right of it
    // and joined to it — never a flat list in whatever order the names fell in.
    expect(why.slice(0, 5)).toEqual([
      '✕ fix-charge',
      '╰─! add-refunds  after fix-charge',
      '  │ both change charge.ts',
      '  ╰─◌ refund-emails  after add-refunds',
      '      it emails what refund() returns',
    ])
    // Each name in it goes to the work it names.
    const at = drawn.hits.filter(
      (hit) =>
        hit.row === from + 2 &&
        hit.target.kind === 'task' &&
        hit.target.task === 'checkout/add-refunds',
    )
    expect(at.length).toBeGreaterThan(0)
  })

  it('wraps a wait’s reason into a narrow panel rather than off the edge', () => {
    const drawn = draw(focusTask(queued(), 'checkout/refund-emails'), {
      ...frame({ width: 74, height: 44 }),
    })
    const rows = drawn.rows.map(plain)
    const from = rows.findIndex((row) => row.includes('WHY IT WAITS'))
    expect(from).toBeGreaterThan(0)
    // It is still the tree, and every row of it still fits the window.
    expect(rows.slice(from).some((row) => row.includes('╰─◌ refund-emails'))).toBe(true)
    for (const row of drawn.rows) expect(visibleWidth(row)).toBe(74)
  })

  it('keeps the boxes when the chain is wider than the pane, and a bar to reach the rest', () => {
    const state = focusTask(queued(), 'checkout/refund-emails')
    const drawn = draw(state, { ...frame({ width: 74, height: 44 }) })
    const rows = drawn.rows.map(plain)
    // Three tight boxes and the room between them are more than this pane
    // has — and they are drawn anyway, heading, arrows and all.
    expect(rows.some((row) => row.includes('THE CHAIN IT IS IN'))).toBe(true)
    expect(rows.some((row) => row.includes('╭───'))).toBe(true)
    // Never the flat list of names it used to fall back to.
    expect(rows.some((row) => row.includes('WAITS ON'))).toBe(false)
    const bar = drawn.hits.filter(
      (hit) => hit.target.kind === 'scrollbar' && hit.target.area === 'plan',
    )
    expect(bar.length).toBe(1)
    expect(bar[0]?.target).toMatchObject({ across: true })

    // Dragged sideways, the picture moves and the far end of the chain arrives.
    const far = draw({ ...state, planAcross: 40 }, { ...frame({ width: 74, height: 44 }) })
    const seen = far.rows.map(plain)
    expect(seen.some((row) => row.includes('refund-emails'))).toBe(true)
    expect(seen.join('\n')).not.toBe(rows.join('\n'))
    for (const row of far.rows) expect(visibleWidth(row)).toBe(74)
  })

  it('offers the plan on its heading, and only where there is a plan', () => {
    // The whole route into the plan view, held to end to end: the heading
    // offers `queue-plan`, and `queue-plan` is what shows the plan. It was
    // built as `action` where `Section` has `actions` — a key a spread let
    // through unchecked — so the button was never drawn and the view behind
    // it could not be reached at all.
    const plan: Target = { kind: 'action', name: 'queue-plan' }
    const drawn = draw(queued(), frame({ width: 160, height: 40 }))
    const offered = drawn.hits.find((hit) => sameTarget(hit.target, plan))
    expect(offered).toBeDefined()
    // On the heading, where the section it belongs to is.
    const heading = drawn.rows.findIndex((row) => plain(row).includes('SMART QUEUE'))
    expect(offered?.row).toBe(heading)
    expect(plain(drawn.rows[heading] ?? '')).toContain('plan')

    // Pressed, it draws the plan where an agent's screen was.
    const rows = renderApp(showPlan(queued()), frame({ width: 160, height: 40 })).map(plain)
    expect(rows.some((row) => row.includes('checkout › plan'))).toBe(true)

    // Work that waits on nothing and that nothing waits on is not a plan, and
    // then there is nothing to offer.
    const alone = draw(
      queued({
        ...withTasks(withProjects(initialState(), ['checkout']), [
          { task: 'checkout/docs-typos', state: 'working', lane: 'checkout/docs-typos/agent' },
        ]),
      }),
      frame({ width: 160, height: 40 }),
    )
    expect(alone.hits.some((hit) => sameTarget(hit.target, plan))).toBe(false)
  })

  it('is there with nothing in it, folded, and its heading says why', () => {
    // Nothing queued and nothing scheduled: the section used to be missing
    // altogether, which is the thing a person cannot find when they look.
    const quiet = { ...quietWindow(), folded: ['changes', 'files', 'notes', 'where'] }
    const rows = renderApp(quiet, frame({ width: 160, height: 40 })).map(plain)
    const heading = rows.find((row) => row.includes('SMART QUEUE')) ?? ''
    expect(heading).toContain('▸ SMART QUEUE')
    // In the words of the reason it actually is, not one sentence for every case.
    expect(heading).toContain(queueEmptySays(quiet))
    // Folded is one row and no more: nothing of the list under it.
    expect(rows.filter((row) => row.includes('SMART QUEUE')).length).toBe(1)
  })

  it('says as much of why as a narrow side has room for, never nothing at all', () => {
    const quiet = { ...quietWindow(), folded: ['changes', 'files', 'notes', 'where'] }
    const heading = (width: number) =>
      renderApp(quiet, frame({ width, height: 40 }))
        .map(plain)
        .find((row) => row.includes('SMART QUEUE')) ?? ''
    // A side too narrow for the sentence still says the count in words.
    expect(heading(100)).toMatch(/SMART QUEUE +none/)
    expect(heading(160)).toContain('nothing is queued')
  })

  it('opens where it is pressed, and what it opened stays open with nothing in it', () => {
    const quiet = { ...quietWindow(), folded: ['changes', 'files', 'notes', 'where'] }
    const drawn = draw(quiet, frame({ width: 160, height: 40 }))
    const at = drawn.hits.find(
      (hit) => hit.target.kind === 'section' && hit.target.section === 'queue',
    )
    // The heading carries what the drawing found, so the press and the paint
    // can never read the emptiness differently.
    expect(at?.target).toEqual({ kind: 'section', section: 'queue', quiet: true })
    const open = toggleSection(quiet, 'queue', true)
    expect(open.opened).toContain('queue')
    const after = renderApp(open, frame({ width: 160, height: 40 })).map(plain)
    expect(after.some((row) => row.includes('▾ SMART QUEUE'))).toBe(true)
    // And the reason is the whole of what the open section is for.
    expect(after.some((row) => row.includes('nothing is queued'))).toBe(true)
  })

  it('stays folded when you fold it with work waiting in it', () => {
    const shut = toggleSection(queued(), 'queue', false)
    expect(shut.folded).toContain('queue')
    const rows = renderApp(shut, frame({ width: 100, height: 40 })).map(plain)
    // The count stays on the heading: what was put away is still there.
    expect(rows.find((row) => row.includes('SMART QUEUE'))).toMatch(/▸ SMART QUEUE +\(?3\)?/)
    expect(rows.some((row) => row.includes('add-refunds'))).toBe(false)
  })
})
