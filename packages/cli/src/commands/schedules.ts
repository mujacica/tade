import {
  defaultClock,
  describeWhen,
  runsOf,
  scheduleEnded,
  taskOrigin,
  wilcoHome,
} from '@wilco/core'
import { readJournal } from '@wilco/workbench/events'
import { readSchedules } from '@wilco/workbench/schedules'
import type { Command } from 'commander'
import type { Io } from '../io.ts'

// What runs on a clock.
//
// A question, so it reads the schedules and the journal itself and never takes
// the workbench: asking when something next runs must work with a window open.
// Changing a schedule is the window's, or the orchestrator's, to do.

export function registerSchedules(program: Command, io: Io): void {
  program
    .command('schedules')
    .description('What runs on a clock: when each runs next, what it does, and who made it')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const home = wilcoHome()
      const kept = readSchedules(home)
      const fired = await readJournal(home, { types: ['schedule_fired'] })
      const now = Date.now()
      const shown = kept.map((one) => {
        const runs = fired.filter((event) => event.detail.schedule === one.id)
        const last = runs.length > 0 ? Date.parse(String(runs.at(-1)?.detail.due ?? '')) : null
        const ran = runs.filter((event) => event.detail.ran !== false).length
        const created = Date.parse(one.created)
        const next = scheduleEnded(one, last, ran, now)
          ? null
          : (runsOf(
              one.when,
              created,
              Math.max(last ?? created - 1, now),
              Number.POSITIVE_INFINITY,
              1,
            )[0] ?? null)
        return { schedule: one, next, ran }
      })
      if (opts.json) {
        io.out(
          JSON.stringify(
            shown.map(({ schedule, next, ran }) => ({
              ...schedule,
              next: next === null ? null : new Date(next).toISOString(),
              ran,
            })),
            null,
            2,
          ),
        )
        return
      }
      if (shown.length === 0) {
        io.out(
          'nothing runs on a clock: ask the orchestrator for something at a time, or again and again',
        )
        return
      }
      for (const { schedule, next } of shown) {
        const origin = taskOrigin(schedule.by)
        const does =
          schedule.does.kind === 'agent'
            ? 'starts an agent'
            : schedule.does.kind === 'ask'
              ? 'asks the orchestrator'
              : `watches with ${schedule.does.watch}`
        const when = schedule.paused
          ? 'paused'
          : next === null
            ? 'nothing left to run'
            : `next ${defaultClock(schedule.when)(next)}`
        io.out(`${schedule.id}  ${schedule.project}  ${describeWhen(schedule.when)}, ${does}`)
        io.out(`  ${when} · made by ${origin.name}`)
      }
    })
}
