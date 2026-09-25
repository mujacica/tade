import {
  checkBudget,
  defaultConfigPath,
  duration,
  loadConfig,
  modelsSaid,
  noSpend,
  pricedOf,
  RUNTIME_EVENTS,
  type Runtime,
  runFactsFrom,
  runtimeFrom,
  runtimeSays,
  type Spend,
  STATS_EVENTS,
  spendFrom,
  startOfToday,
  statsFrom,
  tadeHome,
  UNRECORDED,
  workedSays,
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
//
// The same six groupings the window has, and for the same reason: three rows
// of `claude-opus-5`, `anthropic/claude-opus-5` and
// `openrouter/anthropic/claude-opus-5` are one model reached three ways, and
// the harness, the sign-in and the provider are what tell them apart.

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
      const runs = await readJournal(tadeHome(), { types: [...RUNS] })
      // What each run was — harness, sign-in, provider — read off the
      // `run_started` that opened it, so usage written before it carried its
      // own still lands in the right bucket.
      const report = spendFrom(events, { since, runs: runFactsFrom(runs) })
      // Timed by what each run turned out to be on rather than by what its
      // route asked for, so one agent is one model row and not two.
      const ran = runtimeFrom(runs, { since, now, said: modelsSaid(events) })
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
      const width = Math.max(
        ...[...projects, ...models, ...agents].map((n) => shown(n).length),
        ...names(report.byHarness, ran.byHarness).map((n) => shown(n).length),
        ...names(report.byAccount, ran.byAccount).map((n) => shown(n).length),
        ...names(report.byProvider, ran.byProvider).map((n) => shown(n).length),
        7,
      )
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
          io.out(`  ${line(shown(name), width, report.byModel[name], ran.byModel[name])}`)
        }
      }
      // How it was reached, which is what tells one model's three rows apart.
      // Only where there is more than one of something: a machine with one
      // harness and one key learns nothing from a list of one.
      const already: string[] = []
      for (const facet of [
        { title: 'by harness', spend: report.byHarness, ran: ran.byHarness },
        { title: 'by sign-in', spend: report.byAccount, ran: ran.byAccount },
        { title: 'by provider', spend: report.byProvider, ran: ran.byProvider },
      ]) {
        const keys = names(facet.spend, facet.ran).sort(
          (a, b) =>
            (facet.spend[b]?.usd ?? 0) - (facet.spend[a]?.usd ?? 0) ||
            (facet.ran[b]?.ms ?? 0) - (facet.ran[a]?.ms ?? 0) ||
            a.localeCompare(b),
        )
        if (keys.length < 2) continue
        // And not the same answer twice. Nobody who runs one account per
        // harness has a sign-in question: their sign-in list is their harness
        // list with the same figures beside it, and printing it again teaches
        // them that this page repeats itself.
        const shape = keys.join('\u0000')
        if (already.includes(shape)) continue
        already.push(shape)
        io.out('')
        io.out(facet.title)
        for (const key of keys) {
          io.out(`  ${line(shown(key), width, facet.spend[key], facet.ran[key])}`)
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
      io.out('')
      io.out(pricedSays(report.total))
      // And what the runtime column has been adding up: `13d 3h` off a machine
      // that has been on since breakfast reads as a bug and is not one, and a
      // figure nobody can defend is one nobody looks at twice.
      const says = runtimeSays(ran.total)
      if (says) io.out(says)
      // And how much of that time a model was actually working, which is the
      // half of the question the column above cannot answer: a run counts
      // until it stopped, idle time included, and what it *worked* is the
      // figure that pairs with what it cost.
      const worked = workedSays(ran.total)
      if (worked) io.out(worked)
    })
}

/** Every bucket either side of the question knows about. */
function names(spend: Record<string, unknown>, ran: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(spend), ...Object.keys(ran)])]
}

/**
 * A bucket key as a person reads it. Nothing recorded is said as that, never
 * as a model, a harness or a provider called `unknown` — the first sends
 * somebody looking for a thing that does not exist.
 */
function shown(key: string): string {
  return key === UNRECORDED ? 'not recorded' : key
}

/**
 * Which kind of money this was. Priced and estimated both go in the total and
 * neither goes in silently: a harness that can only guess at what a turn cost
 * says so every turn, and a total that hid that is a total nobody can defend.
 */
export function pricedSays(spend: Spend): string {
  const exact = `$${spend.usdExact.toFixed(2)} priced by the harness`
  const guessed = `$${spend.usdEstimated.toFixed(2)} estimated`
  const said = (() => {
    switch (pricedOf(spend)) {
      case 'mixed':
        return `of $${spend.usd.toFixed(2)}: ${exact}, ${guessed}`
      case 'exact':
        return `${exact}, against its own catalog`
      case 'estimate':
        return `${guessed} — this harness cannot price a turn, only guess at it`
      default:
        // Zero dollars from a subscription is not the same as free.
        return 'no prices reported — a subscription plan bills you, not per token'
    }
  })()
  // And what no figure above covers. A harness whose own sign-in is a plan
  // has no price per turn at all — Codex and Claude Code both say so
  // (`capabilities.spend.usd: 'none'`) — so its agents ran up tokens and no
  // dollars, and a total that adds the rest up and stops there is a figure
  // with an agent's cost missing from it. Only said where there is money for
  // it to be missing from: with none at all the sentence above has said it.
  if (spend.tokensUnpriced > 0 && spend.usd > 0) {
    return `${said} — and ${count(spend.tokensUnpriced)} of these tokens ran in a harness that reports no money at all, which no figure here covers`
  }
  return said
}

function line(name: string, width: number, spend?: Spend, ran?: Runtime): string {
  const it = spend ?? noSpend()
  return `${name.padEnd(width)}  ${money(it)}  ${tokens(it)}  ${time(ran)}`
}

function money(spend: Spend): string {
  return spend.hasCost ? `$${spend.usd.toFixed(2)}`.padStart(8) : '       —'
}

function tokens(spend: Spend): string {
  return `${count(spend.tokens)} tokens`.padStart(14)
}

/** A count of tokens as a person reads one: `1.9M`, `880k`, `412`. */
function count(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
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
