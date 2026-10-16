import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Workbench } from '@tade/workbench'
import { afterEach, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

// `tade stats`: the scorecards, read out of the journal with a window open.

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

let window: Workbench | null = null

afterEach(async () => {
  await window?.close().catch(() => {})
  window = null
})

function tade(
  home: string,
  args: string[],
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, TADE_HOME: home, HOME: home },
    })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      err += chunk
    })
    child.on('exit', (code) => resolve({ code, out, err }))
  })
}

async function journal(home: string): Promise<void> {
  window = await Workbench.open({ home })
  const log = window.log
  for (const [task, harness, model] of [
    ['app/refunds', 'claude-code', 'claude-opus-5'],
    ['app/billing', 'claude-code', 'claude-opus-5'],
    ['app/search', 'pi', 'kimi-k2'],
  ] as const) {
    await log.append({ type: 'task_created', task, detail: { intent_spoken: 'do it' } })
    await log.append({
      type: 'run_started',
      task,
      run: `${task}/agent`,
      detail: { harness, model },
    })
  }
  await log.append({
    type: 'usage',
    task: 'app/refunds',
    run: 'app/refunds/agent',
    detail: { model: 'claude-opus-5', tokens: 2_000, usd: 3, priced: 'exact', harness: 'pi' },
  })
  await log.append({
    type: 'task_done',
    task: 'app/refunds',
    detail: { by: 'rule', rule: 'merged' },
  })
  await log.append({ type: 'task_done', task: 'app/billing', detail: { by: 'agent' } })
  await log.append({
    type: 'tool_call',
    task: 'app/billing',
    detail: { tool: 'bash', summary: 'git push', checks: 'types failed at this commit' },
  })
}

it('scores each model by what landed and what landing it cost, while a window is open', async () => {
  const home = tmp('tade-cli-stats-')
  await journal(home)
  const result = await tade(home, ['stats', '--by', 'model', '--json'])
  expect(result.code).toBe(0)
  const report = JSON.parse(result.out) as {
    by: string
    mergedFrom: string
    rows: {
      key: string
      tasks: number
      done: number
      merged: number
      landed: number
      pushed: number
      firstPushGreen: number
      findings: unknown
      perLanded: { cost: { said: string; kind: string }[]; tokens: number | null }
    }[]
  }
  expect(report.by).toBe('model')
  expect(report.mergedFrom).toBe('journal')
  expect(report.rows.map((row) => [row.key, row.tasks, row.done, row.merged, row.landed])).toEqual([
    ['claude-opus-5', 2, 2, 1, 1],
    ['kimi-k2', 1, 0, 0, 0],
  ])
  const [opus, kimi] = report.rows
  expect(opus).toMatchObject({ pushed: 1, firstPushGreen: 0 })
  expect(opus?.perLanded).toEqual({ cost: [{ said: '$3.00', kind: 'billed' }], tokens: 2_000 })
  // Nothing landed is nothing to divide by, said as that rather than as nought.
  expect(kimi?.perLanded).toEqual({ cost: [{ said: '—', kind: 'none' }], tokens: null })
  // No judge reads anything in a home with no key: not read, never none found.
  expect(opus?.findings).toBeNull()
}, 30_000)

it('says the counts before any rate, and that no judge was read', async () => {
  const home = tmp('tade-cli-stats-said-')
  await journal(home)
  const result = await tade(home, ['stats'])
  expect(result.code).toBe(0)
  expect(result.out).toContain('by harness · all of the journal · merges from the journal')
  expect(result.out).toMatch(/claude-code\s+2\s+2 of 2\s+1 of 2\s+0 of 1/)
  expect(result.out).toContain('judge: no judge reads anything here')
}, 30_000)

it('refuses a grouping it does not have, and says which it has', async () => {
  const home = tmp('tade-cli-stats-by-')
  const result = await tade(home, ['stats', '--by', 'colour'])
  expect(result.code).toBe(2)
  expect(result.err).toContain('harness, model, persona, template')
}, 30_000)
