import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { type Hit, sameTarget, type Target } from '../src/hits.ts'
import {
  focusTask,
  initialState,
  keyAction,
  pageOf,
  selectProject,
  showPlan,
  showPlans,
  withProjects,
  withTasks,
} from '../src/model.ts'
import { PLAIN } from '../src/skin.ts'
import { renderPlans } from '../src/view/plans.ts'
import { draw } from '../src/view.ts'
import { base, frame, utcClock } from './screens/scenarios/fixtures.ts'
import { plans } from './screens/scenarios/plans.ts'

// The Plans screen: drawn to the geometry contract at every size, every press
// on it something you could have typed, and a place you go to and come back
// from the way a plan or a schedule is.

const SIZES = [
  [12, 3],
  [20, 6],
  [40, 12],
  [80, 24],
  [160, 45],
] as const

const plain = (rows: readonly string[]) => rows.map((row) => stripTerminalSequences(row))

/** The first hit that lands on a target, and its row. */
const find = (hits: readonly Hit[], target: Target) =>
  hits.find((hit) => sameTarget(hit.target, target))

describe('the Plans screen', () => {
  it('keeps the geometry contract at every size, open on every plan, one, none and before a look', () => {
    const cases = [
      { state: showPlans(base()), plans: plans() },
      { state: showPlans(base(), 'checkout-v2'), plans: plans() },
      { state: showPlans(base(), 'gone'), plans: plans() },
      { state: showPlans(base()), plans: [] },
      { state: showPlans(base()), plans: null },
    ]
    for (const one of cases) {
      for (const [width, height] of SIZES) {
        const drawn = renderPlans(
          one.state,
          frame({ width, height, plans: one.plans, clock: utcClock }),
          width,
          height,
          PLAIN,
          { hover: null, pressed: null },
        )
        expect(drawn.rows).toHaveLength(height)
        for (const row of drawn.rows) expect(visibleWidth(row)).toBe(width)
      }
    }
  })

  it('lists what wants you, then what is under way, then what is done', () => {
    const drawn = renderPlans(
      showPlans(base()),
      frame({ width: 120, height: 200, plans: plans() }),
      120,
      200,
      PLAIN,
      { hover: null, pressed: null },
    )
    const text = plain(drawn.rows).join('\n')
    const at = (words: string) => text.indexOf(words)
    expect(at('NEEDS YOU')).toBeLessThan(at('checkout-v2'))
    expect(at('checkout-v2')).toBeLessThan(at('UNDER WAY'))
    expect(at('UNDER WAY')).toBeLessThan(at('search-relevance'))
    expect(at('search-relevance')).toBeLessThan(at('FINISHED'))
    expect(at('FINISHED')).toBeLessThan(at('release-notes'))
    // The whole graph of a plan still going, its finished step among the rest.
    expect(text).toContain('✓ schema')
    expect(text).toContain('! form')
    expect(text).toContain('◌ page')
    // A finished one is a quiet row, with no graph.
    expect(text).not.toContain('draft')
    expect(text).toContain('3 plans · 1 needs you · 1 under way · 1 finished')
  })

  it('opens a plan from its name, and its steps go to their agents', () => {
    const drawn = renderPlans(
      showPlans(base()),
      frame({ width: 120, height: 200, plans: plans() }),
      120,
      200,
      PLAIN,
      { hover: null, pressed: null },
    )
    expect(find(drawn.hits, { kind: 'action', name: 'plan:checkout-v2' })).toBeDefined()
    expect(find(drawn.hits, { kind: 'action', name: 'plan:release-notes' })).toBeDefined()
    expect(find(drawn.hits, { kind: 'task', task: 'web/v2-form' })).toBeDefined()
  })

  it('draws one plan whole: its facts, what wants you, its graph and why, every stage', () => {
    const drawn = renderPlans(
      showPlans(base(), 'checkout-v2'),
      frame({ width: 120, height: 200, plans: plans() }),
      120,
      200,
      PLAIN,
      { hover: null, pressed: null },
    )
    const text = plain(drawn.rows).join('\n')
    for (const words of [
      'checkout-v2  1/4 steps finished · wants you',
      'workflow  cross-repo@3',
      'projects  checkout, web',
      'NEEDS YOU',
      'THE GRAPH',
      'WHY THIS ORDER',
      'STAGE BY STAGE',
      'Stage 3  after stage 2',
      '2 agents have been on it',
      'after form, wants you',
      'the page puts the form in',
    ]) {
      expect(text).toContain(words)
    }
    expect(find(drawn.hits, { kind: 'action', name: 'plans' })).toBeDefined()
  })

  it('says a plan whose task files are gone, rather than drawing nothing', () => {
    const drawn = renderPlans(
      showPlans(base(), 'gone'),
      frame({ width: 80, height: 10, plans: plans() }),
      80,
      10,
      PLAIN,
      { hover: null, pressed: null },
    )
    expect(plain(drawn.rows).join('\n')).toContain('No plan by that name')
  })

  it('draws a plan named with escapes as text', () => {
    const [one] = plans()
    if (!one) throw new Error('no plan')
    const evil = { ...one, run: 'evil\u001b[2J' }
    const drawn = renderPlans(
      showPlans(base()),
      frame({ width: 80, height: 60, plans: [evil] }),
      80,
      60,
      PLAIN,
      { hover: null, pressed: null },
    )
    expect(drawn.rows.join('')).not.toContain('\u001b[2J')
  })

  it('is where an agent’s screen would be, inside the whole window', () => {
    const state = showPlans(base())
    const drawn = draw(state, frame({ plans: plans(), clock: utcClock }))
    expect(plain(drawn.rows).join('\n')).toContain('plans  3 plans')
  })
})

describe('going to the Plans screen and back', () => {
  it('takes the agent out of front, and an agent clicked puts it back', () => {
    const open = showPlans(base(), 'checkout-v2')
    expect(open.focused).toBeNull()
    expect(open.plans).toEqual({ effort: 'checkout-v2' })
    const back = focusTask(open, 'checkout/stripe-v15')
    expect(back.plans).toBeNull()
    expect(back.focused).toBe('checkout/stripe-v15')
    expect(selectProject(open, 'search').plans).toBeNull()
    expect(showPlan(open).plans).toBeNull()
  })

  it('stays open while the beat brings the same agents back', () => {
    const tasks = [{ task: 'checkout/a', state: 'working' as const }]
    const there = withTasks(withProjects(initialState(), ['checkout']), tasks)
    const open = showPlans(there)
    const after = withTasks(open, tasks)
    expect(after.plans).toEqual({ effort: null })
    expect(after.focused).toBeNull()
  })

  it('is a page of its own, so it is read from its top', () => {
    const all = showPlans(base())
    expect(pageOf(all)).not.toBe(pageOf(showPlans(base(), 'checkout-v2')))
    expect(pageOf(all)).not.toBe(pageOf(showPlan(base())))
  })

  it('is a key the window claims', () => {
    expect(keyAction('plans', base())).toEqual({ kind: 'run', action: 'plans' })
  })
})
