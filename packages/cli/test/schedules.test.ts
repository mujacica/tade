import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Workbench } from '@wilco/workbench'
import { afterEach, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

let window: Workbench | null = null

afterEach(async () => {
  await window?.close().catch(() => {})
  window = null
})

it('says what runs on a clock while a window has the home open', async () => {
  const home = tmp('wilco-cli-schedules-')
  writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${home}\n`)
  window = await Workbench.open({ home })
  await window.setSchedule(
    {
      id: 'deps-weekly',
      name: 'deps weekly',
      project: 'app',
      said: 'every monday update the dependencies',
      when: { every: 'week', on: ['mon'], times: ['09:00'], tz: 'UTC' },
      does: { kind: 'agent', prompt: 'Update the dependencies.' },
      missed: 'once',
      by: 'orchestrator',
      created: '2026-09-15T08:00:00.000Z',
    },
    'orchestrator',
  )
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [bin, 'schedules'], {
      env: { ...process.env, WILCO_HOME: home, HOME: home },
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('exit', (code) => resolve({ code, stdout }))
  })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('deps-weekly  app  every Monday at 09:00, starts an agent')
  expect(result.stdout).toMatch(/next Mon \d+ \w+ 09:00 · made by orchestrator/)
}, 30_000)
