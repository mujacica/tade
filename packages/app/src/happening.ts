import type { WorkSummary } from '@tade/core'
import type { AgentPane } from './model.ts'

// What is happening, in the words Tade already has for it.
//
// The orchestrator can answer "what is going on" because it reads the task
// files, the journal and the queue's own rules. The search box could only ever
// answer out of names — so "the agent on test coverage" found nothing, and
// whoever was asked what the sentence meant was handed a list of names and
// asked to guess from those.
//
// This is that same answer, folded per thing search can go to. It is derived on
// every look, for exactly the reason the orchestrator's is: what an agent is
// doing changes while you type, and a second store of it would be wrong the
// moment one of them did anything. Everything here is already in the window —
// the pane, a fold over the journal, the last look at the checks, the notes —
// so composing it costs no disk, no git and no clock.
//
// Pure, and held to it.

/** What the window already knows about one piece of work, to say in words. */
export interface Happening {
  /** What its row under the name says it is doing, in the window's own words. */
  doing: string
  /** What the journal says its agent has been up to. */
  work?: WorkSummary | null
  /**
   * How its project's checks stood at the commit it is on, as the last look
   * saw. Never looked up here: a look is git, and this is composed for every
   * task on every keystroke.
   */
  checks?: { rollup: string; commit: string | null; failing: readonly string[] } | null
  /** What you have told Tade that is about this piece of work, newest first. */
  notes?: readonly { text: string; summary?: string }[]
}

/**
 * How much of a prompt or a note is worth carrying: enough to say what it is
 * about, and never the whole of somebody's paragraph. What is left out is
 * marked, because a sentence that stops dead reads as the whole of it.
 */
const SAYS = 160

/** What one piece of work is, and what is happening to it, a fact to a line. */
export function happeningOn(pane: AgentPane, said: Happening): string {
  const lines: string[] = [said.doing]
  if (pane.title && pane.title !== pane.name) lines.push(`called ${pane.title}`)
  // Verbatim, like everywhere else it is read: what somebody asked for is the
  // one thing nothing can recover once it has been reworded.
  if (pane.intent) lines.push(`asked for: ${cut(pane.intent)}`)
  lines.push(...waits(pane))
  lines.push(...beenDoing(said.work ?? null))
  lines.push(...stand(said.checks ?? null))
  for (const note of said.notes ?? []) {
    lines.push(`note: ${note.summary ? `${note.summary} — ` : ''}${cut(note.text)}`)
  }
  if (pane.effort) lines.push(`part of ${pane.effort}`)
  if (pane.by) lines.push(`asked for by ${pane.by}`)
  // A branch, which the briefing may never carry and this may: what goes stale
  // there is a snapshot appended to a prompt and read hours later, and this is
  // composed at the keystroke and thrown away after it.
  if (pane.branch) lines.push(`on branch ${pane.branch}`)
  return lines.filter((line) => line !== '').join('\n')
}

/** What is happening in a project: what you have told Tade about it, and who is at work. */
export function happeningIn(
  project: string,
  said: {
    panes: readonly AgentPane[]
    notes?: readonly { text: string; summary?: string }[]
  },
): string {
  const mine = said.panes.filter((pane) => pane.project === project)
  const lines: string[] = []
  const working = mine.filter((pane) => pane.state === 'working').map((pane) => pane.name)
  const waiting = mine.filter((pane) => pane.waiting).map((pane) => pane.name)
  const queued = mine.filter((pane) => pane.queued).map((pane) => pane.name)
  if (working.length > 0) lines.push(`working here: ${working.join(', ')}`)
  if (waiting.length > 0) lines.push(`waiting on you: ${waiting.join(', ')}`)
  if (queued.length > 0) lines.push(`queued here: ${queued.join(', ')}`)
  for (const note of said.notes ?? []) {
    lines.push(`note: ${note.summary ? `${note.summary} — ` : ''}${cut(note.text)}`)
  }
  return lines.join('\n')
}

/**
 * What queued work is waiting for, and what it will be told to do.
 *
 * Composed from the state's own fields rather than borrowed from the row the
 * queue draws: the row is written to fit a narrow side, and this is written to
 * be read. Two drawings of one relationship drift; a drawing and a sentence
 * made of the same facts do not.
 */
function waits(pane: AgentPane): string[] {
  const queued = pane.queued
  if (!queued) {
    return (pane.waitsOn ?? []).length > 0
      ? [`waited for ${(pane.waitsOn ?? []).map((one) => one.task).join(', ')}`]
      : []
  }
  const lines: string[] = ['queued: it has not started']
  const state = queued.state
  switch (state.kind) {
    case 'waiting':
      lines.push(`waits for ${state.on.join(', ')}`)
      break
    case 'held':
      lines.push(`held: ${state.because}`)
      if (state.changed?.length) lines.push(`the files that hold it: ${state.changed.join(', ')}`)
      break
    case 'scheduled':
      lines.push('waits for a time')
      break
    case 'paused':
      lines.push(state.all ? 'paused with everything in its project' : 'paused')
      break
    case 'ready':
      lines.push('ready to start, waiting for room')
      break
  }
  for (const one of queued.after) if (one.why) lines.push(`waits on ${one.task} because ${one.why}`)
  if (queued.prompt) lines.push(`its agent will be told: ${cut(queued.prompt)}`)
  if (queued.touches.length > 0) lines.push(`it is expected to change ${queued.touches.join(', ')}`)
  return lines
}

/** What the journal says the agent has been up to, and what stopped it. */
function beenDoing(work: WorkSummary | null): string[] {
  if (!work || work.empty) return []
  const lines: string[] = []
  const mostly = work.used.slice(0, 3).map((use) => use.tool)
  if (work.tools > 0 || work.turns > 0) {
    lines.push(
      `${work.tools} tool calls over ${work.turns} turns` +
        (mostly.length > 0 ? `, mostly ${mostly.join(', ')}` : ''),
    )
  }
  if (work.waiting) lines.push(`waiting on ${work.waiting}`)
  if (work.failed) lines.push(`failed: ${work.failed}`)
  for (const one of work.notable.slice(0, 3)) lines.push(`it ran ${one}`)
  return lines
}

/** How the checks stand at the commit in hand, `unknown` said as `unknown`. */
function stand(checks: Happening['checks']): string[] {
  if (!checks) return []
  const at = checks.commit ? ` at ${checks.commit.slice(0, 7)}` : ''
  const lines = [`checks${at}: ${checks.rollup}`]
  if (checks.failing.length > 0) lines.push(`failing checks: ${checks.failing.join(', ')}`)
  return lines
}

/** Somebody's own words, as far as they are worth carrying, saying where they were cut. */
function cut(text: string): string {
  const said = text.replace(/\s+/g, ' ').trim()
  return said.length <= SAYS ? said : `${said.slice(0, SAYS)}…`
}
