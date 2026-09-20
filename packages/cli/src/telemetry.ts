import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  type Config,
  defaultConfigPath,
  loadConfig,
  RUNTIME_EVENTS,
  runtimeFrom,
  startOfToday,
  type Unsubscribe,
} from '@tade/core'
import { openReporter, type Reporter, saw } from '@tade/telemetry'
import type { Workbench } from '@tade/workbench'
import { version } from './version.ts'

// Tade reporting its own trouble.
//
// One place decides whether anything is sent and what it is scrubbed against,
// so no command has to think about it. Off unless a DSN is set, and then it is
// the user's own Sentry project — which is what lets the Sentry extension
// watch Tade's own issues and hand one to an agent.

/** Where a DSN can be, when it is not in the config file. */
const DSN_ENV = 'TADE_TELEMETRY_DSN'

/** Where Tade itself is, so a frame in its own code is one you could fix. */
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** The reporter for this run: `none` unless somewhere to send was set. */
export function reporterFor(
  config: Config,
  opts: { sink?: (envelope: unknown) => void; now?: () => number } = {},
): Promise<Reporter> {
  const dsn = config.telemetry.dsn.trim() || (process.env[DSN_ENV] ?? '').trim()
  return openReporter(
    { ...config.telemetry, dsn },
    {
      release: `tade@${version()}`,
      // Paths are scrubbed against the person's own home, so nothing says who they are.
      home: homedir(),
      root: ROOT,
      ...opts,
    },
  )
}

/**
 * Everything the journal says, reported as whatever it is worth: Tade's own
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
        name: 'tade.agents',
        kind: 'gauge',
        value: client.runs().length,
      })
      void reportRuntime(reporter, client)
    }
    // A harness that watches its own limits has just been told where they
    // stand, because a turn is what uses them up. Read from what it already
    // holds, so this asks nobody anything.
    if (event.type === 'turn_done') reportLimits(reporter, client)
  })
}

/**
 * How long the agents have run, as `runtimeFrom` derives it.
 *
 * Derived and re-sent rather than counted when a run ends, because the event
 * that ends a run is the one most often missing: the journal behind
 * `runtime.ts` had 100 `run_started` and 35 `run_exited`, so a duration
 * emitted on exit would lose two runs in three. A gauge of the total instead,
 * recomputed from the same reading the window draws, which is right whether or
 * not anybody wrote the exit.
 */
async function reportRuntime(reporter: Reporter, client: Workbench): Promise<void> {
  const events = await client.events({ types: [...RUNTIME_EVENTS] }).catch(() => [])
  if (events.length === 0) return
  const now = Date.now()
  const ran = runtimeFrom(events, { since: startOfToday(now), now })
  for (const [project, runtime] of Object.entries(ran.byProject)) {
    reporter.measure({
      at: now,
      name: 'tade.agent.runtime',
      kind: 'gauge',
      value: runtime.ms,
      unit: 'millisecond',
      about: { project },
    })
  }
}

/** How much of each plan is used, for the harnesses that can say. */
function reportLimits(reporter: Reporter, client: Workbench): void {
  const now = Date.now()
  for (const { harness, limits } of client.planLimits()) {
    for (const [window, used] of [
      ['5h', limits.fiveHour],
      ['7d', limits.sevenDay],
    ] as const) {
      if (!used) continue
      reporter.measure({
        at: now,
        name: 'tade.plan.used',
        kind: 'gauge',
        value: used.used,
        unit: 'percent',
        about: { harness, window },
      })
    }
  }
}

/**
 * A command that ended in a crash, reported on its way out. Read from the
 * config on the error path only: a command that worked never opens this.
 */
export async function reportCrash(
  error: unknown,
  argv: readonly string[],
  opts: { sink?: (envelope: unknown) => void } = {},
): Promise<void> {
  try {
    const loaded = await loadConfig(defaultConfigPath())
    if (!loaded.ok) return
    const reporter = await reporterFor(loaded.config, opts)
    if (!reporter.on) return
    const command = argv.slice(2).find((arg) => !arg.startsWith('-')) ?? 'tade'
    reporter.trouble({ error, where: `tade ${command}`, level: 'fatal' })
    await reporter.close()
  } catch {
    // Reporting a crash must never be the reason for another one.
  }
}
