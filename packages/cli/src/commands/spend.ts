import {
  checkBudget,
  defaultConfigPath,
  duration,
  loadConfig,
  noSpend,
  RUNTIME_EVENTS,
  type Runtime,
  runtimeFrom,
  type Spend,
  STATS_EVENTS,
  spendFrom,
  startOfToday,
  statsFrom,
  tadeHome,
} from '@tade/core'
import { readJournal } from '@tade/workbench/events'
import type { Command } from 'commander'
import type { Io } from '../io.ts'

// What the agents have cost, and how long they were at it.
//
// Read out of the journal, priced by the harness against its own model
// catalog. Nothing here estimates: a provider that reports no money leaves the
// money column empty rather than showing a plausible zero. Runtime is the same
// answer read from the same place — when each run started and when it ended —
// so a subscription that reports no price still says where the hours went.
// A question, so it reads the journal itself: asking what today cost must work
// with a window open.

/** Read unwindowed: a run that began before the window is still in it. */
const RUNS = RUNTIME_EVENTS

export function registerSpend(program: Command, io: Io): void {
  program
    .command('spend')
    .description('What the agents have cost and how long they ran, today or over the last few days')
    .option('-d, --days <n>', 'how many days back', '1')
    .option('--json', 'machine-readable output')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { days: string; json?: boolean; config: string }) => {
      const days = Math.max(1, Number(opts.days) || 1)
      const now = Date.now()
      const since = startOfToday(now) - (days - 1) * 86_400_000
      const cfg = await loadConfig(opts.config)

      const events = await readJournal(tadeHome(), { types: ['usage'] })
      const report = spendFrom(events, { since })
      const ran = runtimeFrom(await readJournal(tadeHome(), { types: [...RUNS] }), { since, now })
      // What the money bought: commits, the size of them, and how the
      // project's own checks have been going.
      const made = statsFrom(await readJournal(tadeHome(), { types: [...STATS_EVENTS] }), { since })

      if (opts.json) {
        io.out(
          JSON.stringify(
            { since: new Date(since).toISOString(), ...report, runtime: ran, produced: made },
            null,
            2,
          ),
        )
        return
      }

      const projects = names(report.byProject, ran.byProject).sort(
        (a, b) =>
          (report.byProject[b]?.usd ?? 0) - (report.byProject[a]?.usd ?? 0) ||
          (ran.byProject[b]?.ms ?? 0) - (ran.byProject[a]?.ms ?? 0) ||
          a.localeCompare(b),
      )
      if (projects.length === 0) {
        io.out(days === 1 ? 'nothing spent or run today' : `nothing spent or run in ${days} days`)
        return
      }

      io.out(days === 1 ? 'today' : `last ${days} days`)
      const models = names(report.byModel, ran.byModel).sort(
        (a, b) =>
          (report.byModel[b]?.tokens ?? 0) - (report.byModel[a]?.tokens ?? 0) || a.localeCompare(b),
      )
      const agents = names(report.byTask, ran.byTask).sort(
        (a, b) =>
          (ran.byTask[b]?.ms ?? 0) - (ran.byTask[a]?.ms ?? 0) ||
          (report.byTask[b]?.usd ?? 0) - (report.byTask[a]?.usd ?? 0) ||
          a.localeCompare(b),
      )
      const width = Math.max(...[...projects, ...models, ...agents].map((n) => n.length), 7)
      for (const name of projects) {
        const spend = report.byProject[name]
        const budget = cfg.ok ? cfg.config.projects[name]?.budget : undefined
        const state = checkBudget(spend ?? noSpend(), budget)
        const note = state.verdict === 'ok' ? '' : `  ← ${state.verdict}: ${state.reason}`
        io.out(`  ${line(name, width, spend, ran.byProject[name])}${note}`)
      }
      io.out(`  ${line('total', width, report.total, ran.total)}`)

      if (models.length > 1) {
        io.out('')
        io.out('by model')
        for (const name of models) {
          io.out(`  ${line(name, width, report.byModel[name], ran.byModel[name])}`)
        }
      }
      // Per agent, longest first: the detail behind the totals above.
      if (agents.length > 0) {
        io.out('')
        io.out('by agent')
        for (const name of agents) {
          const running = ran.byTask[name]?.running ? '  ← running' : ''
          io.out(`  ${line(name, width, report.byTask[name], ran.byTask[name])}${running}`)
        }
      }
      // What it produced. Kept beside what it cost rather than in a command of
      // its own: the two numbers are only worth anything together.
      if (made.produced.commits > 0) {
        io.out('')
        const it = made.produced
        const nobody = it.commits - it.attributed
        io.out(
          `committed  ${it.commits} commit${it.commits === 1 ? '' : 's'}, +${it.added} −${it.removed} across ${it.files} file${it.files === 1 ? '' : 's'}${
            // Unattributed is always an allowed answer, and worth saying: it is
            // usually a person committing by hand, and sometimes an agent that
            // was never told to write its trailer.
            nobody > 0 ? `  (${nobody} with no task trailer)` : ''
          }`,
        )
      }
      if (made.checks.length > 0) {
        io.out('')
        io.out('checks')
        const width = Math.max(...made.checks.map((one) => one.check.length), 7)
        for (const check of made.checks) {
          const took = check.medianMs === null ? '' : `  ${howLong(check.medianMs)} typically`
          io.out(
            `  ${check.check.padEnd(width)}  ${String(check.runs).padStart(4)} run${
              check.runs === 1 ? ' ' : 's'
            }  ${String(check.failed).padStart(4)} failed${took}`,
          )
        }
      }
      if (!report.total.hasCost) {
        io.out('')
        // Zero dollars from a subscription is not the same as free.
        io.out('no prices reported — a subscription plan bills you, not per token')
      }
    })
}

/** Every bucket either side of the question knows about. */
function names(spend: Record<string, unknown>, ran: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(spend), ...Object.keys(ran)])]
}

function line(name: string, width: number, spend?: Spend, ran?: Runtime): string {
  const it = spend ?? noSpend()
  return `${name.padEnd(width)}  ${money(it)}  ${tokens(it)}  ${time(ran)}`
}

function money(spend: Spend): string {
  return spend.hasCost ? `$${spend.usd.toFixed(2)}`.padStart(8) : '       —'
}

function tokens(spend: Spend): string {
  const n = spend.tokens
  const text =
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1000
        ? `${Math.round(n / 1000)}k`
        : String(n)
  return `${text} tokens`.padStart(14)
}

function time(ran: Runtime | undefined): string {
  return (ran && ran.ms > 0 ? duration(ran.ms) : '—').padStart(8)
}

/**
 * How long a check took. `duration` is for how long agents ran, where the
 * interesting range is minutes to days and a second either way is noise; a
 * check that takes under a second is common, and reporting it as `0s` reads
 * like something that did not run.
 */
function howLong(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : duration(ms)
}
