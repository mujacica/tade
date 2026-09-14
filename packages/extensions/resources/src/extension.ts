import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ExtensionContext, object, oneOf, type WilcoExtension } from '@wilco/extensions-core'
import {
  attribute,
  type By,
  History,
  type LaneRef,
  megabytes,
  parsePs,
  percent,
  type Sample,
  sampleOf,
  sparkline,
  totals,
} from './usage.ts'

// Resources: what Wilco and everything it runs is using — by project, by kind,
// by agent, by process — kept for the last hour, in the status bar and on
// request.
//
// Wilco should cost the machine as little as it can, and this is how you find
// out whether it does. So it is itself cheap: one `ps` for the whole process
// table, never more often than every few seconds whoever asks, and a history
// with a fixed length. What watching costs is measured and reported with
// everything else.

const PERIODS: Record<string, number> = {
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
}

export interface ResourcesOptions {
  /** Samples no more often than this, in milliseconds, however often they are asked for. */
  every?: number
  history?: number
}

/** Lanes as the workbench last wrote them down, for asking without a window. */
function lanesFromDisk(home: string): LaneRef[] {
  try {
    const file = JSON.parse(readFileSync(join(home, 'lanes.json'), 'utf8')) as {
      lanes?: { id?: unknown; task?: unknown; kind?: unknown; pid?: unknown }[]
    }
    return (file.lanes ?? []).flatMap((lane) =>
      typeof lane.id === 'string' && typeof lane.task === 'string'
        ? [
            {
              id: lane.id,
              task: lane.task,
              kind: typeof lane.kind === 'string' ? lane.kind : 'shell',
              pid: typeof lane.pid === 'number' ? lane.pid : null,
              alive: typeof lane.pid === 'number',
            },
          ]
        : [],
    )
  } catch {
    return []
  }
}

/**
 * The same breakdown drawn for a person: each row a bar of its share of what
 * Wilco uses, CPU and memory side by side, so the heavy one is seen before it
 * is read.
 */
export function chart(now: Sample, history: History, period: number): string {
  const lines = [
    `**Wilco is using ${percent(now.total.cpu)} CPU and ${megabytes(now.total.rss)} of memory**, across ${now.total.processes} process${now.total.processes === 1 ? '' : 'es'}.`,
  ]
  const section = (title: string, rows: ReturnType<typeof totals>, limit: number) => {
    if (rows.length === 0) return
    const shown = rows.slice(0, limit)
    const wide = Math.min(28, Math.max(...shown.map((row) => row.label.length)))
    lines.push('', `### ${title}`, '', '```', `${''.padEnd(wide)}  ${'CPU'.padEnd(18)}memory`)
    for (const row of shown) {
      lines.push(
        `${row.label.slice(0, wide).padEnd(wide)}  ${bar(row.cpu, now.total.cpu)} ${percent(row.cpu).padStart(5)}  ${bar(row.rss, now.total.rss)} ${megabytes(row.rss).padStart(7)}`,
      )
    }
    if (rows.length > limit) lines.push(`…and ${rows.length - limit} more`)
    lines.push('```')
  }
  section('By project', totals(now, 'project'), 12)
  section('By kind', totals(now, 'kind'), 12)
  section('By agent and terminal', totals(now, 'agent'), 12)
  section('Busiest processes', totals(now, 'process'), 8)
  const past = history.within(period)
  const summary = history.summary(period)
  if (past.length > 1) {
    lines.push(
      '',
      `### The last ${Math.round(period / 60_000)} minutes`,
      '',
      '```',
      `CPU     ${sparkline(past.map((one) => one.total.cpu))}  ${percent(summary.cpu.average)} average, ${percent(summary.cpu.peak)} peak`,
      `memory  ${sparkline(past.map((one) => one.total.rss))}  ${megabytes(summary.rss.average)} average, ${megabytes(summary.rss.peak)} peak`,
      '```',
    )
  }
  lines.push(
    '',
    `Watching costs one \`ps\` every few seconds: this one took ${Math.round(now.took)} ms${
      summary.samples > 1 ? `, ${Math.round(summary.took.average)} ms on average` : ''
    }.`,
  )
  return lines.join('\n')
}

/** A share as ten cells: how much of the whole one row is. */
function bar(part: number, whole: number, cells = 10): string {
  const filled = whole > 0 ? Math.round((part / whole) * cells) : 0
  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

export function resourcesExtension(options: ResourcesOptions = {}): WilcoExtension {
  const history = new History(options.history ?? 720)
  let taking: Promise<Sample> | null = null

  /** A sample no older than the interval: taken now only when the last one is stale. */
  const sample = async (
    ctx: ExtensionContext & { wilco?: { pid: number; lanes(): readonly LaneRef[] } | null },
  ): Promise<Sample> => {
    const every =
      typeof ctx.settings.every === 'number' && ctx.settings.every > 0
        ? ctx.settings.every * 1000
        : (options.every ?? 5_000)
    const latest = history.latest()
    if (latest && ctx.now() - latest.at < every) return latest
    // Two asking at once share one `ps`.
    if (taking) return taking
    taking = (async () => {
      const started = performance.now()
      const listed = await ctx.exec('ps', ['-A', '-o', 'pid=,ppid=,rss=,pcpu=,args='], {
        timeoutMs: 5_000,
      })
      if (listed.code !== 0)
        throw new Error(`ps could not be read: ${listed.stderr.trim() || `exit ${listed.code}`}`)
      const groups = attribute(parsePs(listed.stdout), {
        window: ctx.wilco?.pid ?? null,
        lanes: ctx.wilco ? ctx.wilco.lanes() : lanesFromDisk(ctx.home),
      })
      const taken = sampleOf(groups, ctx.now(), performance.now() - started)
      history.add(taken)
      return taken
    })().finally(() => {
      taking = null
    })
    return taking
  }

  const limits = (ctx: ExtensionContext) => ({
    cpu: typeof ctx.settings.warn_cpu === 'number' ? ctx.settings.warn_cpu : 150,
    memory:
      (typeof ctx.settings.warn_memory === 'number' ? ctx.settings.warn_memory : 4096) * 1024 ** 2,
  })

  const report = (now: Sample, by: readonly By[], period: number): string => {
    const lines = [
      `**Wilco is using ${percent(now.total.cpu)} CPU and ${megabytes(now.total.rss)} of memory**, across ${now.total.processes} process${now.total.processes === 1 ? '' : 'es'}.`,
    ]
    const table = (title: string, rows: ReturnType<typeof totals>, limit = 12) => {
      if (rows.length === 0) return
      lines.push('', `### ${title}`, '', '| | CPU | Memory | Processes |', '|---|---:|---:|---:|')
      for (const row of rows.slice(0, limit)) {
        lines.push(
          `| ${row.label} | ${percent(row.cpu)} | ${megabytes(row.rss)} | ${row.processes} |`,
        )
      }
      if (rows.length > limit) lines.push(`| …and ${rows.length - limit} more | | | |`)
    }
    const titles: Record<By, string> = {
      project: 'By project',
      kind: 'By kind',
      agent: 'By agent and terminal',
      process: 'Busiest processes',
    }
    for (const one of by) table(titles[one], totals(now, one), one === 'process' ? 10 : 12)

    const past = history.within(period)
    const summary = history.summary(period)
    if (past.length > 1) {
      const minutes = Math.round(period / 60_000)
      lines.push(
        '',
        `### The last ${minutes >= 60 ? 'hour' : `${minutes} minutes`}`,
        '',
        `- CPU: ${percent(summary.cpu.average)} on average, ${percent(summary.cpu.peak)} at most  \`${sparkline(past.map((one) => one.total.cpu))}\``,
        `- Memory: ${megabytes(summary.rss.average)} on average, ${megabytes(summary.rss.peak)} at most  \`${sparkline(past.map((one) => one.total.rss))}\``,
      )
    }
    lines.push(
      '',
      `Watching costs one \`ps\` every few seconds: this one took ${Math.round(now.took)} ms${
        summary.samples > 1 ? `, ${Math.round(summary.took.average)} ms on average` : ''
      }.`,
    )
    return lines.join('\n')
  }

  return {
    name: 'resources',
    title: 'Resources',
    description: 'What Wilco and everything it runs is using, by project, kind, agent and process.',
    settings: [
      {
        key: 'every',
        kind: 'number',
        means: 'seconds between samples, at the least (5 unless set)',
      },
      {
        key: 'warn_cpu',
        kind: 'number',
        means: 'CPU, in percent of one core, above which the status bar warns (150 unless set)',
      },
      {
        key: 'warn_memory',
        kind: 'number',
        means: 'memory, in MB, above which the status bar warns (4096 unless set)',
      },
    ],
    ready: () =>
      process.platform === 'win32' ? 'reading processes is not supported on Windows yet' : null,
    tools: [
      {
        name: 'resources_usage',
        description:
          'How much CPU and memory Wilco and everything it runs is using right now — the window, the orchestrator, each agent and terminal, and helpers — by project, by kind, by agent or by process, with the average and peak over a recent period. Use it when asked how heavy Wilco is, what is using the CPU or memory, or whether an agent is running away.',
        parameters: object({
          by: oneOf(
            ['all', 'project', 'kind', 'agent', 'process'],
            'how to break it down; all unless said',
          ),
          period: oneOf(
            ['1m', '5m', '15m', '1h'],
            'the stretch the average and peak are over; 15m unless said',
          ),
        }),
        for: ['orchestrator'],
        run: async (input, ctx) => {
          const now = await sample(ctx)
          const by = (input.by as string | undefined) ?? 'all'
          const breakdown: By[] =
            by === 'all' ? ['project', 'kind', 'agent', 'process'] : [by as By]
          const top = now.groups.toSorted((a, b) => b.cpu - a.cpu)[0]
          return {
            said: `Wilco is using ${percent(now.total.cpu)} CPU and ${megabytes(now.total.rss)} of memory${
              top ? `; ${top.label} the most, at ${percent(top.cpu)} and ${megabytes(top.rss)}` : ''
            }.`,
            text: report(
              now,
              breakdown,
              PERIODS[String(input.period ?? '15m')] ?? PERIODS['15m'] ?? 900_000,
            ),
            data: {
              total: now.total,
              took: now.took,
              groups: now.groups.map(({ processes, ...group }) => ({
                ...group,
                processes: processes.length,
              })),
            },
          }
        },
      },
    ],
    actions: [
      {
        id: 'usage',
        title: 'Resource usage',
        tool: 'resources_usage',
        input: { by: 'all' },
        heard: [
          /^(how much|what)('?s| is)? (cpu|memory|ram|resources?)( is)? (is )?(wilco|everything|it) (using|taking)$/i,
          /^how (much|heavy) is wilco( using)?$/i,
          /^(show|what'?s|what is) (the )?(wilco )?(resource|cpu|memory) usage$/i,
          /^what is (using|eating) (the|my) (cpu|memory|ram)$/i,
        ],
      },
    ],
    status: async (ctx) => {
      const now = await sample(ctx)
      const limit = limits(ctx)
      const heavy = now.total.cpu > limit.cpu || now.total.rss > limit.memory
      return {
        text: `${percent(now.total.cpu)} · ${megabytes(now.total.rss)}`,
        tone: heavy ? 'warning' : 'quiet',
      }
    },
    view: async (ctx) => chart(await sample(ctx), history, PERIODS['15m'] ?? 900_000),
    orchestrator: () =>
      'When asked how much Wilco or its agents are using, what is slowing the machine, or whether something is running away, call resources_usage and name the top one or two consumers with their CPU and memory.',
  }
}
