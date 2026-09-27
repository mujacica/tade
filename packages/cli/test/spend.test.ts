import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PRICES_TAKEN } from '@tade/core'
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
  // One model reached three ways, in two harnesses, on three kinds of money:
  // a plan, an API key, and a router priced against a catalog.
  await window.log.append({
    type: 'usage',
    task: 'app/refunds',
    run: 'app/refunds/agent',
    detail: {
      model: 'claude-opus-5',
      tokens: 1_000,
      usd: 954.51,
      priced: 'estimate',
      harness: 'claude-code',
      // What the route wished for, beside a harness that cannot reach it.
      provider: 'openrouter',
    },
  })
  await window.log.append({
    type: 'usage',
    task: 'app/billing',
    run: 'app/billing/agent',
    detail: {
      model: 'claude-opus-5',
      tokens: 500,
      usd: 0.4,
      priced: 'estimate',
      harness: 'claude-code',
      account: 'billed',
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
  // Codex counts tokens and prices none of them, and this one is on an API
  // key: billed per token, with nobody who ran it able to say what it cost.
  await window.log.append({
    type: 'usage',
    task: 'app/logs',
    run: 'app/logs/agent',
    detail: {
      model: 'gpt-5.3-codex',
      input: 1_000_000,
      tokens: 1_000_000,
      usd: 0,
      priced: 'none',
      harness: 'codex',
      account: 'work',
    },
  })
  await window.log.append({
    type: 'usage',
    task: 'app/queue',
    run: 'app/queue/agent',
    detail: {
      model: 'openrouter/anthropic/claude-opus-5',
      tokens: 3_000,
      usd: 0.5,
      priced: 'exact',
      harness: 'pi',
      provider: 'openrouter',
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
  // Claude Code reaches Anthropic and no router, whatever the route wished
  // for, so both its turns are Anthropic's; pi is the harness that really
  // routes, and the one recorded against it stands.
  expect(result.stdout).toMatch(/anthropic\s+\$1\.50\s+4k tokens/)
  expect(result.stdout).toMatch(/openrouter\s+\$0\.50\s+3k tokens/)
  // A plan charges a flat fee, so its $954 is tokens and hours and no money;
  // the API key's estimate is a bill somebody gets, and is counted and marked.
  expect(result.stdout).not.toContain('954')
  expect(result.stdout).toContain('$1.60 priced by the harness, $0.40 estimated')
  // And the third kind: a rate off a published page, named apart from both and
  // carrying the day it was taken, because a price is a fact with a date on it.
  expect(result.stdout).toContain(`$1.75 at list prices of ${PRICES_TAKEN}`)
  // Filed under the provider the harness declares, not under a guess at one.
  expect(result.stdout).toMatch(/openai\s+\$1\.75\s+1\.0M tokens/)
  // And that the figure does not cover everything under it. Claude Code's own
  // sign-in has no price per turn at all, so its thousand tokens are effort
  // this total says nothing about — and a figure missing an agent's cost is
  // worse than one marked incomplete.
  expect(result.stdout).toContain('1k of these tokens nothing here could price')
}, 30_000)
