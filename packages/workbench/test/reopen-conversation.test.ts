import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaneId, TadeEvent, TaskId } from '@tade/core'
import { sessionIdFor } from '@tade/harnesses-claude'
import { rememberThread } from '@tade/harnesses-codex'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { wasTold } from '../src/accounts.ts'
import { Workbench } from '../src/workbench.ts'

// An agent comes back to its own conversation, whichever account new agents run
// as by now. Real lanes running each harness's own launch line, and a stand-in
// program on the PATH that writes down how it was started and keeps a transcript
// where Claude Code would.
//
// One agent reopened on an account that had never heard of it opened a new empty
// session under its own id: no prompt, no history, and nothing to say anything
// was wrong. A window that lost a lane's record by a failed save did that.

const STAND_IN = (said: string) =>
  [
    '#!/bin/sh',
    `printf '%s %s\\n' "\${CLAUDE_CONFIG_DIR:-\${CODEX_HOME:-}}" "$*" >> '${said}'`,
    'if [ "$1" = "--session-id" ]; then',
    '  dir="$CLAUDE_CONFIG_DIR/projects/-wt"',
    '  mkdir -p "$dir"',
    `  printf '{"said":"its first prompt"}\\n' > "$dir/$2.jsonl"`,
    'fi',
    'exec sleep 600',
  ].join('\n')

describe('reopening an agent after new agents moved to another account', () => {
  let home: string
  let own: string
  let sessionsRoot: string
  let client: Workbench
  let repo: ReturnType<typeof mkrepo>
  let started: string
  let was: string | undefined

  const open = async () => {
    client = await Workbench.open({ home, version: '9.9.9', harnessHome: own, sessionsRoot })
  }

  /** The next window, whose `lanes.json` has lost what it knew about this agent. */
  const anotherWindow = async (
    task: string,
    change: (lane: Record<string, unknown>) => unknown,
  ) => {
    await client.close()
    const path = join(home, 'lanes.json')
    const file = JSON.parse(readFileSync(path, 'utf8')) as { lanes: Record<string, unknown>[] }
    file.lanes = file.lanes.flatMap((lane) => {
      if (lane.id !== `${task}/agent`) return [lane]
      const kept = change(lane)
      return kept ? [kept as Record<string, unknown>] : []
    })
    writeFileSync(path, JSON.stringify(file))
    await open()
  }

  const lastRun = async (task: string): Promise<TadeEvent | undefined> =>
    (await client.events({ types: ['run_started'], task })).at(-1)

  const until = async (check: () => boolean, what: string): Promise<void> => {
    const deadline = Date.now() + 20_000
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /** How the program was last started, once it has been. */
  const lastLaunch = async (count: number): Promise<string> => {
    const lines = () =>
      existsSync(started) ? readFileSync(started, 'utf8').trim().split('\n') : []
    await until(() => lines().length >= count, `launch ${count}`)
    return lines()[count - 1] ?? ''
  }

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-reopen-')
    own = tmp('tade-reopen-own-')
    sessionsRoot = tmp('tade-reopen-sessions-')
    const bin = tmp('tade-reopen-bin-')
    started = join(bin, 'started')
    for (const name of ['claude', 'codex']) {
      writeFileSync(join(bin, name), STAND_IN(started))
      chmodSync(join(bin, name), 0o755)
    }
    was = process.env.PATH
    process.env.PATH = `${bin}:${was}`
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    await open()
  })

  afterEach(async () => {
    await client.close().catch(() => {})
    process.env.PATH = was
  })

  describe('in a harness whose transcript is a file named by the task', () => {
    /** An agent that ran on the own sign-in, stopped, and has a transcript there. */
    const ranOnOwnSignIn = async () => {
      await client.addAccount({ name: 'personal', harness: 'claude-code' })
      const task = await client.createTask({ project: 'app', slug: 'ran', intent: 'fix it' })
      await client.setAgentHarness({
        task: task.id,
        worktree: task.worktree,
        harness: 'claude-code',
      })
      await client.startAgent({ task: task.id, cwd: task.worktree, prompt: 'its first prompt' })
      const transcript = join(own, '.claude', 'projects', '-wt', `${sessionIdFor(task.id)}.jsonl`)
      await until(() => existsSync(transcript), 'its transcript')
      await client.stopAgent(task.id)
      await client.useAccount('claude-code', 'personal')
      return { task, transcript }
    }

    it('goes back to the sign-in that keeps it when the lane’s record is gone', async () => {
      const { task } = await ranOnOwnSignIn()
      await anotherWindow(task.id, () => null)
      await client.reopenAgent({ task: task.id, cwd: task.worktree })
      expect((await lastRun(task.id))?.detail.account).toBeNull()
      const id = sessionIdFor(task.id)
      expect(await lastLaunch(2)).toContain(join(own, '.claude'))
      expect(await lastLaunch(2)).toContain(`--resume ${id}`)
      expect(await lastLaunch(2)).not.toContain('--session-id')
    }, 60_000)

    it('goes back to the sign-in that keeps it when the lane’s record names another', async () => {
      const { task } = await ranOnOwnSignIn()
      // What a reopen onto an empty session left behind.
      await anotherWindow(task.id, (lane) => ({ ...lane, account: 'personal' }))
      expect((await client.agentHarness(task.id)).account).toBeNull()
      await client.reopenAgent({ task: task.id, cwd: task.worktree })
      expect((await lastRun(task.id))?.detail.account).toBeNull()
      expect(await lastLaunch(2)).toContain(`--resume ${sessionIdFor(task.id)}`)
    }, 60_000)

    it('carries it, whatever the record says, to the account somebody moved the agent to', async () => {
      const { task, transcript } = await ranOnOwnSignIn()
      await anotherWindow(task.id, () => null)
      const moved = await client.setAgentAccount({
        task: task.id,
        worktree: task.worktree,
        account: 'personal',
      })
      expect(moved.carried).toBe(true)
      await client.reopenAgent({ task: task.id, cwd: task.worktree })
      expect((await lastRun(task.id))?.detail.account).toBe('personal')
      const launched = await lastLaunch(2)
      expect(launched).toContain(join(home, 'accounts', 'personal'))
      expect(launched).toContain(`--resume ${sessionIdFor(task.id)}`)
      expect(
        readFileSync(
          join(home, 'accounts', 'personal', 'projects', '-wt', `${sessionIdFor(task.id)}.jsonl`),
          'utf8',
        ),
      ).toBe(readFileSync(transcript, 'utf8'))
    }, 60_000)

    it('carries it at the reopen where the move could not', async () => {
      const { task } = await ranOnOwnSignIn()
      // Moved by a Tade that looked for it on the wrong sign-in: chosen, not carried.
      const file = join(home, 'projects', 'app', 'tasks', 'ran', 'task.yaml')
      writeFileSync(file, `${readFileSync(file, 'utf8')}account: personal\n`)
      await client.reopenAgent({ task: task.id, cwd: task.worktree })
      expect((await lastRun(task.id))?.detail.account).toBe('personal')
      expect(await lastLaunch(2)).toContain(`--resume ${sessionIdFor(task.id)}`)
      const carried = await client.events({ types: ['state_change'], task: task.id })
      expect(carried.at(-1)?.detail).toEqual({ account: 'personal', carried: true, by: 'reopen' })
    }, 60_000)

    it('says so when no sign-in keeps it, rather than opening an empty session', async () => {
      const { task, transcript } = await ranOnOwnSignIn()
      rmSync(transcript)
      await expect(client.reopenAgent({ task: task.id, cwd: task.worktree })).rejects.toThrow(
        /was told what to do, and claude-code keeps no record of its conversation on any account/,
      )
      expect(client.lane(`${task.id}/agent` as LaneId)?.alive).toBe(false)
      expect(await client.events({ types: ['run_started'], task: task.id })).toHaveLength(1)
      // A prompt is a new start, which nothing here stands in the way of.
      await client.startAgent({ task: task.id, cwd: task.worktree, prompt: 'start over' })
      expect(await lastLaunch(2)).toContain('--session-id')
    }, 60_000)

    it('opens an agent nothing was ever said to, which has no conversation to have lost', async () => {
      const task = await client.createTask({ project: 'app', slug: 'quiet', intent: 'not yet' })
      await client.setAgentHarness({
        task: task.id,
        worktree: task.worktree,
        harness: 'claude-code',
      })
      await client.reopenAgent({ task: task.id, cwd: task.worktree })
      expect(client.lane(`${task.id}/agent` as LaneId)?.alive).toBe(true)
    }, 60_000)

    it('starts again as an account it was stopped on, and tells the journal it stopped', async () => {
      await client.addAccount({ name: 'personal', harness: 'claude-code' })
      await client.useAccount('claude-code', 'personal')
      const task = await client.createTask({ project: 'app', slug: 'moved', intent: 'fix it' })
      await client.setAgentHarness({
        task: task.id,
        worktree: task.worktree,
        harness: 'claude-code',
      })
      await client.startAgent({ task: task.id, cwd: task.worktree, prompt: 'its first prompt' })
      await client.stopAgent(task.id)
      expect(await client.events({ types: ['run_exited'], task: task.id })).toHaveLength(1)
      // Refused as `run already started` while the account's adapter held on to it.
      await client.startAgent({ task: task.id, cwd: task.worktree, prompt: 'again' })
      expect(client.lane(`${task.id}/agent` as LaneId)?.alive).toBe(true)
    }, 60_000)
  })

  describe('in a harness that names its own conversation', () => {
    const THREAD = '019a0000-0000-7000-8000-000000000001'

    const threadOnOwnSignIn = async () => {
      await client.addAccount({ name: 'work', harness: 'codex' })
      const task = await client.createTask({ project: 'app', slug: 'threaded', intent: 'fix it' })
      await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'codex' })
      const day = join(own, '.codex', 'sessions', '2026', '11', '07')
      mkdirSync(day, { recursive: true })
      writeFileSync(join(day, `rollout-2026-11-07T00-00-00-${THREAD}.jsonl`), '{"said":"hi"}\n')
      await rememberThread(task.id, join(home, 'runs'), THREAD)
      await client.useAccount('codex', 'work')
      return task
    }

    it('goes back to the sign-in that keeps it', async () => {
      const task = await threadOnOwnSignIn()
      await client.reopenAgent({ task: task.id, cwd: task.worktree })
      expect((await lastRun(task.id))?.detail.account).toBeNull()
      expect(await lastLaunch(1)).toContain(`resume ${THREAD}`)
    }, 60_000)

    it('carries it to the account somebody moved the agent to', async () => {
      const task = await threadOnOwnSignIn()
      const moved = await client.setAgentAccount({
        task: task.id,
        worktree: task.worktree,
        account: 'work',
      })
      expect(moved.carried).toBe(true)
      await client.reopenAgent({ task: task.id, cwd: task.worktree })
      expect((await lastRun(task.id))?.detail.account).toBe('work')
      expect(await lastLaunch(1)).toContain(`resume ${THREAD}`)
      expect(
        existsSync(
          join(
            home,
            'accounts',
            'work',
            'sessions',
            '2026',
            '11',
            '07',
            `rollout-2026-11-07T00-00-00-${THREAD}.jsonl`,
          ),
        ),
      ).toBe(true)
    }, 60_000)
  })

  describe('in a harness with one set of sign-ins', () => {
    it('says so when its session has gone, asked of the adapter alone', async () => {
      const task = await client.createTask({ project: 'app', slug: 'solo', intent: 'fix it' })
      await client.startAgent({ task: task.id as TaskId, cwd: task.worktree, prompt: 'look' })
      await client.stopAgent(task.id)
      // However far it got before it stopped: its session is gone either way.
      rmSync(sessionsRoot, { recursive: true, force: true })
      await expect(client.reopenAgent({ task: task.id, cwd: task.worktree })).rejects.toThrow(
        /was told what to do, and pi keeps no record/,
      )
    }, 60_000)
  })

  describe('told to carry on after the machine slept', () => {
    it('is told through the account it runs on, not its harness’s own sign-in', async () => {
      await client.addAccount({ name: 'personal', harness: 'claude-code' })
      await client.useAccount('claude-code', 'personal')
      const task = await client.createTask({ project: 'app', slug: 'slept', intent: 'fix it' })
      await client.setAgentHarness({
        task: task.id,
        worktree: task.worktree,
        harness: 'claude-code',
      })
      await client.startAgent({ task: task.id, cwd: task.worktree, prompt: 'its first prompt' })
      expect((await lastRun(task.id))?.detail.account).toBe('personal')
      const run = client.runs().find((one) => one.task === task.id)?.run
      if (!run) throw new Error('no run for the agent')
      // Only the channel is stood in for, which needs a real Claude to connect
      // back. Its own sign-in's adapter is left real, and refuses a run it does
      // not hold, as it did every agent on an account after a sleep.
      const told = vi.spyOn(client.workers.adapterOf(run), 'prompt').mockResolvedValue()
      await client.continueRun(run, 60 * 60_000)
      expect(told).toHaveBeenCalledOnce()
      expect(await client.events({ types: ['agent_continued'], task: task.id })).toHaveLength(1)
    }, 60_000)
  })
})

describe('whether a task’s agent was ever told anything', () => {
  const event = (type: string, detail: Record<string, unknown>) => ({ type, detail }) as TadeEvent

  it('reads what it was told, in this harness and no other', () => {
    const told = event('run_started', { adapter: 'pi', told: true })
    expect(wasTold([told], 'pi')).toBe(true)
    expect(wasTold([told], 'claude-code')).toBe(false)
  })

  it('reads a turn as its run’s harness’s, for what was said after an empty start', () => {
    const empty = event('run_started', { adapter: 'pi' })
    const turn = event('turn_started', {})
    expect(wasTold([empty], 'pi')).toBe(false)
    expect(wasTold([empty, turn], 'pi')).toBe(true)
    expect(wasTold([empty, turn, event('run_started', { adapter: 'codex' })], 'codex')).toBe(false)
  })
})
