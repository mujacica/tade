import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, type TaskId, taskDir } from '@tade/core'
import { readTaskFile, reportLeftovers, Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import type { App } from '../../src/app.ts'
import type { AppState } from '../../src/model.ts'
import {
  type FakeTerminal,
  HARNESSES,
  type Repo,
  SPAWNING_MS,
  until,
  windowUnderTest,
} from './harness.ts'

// A finished agent's lane closing by itself, through the real window and a real
// workbench: what holds it open, what it waits for, and that only the lane goes.

const T = 'app/refunds'
const LANE = `${T}/agent`

describe('agents that close when done', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  const { start, beats, newTerminal } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
  })

  const worktree = () => join(repo.root, '..', 'worktrees', 'app-refunds')
  /** Past the settling and any retry: what the clock does is `close-when-done.test.ts`'s. */
  let ahead = 0
  const now = () => Date.now() + 60_000 + ahead

  const settings = (agents: object, project: object = {}) =>
    ConfigSchema.parse({ agents, projects: { app: { root: repo.root, ...project } } })

  const wireOf = (window: App) =>
    (window as unknown as { wire: { state: AppState; put(state: AppState): void } }).wire
  const standOn = (window: App, focused: string) => {
    const wire = wireOf(window)
    wire.put({ ...wire.state, focused })
  }
  /** Standing somewhere else, so nobody is looking at the agent being closed. */
  const lookAway = (window: App) => standOn(window, 'app/search')
  const lane = (of: Workbench = client) => of.lanes().find((one) => String(one.id) === LANE)
  const closedLines = (of: Workbench = client) => of.events({ types: ['agent_closed'] })

  /** A window with the setting on, an agent in the lane, and whatever it was told recorded. */
  const working = async (
    over: { agents?: object; project?: object; tell?: (text: string) => Promise<void> } = {},
  ) => {
    const told: { text: string; alive: boolean | undefined }[] = []
    const window = await start({
      now,
      config: settings(over.agents ?? { close_when_done: true }, over.project),
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          await over.tell?.(text)
          told.push({ text, alive: lane()?.alive })
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    await client.startAgent({ task: T as TaskId, cwd: worktree(), prompt: '' })
    await until('its lane', () => lane()?.alive === true, SPAWNING_MS)
    lookAway(window)
    return { window, told }
  }

  const finish = async (summary = 'charges once') => {
    await client.log.append({ type: 'turn_started', task: T, detail: {} })
    await client.log.append({ type: 'task_done', task: T, detail: { by: 'agent', summary } })
    await client.log.append({ type: 'turn_done', task: T, detail: { status: 'ok' } })
  }

  it('leaves a finished agent open unless somebody turned it on', async () => {
    const { told } = await working({ agents: {} })
    await finish()
    await beats(3)
    expect(lane()?.alive).toBe(true)
    expect(await closedLines()).toEqual([])
    // Off, the report is what it always was: news, and no turn of its own.
    expect(told).toEqual([])
  })

  it('leaves it open where the project says off, over the machine', async () => {
    await working({ project: { close_when_done: 'off' } })
    await finish()
    await beats(3)
    expect(lane()?.alive).toBe(true)
    expect(await closedLines()).toEqual([])
  })

  it('closes it on the project’s word, and says whose word it was', async () => {
    await working({ agents: {}, project: { close_when_done: 'on' } })
    await finish()
    await until('the close', async () => (await closedLines()).length === 1, SPAWNING_MS)
    expect((await closedLines())[0]?.detail.setting).toBe('projects.app.close_when_done')
  })

  it('tells the orchestrator first, closes only the lane, and writes down why', async () => {
    const { told } = await working()
    await finish()
    await until('the close', async () => (await closedLines()).length === 1, SPAWNING_MS)

    // What it reported was in the orchestrator's hands with the lane still there.
    expect(told[0]?.text).toContain('app/refunds finished (its agent said so): charges once')
    expect(told[0]?.alive).toBe(true)
    expect(told.filter((one) => one.text.includes('charges once'))).toHaveLength(1)

    const [line] = await closedLines()
    expect(line).toMatchObject({
      task: T,
      detail: { done_by: 'agent', setting: 'agents.close_when_done', lost: false },
    })
    const [stopped] = await client.events({ types: ['run_exited'], task: T })
    expect(stopped?.seq).toBeLessThan(line?.seq ?? 0)

    // Only the lane: the task, its worktree and its branch are all still here.
    expect(lane()?.alive).toBe(false)
    expect(lane()?.lost).toBeUndefined()
    expect(existsSync(join(taskDir(home, T), 'task.yaml'))).toBe(true)
    expect(existsSync(worktree())).toBe(true)
    expect(await client.events({ types: ['task_removed'] })).toEqual([])
    await until('it said so', () => terminal.written.includes('Closed the agent'))
  })

  it('waits for the turn to end, however long that takes', async () => {
    const { told } = await working()
    await client.log.append({ type: 'turn_started', task: T, detail: {} })
    await client.log.append({ type: 'task_done', task: T, detail: { by: 'agent', summary: 'x' } })
    await until('the report', () => told.length > 0)
    await beats(3)
    expect(lane()?.alive).toBe(true)
    await client.log.append({ type: 'turn_done', task: T, detail: { status: 'ok' } })
    await until('the close', async () => (await closedLines()).length === 1, SPAWNING_MS)
  })

  it('leaves one that asked a question, however its turn ended', async () => {
    await working()
    await client.log.append({ type: 'turn_started', task: T, detail: {} })
    await client.log.append({ type: 'document_ready', task: T, detail: { asked: 'A or B?' } })
    await client.log.append({ type: 'turn_done', task: T, detail: { status: 'ok' } })
    await beats(3)
    expect(lane()?.alive).toBe(true)
    expect(await closedLines()).toEqual([])
  })

  it('has what it left parked and told by the time the lane goes', async () => {
    let parkedWhenTold: boolean | undefined
    const left: string[] = []
    const { told } = await working({
      tell: async (text) => {
        if (text.includes('finished (')) {
          const item = (await client.events({ types: ['leftovers_reported'] }))[0]?.detail
            .items as {
            task: string
          }[]
          left.push(item[0]?.task ?? '')
          parkedWhenTold = (await readTaskFile(home, item[0]?.task ?? ''))?.parked !== undefined
        }
      },
    })
    await reportLeftovers(client, {
      task: T,
      run: LANE,
      input: {
        items: [
          {
            title: 'The retry loop has no ceiling',
            where: 'retry.ts:4',
            why: 'not this task',
            sure: 'likely',
          },
        ],
        finishing: true,
      },
    })
    await finish()
    await until('the close', async () => (await closedLines()).length === 1, SPAWNING_MS)
    expect(parkedWhenTold).toBe(true)
    const leftAt = told.findIndex((one) => one.text.includes('The retry loop has no ceiling'))
    const doneAt = told.findIndex((one) => one.text.includes('finished ('))
    expect(leftAt).toBeGreaterThanOrEqual(0)
    expect(leftAt).toBeLessThan(doneAt)
    expect(await readTaskFile(home, left[0] ?? '')).not.toBeNull()
  })

  it('keeps the lane open while the report cannot be told, says so once, and tries again', async () => {
    let refusing = true
    const { window } = await working({
      tell: async () => {
        if (refusing) throw new Error('the model is overloaded')
      },
    })
    await finish()
    await until('it said why', () => terminal.written.includes('overloaded'), SPAWNING_MS)
    await beats(3)
    expect(lane()?.alive).toBe(true)
    expect(await closedLines()).toEqual([])
    const said = JSON.stringify(wireOf(window).state.transcript.entries)
    expect(said.split('the model is overloaded').length - 1).toBe(1)
    refusing = false
    ahead += 120_000
    await until('the close', async () => (await closedLines()).length === 1, SPAWNING_MS)
  })

  it('leaves the one somebody is looking at until they look away', async () => {
    const { window } = await working()
    standOn(window, T)
    await finish()
    await beats(3)
    expect(lane()?.alive).toBe(true)
    lookAway(window)
    await until('the close', async () => (await closedLines()).length === 1, SPAWNING_MS)
  })

  it('does not undo somebody opening it again, and closes it when it finishes again', async () => {
    await working()
    await finish()
    await until('the close', async () => (await closedLines()).length === 1, SPAWNING_MS)
    // Started rather than reopened: this fixture's pi keeps no record of a
    // conversation to come back to, and what is read here is the `run_started`
    // line, which both write.
    await client.startAgent({ task: T as TaskId, cwd: worktree(), prompt: 'one more thing' })
    await until('it back', () => lane()?.alive === true, SPAWNING_MS)
    await beats(3)
    expect(lane()?.alive).toBe(true)
    expect(await closedLines()).toHaveLength(1)
    await finish('charges once, again')
    await until('the second close', async () => (await closedLines()).length === 2, SPAWNING_MS)
  })

  it('does not bring it back on the next open, and does not call it lost after', async () => {
    const first = await working()
    await finish()
    await until('the close', async () => (await closedLines()).length === 1, SPAWNING_MS)
    await first.window.stop()
    await client.close()
    const after = await Workbench.open({ home, harnesses: HARNESSES })
    try {
      expect(lane(after)?.alive).toBe(false)
      expect(lane(after)?.lost).toBeUndefined()
      terminal = newTerminal()
      await start({ client: after, now, config: settings({ close_when_done: true }) })
      await beats(3)
      expect(lane(after)?.alive).toBe(false)
      expect(after.runs()).toEqual([])
    } finally {
      await after.close()
    }
  })

  it('closes rather than brings back one finished as the window went', async () => {
    const window = await start({
      now,
      config: settings({}),
      thinker: { ask: async () => 'ok', tell: async () => {} },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    await client.startAgent({ task: T as TaskId, cwd: worktree(), prompt: '' })
    await finish()
    await window.stop()
    await client.close()
    const after = await Workbench.open({ home, harnesses: HARNESSES })
    try {
      expect(lane(after)?.lost).toBe(true)
      terminal = newTerminal()
      const told: string[] = []
      await start({
        client: after,
        now,
        config: settings({ close_when_done: true }),
        thinker: {
          ask: async () => 'ok',
          tell: async (text: string) => {
            told.push(text)
          },
        },
      })
      await until('the close', async () => (await closedLines(after)).length === 1, SPAWNING_MS)
      const [line] = await closedLines(after)
      expect(line?.detail.lost).toBe(true)
      // Told too: nothing says the window that went got to tell it.
      expect(told.join('\n')).toContain('charges once')
      expect(lane(after)?.lost).toBeUndefined()
      expect(after.runs()).toEqual([])
    } finally {
      await after.close()
    }
  })
})
