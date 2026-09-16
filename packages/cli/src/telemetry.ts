import { homedir } from 'node:os'
import { type Config, defaultConfigPath, loadConfig, type Unsubscribe } from '@wilco/core'
import { openReporter, type Reporter, saw } from '@wilco/telemetry'
import type { Workbench } from '@wilco/workbench'
import { version } from './version.ts'

// Wilco reporting its own trouble.
//
// One place decides whether anything is sent and what it is scrubbed against,
// so no command has to think about it. Off unless a DSN is set, and then it is
// the user's own Sentry project — which is what lets the Sentry extension
// watch Wilco's own issues and hand one to an agent.

/** Where a DSN can be, when it is not in the config file. */
const DSN_ENV = 'WILCO_TELEMETRY_DSN'

/** The reporter for this run: `none` unless somewhere to send was set. */
export function reporterFor(
  config: Config,
  opts: { fetch?: typeof fetch; now?: () => number; everyMs?: number } = {},
): Reporter {
  const dsn = config.telemetry.dsn.trim() || (process.env[DSN_ENV] ?? '').trim()
  return openReporter(
    { ...config.telemetry, dsn },
    {
      release: `wilco@${version()}`,
      // Paths are scrubbed against the person's own home, so nothing says who they are.
      home: homedir(),
      ...opts,
    },
  )
}

/**
 * Everything the journal says, reported as whatever it is worth: Wilco's own
 * warnings as issues, what happened around them as logs, what was spent as
 * numbers. How many agents are running is counted where it changes, so nothing
 * new runs on a timer for it.
 */
export function reportJournal(reporter: Reporter, client: Workbench): Unsubscribe {
  if (!reporter.on) return () => {}
  const home = homedir()
  return client.subscribe((event) => {
    saw(reporter, event, home)
    if (event.type === 'run_started' || event.type === 'run_exited') {
      reporter.measure({
        at: Date.now(),
        name: 'wilco.agents',
        kind: 'gauge',
        value: client.runs().length,
      })
    }
  })
}

/**
 * A command that ended in a crash, reported on its way out. Read from the
 * config on the error path only: a command that worked never opens this.
 */
export async function reportCrash(error: unknown, argv: readonly string[]): Promise<void> {
  try {
    const loaded = await loadConfig(defaultConfigPath())
    if (!loaded.ok) return
    const reporter = reporterFor(loaded.config)
    if (!reporter.on) return
    const command = argv.slice(2).find((arg) => !arg.startsWith('-')) ?? 'wilco'
    reporter.trouble({ error, where: `wilco ${command}`, level: 'fatal' })
    await reporter.close()
  } catch {
    // Reporting a crash must never be the reason for another one.
  }
}
