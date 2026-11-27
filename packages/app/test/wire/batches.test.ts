import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type CheckLog,
  type CheckRun,
  type CheckState,
  OUT_OF_DISK,
  readRuns,
  SLEPT,
  writeRun,
} from '@tade/checks-core'
import { ConfigSchema, recordsDir, SETTLE_MS } from '@tade/core'
import { readTaskFile, Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo } from '../../../../test/fixtures/mkrepo.ts'
import { CI_WORKFLOW, ciWorkflow } from '../../../../test/fixtures/workflow.ts'
import { type AppState, initialState } from '../../src/model.ts'
import { answered, BATCH_LOOK_MS, Batches, diskSaid } from '../../src/wire/batches.ts'
import type { Wiring } from '../../src/wire/context.ts'

// The full checks once a batch, from the window: nothing until HEAD has sat
// still, one run at HEAD in a tree of its own, and a red one narrowed to the
// commit that broke it and put to the orchestrator as one parked proposal —
// never an agent per covered task, and never started by this.

const opened: Workbench[] = []
afterEach(async () => {
  for (const one of opened.splice(0)) await one.close().catch(() => {})
})

async function world(how: { held?: boolean; run?: (home: string) => string } = {}) {
  const repo = mkrepo()
  // Held, the check waits for the test to let it finish: a batch that is going
  // for exactly as long as the test needs it to be.
  const gate = join(repo.home, 'let-it-finish')
  const run = how.run
    ? how.run(repo.home)
    : how.held
      ? `while [ ! -e ${gate} ]; do sleep 0.05; done\ntest ! -e broken`
      : 'test ! -e broken'
  repo.commit('the gate', { [CI_WORKFLOW]: ciWorkflow([{ id: 'tests', run }]) })
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
    release: () => writeFileSync(gate, ''),
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
    // Over, and not only recorded: its record is written before it lets go
    // of the machine, and a look while it still holds it starts nothing anyway.
    await until(
      'the batch over',
      async () => w.batches.running('shop') === null && (await w.runs()).length > 0,
    )
    expect((await w.runs()).map((run) => [run.check, run.state, run.by])).toEqual([
      ['tests', 'passed', 'batch'],
    ])
    w.later(BATCH_LOOK_MS + SETTLE_MS)
    await w.batches.beat()
    // A batch that starts is going by the time the look that started it returns.
    expect(w.batches.running('shop')).toBeNull()
    expect(await w.runs()).toHaveLength(1)
  })

  it('runs a batch the machine slept through again, and once: a sleep is nobody’s red', async () => {
    const w = await world()
    const head = w.repo.head()
    const at = new Date(1_000_000).toISOString()
    await writeRun(recordsDir(w.repo.home, 'shop', null), {
      id: `${head.slice(0, 7)}:tests:here:1`,
      check: 'tests',
      commit: head,
      state: 'cancelled',
      where: { kind: 'here', runner: 'local', host: 'here' },
      required: true,
      startedAt: at,
      finishedAt: at,
      code: null,
      summary: SLEPT,
      by: 'batch',
      tail: '',
    })
    w.later(SETTLE_MS)
    await w.batches.beat()
    await w.batches.beat()
    w.later(BATCH_LOOK_MS + SETTLE_MS)
    await w.batches.beat()
    expect(w.batches.running('shop')).toBe(head)
    await until(
      'the batch over',
      async () => w.batches.running('shop') === null && (await w.runs()).length === 2,
    )
    expect((await w.runs()).map((run) => [run.state, run.summary])).toEqual([
      ['cancelled', SLEPT],
      ['passed', null],
    ])
    expect(w.told).toEqual([])
    w.later(BATCH_LOOK_MS + SETTLE_MS)
    await w.batches.beat()
    expect(w.batches.running('shop')).toBeNull()
  })

  it('sees HEAD settle while a batch runs, and starts the next one as soon as that is over', async () => {
    const w = await world({ held: true })
    w.later(SETTLE_MS)
    await w.batches.beat()
    await w.batches.beat()
    w.later(BATCH_LOOK_MS + SETTLE_MS)
    await w.batches.beat()
    let head = ''
    try {
      expect(w.batches.running('shop')).not.toBeNull()
      head = w.repo.commit('work of a\n\nTade-Task: shop/a', { 'a.txt': 'a' })
      // The look while it runs sees HEAD move, and HEAD then sits still for a minute.
      w.later(BATCH_LOOK_MS)
      await w.batches.beat()
      w.later(SETTLE_MS)
    } finally {
      w.release()
    }
    await until(
      'the first batch over',
      async () => w.batches.running('shop') === null && (await w.runs()).length === 1,
    )
    w.later(BATCH_LOOK_MS)
    await w.batches.beat()
    // Settled already, so this look starts it, rather than starting its minute.
    expect(w.batches.running('shop')).toBe(head)
    await until('the next batch over', () => w.batches.running('shop') === null)
  })

  it('narrows a red batch to whose commit broke it, and puts one parked proposal to the orchestrator', async () => {
    const w = await world()
    w.later(SETTLE_MS)
    await w.batches.beat()
    await w.batches.beat()
    w.later(BATCH_LOOK_MS + SETTLE_MS)
    await w.batches.beat()
    await until(
      'the green batch over',
      async () => w.batches.running('shop') === null && (await w.runs()).length === 1,
    )

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

  it('cannot tell whose commit it was when the one it came to passes on a second look', async () => {
    // A check whose failures vary: with `broken` in the tree it fails the
    // batch, the run again at HEAD and the first at the commit that added it,
    // and then passes — a failure that hangs on the machine, not on a commit.
    const w = await world({
      run: (home) => {
        const script = join(home, 'varying.sh')
        const count = join(home, 'count')
        writeFileSync(
          script,
          [
            'test -e broken || exit 0',
            `n=$(( $(cat '${count}' 2>/dev/null || echo 0) + 1 ))`,
            `echo "$n" > '${count}'`,
            'test "$n" -ge 4',
            '',
          ].join('\n'),
        )
        return `sh ${script}`
      },
    })
    w.later(SETTLE_MS)
    await w.batches.beat()
    await w.batches.beat()
    w.later(BATCH_LOOK_MS + SETTLE_MS)
    await w.batches.beat()
    await until(
      'the green batch over',
      async () => w.batches.running('shop') === null && (await w.runs()).length === 1,
    )

    w.repo.commit('work of a\n\nTade-Task: shop/a', { 'a.txt': 'a' })
    const blamed = w.repo.commit('work of b\n\nTade-Task: shop/b', { broken: 'yes' })
    const head = w.repo.commit('work of c\n\nTade-Task: shop/c', { 'c.txt': 'c' })
    w.later(BATCH_LOOK_MS)
    await w.batches.beat()
    w.later(BATCH_LOOK_MS + SETTLE_MS)
    await w.batches.beat()
    await until('the orchestrator to be told', () => w.told.length > 0)

    const [said] = w.told
    expect(said).toContain(`went red at ${head.slice(0, 8)}`)
    expect(said).toContain(
      `Whose commit broke it: cannot tell — the failing tests failed at ${blamed.slice(0, 8)} and then passed when they ran there a second time.`,
    )
    expect(said).not.toContain("shop/b's by its trailer")
    expect(said).toContain('Leave it if the next batch is green')
    const file = await readTaskFile(w.repo.home, `shop/red-full-run-${head.slice(0, 7)}`)
    expect(file?.parked).toBe(true)
  })
})

describe('whether a batch answered HEAD', () => {
  const run = (state: CheckState, at: number, over: Partial<CheckRun> = {}): CheckRun => ({
    id: `abc:tests:here:${at}`,
    check: 'tests',
    commit: 'abc',
    state,
    where: { kind: 'here', runner: 'local', host: 'here' },
    required: true,
    startedAt: new Date(at).toISOString(),
    finishedAt: new Date(at).toISOString(),
    code: null,
    summary: state === 'cancelled' ? SLEPT : null,
    by: 'batch',
    ...over,
  })

  it('not by a batch the machine slept through, nor by nobody’s', () => {
    expect(answered([], [], 'abc')).toBe(false)
    expect(answered([], [run('passed', 1, { by: 'shop/a' })], 'abc')).toBe(false)
    expect(answered([], [run('cancelled', 1)], 'abc')).toBe(false)
  })

  it('by the first batch after the sleep that stayed awake, red included', () => {
    expect(answered([], [run('cancelled', 1), run('failed', 2)], 'abc')).toBe(true)
    expect(answered([], [run('failed', 1)], 'abc')).toBe(true)
    // Another reason a run was cancelled is still that batch's answer.
    expect(answered([], [run('cancelled', 1, { summary: null })], 'abc')).toBe(true)
  })

  it('not by a batch the disk was full for, and by the next one that had room', () => {
    const full = run('cancelled', 1, { summary: OUT_OF_DISK })
    expect(answered([], [full], 'abc')).toBe(false)
    expect(answered([full], [], 'abc')).toBe(false)
    expect(answered([], [full, run('failed', 2)], 'abc')).toBe(true)
  })
})

describe('a batch the disk was full for', () => {
  const log = (over: Partial<CheckLog>): CheckLog => ({
    id: 'abc:tests:here:1',
    check: 'tests',
    commit: 'abc',
    state: 'cancelled',
    where: { kind: 'here', runner: 'local', host: 'here' },
    required: true,
    startedAt: null,
    finishedAt: null,
    code: 1,
    summary: OUT_OF_DISK,
    by: 'batch',
    tail: 'fatal: Unable to create index.lock: No space left on device',
    ...over,
  })

  it('is said as the machine’s disk, naming the check, rather than made anybody’s red', () => {
    expect(diskSaid([log({})])).toContain('the machine ran out of disk while tests ran')
  })

  it('is not, for a red run, a run nobody needs, or another reason to cancel', () => {
    expect(diskSaid([log({ state: 'failed', summary: '827 files failed' })])).toBeNull()
    expect(diskSaid([log({ required: false })])).toBeNull()
    expect(diskSaid([log({ summary: SLEPT })])).toBeNull()
  })
})
