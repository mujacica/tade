import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskId } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Workbench } from '../src/workbench.ts'

// A start either gives the agent its opening instruction or starts nothing.
//
// On 2026-11-23 the orchestrator made a task and started it in one breath. While
// its start was on the way, the window opened the new task with nothing said to
// it (clicking a task with no agent opens one), and the start carrying the prompt
// was refused: "already has an agent running". The agent sat idle for ten minutes
// and everything else read as if it were working.
//
// Real lanes running Claude Code's own launch line, with a stand-in `claude` on
// the PATH that writes down how it was started and stays up.

const OPENING = 'Fix the quest plate overlapping the speech bubble, as your context file says.'

const STAND_IN = (said: string) =>
  ['#!/bin/sh', `printf '%s\\n' "$*" >> '${said}'`, 'exec sleep 600'].join('\n')

describe('an agent opened with nothing said, then started with a prompt', () => {
  let home: string
  let client: Workbench
  let started: string
  let was: string | undefined

  const launches = (): string[] =>
    existsSync(started) ? readFileSync(started, 'utf8').trim().split('\n').filter(Boolean) : []

  /** Wait for the stand-in to have been launched this many times, by what it wrote. */
  const launched = async (count: number): Promise<string[]> => {
    const deadline = Date.now() + 20_000
    while (launches().length < count) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for launch ${count}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return launches()
  }

  /** A task the orchestrator just made, whose agents run in Claude Code. */
  const made = async (slug: string) => {
    const task = await client.createTask({ project: 'app', slug, intent: 'fix the quests' })
    await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'claude-code' })
    return task
  }

  beforeEach(async () => {
    const repo = mkrepo()
    home = tmp('tade-start-once-')
    const bin = tmp('tade-start-once-bin-')
    started = join(bin, 'started')
    writeFileSync(join(bin, 'claude'), STAND_IN(started))
    chmodSync(join(bin, 'claude'), 0o755)
    was = process.env.PATH
    process.env.PATH = `${bin}:${was}`
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({
      home,
      version: '9.9.9',
      harnessHome: tmp('tade-start-once-own-'),
      sessionsRoot: tmp('tade-start-once-sessions-'),
    })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
    process.env.PATH = was
  })

  it('is started again with the prompt, rather than the prompt refused', async () => {
    const task = await made('quest-plate')
    await client.reopenAgent({ task: task.id as TaskId, cwd: task.worktree })
    expect((await launched(1))[0]).not.toContain(OPENING)

    const lane = await client.startAgent({
      task: task.id as TaskId,
      cwd: task.worktree,
      prompt: OPENING,
    })

    expect(lane.alive).toBe(true)
    expect((await launched(2))[1]).toContain(OPENING)
    const runs = await client.events({ types: ['run_started', 'run_exited'], task: task.id })
    expect(runs.map((one) => [one.type, one.detail.told ?? null])).toEqual([
      ['run_started', null],
      ['run_exited', null],
      ['run_started', true],
    ])
  }, 60_000)

  it('arriving together, the prompt still reaches it and neither start is refused', async () => {
    const task = await made('together')
    const [opened, told] = await Promise.allSettled([
      client.reopenAgent({ task: task.id as TaskId, cwd: task.worktree }),
      client.startAgent({ task: task.id as TaskId, cwd: task.worktree, prompt: OPENING }),
    ])
    expect(opened.status).toBe('fulfilled')
    expect(told.status).toBe('fulfilled')
    // One after the other, never two agents in one lane at once — the first may
    // be stopped before its program got as far as writing anything.
    const deadline = Date.now() + 20_000
    while (!launches().at(-1)?.includes(OPENING)) {
      if (Date.now() > deadline) throw new Error(`never launched with the opening: ${launches()}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(launches().filter((line) => line.includes(OPENING))).toHaveLength(1)
    const last = (await client.events({ types: ['run_started'], task: task.id })).at(-1)
    expect(last?.detail.told).toBe(true)
  }, 60_000)

  it('is left alone, and the start refused, once it has been told something', async () => {
    const task = await made('told-already')
    await client.startAgent({ task: task.id as TaskId, cwd: task.worktree, prompt: OPENING })
    await launched(1)
    await expect(
      client.startAgent({ task: task.id as TaskId, cwd: task.worktree, prompt: 'and again' }),
    ).rejects.toThrow(/already has an agent running/)
    expect(launches()).toHaveLength(1)
  }, 60_000)

  it('is left alone, and the start refused, once somebody typed to it', async () => {
    const task = await made('typed-to')
    await client.reopenAgent({ task: task.id as TaskId, cwd: task.worktree })
    await launched(1)
    await client.log.append({ type: 'turn_started', task: task.id, run: `${task.id}/agent` })
    await expect(
      client.startAgent({ task: task.id as TaskId, cwd: task.worktree, prompt: OPENING }),
    ).rejects.toThrow(/already has an agent running/)
    expect(launches()).toHaveLength(1)
  }, 60_000)
})
