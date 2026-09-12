import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

function wilco(args: string[], env: Record<string, string>) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WILCO_NO_GH: '1', ...env },
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function setup() {
  const r = mkrepo()
  r.addTask('fresh', { project: 'app', intent: 'add a --json flag to wilco lanes' })
  const done = r.addTask('done', { project: 'app' })
  r.commit('feat', undefined, done)
  const wilcoHome = tmp('wilco-home-')
  writeFileSync(join(wilcoHome, 'config.yaml'), `projects:\n  app:\n    root: ${r.root}\n`)
  return { WILCO_HOME: wilcoHome, HOME: tmp('wilco-userhome-') }
}

describe('wilco status', () => {
  it('--json reports tasks with derived states and verbatim intent', () => {
    const r = wilco(['status', '--json'], setup())
    expect(r.code).toBe(0)
    const ws = JSON.parse(r.stdout)
    const tasks = ws.projects[0].tasks
    expect(tasks.map((t: { id: string; state: string }) => [t.id, t.state])).toEqual([
      ['app/done', 'review'],
      ['app/fresh', 'queued'],
    ])
    expect(tasks[1].intent_spoken).toBe('add a --json flag to wilco lanes')
  })

  it('human output is terse', () => {
    const r = wilco(['status'], setup())
    expect(r.code).toBe(0)
    const lines = r.stdout.trim().split('\n')
    expect(lines[0]).toBe('app')
    expect(lines[1]).toMatch(/^ {2}done\s+review\s+1 commit ahead/)
    expect(lines.length).toBeLessThan(10)
  })

  it('an invalid config exits 2', () => {
    const env = setup()
    writeFileSync(join(env.WILCO_HOME, 'config.yaml'), 'projects: nope\n')
    expect(wilco(['status'], env).code).toBe(2)
  })
})
