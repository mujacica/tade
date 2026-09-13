import {
  type EventFilter,
  type LaneId,
  type LaneKind,
  type WilcoEvent,
  wilcoHome,
} from '@wilco/core'
import type { Workbench } from '@wilco/workbench'
import { readJournal } from '@wilco/workbench/events'
import type { LaneRecord } from '@wilco/workbench/registry'
import type { Command } from 'commander'
import { attachToLane } from '../attach.ts'
import { Exit, type Io } from '../io.ts'
import { withWorkbench } from '../with-workbench.ts'

export function registerLanes(program: Command, io: Io, setExit: (code: number) => void): void {
  const withClient = (fn: (client: Workbench) => Promise<void>) => withWorkbench(io, setExit, fn)

  program
    .command('spawn')
    .argument('<lane>', 'lane id: <project>/<task>/<lane>, or <project>/<task>')
    .description('Start a process in a new lane')
    .requiredOption('--cmd <command...>', 'command and arguments to run')
    .option('--cwd <path>', 'working directory', process.cwd())
    .option('--kind <kind>', 'agent | server | tests | shell', 'shell')
    .option('--title <title>', 'lane title')
    .option('--json', 'machine-readable output')
    .action(
      async (
        lane: string,
        opts: { cmd: string[]; cwd: string; kind: string; title?: string; json?: boolean },
      ) => {
        const id = normaliseLaneId(lane, opts.kind)
        if (!id) {
          io.err(`invalid lane id: ${lane} (want <project>/<task>/<lane>)`)
          setExit(Exit.invalidInput)
          return
        }
        await withClient(async (client) => {
          const [command, ...args] = opts.cmd
          const record = await client.spawn({
            id: id as LaneId,
            task: id.split('/').slice(0, 2).join('/'),
            kind: opts.kind as LaneKind,
            cwd: opts.cwd,
            command: command!,
            args,
            ...(opts.title ? { title: opts.title } : {}),
          })
          if (opts.json) io.out(JSON.stringify(record, null, 2))
          else io.out(`${record.id}  pid ${record.pid}  attach: wilco attach ${record.id}`)
        })
      },
    )

  program
    .command('lanes')
    .description('List lanes')
    .option('--task <task>', 'only lanes of this task')
    .option('--json', 'machine-readable output')
    .action(async (opts: { task?: string; json?: boolean }) => {
      await withClient(async (client) => {
        const lanes = await client.lanes(opts.task)
        if (opts.json) {
          io.out(JSON.stringify(lanes, null, 2))
          return
        }
        if (lanes.length === 0) {
          io.out('no lanes')
          return
        }
        const width = Math.max(...lanes.map((l) => l.id.length))
        for (const lane of lanes) io.out(formatLane(lane, width))
      })
    })

  program
    .command('kill')
    .argument('<lane>')
    .description('Stop a lane')
    .action(async (lane: string) => {
      await withClient(async (client) => {
        await client.closeLane(lane as LaneId)
        io.out(`${lane} closed`)
      })
    })

  program
    .command('attach')
    .argument('<lane>')
    .description('Attach your terminal to a lane (detach with Ctrl-\\ twice)')
    .action(async (lane: string) => {
      await withClient(async (client) => {
        const code = await attachToLane(client, lane as LaneId, io)
        if (code !== Exit.ok) setExit(code)
      })
    })

  program
    .command('logs')
    .description('Read the event log')
    .option('-f, --follow', 'stream new events')
    .option('--task <task>')
    .option('--lane <lane>')
    .option('--type <type...>', 'event types to include')
    .option('--min-urgency <urgency>', 'blocking | notable | routine | trace')
    .option('-n, --limit <n>', 'how many past events to show', '20')
    .option('--json', 'machine-readable output')
    .action(
      async (opts: {
        follow?: boolean
        task?: string
        lane?: string
        type?: string[]
        minUrgency?: string
        limit: string
        json?: boolean
      }) => {
        const filter: EventFilter = {
          ...(opts.task ? { task: opts.task } : {}),
          ...(opts.lane ? { lane: opts.lane } : {}),
          ...(opts.type ? { types: opts.type as EventFilter['types'] } : {}),
          ...(opts.minUrgency ? { minUrgency: opts.minUrgency as EventFilter['minUrgency'] } : {}),
          limit: Number(opts.limit),
        }
        const show = (e: WilcoEvent) => io.out(opts.json ? JSON.stringify(e) : formatEvent(e))
        // Read the file rather than take the workbench: what happened is a
        // question, and you must be able to ask it with a window open.
        const home = wilcoHome()
        let seen = 0
        for (const e of await readJournal(home, filter)) {
          show(e)
          seen = Math.max(seen, e.seq)
        }
        if (!opts.follow) return

        const { limit: _limit, ...live } = filter
        await new Promise<void>((resolve) => {
          const stop = () => {
            clearInterval(timer)
            resolve()
          }
          const timer = setInterval(async () => {
            for (const e of await readJournal(home, live).catch(() => [])) {
              if (e.seq <= seen) continue
              seen = e.seq
              show(e)
            }
          }, 250)
          process.once('SIGINT', stop)
          process.once('SIGTERM', stop)
        })
      },
    )
}

/** `project/task` gets the lane name appended; `project/task/lane` passes through. */
export function normaliseLaneId(input: string, kind: string): string | null {
  const parts = input.split('/').filter(Boolean)
  if (parts.length === 3) return parts.join('/')
  if (parts.length === 2) return `${parts.join('/')}/${kind}`
  return null
}

function formatLane(lane: LaneRecord, width: number): string {
  const state = lane.alive
    ? 'running'
    : `exited${lane.exitCode === null ? '' : ` ${lane.exitCode}`}`
  const age = lane.startedAt ? ` ${duration(Date.now() - lane.startedAt)}` : ''
  return `${lane.id.padEnd(width)}  ${lane.kind.padEnd(6)}  ${state.padEnd(9)}${age}`
}

function formatEvent(e: WilcoEvent): string {
  const where = e.lane ?? e.task ?? '-'
  const detail = Object.entries(e.detail)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
  return `${e.ts}  ${e.urgency.padEnd(8)}  ${e.type.padEnd(18)}  ${where}  ${detail}`.trimEnd()
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}
