import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { drawPanel, type PanelContext } from '../src/panels/context.ts'
import { type SpendPanel, spendPanel } from '../src/panels/spend/state.ts'
import { nameLines, spendColumns } from '../src/panels/spend/view.ts'
import { COLOUR } from '../src/skin.ts'
import { type SpendBy, spendView } from '../src/spend.ts'

// What the Spend table has to be true at every width.
//
// The goldens say what it looks like on the terminal they were drawn on; these
// say what holds on every other one — that a name is never cut without saying
// so, never runs into the column beside it, and that the whole of it is
// reachable somewhere on the row. Two rows that read `openrouter/anthrop` and
// `anthropic/claude-o`, hard against the next column, is what these are for.

const NOW = Date.parse('2026-09-13T12:00:00.000Z')

let seq = 0
const usage = (over: Partial<TadeEvent> & { detail?: Record<string, unknown> } = {}): TadeEvent =>
  ({
    seq: ++seq,
    ts: '2026-09-13T11:00:00.000Z',
    type: 'usage',
    urgency: 'routine',
    task: 'checkout/refunds',
    lane: null,
    run: 'r1',
    ...over,
    detail: { model: 'claude-opus-5', tokens: 1000, usd: 1, priced: 'exact', ...over.detail },
  }) as TadeEvent

const run = (
  type: 'run_started' | 'run_exited' | 'run_model',
  over: Partial<TadeEvent> & { detail?: Record<string, unknown> } = {},
): TadeEvent =>
  ({
    seq: ++seq,
    ts: '2026-09-13T11:00:00.000Z',
    type,
    urgency: 'notable',
    task: 'checkout/refunds',
    lane: null,
    run: 'r1',
    ...over,
    detail: { ...over.detail },
  }) as TadeEvent

/**
 * A morning across three routes to one model: a subscription, an API key and a
 * router. The same weights, three different bills — which is the whole reason
 * the last three facets exist.
 */
const THREE_ROUTES: TadeEvent[] = [
  usage({
    run: 'r1',
    task: 'checkout/refunds',
    detail: {
      model: 'claude-opus-5',
      harness: 'claude-code',
      tokens: 400_000,
      usd: 0.5,
      priced: 'estimate',
    },
  }),
  usage({
    run: 'r2',
    task: 'checkout/stripe-v15',
    detail: {
      model: 'anthropic/claude-opus-5',
      harness: 'pi',
      provider: 'anthropic',
      tokens: 300_000,
      usd: 1.25,
      priced: 'exact',
    },
  }),
  usage({
    run: 'r3',
    task: 'search/pagination',
    detail: {
      model: 'openrouter/anthropic/claude-opus-5',
      harness: 'pi',
      account: 'work',
      provider: 'openrouter',
      tokens: 200_000,
      usd: 0.75,
      priced: 'exact',
    },
  }),
]

const viewBy = (by: SpendBy, events: readonly TadeEvent[] = THREE_ROUTES, runs: TadeEvent[] = []) =>
  spendView(events, {
    window: 'today',
    by,
    now: NOW,
    openedAt: NOW - 3_600_000,
    projects: ['checkout', 'search'],
    budgets: {},
    runs,
  })

const context = (over: Partial<PanelContext> = {}): PanelContext =>
  ({
    width: 120,
    height: 40,
    skin: COLOUR,
    pointer: { hover: null, pressed: null },
    home: '~/.tade',
    date: (at: number) => new Date(at).toISOString(),
    route: null,
    spend: null,
    panes: [],
    project: 'checkout',
    items: [],
    changes: [],
    ahead: null,
    branch: null,
    base: null,
    diff: null,
    choices: [],
    settings: [],
    accounts: [],
    updates: null,
    updatesBusy: false,
    lanesSurvive: false,
    configPath: '~/.tade/config.yaml',
    releases: true,
    budgetWarnings: 0,
    levels: [],
    openRows: [],
    browsing: null,
    homeDir: '/Users/me',
    entries: [],
    searching: false,
    viewing: null,
    talkKey: 'ctrl+space',
    talkMode: 'hold',
    bindings: {},
    running: 0,
    branches: [],
    checkout: null,
    found: 0,
    terminalName: 'terminal',
    extensions: [],
    harnessExtensions: [],
    servers: [],
    written: [],
    extensionView: null,
    setup: null,
    extensionsRoot: '~/.tade/extensions',
    models: [],
    modelTarget: 'the orchestrator',
    currentModel: null,
    ...over,
  }) as PanelContext

const drawn = (by: SpendBy, width: number, events: readonly TadeEvent[] = THREE_ROUTES) => {
  const panel: SpendPanel = { ...spendPanel(), by }
  return drawPanel(panel, context({ width, spend: viewBy(by, events) })).panel.rows.map((row) =>
    stripTerminalSequences(row),
  )
}

/** A drawn row without the box around it. */
const inside = (row: string) =>
  row
    .replace(/^[^\S\n]*│/, '')
    .replace(/│[^\S\n]*$/, '')
    .trim()

/** The widths worth trying: from a terminal nobody should use to a wide one. */
const WIDTHS = [48, 56, 64, 72, 80, 96, 120, 160]

describe('grouping what it cost', () => {
  it('tells three routes to one model apart by harness, sign-in and provider', () => {
    // One model, so one row: `claude-opus-5`, `anthropic/claude-opus-5` and
    // `openrouter/anthropic/claude-opus-5` are the same weights spelled by
    // three harnesses, and added up by the string one agent became three.
    expect(viewBy('model').rows.map((row) => [row.label, row.usd])).toEqual([
      ['claude-opus-5', 2.5],
    ])
    // What differs is the route, and that is what the three facets below say.

    const harness = viewBy('harness').rows
    expect(harness.map((row) => [row.label, row.usd])).toEqual([
      ['pi', 2],
      ['claude-code', 0.5],
    ])
    expect(viewBy('account').rows.map((row) => row.label)).toEqual([
      'pi',
      'pi @work',
      'claude-code',
    ])
    expect(viewBy('provider').rows.map((row) => [row.label, row.usd])).toEqual([
      ['anthropic', 1.25],
      ['openrouter', 0.75],
      // The subscription turn named no provider, and nothing guesses one out
      // of the model's name.
      ['not recorded', 0.5],
    ])
  })

  it('reads the facets off the run when the usage event carries none', () => {
    const events = [usage({ run: 'r7', detail: { usd: 2, priced: 'exact' } })]
    const runs = [
      run('run_started', { run: 'r7', detail: { adapter: 'codex', account: 'work' } }),
      run('run_exited', { run: 'r7' }),
    ]
    expect(viewBy('harness', events, runs).rows.map((row) => row.label)).toEqual(['codex'])
    expect(viewBy('account', events, runs).rows.map((row) => row.label)).toEqual(['codex @work'])
  })

  it('says what an unrecorded row is, rather than naming a thing that does not exist', () => {
    const events = [usage({ run: null, detail: { model: undefined, usd: 0, tokens: 500 } })]
    const [row] = viewBy('model', events).rows
    expect(row?.label).toBe('not recorded')
    expect(row?.note).toBe('no model was written down for these runs')
  })

  it("names the harness's own sign-in as its own, not as an account", () => {
    const [row] = viewBy('account', [
      usage({ detail: { harness: 'claude-code', usd: 1, priced: 'exact' } }),
    ]).rows
    expect(row?.label).toBe('claude-code')
    expect(row?.note).toBe("the harness's own sign-in")
  })

  it('puts an agent\u2019s hours and its money in the same row', () => {
    // The shape of the journal this was reported from: money written under
    // every spelling there is, runs timed under a fourth, and 86 of 161 runs
    // that named no model at all. It drew four model rows, one carrying
    // 742.8M tokens and another 12d 8h of runtime with 17M beside it, and an
    // `unknown` row holding 18h 48m of nobody's hours.
    const hour = 3_600_000
    const ran = (id: string, over: Record<string, unknown> = {}) => [
      run('run_started', { run: id, task: `checkout/${id}`, ...over }),
      run('run_exited', {
        run: id,
        task: `checkout/${id}`,
        ts: new Date(NOW - hour).toISOString(),
      }),
    ]
    const spent = (id: string, model: string | undefined) =>
      usage({ run: id, task: `checkout/${id}`, detail: { model, tokens: 1000, usd: 1 } })
    const runs = [
      // Asked for one spelling, billed under another: one agent, one row.
      ...ran('r1', {
        ts: new Date(NOW - 3 * hour).toISOString(),
        detail: { model: 'anthropic/claude-opus-5' },
      }),
      // Nothing asked for — pi picks by what you are signed in to — and what
      // it picked said so before it did any work.
      ...ran('r2', { ts: new Date(NOW - 3 * hour).toISOString() }),
      run('run_model', {
        run: 'r2',
        task: 'checkout/r2',
        ts: new Date(NOW - 3 * hour).toISOString(),
        detail: { model: 'claude-opus-5', modelId: 'openrouter/anthropic/claude-opus-5' },
      }),
      // And one nothing ever said anything about.
      ...ran('r3', { ts: new Date(NOW - 3 * hour).toISOString() }),
    ]
    const view = spendView(
      [spent('r1', 'claude-opus-5'), spent('r2', 'openrouter/anthropic/claude-opus-5')],
      {
        window: 'today',
        by: 'model',
        now: NOW,
        openedAt: NOW - 4 * hour,
        projects: ['checkout'],
        budgets: {},
        runs,
      },
    )
    expect(view.rows.map((row) => row.label)).toEqual(['claude-opus-5', 'not recorded'])
    const [model, nobody] = view.rows
    // One row holding both halves of both agents, rather than four holding one
    // half each.
    expect(model?.tokens).toBe(2000)
    expect(model?.runtime?.ms).toBe(4 * hour)
    expect(model?.runtime?.runs).toBe(2)
    // What is genuinely unknown stays unknown, and says which it is.
    expect(nobody?.runtime?.ms).toBe(2 * hour)
    expect(nobody?.tokens).toBe(0)
    expect(nobody?.note).toBe('no model was written down for these runs')
  })

  it('keeps priced money apart from estimated, on the row and in the total', () => {
    const view = viewBy('harness')
    expect(view.rows.find((row) => row.label === 'pi')?.priced).toBe('exact')
    expect(view.rows.find((row) => row.label === 'claude-code')?.priced).toBe('estimate')
    expect(view.priced).toBe('mixed')
    expect(view.usdExact).toBe(2)
    expect(view.usdEstimated).toBe(0.5)
  })
})

describe('a long name at any width', () => {
  /**
   * The longest name this table draws, which is a task's: a model is one row
   * under its own name now, so `openrouter/anthropic/claude-opus-5` is never
   * a label — but a name is still the one column that cannot be abbreviated
   * without lying, and an agent's is as long as somebody's title.
   */
  const LONGEST = 'checkout/orchestrator-extension-tools-gap'
  const LONG_NAMES: TadeEvent[] = [usage({ run: 'r9', task: LONGEST })]

  it('never draws a box wider than the terminal', () => {
    for (const width of WIDTHS) {
      const widths = new Set(drawn('model', width).map((row) => visibleWidth(row)))
      expect([...widths], `at ${width}`).toHaveLength(1)
      expect([...widths][0] ?? 0, `at ${width}`).toBeLessThanOrEqual(width)
    }
  })

  it('shows the whole of the longest name, or says it cut it', () => {
    for (const width of WIDTHS) {
      const rows = drawn('agent', width, LONG_NAMES)
      const whole = rows.some((row) => row.includes(LONGEST))
      // Not shown whole means shown in pieces — wrapped onto a second line —
      // and past that ellipsised, which says so. What may never happen is a
      // name that simply stops.
      const pieces = rows.some((row) => row.includes('…')) || wrapped(rows, LONGEST)
      expect(whole || pieces, `at ${width}`).toBe(true)
    }
  })

  it('never lets a name run into the column beside it', () => {
    for (const width of WIDTHS) {
      // The tokens column is the first figure after the name. Every row that
      // has one has at least one clear column before it.
      for (const row of drawn('agent', width, LONG_NAMES)) {
        const at = row.search(/\d+k|\d+\.\d+M/)
        if (at <= 0) continue
        expect(row.slice(Math.max(0, at - 1), at), `at ${width}: ${row}`).toBe(' ')
      }
    }
  })

  it('gives the name the room the model column was wasting', () => {
    // In the Agent view the second column says which model that agent ran on,
    // which is worth its width. Beside a model it repeats the name column, and
    // beside a harness or a provider it averages over rows that ran on many.
    for (const width of WIDTHS) {
      const inner = Math.min(84, width - 4) - 2
      const model = spendColumns(inner, 'model')
      const agent = spendColumns(inner, 'agent')
      expect(model.model, `at ${width}`).toBe(0)
      expect(spendColumns(inner, 'harness').model, `at ${width}`).toBe(0)
      expect(model.name, `at ${width}`).toBeGreaterThanOrEqual(agent.name)
      // Wherever the Agent view can afford that column, the room it costs is
      // room the Model view spends on the name instead.
      if (agent.model > 0) expect(model.name, `at ${width}`).toBeGreaterThan(agent.name)
    }
  })

  it('wraps a name onto a second line before it ellipsises one', () => {
    // Its own string: this is the wrapper, not the table, and what it has to
    // hold is that two lines are tried before anything is thrown away.
    const name = 'openrouter/anthropic/claude-opus-5'
    expect(nameLines(name, null, 20)).toEqual([
      { text: 'openrouter/anthropic', note: false },
      { text: '/claude-opus-5', note: false },
    ])
    // Past two lines it is cut, and the cut is marked.
    const tiny = nameLines(name, null, 8)
    expect(tiny).toHaveLength(2)
    expect(tiny.at(-1)?.text.endsWith('…')).toBe(true)
    // A note is its own line, in its own tone: `not recorded` is not an agent.
    expect(nameLines('not recorded', 'no model was written down', 30)).toEqual([
      { text: 'not recorded', note: false },
      { text: 'no model was written down', note: true },
    ])
  })

  it('keeps every grouping reachable, however narrow the panel', () => {
    for (const width of WIDTHS) {
      const rows = drawn('agent', width).join('\n')
      for (const label of ['Agent', 'Project', 'Model', 'Harness', 'Sign-in', 'Provider']) {
        expect(rows, `at ${width}`).toContain(label)
      }
    }
  })

  it('marks estimated money where it is read, and says how much at the foot', () => {
    const rows = drawn('harness', 96).join('\n')
    // The estimating harness's row carries the mark; the pricing one does not.
    expect(rows).toMatch(/~\$0\.50/)
    expect(rows).toMatch(/[^~]\$2\.00/)
    // And the foot is the mark and the figure, not the paragraph it was:
    // `tade spend` says the whole of it, which is where somebody asks.
    expect(rows).toContain('~ $0.50 estimated')
    expect(rows).not.toContain('priced by the harness')
  })
})

/**
 * Whether the name was drawn across two lines: one row holds a prefix of it
 * (the figures of that row follow, so it is not the end of the line) and the
 * next begins with the rest. Split anywhere — where the wrap falls is the
 * wrapper's business, and a test that knew would break on a rename.
 */
function wrapped(rows: readonly string[], name: string): boolean {
  for (let at = 1; at < name.length; at++) {
    const head = name.slice(0, at)
    const tail = name.slice(at)
    for (let line = 0; line + 1 < rows.length; line++) {
      if (!(rows[line] ?? '').includes(head)) continue
      if (inside(rows[line + 1] ?? '') === tail) return true
    }
  }
  return false
}
