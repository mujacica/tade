import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type EventFilter, matchesFilter, type TadeEvent, taskDir } from '@tade/core'
import { type RunId, runFolderName, type WorkerAdapter } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import type { LaneRecord } from '../src/registry.ts'
import { type RunsHome, settleRuns } from '../src/run-files.ts'
import { Workbench } from '../src/workbench.ts'

// What a harness wrote to launch a run goes once nothing can launch it again:
// its task was made and is gone, and its lane is neither running nor `lost`.

let seq = 0
const said = (type: 'task_created' | 'run_started', task: string): TadeEvent => ({
  seq: ++seq,
  ts: new Date().toISOString(),
  type,
  urgency: 'notable',
  task,
  lane: null,
  run: type === 'run_started' ? `${task}/agent` : null,
  detail: {},
})

/** A task made, and its agent started. */
const ran = (task: string) => [said('task_created', task), said('run_started', task)]

function taskFile(home: string, task: string): void {
  mkdirSync(taskDir(home, task), { recursive: true })
  writeFileSync(join(taskDir(home, task), 'task.yaml'), `id: ${task}\n`)
}

/** A harness that takes away every run it is asked about, and says which it was asked. */
function recording(): WorkerAdapter & { asked: RunId[][] } {
  const asked: RunId[][] = []
  return {
    id: 'recording',
    asked,
    forgetRuns: async (runs: readonly RunId[]) => {
      asked.push([...runs])
      return [...runs]
    },
  } as unknown as WorkerAdapter & { asked: RunId[][] }
}

function homeWith(
  events: TadeEvent[],
  lanes: Partial<LaneRecord>[],
  adapters: WorkerAdapter[],
): RunsHome & { warnings: string[] } {
  const warnings: string[] = []
  return {
    home: tmp('tade-run-files-'),
    log: {
      read: async (filter: EventFilter = {}) => events.filter((one) => matchesFilter(one, filter)),
      append: async (event) => {
        if (event.type === 'warning') warnings.push(event.detail.message)
        return said('task_created', 'unused')
      },
    },
    lanes: () => lanes as LaneRecord[],
    adapters: () => adapters,
    warnings,
  }
}

describe('a run’s files', () => {
  it('go once its task is gone, and never for a task still there, a chat, or an agent running or lost', async () => {
    const harness = recording()
    const deps = homeWith(
      [
        ...ran('shop/kept'),
        ...ran('shop/gone'),
        ...ran('shop/running'),
        ...ran('shop/lost'),
        // A chat never had a task file, and is brought back from the journal.
        said('run_started', 'chats/3'),
      ],
      [
        { id: 'shop/running/agent', task: 'shop/running', alive: true },
        { id: 'shop/lost/agent', task: 'shop/lost', alive: false, lost: true },
      ],
      [harness],
    )
    taskFile(deps.home, 'shop/kept')

    expect(await settleRuns(deps)).toEqual(['shop/gone/agent'])
    expect(harness.asked).toEqual([['shop/gone/agent']])
  })

  it('go for the one task named, when one is', async () => {
    const harness = recording()
    const deps = homeWith([...ran('shop/gone'), ...ran('shop/also-gone')], [], [harness])
    expect(await settleRuns(deps, 'shop/also-gone')).toEqual(['shop/also-gone/agent'])
    expect(await settleRuns(deps, 'shop/never-made')).toEqual([])
    expect(harness.asked).toEqual([['shop/also-gone/agent']])
  })

  it('stay where the task file cannot be reached: that is not work that is over', async () => {
    const harness = recording()
    const deps = homeWith(ran('shop/unreadable'), [], [harness])
    taskFile(deps.home, 'shop/unreadable')
    const tasks = join(taskDir(deps.home, 'shop/unreadable'), '..')
    chmodSync(tasks, 0o000)
    try {
      expect(await settleRuns(deps)).toEqual([])
    } finally {
      chmodSync(tasks, 0o700)
    }
    expect(harness.asked).toEqual([])
  })

  it('are asked of every harness, and one that fails is said without stopping the rest', async () => {
    const after = recording()
    const failing = {
      id: 'broken',
      forgetRuns: async () => {
        throw new Error('EACCES: permission denied')
      },
    } as unknown as WorkerAdapter
    const deps = homeWith(ran('shop/gone'), [], [failing, after])
    expect(await settleRuns(deps)).toEqual(['shop/gone/agent'])
    expect(after.asked).toEqual([['shop/gone/agent']])
    expect(deps.warnings).toEqual([
      "could not take away broken's files for runs that are over: Error: EACCES: permission denied",
    ])
  })
})

describe('a removed task’s run folder', () => {
  let client: Workbench | null = null
  afterEach(async () => {
    await client?.close().catch(() => {})
    client = null
  })

  it('goes with the task, and one whose task went otherwise goes when the window next opens', async () => {
    const repo = mkrepo()
    const home = tmp('tade-run-files-home-')
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'agents:',
        '  workspace: checkout',
        'projects:',
        '  shop:',
        `    root: ${repo.root}`,
        '',
      ].join('\n'),
    )
    const folderOf = (task: string) => join(home, 'runs', 'claude', runFolderName(`${task}/agent`))
    const launched = async (task: string) => {
      await client?.createTask({ project: 'shop', slug: task.split('/')[1] ?? '', intent: task })
      await client?.log.append({ type: 'run_started', task, run: `${task}/agent` })
      mkdirSync(folderOf(task), { recursive: true })
      writeFileSync(join(folderOf(task), 'settings.json'), '{}')
    }
    client = await Workbench.open({ home, version: '9.9.9' })
    await launched('shop/refunds')
    await launched('shop/returns')

    await client.removeTask({
      root: repo.root,
      worktree: repo.root,
      branch: 'main',
      task: 'shop/refunds',
    })
    expect(existsSync(folderOf('shop/refunds'))).toBe(false)
    expect(existsSync(folderOf('shop/returns'))).toBe(true)

    await client.close()
    rmSync(taskDir(home, 'shop/returns'), { recursive: true })
    client = await Workbench.open({ home, version: '9.9.9' })
    expect(existsSync(folderOf('shop/returns'))).toBe(false)
  })
})
