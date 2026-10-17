import { DONE_RULE_MEANS } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { ActivityIn } from '../src/agent.ts'
import { agentOf } from '../src/agent.ts'
import { WHY_SAID, whyOf } from '../src/assets/pages/agent-pane.js'
import {
  aboutOf,
  branchOf,
  DONE_SAID,
  DOTS,
  FOLD,
  findingsOf,
  foldSaid,
  headOf,
  momentsOf,
  nowOf,
  recentOf,
  runOf,
  SPAN_MIN,
  STRIP,
  spendOf,
  stateOf,
  timelineOf,
  tracksOf,
  treeOf,
} from '../src/assets/pages/agent-shape.js'
import { applySnapshot, emptyStore, taskAt } from '../src/assets/store.js'
import { notShownSaid } from '../src/assets/ui.js'
import { GRANTS } from '../src/reach.ts'
import { projector } from '../src/reading.ts'
import {
  agentHeld,
  blocked,
  checkRun,
  checkTree,
  EVERY,
  finding,
  input,
  NOW,
  reach,
  run,
  spend,
  task,
} from './fixtures.ts'

// One agent's page — the lead, its checks, its branch, its money, its run, the
// facts about it and its timeline — held here with no browser, against **the
// real projection**: every row goes through `projector` and the agent's own
// answer through `agentOf`, so a field the projection renames or withholds is
// a red test here rather than a blank cell on a phone.
//
// What it looks like is a browser's (`scripts/browser.ts`, `browser-desk.ts`).
// What is held here is that every figure is the projection's own fact, placed
// and worded and never decided again, and that a figure nobody could read is a
// dash that says *which* dash.

type Over = Parameters<typeof input>[0]

/** A page's store, filled from the real projection. */
function held(over: Over = {}, granted = EVERY) {
  const store = emptyStore()
  const made = projector(input({ reach: reach(granted), ...over }), NOW)
  expect(applySnapshot(store, made.snapshot())).toBeNull()
  return store
}

/** The fixture's working agent, as the page has it. */
function rowOf(store: ReturnType<typeof held>, id = 'sentry/away-projection') {
  const cut = id.indexOf('/')
  const row = taskAt(store, id.slice(0, cut), id.slice(cut + 1))
  if (row === null) throw new Error(`${id} is not in the projection`)
  return row
}

const minute = (n: number) => NOW - n * 60_000

describe('the lead: what it is doing now', () => {
  it('says deriveState’s own clause beside the window’s mark, and what it runs on', () => {
    const now = nowOf(rowOf(held()), NOW)
    expect(now.said).toBe('4 files touched')
    expect(now.mark).toMatchObject({ word: 'working', tone: 't-working' })
    expect(now.loud).toBeNull()
    expect(now.runsOn).toBe('claude-code · claude-opus-5')
    expect(now.moved).toBe('20m ago')
  })

  it('is loud only where it waits on somebody or failed, and names the tool', () => {
    const store = held({ tasks: [blocked()] })
    const now = nowOf(rowOf(store, 'sentry/blocked'), NOW)
    expect(now.loud).toBe('wants')
    // A device that may not answer was sent no command, and draws none.
    expect(now.waiting).toEqual({ tool: 'Bash', for: '10m', command: null })
    const failed = nowOf(rowOf(held({ tasks: [task({ mark: 'failed' })] })), NOW)
    expect(failed.loud).toBe('failed')
  })

  it('carries the command it waits to run where the machine sent it, with its count', () => {
    const row = rowOf(held({ tasks: [blocked()] }), 'sentry/blocked')
    const command = { text: 'Bash: npm i stripe@15', notShown: 12 }
    const now = nowOf({ ...row, approval: { ...row.approval, command } }, NOW)
    expect(now.waiting?.command).toEqual(command)
    expect(notShownSaid(12)).toBe('12 characters not shown')
    expect(notShownSaid(1)).toBe('1 character not shown')
    expect(notShownSaid(2048)).toBe('2,048 characters not shown')
  })

  it('says the mark’s word where deriveState said nothing, and never an age for what never moved', () => {
    const quiet = task({ reason: { kind: 'clause', said: '' }, movedAt: null, harness: '' })
    const now = nowOf(rowOf(held({ tasks: [quiet] })), NOW)
    expect(now.said).toBe('working')
    expect(now.moved).toBeNull()
    expect(now.movedSaid).toBe('never moved')
    expect(now.runsOn).toBe('claude-opus-5')
  })
})

describe('its checks', () => {
  it('reads its own worktree’s record, failing first, with how long each has said it', () => {
    const store = held({
      tasks: [task({ workspace: 'worktree', shared: false })],
      checks: [checkTree({ runs: [] }), checkTree({ task: 'sentry/away-projection' })],
    })
    const record = treeOf(rowOf(store), store)
    expect(record).toMatchObject({ read: true, own: true })
    const tracks = tracksOf(record.tree, Date.parse('2026-10-08T12:00:00.000Z'))
    expect(tracks.map((one) => [one.check, one.answer])).toEqual([
      ['tests', 'fail'],
      ['types', 'none'],
      ['format', 'pass'],
    ])
    expect(tracks[0]).toMatchObject({ forSaid: '2h 0m', typical: '1m' })
    expect(tracks[0]?.cells.map((one) => one.tone)).toEqual([
      'done',
      'done',
      'failed',
      'quiet',
      'failed',
      'failed',
    ])
  })

  it('reads the checkout’s record for an agent in it, and says that is not its own', () => {
    const store = held({ checks: [checkTree()] })
    expect(treeOf(rowOf(store), store)).toMatchObject({ read: true, own: false })
    expect(treeOf(rowOf(store), store).tree?.task).toBeNull()
    // A worktree with no runs of its own has no record, rather than borrowing the checkout's.
    const alone = held({
      tasks: [task({ workspace: 'worktree', shared: false })],
      checks: [checkTree()],
    })
    expect(treeOf(rowOf(alone), alone)).toEqual({ read: true, tree: null, own: false })
  })

  it('never says nothing ran where nothing has read the record', () => {
    const store = held({ checks: null })
    expect(treeOf(rowOf(store), store)).toEqual({ read: false, tree: null, own: false })
    expect(tracksOf(null, NOW)).toEqual([])
  })

  it('names what is red and what was not run at its head, and an overruled red', () => {
    const red = {
      state: 'fail' as const,
      failed: ['tests', 'lint'],
      missing: ['types'],
      overridden: true,
    }
    const head = headOf(rowOf(held({ tasks: [task({ checks: red })] })))
    expect(head.mark.word).toBe('red')
    expect(head.line).toBe('tests, lint failing · types not run here')
    expect(head.overruled).toBe(true)
  })

  it('strips the newest runs across its checks, oldest first, and counts what passed', () => {
    const runs = Array.from({ length: STRIP + 3 }, (_, at) =>
      checkRun({ minute: at, state: at % 4 === 0 ? 'failed' : 'passed' }),
    )
    const store = held({ checks: [checkTree({ runs })] })
    const recent = recentOf(treeOf(rowOf(store), store).tree)
    expect(recent.cells).toHaveLength(STRIP)
    expect(recent.cells.at(-1)?.tone).toBe('done')
    expect(recent.line).toBe(`9 of the last ${STRIP} passed`)
    expect(recentOf(null)).toMatchObject({ cells: [], line: null })
  })
})

describe('its branch', () => {
  it('draws a dot a commit either side of where it started, and says the rest', () => {
    const one = branchOf(rowOf(held({ tasks: [task({ ahead: DOTS + 4, behind: 1, dirty: 3 })] })))
    expect(one.value).toBe(`${DOTS + 4} ahead`)
    expect(one.under).toBe('1 behind · 3 uncommitted')
    expect([one.ahead, one.moreAhead, one.behind, one.moreBehind]).toEqual([DOTS, 4, 1, 0])
  })

  it('tells no branch, not compared and even apart', () => {
    expect(branchOf(rowOf(held({ tasks: [task({ branch: '' })] })))).toMatchObject({
      value: 'no branch',
      under: null,
    })
    expect(branchOf(rowOf(held({ tasks: [task({ ahead: null })] })))).toMatchObject({
      value: null,
      under: 'not compared',
    })
    expect(branchOf(rowOf(held({ tasks: [task({ ahead: 0, behind: 0, dirty: 0 })] }))).under).toBe(
      'even with where it started',
    )
  })

  it('says a branch with work on it that nobody offered is not offered, and where it lives', () => {
    const offered = branchOf(rowOf(held()))
    expect(offered.review?.word).toBe('open')
    expect(offered.where).toBe('shared checkout')
    const loose = branchOf(
      rowOf(held({ tasks: [task({ review: null, shared: false, workspace: 'worktree' })] })),
    )
    expect(loose.review?.word).toBe('not offered')
    expect(loose.where).toBe('own worktree')
    expect(branchOf(rowOf(held({ tasks: [task({ review: null, ahead: 0 })] }))).review).toBeNull()
  })
})

describe('its money', () => {
  it('says what it cost, the period, and its share of its project’s', () => {
    const store = held({
      tasks: [task(), task({ id: 'sentry/other', spend: spend(3.75) })],
    })
    const paid = spendOf(rowOf(store), store)
    expect(paid.value).toBe('$1.25')
    expect(paid.tokens).toBe('15k tokens')
    expect(paid.share).toBe(25)
    expect(paid.shareSaid).toBe('25% of sentry')
    expect(paid.since).toMatch(/^since \d\d:\d\d$/)
  })

  it('draws not granted and not recorded as two different dashes', () => {
    const withheld = held(
      {},
      GRANTS.filter((one) => one !== 'spend'),
    )
    expect(spendOf(rowOf(withheld), withheld)).toMatchObject({
      value: null,
      why: 'not granted',
      share: null,
    })
    const free = { ...spend(0), hasCost: false }
    const unrecorded = held({ tasks: [task({ spend: free })] })
    expect(spendOf(rowOf(unrecorded), unrecorded)).toMatchObject({
      value: null,
      why: 'not recorded',
    })
  })
})

describe('its run', () => {
  it('puts it among the run’s steps and says which one it is', () => {
    const steps = run().steps.map((one, at) =>
      at === 0
        ? {
            ...one,
            task: 'sentry/away-projection',
            name: 'away-projection',
            finished: false,
            active: true,
          }
        : one,
    )
    const store = held({
      tasks: [task({ effort: 'shop-1402' })],
      runs: [run({ steps })],
    })
    const ran = runOf(rowOf(store), store)
    expect(ran).toMatchObject({ name: 'shop-1402', href: '/plans/shop-1402', value: '0 of 2 done' })
    expect(ran?.steps.map((one) => [one.label, one.state, one.mine])).toEqual([
      ['away-projection', 'now', true],
      ['github-1402-fix', 'next', false],
    ])
    expect(ran?.steps[0]?.under).toBe('this one')
  })

  it('is nothing for work on its own, and keeps its name for a run nobody sent', () => {
    expect(runOf(rowOf(held({ tasks: [task({ effort: '' })] })), held())).toBeNull()
    const store = held({ runs: [] })
    expect(runOf(rowOf(store), store)).toMatchObject({
      name: 'remote-software-factory',
      value: null,
      steps: [],
    })
  })
})

describe('the facts about it', () => {
  const cell = (cells: ReturnType<typeof aboutOf>, label: string) =>
    cells.find((one) => one.label === label)

  it('keeps a cell for what nobody wrote down, rather than leaving it out', () => {
    const store = held({ tasks: [task({ harness: '', model: '', done: null })] })
    const cells = aboutOf(rowOf(store), store, NOW)
    expect(cells.map((one) => one.label)).toEqual([
      'Harness',
      'Account',
      'Asked by',
      'Done when',
      'Workspace',
      'Agent',
      'Made',
      'Produces',
    ])
    expect(cell(cells, 'Harness')).toMatchObject({ value: null, under: null })
    expect(cell(cells, 'Done when')?.value).toBeNull()
    expect(cell(cells, 'Made')?.value).toBe('37m ago')
  })

  it('says when it counts as finished in the domain’s own words', () => {
    // A second wording of a rule is a second rule: the page's copy is held to the core's.
    expect(DONE_SAID).toEqual(DONE_RULE_MEANS)
    const store = held({ tasks: [task({ done: 'merged' })] })
    const cells = aboutOf(rowOf(store), store, NOW)
    expect(cell(cells, 'Done when')?.value).toBe('its branch is merged into the base')
  })

  it('says not granted where that is why, and names a shared checkout', () => {
    const store = held({}, [])
    const cells = aboutOf(rowOf(store), store, NOW)
    expect(cell(cells, 'Account')?.value).toBe('not granted')
    expect(cell(cells, 'Workspace')).toMatchObject({ value: 'shared checkout' })
    expect(cell(cells, 'Asked by')?.value).toBe('the orchestrator')
  })

  it('counts the findings about it only where the device may read them', () => {
    const store = held({ findings: [finding(), finding({ key: 'two', tasks: ['tade/window'] })] })
    expect(findingsOf(rowOf(store), store)).toEqual({ may: true, n: 1, said: '1 finding' })
    const none = held({}, [])
    expect(findingsOf(rowOf(none), none)).toEqual({ may: false, n: 0, said: null })
  })
})

describe('its timeline', () => {
  /** What the agent's own answer carries, through the real projection. */
  function answerOf(activity: ActivityIn[]) {
    return agentOf(reach(EVERY), [task()], 'sentry/away-projection', agentHeld({ activity }))
  }

  const moment = (n: number, kind: ActivityIn['kind'], what = '', ok: boolean | null = null) => ({
    at: minute(n),
    kind,
    what,
    ok,
  })

  it('draws a lane each, the agent running from its start to now', () => {
    const answer = answerOf([
      moment(2, 'committed'),
      moment(5, 'turn', '', true),
      moment(8, 'used', 'Bash'),
      moment(9, 'asked', 'Bash'),
      moment(30, 'started'),
      moment(37, 'made'),
    ])
    const store = held()
    const line = timelineOf(answer, rowOf(store), null, false, NOW)
    expect(line.lanes.map((one) => one.label)).toEqual([
      'Agent',
      'Turns · 1',
      'Tools · 2',
      'Checks · none',
      'Commits · 1',
    ])
    const [agent, , tools] = line.lanes
    expect(agent?.spans).toEqual([
      expect.objectContaining({ from: minute(30), to: null, tone: 'working' }),
    ])
    expect(tools?.marks.map((one) => one.tone)).toEqual(['wants', 'queued'])
    // Everything since it was made was sent, so the stretch starts there.
    expect(line.from).toBe(Date.parse(rowOf(store).createdAt))
    expect(line.ticks.at(-1)?.said).toBe('now')
  })

  it('never draws an agent that is not running as running', () => {
    const answer = answerOf([moment(5, 'turn', '', true), moment(30, 'started')])
    const stopped = rowOf(held({ tasks: [task({ lane: 'stopped', agents: 0, lanes: 0 })] }))
    const [agent] = timelineOf(answer, stopped, null, false, NOW).lanes
    expect(agent?.spans[0]).toMatchObject({ from: minute(30), to: minute(5) })
    const idle = rowOf(held({ tasks: [task({ lane: 'none', agents: 0, lanes: 0 })] }))
    expect(timelineOf(answerOf([moment(5, 'turn')]), idle, null, false, NOW).lanes[0]?.label).toBe(
      'Agent · not running',
    )
  })

  it('draws checks from its own record, toned, and from its moments where the record is anybody’s', () => {
    const runs = [
      checkRun({ at: minute(4), state: 'failed' }),
      checkRun({ at: minute(3), state: 'passed', check: 'types' }),
      // Before the stretch: not on the chart.
      checkRun({ at: minute(600), state: 'passed' }),
    ]
    const store = held({
      tasks: [task({ workspace: 'worktree', shared: false })],
      checks: [checkTree({ runs: [] }), checkTree({ task: 'sentry/away-projection', runs })],
    })
    const record = treeOf(rowOf(store), store)
    const answer = answerOf([moment(4, 'checked', 'tests', false), moment(20, 'started')])
    const own = timelineOf(answer, rowOf(store), record.tree, record.own, NOW)
    expect(own.lanes[3]?.marks.map((one) => [one.tone, one.said.split(' at ')[0]])).toEqual([
      ['failed', 'tests failed'],
      ['done', 'types passed'],
    ])
    const shared = timelineOf(answer, rowOf(store), record.tree, false, NOW)
    expect(shared.lanes[3]?.marks.map((one) => one.tone)).toEqual(['queued'])
  })

  it('covers what was sent and no wider, and never less than a quarter hour', () => {
    const more = answerOf(Array.from({ length: 40 }, (_, at) => moment(at, 'used', 'Bash')))
    expect(more.more).toBe(true)
    const line = timelineOf(more, rowOf(held()), null, false, NOW)
    expect(line.from).toBe(minute(29))
    const brief = timelineOf(
      answerOf([moment(1, 'turn')]),
      rowOf(held({ tasks: [task({ createdAt: minute(2) })] })),
      null,
      false,
      NOW,
    )
    expect(line.to - line.from).toBeGreaterThanOrEqual(SPAN_MIN)
    expect(brief.from).toBe(NOW - SPAN_MIN)
    expect(timelineOf(null, rowOf(held()), null, false, NOW).moments).toBe(0)
  })

  it('lists the moments newest first, two of one kind in one second as two rows', () => {
    const answer = answerOf([moment(1, 'turn'), moment(1, 'turn'), moment(3, 'committed')])
    const rows = momentsOf(answer)
    expect(rows.map((one) => one.said)).toEqual(['finished a turn', 'finished a turn', 'committed'])
    expect(new Set(rows.map((one) => one.key)).size).toBe(3)
    expect(rows[2]).toMatchObject({ glyph: '●', tone: 't-working' })
    expect(foldSaid(1, false)).toBe('Show 1 earlier moment')
    expect(foldSaid(FOLD, true)).toBe('Show fewer')
  })
})

describe('its screen, where there is none', () => {
  it('says each absence as a heading and what to do about it, and only a failed read as wrong', () => {
    expect(whyOf('not granted')).toEqual({
      kind: 'empty',
      icon: 'devices',
      title: 'Screen not granted',
      line: 'grant it at the machine',
    })
    expect(whyOf('no agent')).toMatchObject({
      kind: 'empty',
      title: 'No agent running',
      line: null,
    })
    expect(whyOf('could not read')).toMatchObject({ kind: 'error', icon: 'alert' })
    // Every word the machine can send has its own heading, so no two absences read alike.
    const headings = Object.keys(WHY_SAID).map((word) => whyOf(word).title)
    expect(new Set(headings).size).toBe(headings.length)
  })

  it('says a word it does not know as the read that failed, never as an empty card', () => {
    expect(whyOf('something new')).toEqual(whyOf('could not read'))
    expect(whyOf(null)).toEqual(whyOf('could not read'))
  })
})

describe('a region’s state', () => {
  it('carries its heading as a field of its own', () => {
    expect(stateOf('empty', 'Nothing yet', 'Something would put it here', 'clock')).toEqual({
      kind: 'empty',
      title: 'Nothing yet',
      line: 'Something would put it here',
      icon: 'clock',
    })
  })
})
