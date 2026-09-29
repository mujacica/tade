import type { TadeEvent } from './events.ts'

// What a task produces that is not a change to the code.
//
// An agent sent to plan, audit or research writes a document, and a task
// finishing reached the orchestrator as one line — the summary its agent
// wrote — with nothing saying a document existed or where. So every time, a
// person had to say "the research agent is done, go and read it", which is the
// one step nobody should have to remember.
//
// A task may therefore name what it produces (`TaskFile.produces`), written
// when the task is made like `done` and `start`, and the line that says it
// finished carries that path and whether the file is actually there. It is on
// `task_done` rather than looked up afterwards because **the journal is the
// only thing that remembers**: the task's folder goes when the task does, and
// a window that was shut when an agent finished still has to be able to say,
// when it opens, that there is a document waiting to be read.
//
// There is no research mode and no lifecycle of its own: a task is a task, and
// this is one optional field on it.
//
// Pure: the journal in, what is waiting out. Nothing here starts anything —
// what to do about an analysis is a judgement, and a rule that queued work off
// a document would fill the queue with somebody's guesses.

/**
 * Why a path cannot be what a task produces, or null when it can.
 *
 * The rule exists to answer one question: what happens to the document after
 * the task is cleaned up. Anywhere in the tree it is an ordinary file the agent
 * commits like any other change, so it survives on its branch and in the
 * project's history; anywhere outside it is a file that goes with the worktree.
 * Tade's own folder used to be the third case and the one worth naming — a
 * document written there was ignored by git and removed with the task — and it
 * is not a case any more: Tade writes nothing inside a project.
 */
export function producesProblem(path: string): string | null {
  const said = path.trim()
  if (!said) return 'name the file it writes, as a path in the repository'
  if (said.startsWith('/') || said.startsWith('~') || /^[a-z]:[\\/]/i.test(said)) {
    return `${said} is not in the repository: give a path relative to where the agent works`
  }
  const parts = said.split(/[\\/]/)
  if (parts.includes('..')) {
    return `${said} climbs out of the repository: give a path inside it`
  }
  return null
}

/**
 * A document a finished task produced, and what has come of it since.
 *
 * `Document` and not `Produced`, which this file's neighbour already uses for
 * what a task committed: one of them is lines of code and the other is the
 * thing somebody reads instead of the code.
 */
export interface Document {
  task: string
  /** Where it is, as the task named it: relative to where its agent worked. */
  path: string
  /** What its agent said when it finished. */
  summary: string
  /** When it finished, as the journal wrote it. */
  at: string
  /** The task named it and the file was not there when it finished. */
  missing: boolean
  /** Work made since it finished that waits on it: what was queued off it. */
  followed: string[]
  /** Its own agent was started again after it finished, warm context and all. */
  reused: boolean
}

/**
 * Documents finished tasks produced, oldest first.
 *
 * `followed` and `reused` are the two things the orchestrator may do about one
 * that leave a mark in the journal — queue the work it argues for, or start
 * its own agent again on the next piece — so between them they are what "has
 * anybody acted on this yet" means. Derived rather than remembered: nothing
 * writes down that a document was dealt with, and a flag somebody had to set
 * is a flag that goes unset.
 *
 * A removed task is left out, as everywhere else in a briefing: its worktree
 * is gone, so the path no longer says where to look.
 */
export function producedIn(
  events: readonly TadeEvent[],
  opts: { since?: number } = {},
): Document[] {
  const out = new Map<string, Document>()
  for (const event of events) {
    const task = event.task
    if (!task) continue
    if (event.type === 'task_removed') {
      out.delete(task)
      continue
    }
    if (event.type === 'run_started') {
      const one = out.get(task)
      if (one) one.reused = true
      continue
    }
    if (event.type === 'task_created') {
      const after = Array.isArray(event.detail.after) ? event.detail.after.map(String) : []
      // Only work made *after* it finished: a plan written before the research
      // ran always names it, and that is the plan waiting, not somebody
      // deciding what the document turned out to say.
      for (const waited of after) {
        const one = out.get(waited)
        if (one && !one.followed.includes(task)) one.followed.push(task)
      }
      continue
    }
    if (event.type !== 'task_done') continue
    const path = typeof event.detail.produces === 'string' ? event.detail.produces.trim() : ''
    if (!path) continue
    out.delete(task)
    out.set(task, {
      task,
      path,
      summary: typeof event.detail.summary === 'string' ? event.detail.summary.trim() : '',
      at: event.ts,
      missing: event.detail.missing === true,
      followed: [],
      reused: false,
    })
  }
  const since = opts.since
  return [...out.values()].filter((one) => since === undefined || when(one.at) >= since)
}

/**
 * What a task produced and what has come of it, as a clause after its own
 * name: "produced notes/audit.md, and nothing has been done about it yet".
 *
 * One wording, said by the news the moment a task finishes and by the briefing
 * a window later, because two descriptions of one fact drift apart.
 */
export function producedClause(one: {
  path: string
  missing?: boolean
  followed?: readonly string[]
  reused?: boolean
}): string {
  if (one.missing) return `said it would produce ${one.path} and did not write it`
  return `produced ${one.path}, and ${actedOnSays(one)}`
}

/** What has been done about a document since its task finished, in one clause. */
export function actedOnSays(one: { followed?: readonly string[]; reused?: boolean }): string {
  const followed = one.followed ?? []
  const parts: string[] = []
  if (followed.length > 0) {
    parts.push(`${followed.join(', ')} ${followed.length === 1 ? 'was' : 'were'} queued off it`)
  }
  if (one.reused) parts.push('its own agent was started again')
  return parts.length === 0 ? 'nothing has been done about it yet' : parts.join(', and ')
}

/** A journal timestamp as a moment; an unreadable one counts as the epoch rather than NaN. */
function when(ts: string): number {
  const at = Date.parse(ts)
  return Number.isNaN(at) ? 0 : at
}
