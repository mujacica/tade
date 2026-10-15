import {
  type Conflict,
  conflictKey,
  conflictsToTell,
  type Queued,
  sameOrInside,
  type Task,
  whoYields,
} from '@tade/core'
import { conflictGoneSays, conflictLine, conflictSays } from '../queue.ts'
import type { Wiring } from './context.ts'

// The conflict forecast, told: what status found would collide (core's
// `conflicts.ts`, looked at in `status/src/conflicts.ts`), said to the
// orchestrator once per collision, with the call that answers it.
//
// On the queue's pass, because it is the same kind of thing as a hold — a
// reason somebody has to decide something about work — and the same person
// decides it (`queue.holds`). Told now (`tell`), after the orchestrator's
// turn, rather than with the next thing somebody says: they asked for it to be
// resolved without them, and news waits for them to speak. Written down as a
// `conflict_forecast` line before it is told, so a window opened again does not
// tell it again; a collision that has gone is written down too, so the next
// time it appears it is news. Evidence may only ever tell or hold: nothing here
// starts, stops or changes any work.

/** What telling needs from the rest of the window. */
export interface ForecastDeps {
  /** Tell the orchestrator now rather than with the next thing you say. */
  tell(text: string): Promise<void>
  /** Something it has not heard yet: it goes with the next thing said. */
  news(said: string): void
  /** A line in the conversation, where you would look for it. */
  said(text: string): void
}

export class Forecast {
  private readonly wire: Wiring
  private readonly deps: ForecastDeps
  /**
   * What this window has written down, by collision: its files. The journal
   * says the same once the line comes back from it, and this is what stops the
   * pass in between telling it twice.
   */
  private readonly written = new Map<string, string | null>()
  /** Why the last forecast could not be written down or told, once said; null while it can. */
  private trouble: string | null = null

  constructor(wire: Wiring, deps: ForecastDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * Tell what is new in the last look's forecast, and write down what has gone.
   * Never throws: what stops it is said once, in the conversation, and the next
   * pass tries again — nothing it could not tell is counted as told.
   */
  async look(): Promise<void> {
    try {
      await this.tellNew()
    } catch (err) {
      this.troubled(err)
    }
  }

  private async tellNew(): Promise<void> {
    const live = this.wire.live
    const world = live?.world
    if (!live || !world) return
    const events = live.queueFacts().events
    for (const project of world.projects) {
      const { tell, gone } = conflictsToTell(project.name, project.conflicts, events)
      for (const conflict of gone) {
        if (!(await this.write(project.name, conflict, true))) continue
        this.deps.news(conflictGoneSays(conflict))
      }
      for (const conflict of tell) {
        if (!(await this.write(project.name, conflict, false))) continue
        this.deps.said(conflictLine(conflict))
        void this.deps
          .tell(this.says(conflict, project.tasks, live.queued))
          .catch((err) => this.troubled(err))
      }
    }
  }

  /** The message, with what only the window knows: who it is to, their branches, the queue. */
  private says(conflict: Conflict, tasks: readonly Task[], queued: readonly Queued[]): string {
    const byId = new Map(tasks.map((task) => [task.id, task]))
    const { yields, keeps } = whoYields(conflict, byId)
    const touches = (item: Queued) =>
      item.start.touches.some((path) => conflict.files.some((file) => sameOrInside(file, path)))
    return conflictSays(conflict, {
      holds: this.wire.opts.config.queue.holds,
      yields,
      keeps,
      branches: new Map(tasks.flatMap((task) => (task.branch ? [[task.id, task.branch]] : []))),
      queued: queued
        .filter(
          (item) =>
            !conflict.tasks.includes(item.task) &&
            touches(item) &&
            !item.start.after.some((dep) => dep.task === keeps),
        )
        .map((item) => item.task)
        .sort(),
    })
  }

  /** Write the line once; false where this window already has, or it would not write. */
  private async write(project: string, conflict: Conflict, gone: boolean): Promise<boolean> {
    const key = `${project}\0${conflictKey(conflict)}`
    const files = gone ? null : conflict.files.join('\0')
    if (this.written.has(key) && this.written.get(key) === files) return false
    const line = {
      type: 'conflict_forecast' as const,
      task: conflict.tasks[0] ?? null,
      detail: {
        project,
        kind: conflict.kind,
        tasks: conflict.tasks,
        ...(conflict.base ? { base: conflict.base } : {}),
        files: conflict.files,
        ...(gone ? { gone: true } : {}),
      },
    }
    try {
      await this.wire.opts.client.log.append(line)
    } catch (err) {
      this.troubled(err)
      return false
    }
    this.written.set(key, files)
    this.trouble = null
    return true
  }

  /** Say what went wrong, once for as long as it keeps going wrong the same way. */
  private troubled(err: unknown): void {
    const why = err instanceof Error ? err.message : String(err)
    if (why === this.trouble) return
    this.trouble = why
    this.deps.said(`could not tell the orchestrator about work that would collide: ${why}`)
  }
}
