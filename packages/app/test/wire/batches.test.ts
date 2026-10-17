import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readRuns } from '@tade/checks-core'
import { ConfigSchema, recordsDir, SETTLE_MS } from '@tade/core'
import { readTaskFile, Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { CI_WORKFLOW, ciWorkflow } from '../../../../test/fixtures/workflow.ts'
import { type AppState, initialState } from '../../src/model.ts'
import { BATCH_LOOK_MS, Batches } from '../../src/wire/batches.ts'
import type { Wiring } from '../../src/wire/context.ts'

// The full checks once a batch, from the window: nothing until HEAD has sat
// still, one run at HEAD in a tree of its own, and a red one narrowed to the
// commit that broke it and put to the orchestrator as one parked proposal —
// never an agent per covered task, and never started by this.

const opened: Workbench[] = []
afterEach(async () => {
  for (const one of opened.splice(0)) await one.close().catch(() => {})
})

async function world() {
  const repo = mkrepo()
  repo.commit('the gate', { [CI_WORKFLOW]: ciWorkflow([{ id: 'tests', run: 'test ! -e broken' }]) })
  const config = ConfigSchema.parse({
    projects: { shop: { root: repo.root, checks: { full: 'batched' } } },
  })
  writeFileSync(
    join(repo.home, 'config.yaml'),
    `projects:\n  shop:\n    root: ${repo.root}\n    checks:\n      full: batched\n`,
  )
  const client = await Workbench.open({ home: repo.home })
  opened.push(client)
  let now = 1_000_000
  let state: AppState = initialState()
  const told: string[] = []
  // How often the pass asked for the config: once a look, and never between.
  let asked = 0
  const opts = {
    get config() {
      asked += 1
      return config
    },
    home: repo.home,
    client,
  }
  const wire = {
    opts,
    get state() {
      return state
    },
    put: (next: AppState) => {
      state = next
    },
    now: () => now,
    draw: () => {},
    note: (err: unknown) => {
      throw err
    },
  } as unknown as Wiring
  const batches = new Batches(wire, () => ({
    started: true,
    tell: async (text: string) => {
      told.push(text)
    },
    note: () => {},
  }))
  const runs = () => readRuns(recordsDir(repo.home, 'shop', null))
  return {
    repo,
    client,
    batches,
    told,
    runs,
    at: () => state,
    asked: () => asked,
    later: (ms: number) => {
      now += ms
    },
  }
}

async function until(what: string, check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 60_000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('a batched project, from the window', () => {
  it('looks once a pace however often the beat comes, and asks nothing between', async () => {
    const w = await world()
    await w.batches.beat()
    const once = w.asked()
    expect(once).toBeGreaterThan(0)
    // The task beat comes every couple of seconds; fifty of them inside one pace
    // are fifty returns, not fifty reads of the record and fifty gits.
    for (let i = 0; i < 50; i++) {
      w.later(BATCH_LOOK_MS / 100)
      await w.batches.beat()
    }
    expect(w.asked()).toBe(once)
    w.later(BATCH_LOOK_MS)
    await w.batches.beat()
    expect(w.asked()).toBe(2 * once)
  })

  it('runs the full checks once HEAD has settled, and not again at a HEAD a batch answered', async () => {
    const w = await world()
    await w.batches.beat()
    w.later(SETTLE_MS / 2)
    await w.batches.beat()
    // Inside the look's own pace, and HEAD moved a moment ago: nothing ran.
    expect(await w.runs()).toEqual([])
    w.later(SETTLE_MS)
    await w.batches.beat()
    await until('the batch to be recorded', async () => (await w.runs()).length > 0)
    expect((await w.runs()).map((run) => [run.check, run.state, run.by])).toEqual([
      ['tests', 'passed', 'batch'],
    ])
    w.later(BATCH_LOOK_MS + SETTLE_MS)
    await w.batches.beat()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(await w.runs()).toHaveLength(1)
  })

  it('narrows a red batch to whose commit broke it, and puts one parked proposal to the orchestrator', async () => {
    const w = await world()
    w.later(SETTLE_MS)
    await w.batches.beat()
    await w.batches.beat()
    w.later(BATCH_LOOK_MS + SETTLE_MS)
    await w.batches.beat()
    await until('the green batch', async () => (await w.runs()).length === 1)

    w.repo.commit('work of a\n\nTade-Task: shop/a', { 'a.txt': 'a' })
    const broke = w.repo.commit('work of b\n\nTade-Task: shop/b', { broken: 'yes' })
    const head = w.repo.commit('work of c\n\nTade-Task: shop/c', { 'c.txt': 'c' })
    w.later(BATCH_LOOK_MS)
    await w.batches.beat()
    w.later(BATCH_LOOK_MS + SETTLE_MS)
    await w.batches.beat()
    await until('the orchestrator to be told', () => w.told.length > 0)

    const [said] = w.told
    expect(said).toContain(`went red at ${head.slice(0, 8)}`)
    expect(said).toContain(`first fail at ${broke.slice(0, 8)}`)
    expect(said).toContain("shop/b's by its trailer")
    expect(said).toContain('One agent on it, never one per covered task.')
    const task = `shop/red-full-run-${head.slice(0, 7)}`
    expect(said).toContain(`parked as ${task}`)
    const file = await readTaskFile(w.repo.home, task)
    expect(file?.parked).toBe(true)
    expect(file?.by).toBe('extension:checks')
  })
})
