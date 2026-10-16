import {
  countSaid,
  defaultConfigPath,
  duration,
  EVAL_BY,
  EVALUATION_EVENTS,
  type EvalBy,
  type EvalFinding,
  evaluationsFrom,
  loadConfig,
  perLanded,
  perLandedCost,
  precisionSaid,
  pricesFrom,
  RUNTIME_EVENTS,
  runFactsFrom,
  type Scorecard,
  scorecardsBy,
  spendFrom,
  startOfToday,
  tadeHome,
  UNRECORDED,
  WITHOUT,
  worthSaid,
} from '@tade/core'
import { loadExtensions } from '@tade/orchestrator'
import { readJournal } from '@tade/workbench/events'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// The scorecards: which harness, model, persona and template lands work, and
// what landing it cost. Landed is merged, or committed straight onto a shared
// checkout under the task's own trailer (`evaluations.ts` says why); `merged`
// is in the JSON beside it.
//
// A question, so it reads the journal itself and never opens the workbench —
// asking which model merges most must work with a window open. What a judge
// raised is asked of the extensions' own records (the `findings` hook), which
// is the same answer the window draws; and a merge is the journal's alone
// here, since asking every forge about every task is a look the window
// already takes and this command does not, which `mergedFrom` says.
//
// Counts before rates: a percentage is said only from `ENOUGH` of something,
// and always after the two numbers it is made of.

export function registerStats(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('stats')
    .description(
      'Which harness, model, persona or template lands work: tasks done and merged, first push green, reds caught here, judge findings, cost per merged task, time to done',
    )
    .option('--by <facet>', `group by ${EVAL_BY.map((one) => one.id).join(', ')}`, 'harness')
    .option('-d, --days <n>', 'only work made in the last n days (all of it when absent)')
    .option('--json', 'machine-readable output')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { by: string; days?: string; json?: boolean; config: string }) => {
      const by = EVAL_BY.find((one) => one.id === opts.by)?.id
      if (!by) {
        io.err(`--by is one of ${EVAL_BY.map((one) => one.id).join(', ')}, not ${opts.by}`)
        setExit(Exit.invalidInput)
        return
      }
      const days = opts.days === undefined ? 0 : Math.max(1, Number(opts.days) || 1)
      const since = days === 0 ? 0 : startOfToday(Date.now()) - (days - 1) * 86_400_000
      const cfg = await loadConfig(opts.config)
      const home = tadeHome()
      const events = await readJournal(home, { types: [...EVALUATION_EVENTS] })
      // What each task cost over every run, whenever it ran: a task made this
      // week may have been started again on an older run's id.
      const usage = events.filter((event) => event.type === 'usage')
      const runs = await readJournal(home, { types: [...RUNTIME_EVENTS] })
      const spent = spendFrom(usage, {
        since: 0,
        runs: runFactsFrom(runs),
        prices: pricesFrom(cfg.ok ? cfg.config.prices : {}),
      }).byTask
      const judged = cfg.ok ? await findingsHere(cfg.config, home) : null
      const evals = evaluationsFrom(events, {
        since,
        spent,
        findings: judged?.findings ?? null,
      })
      for (const problem of judged?.problems ?? []) io.err(`(could not ask ${problem})`)
      const rows = scorecardsBy(evals, by)

      if (opts.json) {
        io.out(
          JSON.stringify(
            {
              by,
              since: since === 0 ? null : new Date(since).toISOString(),
              mergedFrom: evals.mergedFrom,
              total: withFigures(evals.total),
              rows: rows.map(withFigures),
              calibration: evals.calibration,
            },
            null,
            2,
          ),
        )
        return
      }

      if (rows.length === 0) {
        io.out(days === 0 ? 'no work in the journal' : `no work made in ${days} days`)
        return
      }
      const over = days === 0 ? 'all of the journal' : days === 1 ? 'today' : `${days} days`
      io.out(`by ${by} · ${over} · merges from the ${evals.mergedFrom}`)
      const table = [HEAD, ...rows.map((row) => cells(row, by)), cells(evals.total, by, 'all')]
      const widths = HEAD.map((_, at) => Math.max(...table.map((row) => (row[at] ?? '').length)))
      for (const row of table) {
        io.out(
          row
            .map((cell, at) =>
              at === 0 ? cell.padEnd(widths[at] ?? 0) : cell.padStart(widths[at] ?? 0),
            )
            .join('  ')
            .trimEnd(),
        )
      }
      const moved = evals.total.moved
      if (moved > 0 && (by === 'harness' || by === 'model')) {
        io.out(
          `${moved} moved to another ${by} after their first run, and are counted where they began`,
        )
      }
      io.out('')
      const calibration = evals.calibration
      if (calibration === null) {
        io.out(
          (judged?.problems.length ?? 0) > 0
            ? 'judge: what the judges raised could not be read'
            : 'judge: no judge reads anything here, so nothing was asked',
        )
        return
      }
      io.out(
        `judge: ${calibration.total.fired} findings, ${calibration.total.open} with no verdict · precision ${precisionSaid(calibration.total)}`,
      )
      for (const band of calibration.byBand) {
        if (band.tally.fired === 0) continue
        io.out(
          `  at ${band.from.toFixed(1)}–${band.to.toFixed(1)}  ${band.tally.fired} fired · ${precisionSaid(band.tally)}`,
        )
      }
      for (const row of calibration.byQuestion) {
        const worth = worthSaid(row.worth, row.tally)
        io.out(
          `  ${row.question}  ${row.tally.fired} fired · ${precisionSaid(row.tally)}${worth ? ` · ${worth}` : ''}`,
        )
      }
    })
}

const HEAD = [
  '',
  'tasks',
  'done',
  'landed',
  'first push green',
  'reds here',
  'findings',
  'per landed',
  'tokens/landed',
  'to done',
]

function cells(row: Scorecard, by: EvalBy, name?: string): string[] {
  const tokens = perLanded(row, (spend) => spend.tokens)
  const cost = perLandedCost(row)
  return [
    name ?? shown(row.key, by),
    String(row.tasks),
    countSaid(row.done, row.tasks),
    countSaid(row.landed, row.tasks),
    countSaid(row.firstPushGreen, row.pushed),
    row.checkedHere === 0 ? '—' : String(row.redsHere),
    findingsSaid(row),
    cost.map((part) => (part.kind === 'at list' ? `${part.said} at list` : part.said)).join(' · '),
    tokens === null ? '—' : count(tokens),
    row.toDoneMs === null ? '—' : duration(row.toDoneMs),
  ]
}

/** What the judge raised about a row's changes, by what became of each. */
function findingsSaid(row: Scorecard): string {
  const found = row.findings
  if (found === null) return 'not read'
  if (found.fired === 0) return '0'
  return `${found.fired} on ${found.on} · ${found.confirmed}✓ ${found.wrong}✗ ${found.open}?`
}

/** The figures a JSON reader would otherwise have to work out, beside the counts. */
function withFigures(row: Scorecard) {
  return {
    ...row,
    perLanded: {
      cost: perLandedCost(row),
      tokens: perLanded(row, (spend) => spend.tokens),
    },
  }
}

/**
 * A key as a person reads it: nothing recorded is said as that, and no persona
 * or template is said as none — never as one called `unknown`.
 */
function shown(key: string, by: EvalBy): string {
  if (key === UNRECORDED) return 'not recorded'
  if (key === WITHOUT) return `no ${by}`
  return key
}

/** What every judge here has raised, asked of the extensions' own records. */
async function findingsHere(
  config: Parameters<typeof loadExtensions>[0]['config'],
  home: string,
): Promise<{ findings: EvalFinding[] | null; problems: string[] } | null> {
  try {
    const host = await loadExtensions({ config, home })
    const { findings, problems, asked } = await host.findings()
    return { findings: asked === 0 ? null : findings, problems }
  } catch (err) {
    return { findings: null, problems: [err instanceof Error ? err.message : String(err)] }
  }
}

function count(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n))
}
