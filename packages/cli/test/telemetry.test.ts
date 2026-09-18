import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, loadConfig } from '@tade/core'
import { Workbench } from '@tade/workbench'
import { afterEach, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { reportCrash, reporterFor, reportJournal } from '../src/telemetry.ts'

// Tade reporting its own trouble. Nothing reaches a network: every send is
// answered here, and what would have gone on the wire is read back as text.

const DSN = 'https://abc123@o1.ingest.sentry.io/4507'

let window: Workbench | null = null

afterEach(async () => {
  await window?.close().catch(() => {})
  window = null
})

/** Somewhere for the envelopes to go instead of a network, as items. */
function sentry() {
  const sent: unknown[] = []
  const sink = (envelope: unknown) => sent.push(envelope)
  const items = () =>
    sent.flatMap((envelope) => {
      const [, list] = envelope as [unknown, [Record<string, unknown>, Record<string, unknown>][]]
      return list.map(([header, payload]) => ({ type: String(header.type), payload }))
    })
  return { sink, sent, items }
}

const config = (telemetry: Record<string, unknown>) =>
  ConfigSchema.parse({ projects: {}, telemetry })

it('sends nothing at all until somewhere to send it is set', async () => {
  expect((await reporterFor(config({}))).on).toBe(false)
  expect((await reporterFor(config({ dsn: DSN, driver: 'none' }))).on).toBe(false)
  const on = await reporterFor(config({ dsn: DSN }), { sink: () => {} })
  expect(on.on).toBe(true)
  await on.close()
})

it('takes the DSN from the environment, for people who keep it out of files', async () => {
  process.env.TADE_TELEMETRY_DSN = DSN
  try {
    const report = await reporterFor(config({}), { sink: () => {} })
    expect(report.on).toBe(true)
    await report.close()
  } finally {
    delete process.env.TADE_TELEMETRY_DSN
  }
})

it("reports what the journal says about Tade itself, and nothing about anyone's work", async () => {
  const repo = mkrepo()
  const home = tmp('tade-telemetry-')
  writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
  window = await Workbench.open({ home })
  const { sink, sent, items } = sentry()
  const loaded = await loadConfig(join(home, 'config.yaml'))
  if (!loaded.ok) throw new Error('the fixture config would not load')
  const report = await reporterFor(
    { ...loaded.config, telemetry: { ...loaded.config.telemetry, dsn: DSN } },
    { sink },
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
  await report.flush(2_000)
  stop()

  const text = JSON.stringify(sent)
  // Tade's own warning is an issue somebody could fix.
  const issue = items().find((item) => item.type === 'event')?.payload as {
    message?: string
    level?: string
  }
  expect(issue.message).toBe('tade: tmux is not installed')
  expect(issue.level).toBe('warning')
  // What happened around it is there to read, by name.
  expect(text).toContain('task_created app/refunds')
  // What the person said about their work never leaves the machine.
  expect(text).not.toContain('double charge')
  // Nor does the machine's own home, wherever it appears.
  expect(text).not.toContain(homedir())
  expect(text).toContain('tade.tokens')
  await report.close()
}, 30_000)

it('reports a command that ended in a crash, on its way out', async () => {
  const home = tmp('tade-telemetry-crash-')
  writeFileSync(`${home}/config.yaml`, `telemetry:\n  dsn: ${DSN}\n`)
  const wasHome = process.env.TADE_HOME
  const sent: unknown[] = []
  process.env.TADE_HOME = home
  process.env.TADE_TELEMETRY_SINK = 'test'
  try {
    await reportCrash(new Error('it fell over'), ['node', 'tade', 'status', '--json'], {
      sink: (envelope) => sent.push(envelope),
    })
  } finally {
    delete process.env.TADE_TELEMETRY_SINK
    if (wasHome === undefined) delete process.env.TADE_HOME
    else process.env.TADE_HOME = wasHome
  }
  const event = sent
    .flatMap((envelope) => {
      const [, list] = envelope as [unknown, [Record<string, unknown>, Record<string, unknown>][]]
      return list.map(([header, payload]) => ({ type: String(header.type), payload }))
    })
    .find((item) => item.type === 'event')?.payload as { tags?: { where?: string }; level?: string }
  expect(event.tags?.where).toBe('tade status')
  expect(event.level).toBe('fatal')
}, 30_000)
