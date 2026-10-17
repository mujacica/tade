import {
  LINES_LOOKED_BACK,
  type Schedule,
  WATCH_REACH,
  type WatchWhere,
  watchNamedBy,
} from '@tade/core'
import { watchesListed } from '../queue.ts'
import { saidLately, type Wiring } from './context.ts'

// The orchestrator's watch tools, answered from this window: `tade_watches`
// and `tade_watch_change`. Out of `schedules.ts`, which is what turning a watch
// on and looking with one is, because this is the other half — who may ask,
// and in whose words — and that file was at the length a file is allowed to be.

/** What the orchestrator's watch tools do, answered from this window. */
export interface WatchTools {
  watches(find: string): Promise<string>
  change(req: { watch: string; project: string; on: boolean; said: string }): Promise<string>
}

/** What the tools need of the schedules: what is watching where, and the one act that turns a watch. */
export interface WatchTurning {
  watching(watch: string, project: string): (Schedule & { paused: boolean }) | null
  /** Which machine looks with a watch in a project now (`watchWhere`). */
  where(project: string, watch: string, id: string): WatchWhere
  turnWatch(watch: string, project: string, on: boolean, by: string, said?: string): Promise<string>
}

/**
 * What the orchestrator's watch tools do, answered from this window.
 *
 * The boundary is `WATCH_REACH` in core and it is enforced here rather than
 * in the tool, for the reason the settings boundary is: the tool runs inside
 * the model's own process, and a rule that lives where the model lives is a
 * rule the model can be talked out of. It may only ever refuse — everything
 * it allows, the button on the Extensions page already allowed.
 */
export function watchTools(wire: Wiring, schedules: WatchTurning): WatchTools {
  return {
    watches: async (find) =>
      watchesListed({
        offers: wire.opts.extensions?.watches() ?? [],
        projects: Object.keys(wire.opts.config.projects),
        watching: (watch, project) => schedules.watching(watch, project),
        where: (watch, project) =>
          schedules.where(project, watch, schedules.watching(watch, project)?.id ?? ''),
        find,
      }),
    change: async (req) => askedWatch(wire, schedules, req),
  }
}

/**
 * Turn a watch on or off on somebody's behalf, or say why not.
 *
 * The same three things that hold for a setting: Tade has to offer the watch
 * at all, the boundary has to reach it, and the person has to have asked for
 * *this* watch in their own words. That last check reads the journal, not
 * the argument — `said` is the orchestrator's account of what was asked and
 * is written down beside the change, and what authorises it is a line the
 * person themselves typed or spoke. A page can tell a model to turn the
 * review watch off. It cannot put "turn the review watch off" in somebody's
 * mouth.
 */
async function askedWatch(
  wire: Wiring,
  schedules: WatchTurning,
  req: { watch: string; project: string; on: boolean; said: string },
): Promise<string> {
  const watch = req.watch.trim()
  const offer = wire.opts.extensions?.watches().find((one) => one.id === watch)
  if (!offer) {
    throw new Error(
      `Tade has no watch called ${watch}. tade_watches lists every one there is, by the id this takes.`,
    )
  }
  const project = req.project.trim()
  if (!wire.opts.config.projects[project]) {
    throw new Error(
      `${project || 'no project'} is not a project Tade has open. A watch runs in one, so say which.`,
    )
  }
  if (req.said.trim() === '') {
    throw new Error(
      `${offer.title} only goes ${req.on ? 'on' : 'off'} when somebody asks for it. Pass what they said, word for word.`,
    )
  }
  await mayWatch(wire, offer, req.on)
  return schedules.turnWatch(watch, project, req.on, 'orchestrator', req.said.trim())
}

/**
 * Whether the orchestrator may turn this watch, or why not.
 *
 * The rule is `WATCH_REACH` in core and the check is the journal's: what
 * authorises it is a line the *person* typed or spoke, kept verbatim, which
 * nothing an agent read can ever become. It may only ever refuse.
 */
export async function mayWatch(
  wire: Wiring,
  offer: { id: string; title: string },
  on: boolean,
): Promise<void> {
  const { reach, because } = WATCH_REACH
  const way = on ? 'on' : 'off'
  if (reach === 'never') {
    throw new Error(
      `${offer.title} is not mine to turn ${way}: ${because}. A person does it on the Extensions page or in the queue.`,
    )
  }
  if (reach !== 'asked') return
  const line = watchNamedBy(offer, await saidLately(wire, LINES_LOOKED_BACK))
  if (!line) {
    throw new Error(
      `Nothing they have said names ${offer.title}, so I will not turn it ${way} — ${because}. Ask them plainly: "${offer.title.toLowerCase()}" said back to you is enough.`,
    )
  }
}
