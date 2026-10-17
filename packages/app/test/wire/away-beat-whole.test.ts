import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type Config,
  ConfigSchema,
  inWrittenOrder,
  type Queued,
  type Task,
  type Workspace,
} from '@tade/core'
import type { StatusCollector } from '@tade/status'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { awayCollections } from '../../src/away.ts'
import { JOURNAL } from '../../src/histories.ts'
import { Live } from '../../src/live.ts'
import { type Beatable, beatParts } from '../../src/wire/web-beat.ts'

// The away view's beat reads whole-journal lists for everything it counts,
// orders or says is there, and never `Live.events`, which is the last 500
// lines. A busy machine puts more than that after an agent's start, a written
// order, a document or an override in an afternoon: folded from the tail, a
// run's step drew nought starts for a task the door counts twice, a phone drew
// no order where the window still starts work in the one somebody wrote, no
// document where one was handed over, and checks nobody had overruled.

const opened: { live: Live; client: Workbench }[] = []

afterEach(async () => {
  for (const one of opened.splice(0)) {
    await one.live.stop().catch(() => {})
    await one.client.close().catch(() => {})
  }
})

/** Status nobody looks at: what is asked here is the journal's, not the trees'. */
const unlooked: StatusCollector = {
  id: 'unlooked',
  collect: async () => ({ known: false, why: 'nothing here looks at status' }),
  close: async () => {},
}

/** A window opened after `lines` were written and then a busy machine: more than it keeps. */
async function longAgo(lines: (client: Workbench) => Promise<void>) {
  const repo = mkrepo()
  const home = tmp('tade-beat-whole-')
  const config: Config = ConfigSchema.parse({ projects: { app: { root: repo.root } } })
  // JSON is YAML, so the home's file says exactly what the window was handed.
  writeFileSync(
    join(home, 'config.yaml'),
    JSON.stringify({ projects: { app: { root: repo.root } } }),
  )
  const client = await Workbench.open({ home })
  await lines(client)
  for (let i = 0; i < JOURNAL + 20; i++) {
    await client.log.append({ type: 'output', lane: 'app/other/agent', detail: { bytes: 1 } })
  }
  const live = await Live.start({
    client,
    config,
    home: tmp('tade-beat-whole-user-'),
    tadeHome: home,
    pollMs: 600_000,
    status: unlooked,
  })
  opened.push({ live, client })
  await live.refresh()
  return { live, client }
}

/** What the beat reads of the window, as `partsFrom` hands it over. */
function beatable(live: Live, queued: readonly Queued[] = live.queued): Beatable {
  return {
    rootLines: live.rootLines,
    overrideLines: live.overrideLines,
    pending: live.pending,
    seenActions: (task) => live.seenActions(task),
    spendToday: () => live.spendToday(),
    queued,
    queueFacts: () => live.queueFacts(),
    notes: (project) => live.notes(project),
    tasks: live.tasks,
    titles: {},
    plans: [],
    machineUpSince: null,
    spendSince: null,
    checks: null,
  }
}

function taskOf(id: string, effort?: string): Task {
  return {
    id,
    project: 'app',
    branch: `tade/${id}`,
    worktree: '/nowhere',
    created: '2026-10-17T08:00:00.000Z',
    state: 'working',
    reason: 'turning',
    stalled: false,
    git: null,
    agents: [],
    lanes: [],
    ...(effort === undefined ? {} : { effort }),
  } as unknown as Task
}

function worldOf(tasks: readonly Task[]): Workspace {
  return {
    generatedAt: '2026-10-17T12:00:00.000Z',
    projects: [{ name: 'app', root: '/nowhere', brief: null, untracked: [], tasks: [...tasks] }],
    elsewhere: [],
    toolServers: { looked: true, alive: 0 },
    warnings: [],
  } as unknown as Workspace
}

const notSteerable = () => ({ how: null, why: 'nothing here' })

function queuedOf(task: string): Queued {
  return { task, project: 'app', parked: false, start: { after: [], prompt: '', touches: [] } }
}

describe('the away view’s beat, after more lines than the window keeps', () => {
  it('counts a run’s starts over the whole journal, as the door that re-reads it does', async () => {
    const task = 'app/one'
    const { live, client } = await longAgo(async (one) => {
      for (const _ of [1, 2]) {
        await one.log.append({
          type: 'run_started',
          task,
          lane: `${task}/agent`,
          run: `${task}/agent`,
          detail: { harness: 'pi', model: 'claude-opus-5' },
        })
      }
    })
    // The trap is set: the window's tail has neither start, the queue's whole list has both.
    expect(live.events.some((line) => line.type === 'run_started')).toBe(false)
    expect(live.queueFacts().events.filter((line) => line.type === 'run_started')).toHaveLength(2)

    const parts = beatParts(beatable(live), worldOf([taskOf(task, 'e1')]), notSteerable)
    const step = parts.runs.find((run) => run.run === 'e1')?.steps.find((one) => one.task === task)
    // Two is a retry, and the step says so.
    expect(step?.runs).toBe(2)
    // The same count the task's row carries in its revision, and the one
    // `stop` and `reopen` count again out of the whole journal at the act.
    expect(step?.runs).toBe(parts.extras.get(task)?.starts)
    expect(step?.runs).toBe((await client.events({ types: ['run_started'], task })).length)
  })

  it('draws the order written for the queue, as the window still starts it', async () => {
    const { live } = await longAgo(async (one) => {
      await one.log.append({
        type: 'queue_changed',
        detail: { change: 'order', by: 'you', order: ['app/two', 'app/one'] },
      })
    })
    expect(live.events.some((line) => line.type === 'queue_changed')).toBe(false)
    expect(live.queueFacts().events.some((line) => line.type === 'queue_changed')).toBe(true)

    const queued = [queuedOf('app/one'), queuedOf('app/two')]
    const world = worldOf([taskOf('app/one'), taskOf('app/two')])
    const parts = beatParts(beatable(live, queued), world, notSteerable)
    expect(parts.order).toEqual(['app/two', 'app/one'])
    const rows = awayCollections(parts).queue
    const at = new Map(rows.map((row) => [row.task, row.order]))
    expect(at.get('app/two')).toBe(0)
    expect(at.get('app/one')).toBe(1)
    // What the window's own pass starts first among the ready is what the phone put first.
    expect(inWrittenOrder(queued, live.queueFacts().events).map((one) => one.task)).toEqual([
      'app/two',
      'app/one',
    ])
  })

  it('says a task produced its document, however long ago it was handed over', async () => {
    const task = 'app/one'
    const { live } = await longAgo(async (one) => {
      await one.log.append({
        type: 'document_ready',
        task,
        detail: { produces: 'plan.md', bytes: 120 },
      })
    })
    expect(live.events.some((line) => line.type === 'document_ready')).toBe(false)
    expect(live.queueFacts().events.some((line) => line.type === 'document_ready')).toBe(true)

    const parts = beatParts(
      beatable(live),
      worldOf([taskOf(task), taskOf('app/two')]),
      notSteerable,
    )
    expect(parts.extras.get(task)?.produced).toBe(true)
    expect(parts.extras.get('app/two')?.produced).toBe(false)
  })

  it('says a task’s checks were overruled, however long ago, and hears one written since', async () => {
    const task = 'app/one'
    const override = (on: string) => ({
      type: 'tool_call' as const,
      task: on,
      detail: {
        tool: 'checks_override',
        caller: 'agent',
        input: { scope: 'this task', reason: 'flaky PTY timeout', hours: 1 },
      },
    })
    const { live, client } = await longAgo(async (one) => {
      await one.log.append(override(task))
    })
    expect(live.events.some((line) => line.detail.tool === 'checks_override')).toBe(false)

    const world = worldOf([taskOf(task), taskOf('app/two')])
    let parts = beatParts(beatable(live), world, notSteerable)
    expect(parts.extras.get(task)?.overridden).toBe(true)
    expect(parts.extras.get('app/two')?.overridden).toBe(false)
    expect(live.overrideLines.map((line) => line.task)).toEqual([task])

    // Written while the window is open: kept as it is heard, and only that tool's calls.
    await client.log.append({ type: 'tool_call', task: 'app/two', detail: { tool: 'status' } })
    await client.log.append(override('app/two'))
    await vi.waitFor(() => expect(live.overrideLines).toHaveLength(2))
    parts = beatParts(beatable(live), world, notSteerable)
    expect(parts.extras.get('app/two')?.overridden).toBe(true)
  })
})
