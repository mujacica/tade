import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, loadConfig } from '@wilco/core'
import { Workbench } from '@wilco/workbench'
import { afterEach, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { reportCrash, reporterFor, reportJournal } from '../src/telemetry.ts'

// Wilco reporting its own trouble. Nothing reaches a network: every send is
// answered here, and what would have gone on the wire is read back as text.

const DSN = 'https://abc123@o1.ingest.sentry.io/4507'

let window: Workbench | null = null

afterEach(async () => {
  await window?.close().catch(() => {})
  window = null
})

/** A Sentry that keeps the envelopes it was posted. */
function sentry() {
  const sent: Record<string, unknown>[][] = []
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(
      String(init?.body ?? '')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    )
    return new Response('', { status: 200 })
  }) as typeof fetch
  return { fetcher, sent }
}

const config = (telemetry: Record<string, unknown>) =>
  ConfigSchema.parse({ projects: {}, telemetry })

it('sends nothing at all until somewhere to send it is set', () => {
  expect(reporterFor(config({})).on).toBe(false)
  expect(reporterFor(config({ dsn: DSN, driver: 'none' })).on).toBe(false)
  expect(reporterFor(config({ dsn: DSN })).on).toBe(true)
})

it('takes the DSN from the environment, for people who keep it out of files', () => {
  process.env.WILCO_TELEMETRY_DSN = DSN
  try {
    expect(reporterFor(config({})).on).toBe(true)
  } finally {
    delete process.env.WILCO_TELEMETRY_DSN
  }
})

it("reports what the journal says about Wilco itself, and nothing about anyone's work", async () => {
  const repo = mkrepo()
  const home = tmp('wilco-telemetry-')
  writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
  window = await Workbench.open({ home })
  const { fetcher, sent } = sentry()
  const loaded = await loadConfig(join(home, 'config.yaml'))
  if (!loaded.ok) throw new Error('the fixture config would not load')
  const report = reporterFor(
    { ...loaded.config, telemetry: { ...loaded.config.telemetry, dsn: DSN } },
    { fetch: fetcher, everyMs: 10_000 },
  )
  const stop = reportJournal(report, window)

  await window.log.append({ type: 'warning', detail: { message: 'tmux is not installed' } })
  await window.log.append({
    type: 'task_created',
    task: 'app/refunds',
    detail: { intent_spoken: 'stop the double charge on retries', by: 'you' },
  })
  await window.log.append({
    type: 'usage',
    task: 'app/refunds',
    detail: { tokens: 900, usd: 0.12 },
  })
  await report.flush()
  stop()

  const text = JSON.stringify(sent)
  // Wilco's own warning is an issue somebody could fix.
  const issue = sent[0]?.[2] as { message?: { formatted: string }; level?: string }
  expect(issue.message?.formatted).toBe('wilco: tmux is not installed')
  expect(issue.level).toBe('warning')
  // What happened around it is there to read, by name.
  expect(text).toContain('task_created app/refunds')
  // What the person said about their work never leaves the machine.
  expect(text).not.toContain('double charge')
  // Nor does the machine's own home, wherever it appears.
  expect(text).not.toContain(homedir())
  expect(text).toContain('wilco.tokens')
  await report.close()
}, 30_000)

it('reports a command that ended in a crash, on its way out', async () => {
  const home = tmp('wilco-telemetry-crash-')
  writeFileSync(`${home}/config.yaml`, `telemetry:\n  dsn: ${DSN}\n`)
  const was = { HOME: process.env.WILCO_HOME, fetch: globalThis.fetch }
  const { fetcher, sent } = sentry()
  process.env.WILCO_HOME = home
  globalThis.fetch = fetcher
  try {
    await reportCrash(new Error('it fell over'), ['node', 'wilco', 'status', '--json'])
  } finally {
    globalThis.fetch = was.fetch
    if (was.HOME === undefined) delete process.env.WILCO_HOME
    else process.env.WILCO_HOME = was.HOME
  }
  const event = sent[0]?.[2] as { tags?: { where?: string }; level?: string }
  expect(event.tags?.where).toBe('wilco status')
  expect(event.level).toBe('fatal')
}, 30_000)
