import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Workbench } from '@tade/workbench'
import { afterEach, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

let window: Workbench | null = null

afterEach(async () => {
  await window?.close().catch(() => {})
  window = null
})

it('says what today cost while a window has the home open', async () => {
  const home = tmp('tade-cli-spend-')
  // A window is open: it holds the home, and asking a question must not need it.
  window = await Workbench.open({ home })
  await window.log.append({
    type: 'usage',
    task: 'app/refunds',
    detail: { model: 'claude-opus-5', tokens: 1_200, usd: 0.42 },
  })
  // A run that has not ended is still running, and still counting.
  await window.log.append({
    type: 'run_started',
    task: 'app/refunds',
    run: 'app/refunds/agent',
    detail: { model: 'claude-opus-5' },
  })
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [bin, 'spend', '--json'], {
      env: { ...process.env, TADE_HOME: home, HOME: home },
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('exit', (code) => resolve({ code, stdout }))
  })
  expect(result.code).toBe(0)
  const report = JSON.parse(result.stdout) as {
    total: { usd: number; tokens: number }
    runtime: { total: { runs: number; running: boolean }; byTask: Record<string, { ms: number }> }
  }
  expect(report.total).toMatchObject({ usd: 0.42, tokens: 1_200 })
  expect(report.runtime.total).toMatchObject({ runs: 1, running: true })
  expect(report.runtime.byTask['app/refunds']?.ms).toBeGreaterThanOrEqual(0)
}, 30_000)

it('groups what it cost by harness, sign-in and provider, and says which money is which', async () => {
  const home = tmp('tade-cli-spend-by-')
  window = await Workbench.open({ home })
  // One model reached two ways, in two harnesses, on two kinds of money.
  await window.log.append({
    type: 'usage',
    task: 'app/refunds',
    run: 'app/refunds/agent',
    detail: {
      model: 'claude-opus-5',
      tokens: 1_000,
      usd: 0.4,
      priced: 'estimate',
      harness: 'claude-code',
    },
  })
  await window.log.append({
    type: 'usage',
    task: 'app/search',
    run: 'app/search/agent',
    detail: {
      model: 'anthropic/claude-opus-5',
      tokens: 2_000,
      usd: 1.1,
      priced: 'exact',
      harness: 'pi',
      account: 'work',
      provider: 'anthropic',
    },
  })
  const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
    const child = spawn(process.execPath, [bin, 'spend'], {
      env: { ...process.env, TADE_HOME: home, HOME: home },
    })
    let stdout = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.on('exit', (code) => resolve({ code, stdout }))
  })
  expect(result.code).toBe(0)
  expect(result.stdout).toContain('by harness')
  expect(result.stdout).toContain('claude-code')
  expect(result.stdout).toContain('by sign-in')
  expect(result.stdout).toContain('pi@work')
  expect(result.stdout).toContain('by provider')
  expect(result.stdout).toContain('anthropic')
  // The provider of the subscription turn was never written down, and nothing
  // reads one out of a model's name.
  expect(result.stdout).toContain('not recorded')
  // Priced and estimated money never added in silence.
  expect(result.stdout).toContain('$1.10 priced by the harness, $0.40 estimated')
}, 30_000)
