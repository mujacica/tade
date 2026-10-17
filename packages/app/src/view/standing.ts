import type { AgentMark } from '@tade/core'
import type { RemoteProject } from '../machines.ts'

// What a project's tab says is happening in it, counted: the marks its agents
// wear, in the order a tab reads them and gives them up. One rule for a
// project here (`projectStandings`, `top.ts`, out of the panes) and one on
// another machine (`remoteStanding`, out of the marks that machine drew), so
// the two tabs can never count differently — shared by the top row, the side
// standing in a remote project, and the menus that list projects.

/**
 * What a project tab counts: every mark an agent can have, and queued work,
 * which is not an agent yet and so has no mark of its own.
 */
export type ProjectMark = AgentMark | 'queued'

/**
 * The order a project's marks are read in, and the order a tab short of room
 * gives them up in: what a decision is waiting on, then what went wrong, then
 * what is going, then what has not started, then what is sitting there.
 *
 * `done` is not in it: a tab says what is *not* finished, and says `✓` when
 * nothing is left. A count of what is finished beside a count of what is not
 * is two numbers to subtract in your head, four times a second.
 */
export const MARKS: readonly ProjectMark[] = [
  'needs-you',
  'failed',
  'working',
  'queued',
  'idle',
  'stopped',
  'parked',
]

/** What is happening in one project, as its tab says it. */
export interface ProjectStanding {
  /** How many of each. A mark with none of something is not drawn at all. */
  counts: Readonly<Record<ProjectMark, number>>
  /** Everything in it that is not finished, of every kind. */
  outstanding: number
  /**
   * Something here finished and nothing is left: the answer to "is everything
   * I asked for done in there?", which is the question a tab is here to save
   * you switching to ask.
   */
  settled: boolean
}

export const noneYet = (): Record<ProjectMark, number> => ({
  working: 0,
  idle: 0,
  'needs-you': 0,
  failed: 0,
  done: 0,
  stopped: 0,
  parked: 0,
  queued: 0,
})

export function standingOf(counts: Record<ProjectMark, number>): ProjectStanding {
  let outstanding = 0
  for (const mark of MARKS) outstanding += counts[mark]
  return { counts, outstanding, settled: outstanding === 0 && counts.done > 0 }
}

/**
 * What a project on another machine says on its tab: the marks that machine
 * drew beside its agents (`RemoteAgent.counts`), counted the way a project
 * here is. Undefined where nothing there has been asked of it yet.
 */
export function remoteStanding(project: RemoteProject): ProjectStanding | undefined {
  if (project.agents.length === 0) return undefined
  const counts = noneYet()
  for (const agent of project.agents) counts[agent.counts] += 1
  return standingOf(counts)
}
