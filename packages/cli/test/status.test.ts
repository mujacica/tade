import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

function tade(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, TADE_NO_GH: '1', ...env },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function setup() {
  const r = mkrepo()
  r.addTask('fresh', { project: 'app', intent: 'add a --json flag to tade lanes' })
  const done = r.addTask('done', { project: 'app' })
  r.commit('feat', undefined, done)
  const tadeHome = r.home
  writeFileSync(join(tadeHome, 'config.yaml'), `projects:\n  app:\n    root: ${r.root}\n`)
  return { TADE_HOME: tadeHome, HOME: tmp('tade-userhome-') }
}

describe('tade status', () => {
  it('--json reports tasks with derived states and verbatim intent', () => {
    const r = tade(['status', '--json'], setup())
    expect(r.code).toBe(0)
    const ws = JSON.parse(r.stdout)
    const tasks = ws.projects[0].tasks
    expect(tasks.map((t: { id: string; state: string }) => [t.id, t.state])).toEqual([
      ['app/done', 'review'],
      ['app/fresh', 'queued'],
    ])
    expect(tasks[1].intent_spoken).toBe('add a --json flag to tade lanes')
  })

  it('human output is terse', () => {
    const r = tade(['status'], setup())
    expect(r.code).toBe(0)
    const lines = r.stdout.trim().split('\n')
    expect(lines[0]).toBe('app')
    expect(lines[1]).toMatch(/^ {2}done\s+review\s+1 commit ahead/)
    expect(lines.length).toBeLessThan(10)
  })

  it('calls an agent that said it is done and sat idle finished, as the window draws it', () => {
    // A live agent lane and a journal: `tade status` from another terminal or
    // over ssh read every live agent as `working, agent running`, a finished
    // one included, because a lane alone cannot say whether a turn ended.
    const env = setup()
    const run = 'app/fresh/agent'
    writeFileSync(
      join(env.TADE_HOME, 'lanes.json'),
      JSON.stringify({
        lanes: [
          {
            id: run,
            task: 'app/fresh',
            kind: 'agent',
            spec: { id: run, cwd: '/tmp', command: '/usr/bin/pi', args: [] },
            // This process: running, so the lane is alive.
            pid: process.pid,
            startedAt: Date.now(),
            title: 'an agent',
            alive: true,
            exitCode: null,
            lastOutputAt: Date.now(),
          },
        ],
      }),
    )
    let seq = 0
    const line = (type: string, detail: Record<string, unknown> = {}) =>
      JSON.stringify({
        seq: ++seq,
        ts: new Date(Date.now() - 60_000 + seq * 1_000).toISOString(),
        type,
        urgency: 'notable',
        task: 'app/fresh',
        lane: null,
        run,
        detail,
      })
    const journal = [
      line('run_started'),
      line('turn_started'),
      line('task_done', { by: 'agent', summary: 'the flag is in' }),
      line('turn_done', { status: 'ok' }),
    ]
    writeFileSync(join(env.TADE_HOME, 'events.jsonl'), `${journal.join('\n')}\n`)

    const said = tade(['status'], env).stdout.split('\n')
    expect(said.find((l) => l.includes('fresh'))).toMatch(
      /^ {2}fresh\s+done\s+finished · the flag is in$/,
    )
    const fresh = JSON.parse(tade(['status', '--json'], env).stdout).projects[0].tasks.find(
      (t: { id: string }) => t.id === 'app/fresh',
    )
    expect(fresh.finished).toMatchObject({ by: 'agent', summary: 'the flag is in' })

    // Put back to work after saying so, it is working, as the window says.
    journal.push(line('turn_started'))
    writeFileSync(join(env.TADE_HOME, 'events.jsonl'), `${journal.join('\n')}\n`)
    const again = tade(['status'], env).stdout.split('\n')
    expect(again.find((l) => l.includes('fresh'))).toMatch(/^ {2}fresh\s+working\s+agent running$/)
  })

  it('an invalid config exits 2', () => {
    const env = setup()
    writeFileSync(join(env.TADE_HOME, 'config.yaml'), 'projects: nope\n')
    expect(tade(['status'], env).code).toBe(2)
  })
})
