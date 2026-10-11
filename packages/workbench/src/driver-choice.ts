import type { WorkspaceDriver } from '@tade/drivers-core'
import type { Reporter } from '@tade/telemetry'
import type { EventLog } from './events.ts'
import { drivers, type MakeDriver } from './registry.ts'

/**
 * The driver lanes will live in.
 *
 * A driver the machine cannot provide is not a dead end — `workspace.fallback`
 * says where to go instead — but it is never silent: agents quietly losing the
 * ability to outlive the window is the kind of thing you would discover at the
 * worst possible moment. Set `fallback` to the same driver to refuse instead.
 */
export async function chooseDriver(opts: {
  wanted: string
  fallback: string
  home: string
  /** Injectable so the choice can be tested without uninstalling anything. */
  registry?: Record<string, MakeDriver>
  /** Where the driver says what went wrong that it carried on through. */
  trouble?: (problem: Error) => void
}): Promise<{ driver: WorkspaceDriver; warning: string }> {
  const registry = opts.registry ?? drivers
  const make = registry[opts.wanted]
  if (!make) throw new Error(`unknown workspace driver: ${opts.wanted}`)
  const driver = make(opts.home, opts.trouble)
  const availability = await driver.available()
  if (availability.ok) return { driver, warning: '' }

  const makeFallback = opts.fallback === opts.wanted ? undefined : registry[opts.fallback]
  if (!makeFallback) {
    throw new Error(`workspace.driver is ${opts.wanted}, and ${availability.reason}`)
  }
  const fallback = makeFallback(opts.home, opts.trouble)
  const second = await fallback.available()
  if (!second.ok) throw new Error(`neither ${opts.wanted} nor ${opts.fallback} can run here`)
  return {
    driver: fallback,
    warning:
      `workspace.driver is ${opts.wanted}, and ${availability.reason}. ` +
      `Using ${opts.fallback} instead` +
      (fallback.capabilities.detach ? '.' : ', so agents will not outlive this window.'),
  }
}

/**
 * Where a driver says what went wrong that it carried on through: into the
 * journal, which is where somebody reads it, and to the reporter, which is
 * where it is counted. The driver carried on, and what it carried on with is
 * less than it had — a pane drawn afresh from its replay looks like nothing
 * happened at all.
 */
export function troubleSaid(log: EventLog, report?: Reporter): (problem: Error) => void {
  return (problem) => {
    log.append({ type: 'warning', detail: { message: problem.message } }).catch(() => {})
    report?.trouble({ error: problem, where: 'the workspace driver', level: 'error' })
  }
}
