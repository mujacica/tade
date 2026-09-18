import {
  checkBudget,
  defaultConfigPath,
  loadConfig,
  type Spend,
  spendFrom,
  startOfToday,
  tadeHome,
} from '@tade/core'
import { readJournal } from '@tade/workbench/events'
import type { Command } from 'commander'
import type { Io } from '../io.ts'

// What the agents have cost.
//
// Read out of the journal, priced by the harness against its own model
// catalog. Nothing here estimates: a provider that reports no money leaves the
// money column empty rather than showing a plausible zero. A question, so it
// reads the journal itself: asking what today cost must work with a window open.

export function registerSpend(program: Command, io: Io): void {
  program
    .command('spend')
    .description('What the agents have cost, today or over the last few days')
    .option('-d, --days <n>', 'how many days back', '1')
    .option('--json', 'machine-readable output')
    .option('-c, --config <path>', 'config file path', defaultConfigPath())
    .action(async (opts: { days: string; json?: boolean; config: string }) => {
      const days = Math.max(1, Number(opts.days) || 1)
      const since = startOfToday(Date.now()) - (days - 1) * 86_400_000
      const cfg = await loadConfig(opts.config)

      const events = await readJournal(tadeHome(), { types: ['usage'] })
      const report = spendFrom(events, { since })

      if (opts.json) {
        io.out(JSON.stringify({ since: new Date(since).toISOString(), ...report }, null, 2))
        return
      }

      const projects = Object.entries(report.byProject).sort((a, b) => b[1].usd - a[1].usd)
      if (projects.length === 0) {
        io.out(days === 1 ? 'nothing spent today' : `nothing spent in ${days} days`)
        return
      }

      io.out(days === 1 ? 'today' : `last ${days} days`)
      const width = Math.max(...projects.map(([name]) => name.length), 7)
      for (const [name, spend] of projects) {
        const budget = cfg.ok ? cfg.config.projects[name]?.budget : undefined
        const state = checkBudget(spend, budget)
        const note = state.verdict === 'ok' ? '' : `  ← ${state.verdict}: ${state.reason}`
        io.out(`  ${name.padEnd(width)}  ${money(spend)}  ${tokens(spend)}${note}`)
      }
      io.out(`  ${'total'.padEnd(width)}  ${money(report.total)}  ${tokens(report.total)}`)

      const models = Object.entries(report.byModel).sort((a, b) => b[1].tokens - a[1].tokens)
      if (models.length > 1) {
        io.out('')
        for (const [name, spend] of models) {
          io.out(`  ${name.padEnd(width)}  ${money(spend)}  ${tokens(spend)}`)
        }
      }
      if (!report.total.hasCost) {
        io.out('')
        // Zero dollars from a subscription is not the same as free.
        io.out('no prices reported — a subscription plan bills you, not per token')
      }
    })
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
