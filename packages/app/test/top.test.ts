import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import {
  type AppState,
  initialState,
  selectProject,
  type TaskSnapshot,
  withProjects,
  withTasks,
} from '../src/model.ts'
import { COLOUR } from '../src/skin.ts'
import { NO_POINTER } from '../src/ui.ts'
import { projectSays, projectStandings, renderTop, tabsShown } from '../src/view/top.ts'

// What the row along the top says about the projects you are not looking at.
//
// Two projects and two plain names said nothing at all: which one the spinner
// at the right belonged to, whether anything in the other wanted you, whether
// what you asked for in it was finished. Each tab carries its own marks now,
// and the figures at the right say whose they are.

const frame = (over: Partial<Frame> = {}): Frame =>
  ({
    width: 160,
    height: 24,
    screen: '',
    skin: COLOUR,
    now: 0,
    voice: { keys: ['ctrl', 'space'], available: true },
    ...over,
  }) as Frame

const world = (tasks: TaskSnapshot[], projects = ['checkout', 'search', 'infra']): AppState =>
  withTasks(withProjects(initialState(), projects), tasks)

const strip = (state: AppState, width = 160): string =>
  stripTerminalSequences(
    renderTop(state, frame({ width }), width, COLOUR, NO_POINTER).rows[0] ?? '',
  )

const working: TaskSnapshot = {
  task: 'checkout/refunds',
  state: 'working',
  lane: 'checkout/refunds/agent',
}
const wantsYou: TaskSnapshot = {
  task: 'checkout/stripe-v15',
  state: 'blocked',
  lane: 'checkout/stripe-v15/agent',
  waiting: true,
  approval: { tool: 'bash', summary: 'npm i stripe@15' },
}
const finished: TaskSnapshot = { task: 'search/pagination', state: 'review' }
const held: TaskSnapshot = {
  task: 'infra/rotate-keys',
  state: 'queued',
  queued: {
    state: { kind: 'held', on: 'infra/bump-node', because: 'infra/bump-node failed' },
    after: [{ task: 'infra/bump-node', why: 'both change the Dockerfile' }],
    prompt: 'Rotate the deploy keys.',
    touches: ['deploy/'],
    at: null,
  },
}

describe('what a project tab counts', () => {
  it('reads every mark the agent list reads, project by project', () => {
    const standings = projectStandings(world([working, wantsYou, finished]))
    expect(standings.get('checkout')?.counts).toMatchObject({ working: 1, 'needs-you': 1, done: 0 })
    expect(standings.get('search')?.counts).toMatchObject({ done: 1, working: 0 })
    // Nothing has been asked of it, so it has no standing at all — which is
    // not the same as everything in it being finished.
    expect(standings.get('infra')).toBeUndefined()
  })

  it('counts queued work, which is not an agent and has no mark of its own', () => {
    const queued: TaskSnapshot = {
      task: 'infra/tidy-logs',
      state: 'queued',
      queued: {
        state: { kind: 'ready' },
        after: [],
        prompt: 'Tidy the logs.',
        touches: [],
        at: null,
      },
    }
    const standings = projectStandings(world([queued]))
    expect(standings.get('infra')?.counts.queued).toBe(1)
    expect(standings.get('infra')?.counts.stopped).toBe(0)
  })

  it('counts held work as something waiting on you, the way the queue draws it', () => {
    const standings = projectStandings(world([held]))
    expect(standings.get('infra')?.counts['needs-you']).toBe(1)
    expect(standings.get('infra')?.counts.queued).toBe(0)
  })

  it('counts paused work as set aside, not as waiting its turn', () => {
    const paused: TaskSnapshot = {
      ...held,
      queued: { ...held.queued!, state: { kind: 'paused', all: false } },
    }
    expect(projectStandings(world([paused])).get('infra')?.counts.parked).toBe(1)
  })

  it('settles only where something finished and nothing is left', () => {
    const all = projectStandings(world([working, finished]))
    expect(all.get('search')?.settled).toBe(true)
    expect(all.get('checkout')?.settled).toBe(false)
    // A turn that ended is not a task that finished: an idle agent holds it open.
    const idle: TaskSnapshot = { task: 'search/rankings', state: 'blocked', reason: 'idle' }
    expect(projectStandings(world([finished, idle])).get('search')?.settled).toBe(false)
  })
})

describe('the project tabs', () => {
  it('says what is happening in each one, in marks and counts', () => {
    const text = strip(world([working, wantsYou, finished, held]))
    expect(text).toContain('checkout ! ⠋')
    expect(text).toContain('search ✓')
    expect(text).toContain('infra !')
  })

  it('answers "is everything I asked for done in there?" without going there', () => {
    expect(strip(world([working, finished]))).toContain('search ✓')
  })

  it('says nothing about a project nothing has been asked of', () => {
    const text = strip(world([working]))
    // Its own buttons after it and then the `+`, and nothing between the name
    // and them: no mark, no count, no tick.
    expect(text).toMatch(/infra\s+×\s+≡\s+\+/)
  })

  it('counts where a count is a number you could not have guessed', () => {
    const more: TaskSnapshot[] = [
      working,
      { task: 'checkout/mailer', state: 'working', lane: 'checkout/mailer/agent' },
      { task: 'checkout/ledger', state: 'working', lane: 'checkout/ledger/agent' },
    ]
    expect(strip(world(more))).toContain('checkout ⠋3')
    expect(strip(world([working]))).toContain('checkout ⠋')
  })

  it('gives up its counts, then all but its busiest mark, as the room runs out', () => {
    const state = world([working, wantsYou, finished, held])
    const said = (width: number) => strip(state, width)
    expect(said(160)).toContain('checkout ! ⠋')
    // Narrower: the marks lose the spaces between them, then everything but
    // the first — which is the most urgent, because that is the order.
    expect(said(120)).toContain('checkout !⠋')
    expect(said(96)).not.toContain('checkout !⠋')
    expect(said(96)).toMatch(/checkout !\s/)
  })
})

describe('the figures at the right', () => {
  it('says whose they are where there is more than one project', () => {
    expect(strip(world([working, wantsYou]))).toContain('in checkout')
    expect(strip(world([working, { ...wantsYou, task: 'search/pagination' }]))).toContain(
      'in 2 projects',
    )
  })

  it('names the project the spinner belongs to, not the one you are in', () => {
    const text = strip(world([{ ...working, task: 'search/pagination' }]))
    expect(text).toContain('in search')
  })

  it('leaves the clause off where there is only one project to mean', () => {
    const text = strip(world([working, wantsYou], ['checkout']))
    expect(text).toContain('1 working')
    expect(text).not.toContain(' in ')
  })

  it('draws no total at all where there is no room to say whose it is', () => {
    // A figure nobody can place is the spinner this started as: short of room
    // the total is what goes, and the tabs carry the answer alone.
    const text = strip(world([working, wantsYou, finished]), 96)
    expect(text).not.toContain('! 1')
    expect(text).toContain('checkout !')
    expect(text).toContain('search ✓')
  })
})

describe('Tade’s own MCP server, as the light along the top', () => {
  const lit = (mcp: Frame['mcp'], width = 160): string =>
    stripTerminalSequences(
      renderTop(world([]), frame({ width, mcp }), width, COLOUR, NO_POINTER).rows[0] ?? '',
    )

  it('is not there at all where no agent takes its tools that way', () => {
    // pi is handed Tade's tools directly rather than over MCP, so a window with
    // only pi agents in it has no server of this kind to be lit about.
    expect(lit(undefined)).not.toContain('mcp')
    expect(lit({ expected: 0, alive: 0, looked: true })).not.toContain('mcp')
  })

  it('is a quiet dot while every agent still has its tools', () => {
    expect(lit({ expected: 4, alive: 4, looked: true })).toContain('● mcp')
  })

  it('says how many agents have lost their tools, which is the drop', () => {
    // One of four gone and all four gone are different mornings, so the lamp
    // says which: the count is the part you could not have guessed.
    expect(lit({ expected: 4, alive: 3, looked: true })).toContain('✕ mcp 1 down')
    expect(lit({ expected: 4, alive: 0, looked: true })).toContain('✕ mcp 4 down')
  })

  it('never draws a scan that could not look as every server having gone', () => {
    // A `ps` that lost its race with four agents running a suite is not four
    // dead servers, and a lamp that cried wolf then would be worth nothing.
    const text = lit({ expected: 4, alive: 0, looked: false })
    expect(text).toContain('◌ mcp')
    expect(text).not.toContain('down')
    expect(text).not.toContain('✕')
  })

  it('is a dot and never a complaint where more are alive than were expected', () => {
    // A run that has just ended still has its server for a moment, so `alive`
    // can lead `expected`. That is not news, and must not read as one.
    expect(lit({ expected: 1, alive: 2, looked: true })).toContain('● mcp')
  })

  it('gives up the word beside it before the label, which says which lamp it is', () => {
    // Swept rather than asserted at one width: which rung of the ladder a
    // width lands on is the tabs' business and moves when they do, and what
    // this is about is the order the lamp gives ground in. A bare `✕` beside
    // the talk key is a mark nobody can place — this row already has one on it
    // for a muted speaker — so the label outlives the word every time.
    const forms = new Set<string>()
    for (let width = 40; width <= 200; width++) {
      const text = lit({ expected: 2, alive: 1, looked: true }, width)
      if (!text.includes('✕')) continue
      expect(text, `at ${width} columns`).toContain('✕ mcp')
      forms.add(text.includes('1 down') ? 'with the count' : 'the label alone')
    }
    expect([...forms].sort()).toEqual(['the label alone', 'with the count'])
  })

  it('goes to the Extensions page, which is where everything about tools lives', () => {
    const width = 160
    const drawn = renderTop(
      world([]),
      frame({ width, mcp: { expected: 1, alive: 0, looked: true } }),
      width,
      COLOUR,
      NO_POINTER,
    )
    expect(
      drawn.hits.some((hit) => hit.target.kind === 'action' && hit.target.name === 'extensions'),
    ).toBe(true)
  })
})

// More projects than the row has room for.
//
// It used to be cut off at the edge of the terminal: the last tab half drawn,
// the `+` gone, the marks gone, and the talk key — the one thing on this row
// that must survive a narrow window — gone with them. Twelve projects at 120
// columns drew `checkout search infra … platfor` and nothing else at all.

const TWELVE = [
  'checkout',
  'search',
  'infra',
  'docs',
  'payments',
  'billing',
  'identity',
  'mobile',
  'analytics',
  'platform',
  'ledger',
  'webhooks',
]

describe('more projects than room', () => {
  const crowded = (at?: string): AppState => {
    const state = world([working, wantsYou, finished, held], TWELVE)
    return at === undefined ? state : selectProject(state, at)
  }
  const drawnAt = (width: number, at?: string) =>
    renderTop(crowded(at), frame({ width }), width, COLOUR, NO_POINTER)
  const row = (width: number, at?: string): string => strip(crowded(at), width)

  it('keeps the ones arranged first, and never leaves out the one you are in', () => {
    expect(tabsShown(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['a', 'b'])
    expect(tabsShown(['a', 'b', 'c', 'd'], 'd', 2)).toEqual(['a', 'd'])
    expect(tabsShown(['a', 'b', 'c', 'd'], 'd', 1)).toEqual(['d'])
    // Room for more than there are is all of them; and no room at all is still
    // the one you are standing in, because a row with no tab for where you are
    // is not a shortened row, it is a wrong one.
    expect(tabsShown(['a', 'b'], 'a', 9)).toEqual(['a', 'b'])
    expect(tabsShown(['a', 'b', 'c'], 'c', 0)).toEqual(['c'])
  })

  it('says nothing about room while there is room for every tab', () => {
    expect(strip(world([working, finished]))).not.toContain('⋯')
  })

  it('puts the ones with no room in the `⋯` rather than cutting the row', () => {
    const text = row(120)
    expect(text).toContain('⋯')
    // The `+` is still there, and so is the talk key.
    expect(text).toContain('+')
    expect(text).toContain('space')
  })

  it('says how many have no tab, and that one of them wants you', () => {
    // The whole point of a tab is that an agent wanting you where you are not
    // looking says so, and `webhooks` is the twelfth of twelve: the `⋯` carries
    // the most urgent mark of everything behind it, so putting a tab away is
    // never putting a decision away.
    const far: TaskSnapshot = { ...wantsYou, task: 'webhooks/certs', lane: 'webhooks/certs/agent' }
    const text = strip(world([working, finished, far], TWELVE), 120)
    expect(text).not.toContain('webhooks')
    expect(text).toMatch(/⋯\d+ !/)
  })

  it('keeps the tab of the project you are in, last in the row or not', () => {
    expect(row(120, 'webhooks')).toContain('webhooks')
    expect(row(80, 'webhooks')).toContain('webhooks')
    expect(row(64, 'ledger')).toContain('ledger')
  })

  it('keeps a mark on every tab it does draw, rather than a row of plain names', () => {
    // Twelve names fit at 140 where twelve names and a glyph each do not, and
    // the row takes the glyphs: a tab that says nothing is the row this file
    // was written to be rid of.
    const text = row(140, 'checkout')
    expect(text).toMatch(/checkout\s+!/)
    expect(text).toContain('⋯')
  })

  it('draws exactly the width it was given, however many there are', () => {
    for (const width of [200, 160, 140, 120, 100, 80, 64]) {
      const drawn = drawnAt(width, 'webhooks')
      for (const line of drawn.rows) expect(visibleWidth(line), `${width} columns`).toBe(width)
    }
  })

  it('carries what a hidden tab was saying into the menu beside the row', () => {
    // A project put away keeps its marks and its counts: the menu says what the
    // tab would have, which is what makes putting one away a shortening of the
    // row rather than a hole in it.
    const standings = projectStandings(world([working, wantsYou], TWELVE))
    expect(projectSays(standings.get('checkout'), 0)).toBe('! ⠋')
    // Nothing has been asked of it, so there is nothing to say — which is not
    // the same as everything in it being done.
    expect(projectSays(standings.get('ledger'), 0)).toBe('')
    expect(projectSays(undefined, 0)).toBe('')
  })

  it('offers the ones with no tab as a menu of exactly them', () => {
    // Nothing is cut from the program: every project is a tab or an item in
    // that menu, and never both.
    const drawn = drawnAt(120, 'webhooks')
    const hidden = drawn.hits.flatMap((hit) =>
      hit.target.kind === 'menu' && hit.target.subject.kind === 'projects'
        ? hit.target.subject.hidden
        : [],
    )
    const tabs = [
      ...new Set(
        drawn.hits.flatMap((hit) => (hit.target.kind === 'project' ? [hit.target.project] : [])),
      ),
    ]
    expect(hidden.length).toBeGreaterThan(0)
    expect(hidden.filter((name) => tabs.includes(name))).toEqual([])
    expect([...tabs, ...hidden].sort()).toEqual([...TWELVE].sort())
  })
})
