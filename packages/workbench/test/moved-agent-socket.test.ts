import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { type RunId, WORKER_ENV } from '@tade/harnesses-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Workbench } from '../src/workbench.ts'

// An agent moved to another account keeps its tools.
//
// On 2026-11-25 thirteen Claude Code agents were moved to another account and
// four came back unable to reach Tade: every tade_done and checks_run answered
// "Tade isn't open" for four hours. Moving one stops its run and starts the
// same run id again, and the lane closed for it says it ended only after
// `close()` has returned — so that late exit reached the new run and ended it,
// closing the socket the new agent's lane was dialling.
//
// Real lanes running the real Claude Code adapter's launch line, with a
// stand-in on the PATH that, like a process slow to die, takes a moment to go
// once hung up on: so its exit is said after the new run has started, every
// time, rather than on a machine busy enough to lose the race.
//
// Like Claude Code, it writes its conversation where it was told to keep it,
// `<CLAUDE_CONFIG_DIR>/projects/<dir>/<session>.jsonl`, the session being the
// one it was started or resumed with. A stand-in that keeps no record is
// kinder than reality the other way round: moving the agent then has nothing
// to carry, and Tade rightly refuses to start a told agent on a new
// conversation.

const STAND_IN = (started: string) =>
  [
    '#!/bin/sh',
    `trap 'sleep 1; exit 0' HUP`,
    'session=""; last=""',
    'for one in "$@"; do',
    '  case "$last" in --session-id|--resume) session="$one" ;; esac',
    '  last="$one"',
    'done',
    'if [ -n "$session" ] && [ -n "$CLAUDE_CONFIG_DIR" ]; then',
    '  mkdir -p "$CLAUDE_CONFIG_DIR/projects/stand-in"',
    `  echo '{"type":"user","message":{"role":"user","content":"fix it"}}' >> "$CLAUDE_CONFIG_DIR/projects/stand-in/$session.jsonl"`,
    'fi',
    `echo "$$" >> '${started}'`,
    'while :; do sleep 1; done',
  ].join('\n')

/** Send one request over a run's socket the way Claude Code's side does, and read the answer. */
function ask(path: string, request: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const end = buffer.indexOf('\n')
      if (end < 0) return
      socket.destroy()
      resolve(JSON.parse(buffer.slice(0, end)) as Record<string, unknown>)
    })
    socket.on('error', reject)
  })
}

describe('an agent moved to another account', () => {
  let home: string
  let client: Workbench
  let started: string
  let was: string | undefined

  const until = async (check: () => boolean | Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + 20_000
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  const pids = () =>
    existsSync(started) ? readFileSync(started, 'utf8').trim().split('\n').filter(Boolean) : []

  /** The socket the agent's lane was told to dial: what its tool server reads. */
  const socketOf = (task: string): string => {
    const lane = client.lanes(task).find((one) => one.kind === 'agent' && one.alive)
    const path = lane?.spec.env?.[WORKER_ENV.socket]
    if (!path) throw new Error(`no socket named in ${task}'s lane`)
    return path
  }

  /** A running Claude Code agent. */
  const running = async () => {
    await client.addAccount({ name: 'work', harness: 'claude-code' })
    const task = await client.createTask({ project: 'app', slug: 'moved', intent: 'fix it' })
    await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'claude-code' })
    await client.startAgent({ task: task.id, cwd: task.worktree, prompt: 'fix it' })
    await until(() => pids().length >= 1, 'the agent to start')
    return task
  }

  beforeEach(async () => {
    const repo = mkrepo()
    home = tmp('tade-moved-')
    const bin = tmp('tade-moved-bin-')
    started = join(bin, 'started')
    writeFileSync(join(bin, 'claude'), STAND_IN(started))
    chmodSync(join(bin, 'claude'), 0o755)
    was = process.env.PATH
    process.env.PATH = `${bin}:${was}`
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home, version: '9.9.9', harnessHome: tmp('tade-moved-own-') })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
    process.env.PATH = was
  })

  it('answers a tool call through its socket once the old lane has said it ended', async () => {
    const task = await running()
    const run = `${task.id}/agent` as RunId
    const gone = vi.spyOn(client.workers, 'gone')

    const moved = await client.setAgentAccount({
      task: task.id,
      worktree: task.worktree,
      account: 'work',
    })
    expect(moved.restarted).toBe(true)
    await until(() => pids().length >= 2, 'the agent to start again')
    // The lane that was closed for the move has now said it ended, after the
    // new run started: what used to end the new run.
    await until(() => gone.mock.calls.length >= 1, 'the old lane to say it ended')
    expect(client.workers.startOf(run)).not.toBeNull()

    const answer = await ask(socketOf(task.id), {
      kind: 'call',
      callId: 'after-the-move',
      tool: 'tade_done',
      input: { summary: 'moved and still heard' },
    })
    // Heard, whatever the tool said: a socket nobody listens on is ENOENT.
    expect(answer).toHaveProperty('ok')
    const calls = await client.events({ types: ['tool_call'], task: task.id })
    expect(calls.map((one) => one.detail.tool)).toContain('tade_done')
    expect(await client.events({ types: ['agent_unheard'], task: task.id })).toEqual([])
  })

  it('listens again for an agent left working with nobody listening, and says so', async () => {
    const task = await running()
    const run = `${task.id}/agent` as RunId
    const socket = socketOf(task.id)
    // What the late exit did: the run let go of, the lane working on.
    await client.workers.stop(run)
    expect(client.workers.has(run)).toBe(false)
    await expect(ask(socket, { kind: 'status', status: {} })).rejects.toThrow()

    // Once is a moment between a stop and a start; twice is an agent cut off.
    await client.mendChannels()
    expect(await client.events({ types: ['agent_unheard'], task: task.id })).toEqual([])
    await client.mendChannels()

    const [said] = await client.events({ types: ['agent_unheard'], task: task.id })
    expect(said?.detail).toMatchObject({ why: 'unsupervised', mended: 'listened again' })
    expect(client.workers.has(run)).toBe(true)
    expect(client.unheard().size).toBe(0)
    expect(await ask(socket, { kind: 'status', status: {} })).toBeTypeOf('object')
  })
})
