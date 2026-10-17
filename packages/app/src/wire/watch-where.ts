import {
  nothingToWatch,
  type Schedule,
  type Watched,
  type WatchTwin,
  type WatchWhere,
  watchWhere,
} from '@tade/core'
import { unhush } from '../schedules-view.ts'
import type { Wiring } from './context.ts'

// Which machine looks with a watch due here (core's `watch-where.ts` has the
// rule and its argument), and the look that does not happen when it is not
// this one.
//
// A watch due here does not look for two reasons, and both are quiet facts
// rather than trouble: its project is not open (`nothingToWatch`), or another
// machine of the person's looks with it on the same repository. Each is
// written down as the look it is — `watch_checked` with what it `said`, and
// for a machine, `on` — and said when it starts being true or says something
// new, never at every look, because a watch left to the VPS for a month is not
// a line every ten minutes for a month.

/** What the links know, for one project here, of other machines' watches on its repository. */
export interface WatchTwinsHere {
  /** Every remote this machine links to. */
  remotes: readonly string[]
  /** The ones that have said, since the window opened, which of their projects are which repository. */
  told: ReadonlySet<string>
  twins: readonly WatchTwin[]
}

/** A window that links to no other machine: every watch looks here. */
export function noTwins(): WatchTwinsHere {
  return { remotes: [], told: new Set(), twins: [] }
}

/**
 * Which machine looks with one watch in one project, now, given its schedule's
 * looks here — folded only where there is another machine to ask about: with
 * no remote the rule's answer is here, and the window asks it every beat.
 */
export function whereNow(
  wire: Wiring,
  project: string,
  watch: string,
  watched: () => Watched | null,
  twins: WatchTwinsHere,
): WatchWhere {
  if (twins.remotes.length === 0) return { here: true }
  const look = watched()?.looks[0]
  return watchWhere({
    watch,
    project,
    outside:
      wire.opts.extensions?.watches().find((each) => each.id === watch)?.about === 'repository',
    setting: wire.opts.config.projects[project]?.watches,
    ...twins,
    last: look?.on ? { on: look.on, said: look.said ?? '' } : null,
  })
}

/**
 * Why a watch due here does not look, written down as the quiet look it is —
 * or null, and it looks.
 *
 * A look left to another machine writes no cursor (`since: null`), so the
 * first look back here starts from the last moment the other machine had it
 * (`Watched.elsewhereAt`): what came before that was that machine's to find,
 * and a key it dealt with is not one this machine has seen. A project that is
 * not open keeps its cursor, because nobody else was looking meanwhile.
 */
export async function notLooking(
  wire: Wiring,
  one: Pick<Schedule, 'id' | 'name' | 'project'>,
  watched: Watched,
  where: WatchWhere,
  asked: boolean,
): Promise<{ said: string; news: boolean } | null> {
  const last = watched.looks[0]
  const nothing = nothingToWatch(one.project, Object.keys(wire.opts.config.projects))
  if (nothing) {
    wire.put(unhush(wire.state, one.id))
    await wire.opts.client.watchChecked(one.id, {
      found: 0,
      fresh: [],
      left: 0,
      since: watched.since,
      said: nothing,
    })
    return { said: `${one.name}: ${nothing}`, news: asked || last?.said !== nothing }
  }
  if (where.here) return null
  wire.put(unhush(wire.state, one.id))
  await wire.opts.client.watchChecked(one.id, {
    found: 0,
    fresh: [],
    left: 0,
    since: null,
    said: where.said,
    on: where.on,
  })
  return {
    said: `${one.name} in ${one.project} is left to ${where.on}: ${where.said}`,
    news: asked || last?.on !== where.on || last.said !== where.said,
  }
}
