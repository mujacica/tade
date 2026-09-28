import { noRuntime, type PlanStanding } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import { type AppState, initialState, withProjects, withTasks } from '../src/model.ts'
import { COLOUR } from '../src/skin.ts'
import { draw } from '../src/view.ts'

// What a subscription has left, in the row along the bottom.
//
// A bar each for the windows a harness reports — the session and the week —
// drawn the way the context meter draws how much of a context is gone,
// because it is the same kind of figure. What is dangerous here is the same
// thing that is dangerous everywhere a plan is drawn: a share belonging to a
// window that has already started over looks exactly like one that is true.
// The other half of it is room, and what this row is willing to give up to
// keep the controls beside it.

/** The same row without its colour, for comparing positions against columns. */
const plain = (row: string) =>
  row.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')

const state = (over: Partial<AppState> = {}): AppState => ({
  ...withTasks(withProjects(initialState(), ['checkout', 'search']), [
    { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
  ]),
  ...over,
})

const frame = (over: Partial<{ width: number; height: number; screen: string }> = {}) => ({
  width: 80,
  height: 24,
  screen: '',
  ...over,
})

describe('what a subscription has left, in the strip', () => {
  const NOW = 1_800_000_000_000
  const HOUR = 3_600_000
  const spending = {
    tokens: 1_500,
    usd: 0.351,
    hasCost: true,
    byTask: {},
    runtime: { ...noRuntime(), ms: 80 * 60_000, runs: 2, running: true },
  }
  const standing = (over: Partial<PlanStanding> = {}): PlanStanding => ({
    harness: 'claude-code',
    account: null,
    pays: 'plan',
    at: NOW - 60_000,
    cannotTell: null,
    windows: [
      { label: '5h', used: 78.4, resetsAt: NOW + 2 * HOUR },
      { label: '7d', used: 21, resetsAt: NOW + 40 * HOUR },
    ],
    ...over,
  })
  const strip = (over: Partial<Frame> = {}, appState: Partial<AppState> = {}) =>
    draw(
      { ...state(), ...appState },
      {
        ...frame({ width: 150 }),
        skin: COLOUR,
        now: NOW,
        // The model and how hard it thinks are in this row too, and half of
        // what a plan says here is decided by what it is willing to give up
        // to keep them.
        orchestratorModel: 'claude-opus-5',
        orchestratorThinking: 'high',
        spend: spending,
        plan: [standing()],
        ...over,
      },
    )
  const foot = (drawn: { rows: string[] }) => drawn.rows[drawn.rows.length - 1] ?? ''
  /** What a link looks like: underlined right up to the words. */
  const linked = (row: string, text: string) =>
    new RegExp(`${String.fromCharCode(27)}\\[4m${text.replace(/[$.%]/g, '\\$&')}`).test(row)

  it('draws a bar for each window, the way the context meter draws one', () => {
    const text = plain(foot(strip()))
    // Six cells of it, filled to the share and hollow for the rest — the
    // context meter's own width, because it is the same kind of figure.
    expect(text).toContain('5h █████░ 78%')
    expect(text).toContain('7d █░░░░░ 21%')
    // Its own figure, in front of the money and never folded into it.
    expect(text.indexOf('5h')).toBeLessThan(text.indexOf('$0.35'))
  })

  it('says when each comes back, where there is room for it', () => {
    const text = plain(foot(strip({ width: 180 })))
    expect(text).toContain('78% ↻ 2h')
    expect(text).toContain('21% ↻ 1d 16h')
  })

  it('says the session first and the longer window after it', () => {
    const text = plain(foot(strip()))
    expect(text.indexOf('5h')).toBeLessThan(text.indexOf('7d'))
  })

  it('leaves out a window that has already started over', () => {
    // `planStandings` is what drops it; the strip may only draw what is left,
    // and a share belonging to a window that is gone looks exactly like one
    // that is true.
    const text = plain(
      foot(
        strip({ plan: [standing({ windows: [{ label: '7d', used: 21, resetsAt: NOW + HOUR }] })] }),
      ),
    )
    expect(text).not.toContain('5h')
    expect(text).toContain('7d █░░░░░ 21%')
  })

  it('opens the same overview as the money beside it, and lights with it', () => {
    const pointed = strip({}, { hover: { kind: 'action', name: 'spend' } })
    const row = foot(pointed)
    expect(linked(row, '5h')).toBe(true)
    const hit = pointed.hits.find(
      (one) => one.target.kind === 'action' && one.target.name === 'spend',
    )
    expect(hit).toBeDefined()
  })

  it('is clickable along the bar itself, not only beside it', () => {
    const drawn = strip()
    const row = plain(foot(drawn))
    const at = row.indexOf('█')
    expect(at).toBeGreaterThan(0)
    const hits = drawn.hits.filter(
      (one) =>
        one.row === drawn.rows.length - 1 &&
        one.from <= at &&
        one.to >= at &&
        one.target.kind === 'action' &&
        one.target.name === 'spend',
    )
    expect(hits.length).toBeGreaterThan(0)
  })

  it('says nothing at all when no harness has said', () => {
    const quiet = plain(
      foot(strip({ plan: [standing({ windows: [], at: null, cannotTell: 'has not said yet' })] })),
    )
    expect(quiet).not.toContain('5h')
    // The reason belongs on the page that has room for a sentence, not here.
    expect(quiet).not.toContain('has not said')
  })

  /** Two harnesses that can say, a third sign-in that cannot, and a fourth nobody read. */
  const four = [
    standing(),
    standing({
      harness: 'codex',
      account: 'work',
      windows: [{ label: '5h', used: 91, resetsAt: NOW + HOUR }],
    }),
    // Its window started over since it last said, so `planStandings` has
    // nothing true left to draw and it is not one of the ones to move between.
    standing({
      harness: 'claude-code',
      account: 'reviews',
      windows: [],
      cannotTell: 'started over',
    }),
    standing({ harness: 'pi', windows: [], at: null, cannotTell: 'prices every turn instead' }),
  ]

  it('names whose plan it is only when more than one account has one', () => {
    expect(plain(foot(strip()))).not.toContain('claude-code 5h')
    const two = plain(foot(strip({ plan: four })))
    // The fullest is the one that stops somebody working, and it is named.
    expect(two).toContain('codex @work ⇄ 5h █████░ 91%')
    // One account's windows, never the fullest of each: the 7d beside it is
    // the one that account named, and codex named none.
    expect(two).not.toContain('7d')
  })

  it('offers no way to move between accounts when only one reports anything', () => {
    // A control that moves between a single thing is a control that lies about
    // there being somewhere to go, so there is none — and nothing to press.
    const one = strip({ plan: [standing(), standing({ harness: 'pi', windows: [], at: null })] })
    expect(plain(foot(one))).not.toContain('⇄')
    expect(
      one.hits.some((hit) => hit.target.kind === 'action' && hit.target.name === 'plan-next'),
    ).toBe(false)
  })

  it('moves to the sign-in somebody chose, and keeps it while it can still say', () => {
    const chosen = strip({ plan: four }, { planShown: { harness: 'claude-code', account: null } })
    const row = plain(foot(chosen))
    // Not the tightest any more: 91% is somebody else's, and a person who went
    // to look at this one did not ask to be moved back.
    expect(row).toContain('claude-code ⇄ 5h █████░ 78%')
    expect(row).not.toContain('91%')
  })

  it('goes back to the tightest when the sign-in somebody chose has nothing true to say', () => {
    // Its every window has started over. A stale share is the one thing worse
    // than somebody else's figure, so the choice heals rather than pins.
    const gone = plain(
      foot(strip({ plan: four }, { planShown: { harness: 'claude-code', account: 'reviews' } })),
    )
    expect(gone).toContain('codex @work ⇄ 5h █████░ 91%')
    expect(gone).not.toContain('reviews')
  })

  it('makes the name the thing you press, and lights it on its own', () => {
    const pointed = strip({ plan: four }, { hover: { kind: 'action', name: 'plan-next' } })
    expect(linked(foot(pointed), 'codex @work')).toBe(true)
    const hit = pointed.hits.find(
      (one) => one.target.kind === 'action' && one.target.name === 'plan-next',
    )
    expect(hit).toBeDefined()
    // And the bars beside it still open the page that says the rest.
    expect(
      pointed.hits.some((one) => one.target.kind === 'action' && one.target.name === 'spend'),
    ).toBe(true)
  })

  it('gives up its trimmings before the controls beside it', () => {
    // At the width the window is drawn at, the model and how hard it thinks
    // are said nowhere else; when each window comes back, and the window that
    // is not the tightest, are both on the page this opens.
    //
    // The widths in this file and the three below each went up by 14 — the
    // columns the fourth button in the strip takes — when the anti-sleep hold
    // arrived beside the sound. What is held here is the *order* things are
    // given up in and never the number: a control is kept over a figure,
    // because what is cut from the drawing is not cut from the program and
    // every figure here is one click away on the page this opens.
    const narrow = plain(foot(strip({ width: 134 })))
    expect(narrow).toContain('claude-opus-5 ▾')
    expect(narrow).toContain('high ▾')
    expect(narrow).toContain('5h █████░ 78%')
    expect(narrow).not.toContain('↻')
    expect(narrow).not.toContain('7d')
  })

  it('is the last figure it gives up as the window narrows', () => {
    const narrow = plain(foot(strip({ width: 94 })))
    expect(narrow).not.toContain('tok')
    expect(narrow).not.toContain('7d')
    // The bar goes before the share does: a percent with no bar is still the
    // figure, and the page it opens says the rest.
    expect(narrow).toContain('5h █████░ 78%')
    expect(narrow).toContain('$0.35')
  })

  it('gives up the bar before the share, and the share last of all', () => {
    expect(plain(foot(strip({ width: 78 })))).toContain('5h 78%')
    const tiny = plain(foot(strip({ width: 70 })))
    expect(tiny).not.toContain('5h')
    expect(tiny).toContain('$0.35')
  })
})
