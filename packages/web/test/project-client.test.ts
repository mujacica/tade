import { describe, expect, it } from 'vitest'
import {
  AGENT_PARTS,
  agentsOf,
  armOf,
  branchesOf,
  branchSaid,
  checkSaid,
  checksOf,
  failedOf,
  findingPart,
  findingsIn,
  graphOf,
  moneyOf,
  outlineOf,
  partOf,
  queueOf,
  reviewOf,
  ringOf,
  shortName,
  spentSaid,
  TOP,
  waitsOn,
  wantsOf,
} from '../src/assets/pages/project-shape.js'
import { applySnapshot, emptyStore, queueIn, tasksIn } from '../src/assets/store.js'
import { queueTree } from '../src/assets/tree.js'
import { projector } from '../src/reading.ts'
import { blocked, EVERY, finding, input, NOW, queued, reach, spend, task } from './fixtures.ts'

// The project page's figures — the lead, the agents, the queue as a graph, the
// checks, the branches, the findings and the money — held here with no browser,
// against **the real projection**: every row goes through `projector`, so a
// field the projection renames or withholds is a red test here rather than a
// blank region on a phone.
//
// **What this cannot see is how any of it looks**, which is the browser
// harness's (`scripts/browser.ts`). What it can see is that every figure is the
// projection's own fact, grouped and worded and never decided again; that a
// figure nobody could read is a dash with *which* dash; and that what is over
// folds away rather than disappearing.

/** A page's store, filled from the real projection. */
function held(over = {}, granted = EVERY) {
  const store = emptyStore()
  const made = projector(input({ reach: reach(granted), ...over }), NOW)
  expect(applySnapshot(store, made.snapshot())).toBeNull()
  return store
}

const at = (clock: string) => Date.parse(`2026-10-08T${clock}:00.000Z`)
const green = { state: 'pass' as const, failed: [], missing: [], overridden: false }
const red = (...failed: string[]) => ({
  state: 'fail' as const,
  failed,
  missing: [],
  overridden: false,
})
const noMoney = { ...spend(0), input: 0, output: 0, tokens: 0, usdOnPlan: 0, tokensUnpriced: 0 }

describe('the agents', () => {
  it('lists every task but queued work, in the order it was made, and folds away what is over', () => {
    const store = held({
      tasks: [
        task({ id: 'sentry/late', createdAt: at('13:00') }),
        task({ id: 'sentry/early', createdAt: at('09:00') }),
        task({
          id: 'sentry/landed',
          state: 'merged',
          finished: true,
          agents: 0,
          createdAt: at('08:00'),
        }),
        task({ id: 'sentry/set-aside', state: 'parked', parked: true, createdAt: at('10:00') }),
        task({ id: 'sentry/next', state: 'queued', agents: 0, createdAt: at('11:00') }),
      ],
      queue: [],
    })
    const list = agentsOf(tasksIn(store, 'sentry'))
    expect(list.all.map((one) => one.name)).toEqual(['landed', 'early', 'set-aside', 'late'])
    expect(list.live.map((one) => one.name)).toEqual(['early', 'late'])
    expect(list.over.map((one) => one.name)).toEqual(['landed', 'set-aside'])
  })

  it('draws the ring from the window’s own mark, and counts the working that went quiet', () => {
    const store = held({
      tasks: [
        task({ id: 'sentry/a' }),
        task({ id: 'sentry/b', stalled: true }),
        blocked(),
        task({ id: 'sentry/c', state: 'failed', reason: { kind: 'clause', said: 'exited' } }),
        task({ id: 'sentry/d', mark: 'idle' }),
        task({ id: 'sentry/e', mark: 'stopped' }),
      ],
    })
    const ring = ringOf(agentsOf(tasksIn(store, 'sentry')).all)
    expect(ring.n).toBe(6)
    expect(ring.stalled).toBe(1)
    expect(Object.fromEntries(ring.parts.map((one) => [one.key, one.n]))).toEqual({
      wants: 1,
      failed: 1,
      working: 2,
      idle: 1,
      done: 0,
      aside: 1,
    })
    // Every one of the window's marks is in exactly one part.
    const marks = AGENT_PARTS.flatMap((part) => part.marks)
    expect(new Set(marks).size).toBe(marks.length)
    expect(partOf({ mark: 'something new' })).toBe('aside')
  })

  it('names what failed by the window’s mark, never by a state', () => {
    const store = held({
      tasks: [task({ id: 'sentry/c', state: 'failed', reason: { kind: 'clause', said: 'x' } })],
    })
    expect(failedOf(tasksIn(store, 'sentry')).map((one) => one.name)).toEqual(['c'])
  })
})

describe('what wants you', () => {
  it('counts the window’s needs-you and says what kind of decision each is', () => {
    const wants = wantsOf(held(), 'sentry')
    expect(wants.n).toBe(1)
    expect(wants.said).toBe('1 approval')
    expect(wantsOf(held(), 'tade').n).toBe(0)
  })

  it('says queued work held over an overlap as a decision, not as an agent', () => {
    const store = held({
      tasks: [
        task({ id: 'sentry/asked', state: 'blocked', question: true, mark: 'needs-you' }),
        task({ id: 'sentry/held', state: 'queued', agents: 0, mark: 'needs-you' }),
      ],
    })
    const wants = wantsOf(store, 'sentry')
    expect(wants.n).toBe(2)
    expect(wants.said).toBe('1 question · 1 held in the queue')
  })
})

describe('the checks', () => {
  it('never calls a project green while anything was not run here', () => {
    const checks = checksOf(agentsOf(tasksIn(held(), 'sentry')).all)
    expect(checks.figure).toBe('0 of 3 green')
    expect(checks.tone).toBeNull()
    expect(checks.unrun).toHaveLength(3)
    expect(checks.parts.map((one) => [one.label, one.n])).toEqual([
      ['green', 0],
      ['red', 0],
      ['not run here', 3],
    ])
  })

  it('is red the moment one branch is, and green only when every one is', () => {
    const redStore = held({
      tasks: [
        task({ id: 'sentry/a', checks: red('tests') }),
        task({ id: 'sentry/b', checks: green }),
      ],
    })
    const reds = checksOf(agentsOf(tasksIn(redStore, 'sentry')).all)
    expect(reds.figure).toBe('1 red')
    expect(reds.tone).toBe('failed')
    expect(reds.red.map((one) => one.name)).toEqual(['a'])
    expect(reds.green.map((one) => one.name)).toEqual(['b'])

    const greenStore = held({ tasks: [task({ id: 'sentry/b', checks: green })] })
    const greens = checksOf(agentsOf(tasksIn(greenStore, 'sentry')).all)
    expect(greens.figure).toBe('all green')
    expect(greens.tone).toBe('done')

    expect(checksOf([]).figure).toBe('no work')
  })

  it('names which checks by the project’s own names, and keeps an overruled run red', () => {
    expect(checkSaid(red('tests', 'lint'))).toBe('red: tests and lint')
    expect(checkSaid({ ...red('tests'), overridden: true })).toBe('red: tests · overruled')
    expect(checkSaid({ state: 'unknown', failed: [], missing: ['tests'], overridden: false })).toBe(
      'not run here: tests',
    )
    expect(checkSaid({ state: 'unknown', failed: [], missing: [], overridden: false })).toBe(
      'not run here',
    )
  })
})

describe('the queue, as a graph', () => {
  it('draws the work a piece waits on beside it, with an edge from it to the piece', () => {
    const graph = graphOf(held(), 'sentry', () => '12:30')
    expect(graph.nodes.map((one) => [one.id, one.label, one.under, one.tone])).toEqual([
      ['sentry/away-projection', 'away-projection', 'working', 'working'],
      ['sentry/away-auth-server', 'away-auth-server', 'waiting', 'quiet'],
    ])
    expect(graph.edges).toEqual([
      { from: 'sentry/away-projection', to: 'sentry/away-auth-server', tone: null },
    ])
    expect(graph.nodes[0]?.href).toBe('/t/sentry/away-projection')
  })

  it('dashes an edge out of queued work, and names what it waits on that is on no row', () => {
    const store = held({
      queue: [
        queued(),
        queued({
          task: 'sentry/pairing',
          state: { kind: 'waiting', on: ['sentry/away-auth-server', 'acme/schema'] },
          waitsOn: [],
        }),
      ],
    })
    const graph = graphOf(store, 'sentry')
    const edges = graph.edges.map((one) => `${one.from}>${one.to}:${one.tone}`)
    expect(edges).toContain('sentry/away-auth-server>sentry/pairing:queued')
    expect(edges).toContain('acme/schema>sentry/pairing:null')
    const elsewhere = graph.nodes.find((one) => one.id === 'acme/schema')
    expect(elsewhere).toMatchObject({ label: 'acme/schema', under: 'not on this device' })
    expect(elsewhere?.tone).toBe('unknown')
    // Each piece once, however many pieces wait on it.
    expect(new Set(graph.nodes.map((one) => one.id)).size).toBe(graph.nodes.length)
  })

  it('reads a held piece’s overlap as an edge, the way the side’s tree does', () => {
    const row = {
      task: 'sentry/x',
      state: {
        kind: 'held',
        on: 'sentry/y',
        because: 'it would touch 2 files',
        changed: 2,
        by: [],
      },
      waitsOn: [{ task: 'sentry/z', why: null }],
    }
    expect(waitsOn(row)).toEqual(['sentry/z', 'sentry/y'])
    expect(shortName('sentry/x', 'sentry')).toBe('x')
    expect(shortName('acme/x', 'sentry')).toBe('acme/x')
  })

  it('lays the queue out for a phone as the side’s tree, each piece under what it waits on', () => {
    const store = held({
      queue: [
        queued(),
        queued({
          task: 'sentry/pairing',
          state: { kind: 'waiting', on: ['sentry/away-auth-server'] },
          waitsOn: [],
        }),
        queued({ task: 'sentry/alone', state: { kind: 'ready' }, waitsOn: [] }),
      ],
    })
    const lines = outlineOf(queueTree(queueIn(store, 'sentry')))
    expect(lines.map((one) => [one.row.task, one.depth])).toEqual([
      ['sentry/alone', 0],
      ['sentry/away-auth-server', 0],
      ['sentry/pairing', 1],
    ])
    expect(outlineOf([])).toEqual([])
  })

  it('keeps ready and waiting in the legend always, and the rest only where something stands', () => {
    const store = held({
      queue: [
        queued(),
        queued({ task: 'sentry/r', state: { kind: 'ready' }, waitsOn: [] }),
        queued({
          task: 'sentry/h',
          state: { kind: 'held', on: null, because: 'b', changed: null, by: [] },
          waitsOn: [],
        }),
      ],
    })
    const standing = queueOf(queueIn(store, 'sentry'))
    expect(standing.figure).toBe('3 queued')
    expect(standing.ready).toBe(1)
    expect(standing.parts.map((one) => [one.key, one.n])).toEqual([
      ['ready', 1],
      ['waiting', 1],
      ['held', 1],
    ])
    expect(queueOf([]).figure).toBe('empty')
  })
})

describe('the branches', () => {
  it('adds what is ahead, folds a merged branch with nothing ahead, and says who offered what', () => {
    const store = held({
      tasks: [
        task({ id: 'sentry/a', branch: 'tade/a', ahead: 3, behind: 1, review: null }),
        task({ id: 'sentry/b', branch: 'tade/b', ahead: 2, behind: 0 }),
        task({
          id: 'sentry/c',
          branch: 'tade/c',
          ahead: 0,
          behind: 4,
          review: { state: 'merged', url: 'https://github.invalid/acme/sentry/pull/9' },
        }),
        task({ id: 'sentry/d', branch: 'tade/d', ahead: null, behind: null, review: null }),
      ],
    })
    const branches = branchesOf(agentsOf(tasksIn(store, 'sentry')).all)
    expect(branches.live.map((one) => one.branch)).toEqual(['tade/a', 'tade/b', 'tade/d'])
    expect(branches.over.map((one) => one.branch)).toEqual(['tade/c'])
    // A branch nobody could compare makes the sum a floor.
    expect(branches.figure).toBe('≥5 ahead')
    expect(branches.said).toBe('≥5 commits ahead')
    expect(branches.most).toBe(3)
    expect(Object.fromEntries(branches.parts.map((one) => [one.key, one.n]))).toEqual({
      open: 1,
      draft: 0,
      merged: 1,
      unoffered: 1,
    })
  })

  it('says a branch in one line, noughts left out, and never a nought it could not read', () => {
    expect(branchSaid({ ahead: 5, behind: 4, dirty: 11 })).toBe('5 ahead · 4 behind · 11 changed')
    expect(branchSaid({ ahead: 2, behind: 0, dirty: 0 })).toBe('2 ahead')
    expect(branchSaid({ ahead: 0, behind: 0, dirty: 6 })).toBe('6 changed')
    expect(branchSaid({ ahead: 0, behind: 0, dirty: 0 })).toBe('level with where it started')
    expect(branchSaid({ ahead: null, behind: null, dirty: null })).toBe('ahead: cannot tell')
  })

  it('offers a branch’s review in the forge’s word, and keeps a quiet one out of the quiet grey', () => {
    expect(reviewOf({ review: 'open', ahead: 2 })).toEqual({ word: 'open', tone: 't-working' })
    expect(reviewOf({ review: 'draft', ahead: 2 })).toEqual({ word: 'draft', tone: '' })
    expect(reviewOf({ review: null, ahead: 3 })).toEqual({ word: 'not offered', tone: '' })
    expect(reviewOf({ review: null, ahead: 0 })).toBeNull()
    expect(reviewOf({ review: null, ahead: null })).toBeNull()
  })

  it('draws an arm on a root scale, so one long branch does not flatten the rest', () => {
    expect(armOf(2, 32)).toBe(25)
    expect(armOf(32, 32)).toBe(100)
    expect(armOf(40, 32)).toBe(100)
    expect(armOf(0, 32)).toBe(0)
    expect(armOf(null, 32)).toBe(0)
  })
})

describe('the findings', () => {
  it('puts a person’s move first, then an agent’s, and folds away a false positive', () => {
    const store = held({
      findings: [
        finding({ key: 'k1', account: null, probability: 0.9 }),
        finding({ key: 'k2', verdict: { was: 'false positive', at: '2026-10-08T14:10:00.000Z' } }),
        finding({ key: 'k3', probability: 0.3 }),
        finding({ key: 'k4', verdict: { was: 'confirmed', at: '2026-10-08T14:10:00.000Z' } }),
        finding({ key: 'k5', project: 'tade' }),
      ],
    })
    const found = findingsIn(store, 'sentry')
    expect(found.may).toBe(true)
    expect(found.live.map((one) => one.key)).toEqual(['k3', 'k1', 'k4'])
    expect(found.over.map((one) => one.key)).toEqual(['k2'])
    expect(found.figure).toBe('1 to read')
    expect(found.tone).toBe('wants')
    expect(found.live.map(findingPart)).toEqual(['read', 'open', 'confirmed'])
    expect(found.live[0]?.href).toBe('/t/sentry/away-projection')
  })

  it('says not granted where the device may not read them, which is not none', () => {
    const found = findingsIn(held({}, []), 'sentry')
    expect(found.may).toBe(false)
    expect(found.figure).toBeNull()
    expect(found.n).toBe(0)
  })
})

describe('the money', () => {
  it('adds what was spent, ranks the agents that spent it and marks an estimate', () => {
    const store = held({
      tasks: [
        task({ id: 'sentry/a', spend: spend(3) }),
        task({ id: 'sentry/b', spend: { ...spend(1), usdExact: 0, usdEstimated: 1 } }),
        task({ id: 'sentry/c', spend: noMoney }),
      ],
    })
    const paid = moneyOf(store, 'sentry')
    expect(paid.value).toBe('~$4.00')
    expect(paid.exact).toBe('$3.00')
    expect(paid.estimated).toBe('~$1.00')
    expect(paid.top.map((one) => [one.label, one.said])).toEqual([
      ['a', '$3.00'],
      ['b', '~$1.00'],
    ])
    expect(paid.top.length).toBeLessThanOrEqual(TOP)
    expect(paid.since).not.toBeNull()
    expect(paid.plan?.why).toBe('on a plan · not in the total')
  })

  it('says an agent’s own money on its row, and nothing where none was recorded', () => {
    expect(spentSaid(spend(2.5))).toBe('$2.50')
    expect(spentSaid({ ...spend(1), usdEstimated: 0.2 })).toBe('~$1.00')
    expect(spentSaid(noMoney)).toBeNull()
    expect(spentSaid(null)).toBeNull()
  })

  it('is a dash with its word where nothing was granted or nothing was recorded', () => {
    const ungranted = moneyOf(held({}, []), 'sentry')
    expect(ungranted.value).toBeNull()
    expect(ungranted.why).toBe('not granted')
    expect(ungranted.top).toEqual([])
    expect(ungranted.exact).toBeNull()

    const unrecorded = moneyOf(held({ tasks: [task({ spend: noMoney })] }), 'sentry')
    expect(unrecorded.value).toBeNull()
    expect(unrecorded.why).toBe('not recorded')
    expect(unrecorded.granted).toBe(true)
  })
})
