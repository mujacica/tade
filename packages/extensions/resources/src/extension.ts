import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ExtensionContext, object, oneOf, type TadeExtension } from '@tade/extensions-core'
import { chart, machineSaid } from './chart.ts'
import { diskLow, room } from './machine.ts'
import { type By, type LaneRef, megabytes, percent, sparkline, totals } from './usage.ts'
import { Watch, type Watched } from './watch.ts'

// Drawn by `chart.ts`, and handed on here where they always were.
export { chart, machineSaid }

// Resources: what Tade and everything it runs is using — by project, by kind,
// by agent, by process — kept for the last hour, in the status bar and on
// request.
//
// Tade should cost the machine as little as it can, and this is how you find
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
  /**
   * The watch it reads, shared with whatever else in this process watches the
   * machine (`machineWatch`); its own unless given.
   */
  watch?: Watch
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

export function resourcesExtension(options: ResourcesOptions = {}): TadeExtension {
  const watch = options.watch ?? new Watch({ history: options.history ?? 720 })
  const history = watch.history

  /** A sample no older than the interval: taken now only when the last one is stale. */
  const sample = async (
    ctx: ExtensionContext & { tade?: { pid: number; lanes(): readonly LaneRef[] } | null },
  ): Promise<Watched> => {
    const every =
      typeof ctx.settings.every === 'number' && ctx.settings.every > 0
        ? ctx.settings.every * 1000
        : (options.every ?? 5_000)
    return watch.sample({
      every,
      now: ctx.now(),
      exec: (command, args, opts) => ctx.exec(command, args, opts),
      window: ctx.tade?.pid ?? null,
      lanes: ctx.tade ? ctx.tade.lanes() : lanesFromDisk(ctx.home),
      paths: [ctx.home, ...ctx.projects.map((one) => one.root)],
    })
  }

  const limits = (ctx: ExtensionContext) => ({
    cpu: typeof ctx.settings.warn_cpu === 'number' ? ctx.settings.warn_cpu : 150,
    memory:
      (typeof ctx.settings.warn_memory === 'number' ? ctx.settings.warn_memory : 4096) * 1024 ** 2,
  })

  const report = (now: Watched, by: readonly By[], period: number): string => {
    const lines = [
      `**Tade is using ${percent(now.total.cpu)} CPU and ${megabytes(now.total.rss)} of memory**, across ${now.total.processes} process${now.total.processes === 1 ? '' : 'es'}.`,
      '',
      machineSaid(now.machine),
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
    description: 'What Tade and everything it runs is using, by project, kind, agent and process.',
    workflow: [
      'Answers whether Tade is why the machine is hot (resources_usage).',
      'Breaks it down by agent, where one total hides the worker at a whole core.',
      'Keeps a few words in the status bar; clicking them opens the whole picture.',
      'One `ps` for the machine, shared by every reader: watching costs nothing.',
      'Says the machine too — its CPU, memory and the room left on the disk — and warns under a tenth free.',
    ],
    settings: [
      {
        key: 'every',
        kind: 'number',
        means: 'seconds between samples, at the least (5 unless set)',
        reach: {
          reach: 'asked',
          because: 'it only says how often this machine’s own processes are looked at',
        },
      },
      {
        key: 'warn_cpu',
        kind: 'number',
        means: 'CPU, in percent of one core, above which the status bar warns (150 unless set)',
        reach: {
          reach: 'asked',
          because: 'it only says when the status bar warns about this machine',
        },
      },
      {
        key: 'warn_memory',
        kind: 'number',
        means: 'memory, in MB, above which the status bar warns (4096 unless set)',
        reach: {
          reach: 'asked',
          because: 'it only says when the status bar warns about this machine',
        },
      },
    ],
    ready: () =>
      process.platform === 'win32' ? 'reading processes is not supported on Windows yet' : null,
    tools: [
      {
        name: 'resources_usage',
        description:
          'How much CPU and memory Tade and everything it runs is using right now — the window, the orchestrator, each agent and terminal, and helpers — by project, by kind, by agent or by process, with the average and peak over a recent period; and the machine as a whole: its CPU, load, memory used and the room left on the disk the work is on. Use it when asked how heavy Tade is, what is using the CPU or memory, how much disk is left, or whether an agent is running away.',
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
            said: `Tade is using ${percent(now.total.cpu)} CPU and ${megabytes(now.total.rss)} of memory${
              top ? `; ${top.label} the most, at ${percent(top.cpu)} and ${megabytes(top.rss)}` : ''
            }.`,
            text: report(
              now,
              breakdown,
              PERIODS[String(input.period ?? '15m')] ?? PERIODS['15m'] ?? 900_000,
            ),
            data: {
              total: now.total,
              machine: now.machine,
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
          /^(how much|what)('?s| is)? (cpu|memory|ram|resources?)( is)? (is )?(tade|everything|it) (using|taking)$/i,
          /^how (much|heavy) is tade( using)?$/i,
          /^(show|what'?s|what is) (the )?(tade )?(resource|cpu|memory) usage$/i,
          /^what is (using|eating) (the|my) (cpu|memory|ram)$/i,
          /^how much (disk|disk space|space|room) (is )?(left|free)( on (the|this|my) (disk|machine))?$/i,
        ],
      },
    ],
    status: async (ctx) => {
      const now = await sample(ctx)
      const limit = limits(ctx)
      const heavy = now.total.cpu > limit.cpu || now.total.rss > limit.memory
      // The room left on the disk the work is on: under a tenth of it, a
      // warning however light Tade is, because a full disk stops every agent
      // at once and says so in nobody's words. Where it cannot be asked it is
      // left out rather than drawn as nought.
      const disk = now.machine.disk
      return {
        text: `${percent(now.total.cpu)} · ${megabytes(now.total.rss)}${
          disk ? ` · ${room(disk.free)} free` : ''
        }`,
        tone: heavy || diskLow(disk) ? 'warning' : 'quiet',
      }
    },
    view: async (ctx) => chart(await sample(ctx), history, PERIODS['15m'] ?? 900_000),
    orchestrator: () =>
      'When asked how much Tade or its agents are using, what is slowing the machine, or whether something is running away, call resources_usage and name the top one or two consumers with their CPU and memory.',
  }
}
