import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PlannedAgent } from '@tade/core'
import { lockHome, Workbench } from '@tade/workbench'
import { readJournal } from '@tade/workbench/events'
import { beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// `tade queue`, spawned for real: it opens the workbench, writes the choice
// through `changeQueued` — the operation the window and the orchestrator's
// tool call — and closes it. The work is planned in-process first and the
// workbench closed again, because the child has to be able to take the home.

interface Result {
  code: number | null
  stdout: string
  stderr: string
}

const agent = (name: string, over: Partial<PlannedAgent> = {}): PlannedAgent => ({
  name,
  said: `do ${name}`,
  prompt: `please do ${name}`,
  after: [],
  touches: [],
  ...over,
})

describe('tade queue', () => {
  let home: string
  let env: Record<string, string>

  const tade = (...args: string[]): Promise<Result> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
      })
      child.stderr.on('data', (d: string) => {
        stderr += d
      })
      child.on('exit', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
    })

  const changes = async () =>
    (await readJournal(home, { types: ['queue_changed'] })).map((event) => ({
      task: event.task,
      ...event.detail,
    }))

  beforeEach(async () => {
    const repo = mkrepo()
    home = tmp('tade-cli-queue-')
    writeFileSync(
      join(home, 'config.yaml'),
      `agents:\n  workspace: worktree\nprojects:\n  app:\n    root: ${repo.root}\n`,
    )
    env = { TADE_HOME: home, TADE_NO_GH: '1', HOME: home }
    const client = await Workbench.open({ home, sessionsRoot: tmp('tade-sessions-') })
    try {
      await client.planTasks({
        project: 'app',
        said: 'charge once, then give refunds back',
        agents: [
          agent('charge-once'),
          agent('refund-back', { after: [{ agent: 'charge-once', why: 'same file' }] }),
        ],
      })
    } finally {
      await client.close()
    }
  }, 60_000)

  it('lets held work wait again, written down as yours', async () => {
    const r = await tade('queue', 'wait', 'app/refund-back')
    expect(r.stderr).toBe('')
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(
      'app/refund-back waits again, past what held it. A window acts on it the next time it looks at the tasks.',
    )
    expect(await changes()).toEqual([{ task: 'app/refund-back', change: 'wait', by: 'you' }])
  })

  it('starts, pauses, resumes and orders through the same operation the window uses', async () => {
    expect((await tade('queue', 'start', 'app/refund-back')).code).toBe(0)
    expect((await tade('queue', 'pause', 'app/charge-once')).code).toBe(0)
    expect((await tade('queue', 'resume', '--project', 'app')).code).toBe(0)
    const ordered = await tade('queue', 'order', 'app/refund-back', 'app/charge-once')
    expect(ordered.stdout).toContain('app/refund-back and app/charge-once, in that order')
    expect(await changes()).toEqual([
      { task: 'app/refund-back', change: 'start', by: 'you' },
      { task: 'app/charge-once', change: 'pause', by: 'you' },
      // A whole project's queue, which is what pausing everything is read from.
      { task: null, change: 'resume', by: 'you', all: true, project: 'app' },
      {
        task: null,
        change: 'order',
        by: 'you',
        order: ['app/refund-back', 'app/charge-once'],
      },
    ])
  })

  it('refuses a name that is not queued work, and writes nothing', async () => {
    const r = await tade('queue', 'wait', 'app/perf-draw-gate-subjects')
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('there is no queued work called app/perf-draw-gate-subjects')
    expect(await changes()).toEqual([])
  })

  it('wants one piece of work or a whole project, and says so', async () => {
    const neither = await tade('queue', 'pause')
    expect(neither.code).toBe(2)
    expect(neither.stderr).toContain('name one')
    const both = await tade('queue', 'resume', 'app/charge-once', '--project', 'app')
    expect(both.code).toBe(2)
    expect(await changes()).toEqual([])
  })

  it('says where to change it while a window holds the home', async () => {
    const held = await lockHome(home)
    try {
      const r = await tade('queue', 'wait', 'app/refund-back')
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('in its queue, or by asking the orchestrator (tade_queue_change)')
    } finally {
      await held.release()
    }
    expect(await changes()).toEqual([])
  })
})
