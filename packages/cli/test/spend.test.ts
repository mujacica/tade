import { spawn } from 'node:child_process'
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

it('says what today cost while a window has the home open', async () => {
  const home = tmp('wilco-cli-spend-')
  // A window is open: it holds the home, and asking a question must not need it.
  window = await Workbench.open({ home })
  await window.log.append({
    type: 'usage',
    task: 'app/refunds',
    detail: { model: 'claude-opus-5', tokens: 1_200, usd: 0.42 },
  })
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [bin, 'spend', '--json'], {
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
  const report = JSON.parse(result.stdout) as { total: { usd: number; tokens: number } }
  expect(report.total).toMatchObject({ usd: 0.42, tokens: 1_200 })
}, 30_000)
