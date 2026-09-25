import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { drawPanel, type PanelContext } from '../src/panels/context.ts'
import { type SpendPanel, spendPanel } from '../src/panels/spend/state.ts'
import { nameLines, SPEND_WIDTH, spendColumns } from '../src/panels/spend/view.ts'
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
  type: 'run_started' | 'run_exited' | 'run_model' | 'turn_started' | 'turn_done',
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

/**
 * A drawn row without the box around it — nor the column its scrollbar takes.
 *
 * Every panel keeps that column whether or not there is anything to scroll, so
 * what is inside the box stops one cell short of its right border.
 */
const inside = (row: string) =>
  row
    .replace(/^[^\S\n]*│/, '')
    .replace(/[▕█┆]?│[^\S\n]*$/, '')
    .trim()

/** The widths worth trying: from a terminal nobody should use to a wide one. */
const WIDTHS = [48, 56, 64, 72, 80, 96, 120, 160]

describe('grouping what it cost', () => {
  it('tells three routes to one model apart by harness, sign-in and provider', () => {
    // One model, so one row: `claude-opus-5`, `anthropic/claude-opus-5` and
    // `openrouter/anthropic/claude-opus-5` are the same weights spelled by
    // three harnesses, and added up by the string one agent became three.
    expect(viewBy('model').rows.map((row) => [row.label, row.tokens])).toEqual([
      ['claude-opus-5', 900_000],
    ])
    // What differs is the route, and that is what the three facets below say.

    const harness = viewBy('harness').rows
    expect(harness.map((row) => [row.label, row.usd])).toEqual([
      ['pi', 2],
      // Its plan paid for it, so it spent 400k tokens and no money at all.
      ['claude-code', 0],
    ])
    expect(viewBy('account').rows.map((row) => row.label)).toEqual([
      'pi',
      'pi @work',
      'claude-code',
    ])
    // Claude Code's turn lands under the provider Claude Code reaches, which
    // is the harness's own answer and not the route's: the route on the
    // machine this was reported from asked for `openrouter` beside
    // `harness: claude-code`, and that is not a route Claude Code can take.
    expect(viewBy('provider').rows.map((row) => [row.label, row.usd, row.tokens])).toEqual([
      ['anthropic', 1.25, 700_000],
      ['openrouter', 0.75, 200_000],
    ])
  })

  it('files a run under the provider its harness reaches, not the one a route wished for', () => {
    // The journal this was reported from: `workers.routes.default` held
    // `provider: openrouter` beside `harness: claude-code`, so eleven thousand
    // Claude Code turns were written down as having gone through a router
    // Claude Code cannot reach. The wish cannot be unwritten; it is not
    // believed.
    const wished = [
      usage({
        run: 'r1',
        detail: { model: 'claude-opus-5', harness: 'claude-code', provider: 'openrouter' },
      }),
    ]
    expect(viewBy('provider', wished).rows.map((row) => row.label)).toEqual(['anthropic'])
  })

  it('leaves a routing harness the provider that was recorded for it', () => {
    // pi is the harness that really routes, so what the route recorded is the
    // fact and nothing overrules it.
    const routed = [
      usage({ run: 'r1', detail: { harness: 'pi', provider: 'openrouter', priced: 'exact' } }),
    ]
    expect(viewBy('provider', routed).rows.map((row) => row.label)).toEqual(['openrouter'])
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

  it('names an unrecorded row as that, rather than as a thing that does not exist', () => {
    const events = [usage({ run: null, detail: { model: undefined, usd: 0, tokens: 500 } })]
    const [row] = viewBy('model', events).rows
    // The name and nothing else: a sentence under it saying no model was
    // written down is read four hundred times and wanted once.
    expect(row?.label).toBe('not recorded')
  })

  it("names the harness's own sign-in as its own, not as an account", () => {
    const [row] = viewBy('account', [
      usage({ detail: { harness: 'pi', usd: 1, priced: 'exact' } }),
    ]).rows
    expect(row?.label).toBe('pi')
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
  })

  it('keeps priced money apart from estimated, on the row and in the total', () => {
    // A harness that estimates against an API key is estimating a bill
    // somebody gets, so it is money and is marked as money nobody priced.
    const view = viewBy('harness', [
      ...THREE_ROUTES,
      usage({
        run: 'r4',
        task: 'checkout/refunds',
        detail: {
          model: 'claude-opus-5',
          harness: 'claude-code',
          account: 'billed',
          tokens: 50_000,
          usd: 0.5,
          priced: 'estimate',
        },
      }),
    ])
    expect(view.rows.find((row) => row.label === 'pi')?.priced).toBe('exact')
    expect(view.rows.find((row) => row.label === 'claude-code')?.priced).toBe('estimate')
    expect(view.priced).toBe('mixed')
    expect(view.usdExact).toBe(2)
    expect(view.usdEstimated).toBe(0.5)
  })

  it('counts a plan\u2019s own turns as tokens and never as dollars', () => {
    // $954 of "spend" on a plan that charges a flat fee is a number that means
    // nothing added to a figure that means something: Claude Code's estimate
    // is its guess at what an API would have charged, and on a subscription
    // nobody is charged it. What was used up is the plan's windows, which are
    // their own list and in no total here.
    const plan = [
      usage({
        run: 'r1',
        detail: {
          model: 'claude-opus-5',
          harness: 'claude-code',
          tokens: 900_000,
          usd: 954.51,
          priced: 'estimate',
        },
      }),
    ]
    const view = viewBy('harness', plan)
    expect(view.usd).toBe(0)
    expect(view.usdEstimated).toBe(0)
    expect(view.hasCost).toBe(false)
    expect(view.priced).toBe('none')
    // The effort is still effort, and is still where it went.
    expect(view.tokens).toBe(900_000)
    expect(view.rows.map((row) => [row.label, row.tokens])).toEqual([['claude-code', 900_000]])
  })
})

describe('how long a model was working, beside how long its agent was open', () => {
  // Two questions and two columns. A run counts until it stopped, idle time
  // included — an agent that answered at noon and sat in its lane until
  // somebody closed the window ran all afternoon — and what a model *worked*
  // is the turns inside that. Drawn as one figure, the page was answering the
  // second question with the first.
  const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()
  const table = (runs: TadeEvent[]) => {
    const panel: SpendPanel = { ...spendPanel(), by: 'agent' }
    return drawPanel(
      panel,
      context({ width: 120, spend: viewBy('agent', THREE_ROUTES, runs) }),
    ).panel.rows.map((row) => stripTerminalSequences(row))
  }

  it('says both, each in its own word and its own column', () => {
    const rows = table([
      run('run_started', { ts: ago(60) }),
      run('turn_started', { ts: ago(55) }),
      run('turn_done', { ts: ago(35) }),
      run('run_exited', { ts: ago(10) }),
    ])
    expect(rows.some((row) => row.includes('WORKING') && row.includes('OPEN'))).toBe(true)
    expect(rows.some((row) => row.includes('20m working · 50m open'))).toBe(true)
    // And on the row: twenty minutes of thinking inside fifty of being there.
    const refunds = rows.find((row) => row.includes('refunds')) ?? ''
    expect(refunds).toContain('20m')
    expect(refunds).toContain('50m')
  })

  it('says working time is unknown rather than drawing it as nought', () => {
    // Every run of every journal written before Tade recorded when a turn
    // begins: turns with ends and no beginnings. `0s` here would read as an
    // agent that did nothing, which is the opposite of what happened.
    const rows = table([
      run('run_started', { ts: ago(60) }),
      run('turn_done', { ts: ago(35) }),
      run('run_exited', { ts: ago(10) }),
    ])
    expect(rows.some((row) => row.includes('working unknown · 50m open'))).toBe(true)
    expect(rows.some((row) => row.includes('0s working'))).toBe(false)
    // And the column under it says nothing rather than a figure, the way the
    // money column does for money nobody priced.
    const refunds = rows.find((row) => row.includes('refunds')) ?? ''
    expect(refunds).toContain('—')
    expect(refunds).toContain('50m')
  })

  it('marks a figure made of some runs that could say and some that could not', () => {
    const rows = table([
      run('run_started', { ts: ago(60) }),
      run('turn_started', { ts: ago(55) }),
      run('turn_done', { ts: ago(35) }),
      run('run_exited', { ts: ago(30) }),
      run('run_started', { ts: ago(25), run: 'r2', task: 'search/pagination' }),
      run('turn_done', { ts: ago(20), run: 'r2', task: 'search/pagination' }),
      run('run_exited', { ts: ago(10), run: 'r2', task: 'search/pagination' }),
    ])
    // A floor, marked where it is read — the way estimated money is.
    expect(rows.some((row) => row.includes('≥20m working'))).toBe(true)
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
      const inner = Math.min(SPEND_WIDTH, width - 4) - 2
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
    expect(nameLines(name, 20)).toEqual(['openrouter/anthropic', '/claude-opus-5'])
    // Past two lines it is cut, and the cut is marked.
    const tiny = nameLines(name, 8)
    expect(tiny).toHaveLength(2)
    expect(tiny.at(-1)?.endsWith('…')).toBe(true)
  })

  it('keeps every grouping reachable, however narrow the panel', () => {
    for (const width of WIDTHS) {
      const rows = drawn('agent', width).join('\n')
      for (const label of ['Agent', 'Project', 'Model', 'Harness', 'Sign-in', 'Provider']) {
        expect(rows, `at ${width}`).toContain(label)
      }
    }
  })

  it('marks money nobody priced where it is read, and nowhere else', () => {
    const rows = drawn('harness', 96, [
      ...THREE_ROUTES,
      usage({
        run: 'r4',
        detail: {
          model: 'claude-opus-5',
          harness: 'claude-code',
          account: 'billed',
          tokens: 50_000,
          usd: 0.5,
          priced: 'estimate',
        },
      }),
    ]).join('\n')
    // The estimating sign-in's row carries the mark, the pricing one does not,
    // and the total carries it because it holds both.
    expect(rows).toMatch(/~\$0\.50/)
    expect(rows).toMatch(/[^~]\$2\.00/)
    expect(rows).toMatch(/~\$2\.50/)
    // And there is no footnote under the page saying it again: the mark is on
    // the figure, and `tade spend` says the whole of it where somebody asks.
    expect(rows).not.toContain('estimated')
    expect(rows).not.toContain('priced by the harness')
  })

  it('says what the total does not cover, in the gap under the figure', () => {
    // Claude Code's own sign-in has no price per turn, so its 400k tokens are
    // in the token figure and in no figure of money beside it. A total that
    // adds up the rest and stops there is a figure with an agent's cost
    // missing from it, which is worse than one marked incomplete.
    const rows = drawn('harness', 96).join('\n')
    expect(rows).toContain('400k tokens here ran in a harness that reports no money')
    // The money in it is untouched: this only ever adds what to say.
    expect(rows).toMatch(/\$2\.00/)
    // And a narrow panel keeps the figure and gives up the words, rather than
    // cutting the sentence off where nobody can tell what it was about.
    expect(drawn('harness', 48).join('\n')).toContain('400k tokens unpriced')
  })

  it('says nothing about what it misses when there is no money for it to miss', () => {
    // Nothing was priced at all, so the `—` beside the token figure has
    // already said it, and a sentence under it would be the same fact twice.
    const rows = drawn('harness', 96, [
      usage({ run: 'r1', detail: { harness: 'claude-code', tokens: 900_000, usd: 954.51 } }),
    ]).join('\n')
    expect(rows).not.toContain('reports no money')
    expect(rows).not.toContain('unpriced')
  })

  it('says no money at all as that, rather than as a zero somebody could trust', () => {
    const rows = drawn('harness', 96, [
      usage({ run: 'r1', detail: { harness: 'claude-code', tokens: 900_000, usd: 954.51 } }),
    ]).join('\n')
    expect(rows).toContain('—')
    expect(rows).not.toContain('954')
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
