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

  it('an invalid config exits 2', () => {
    const env = setup()
    writeFileSync(join(env.TADE_HOME, 'config.yaml'), 'projects: nope\n')
    expect(tade(['status'], env).code).toBe(2)
  })
})
