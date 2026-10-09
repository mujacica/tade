import type { InboxRow, InboxState } from '@tade/core'
import { type AgentMark, MARK_TONES, markGlyph } from './model.ts'

// What INTAKE shows, and nothing about what intake is.
//
// Its own file beside `queue-view.ts` and `schedules-view.ts`, and for the same
// reason: three others need these words — the section down the side, the panel
// one row opens, and the test that holds both to them — and the reasoning
// below is about how a state is *drawn* rather than about any of the three.
//
// **One mapping from a state to a mark, and it is the window's existing one.**
// Seven inbox states are drawn with the seven marks an agent already wears
// (`markGlyph`, `MARK_TONES`), because a second vocabulary for "this needs
// you" is how every agent once wore the same dot — and because somebody who
// has learned what `!` means down the side has learned what it means here. The
// *word* is always beside the glyph, since no colour carries meaning on its
// own.
//
// Pure: a row in, a glyph and a word out. No clock except the one handed in
// for the spinner, no state, nothing of the workbench.

/** How one inbox state is drawn: the mark it wears, and the word beside it. */
export interface InboxMark {
  mark: AgentMark | 'queued'
  glyph: string
  word: string
  tone: 'busy' | 'hint' | 'waiting' | 'bad' | 'done'
}

/**
 * Which of the window's marks each state wears.
 *
 * Three of the seven are somebody at this machine's to answer and all three
 * wear `needs-you`, because that is what the mark means and the word under it
 * is what says which. A refusal is `stopped` and not `failed`: nothing went
 * wrong, somebody said no, and a red row would have people looking for a bug.
 */
const MARKS: Readonly<Record<InboxState, AgentMark | 'queued'>> = {
  noticed: 'queued',
  proposed: 'needs-you',
  accepted: 'queued',
  started: 'working',
  held: 'needs-you',
  refused: 'stopped',
  failure: 'failed',
}

export function inboxMark(row: InboxRow, now = 0): InboxMark {
  // Work that has an agent on it and has finished wears the finished mark: a
  // spinner over work nobody is doing is the one reading of `started` that is
  // simply untrue.
  const over =
    row.state === 'started' && row.work.length > 0 && row.work.every((one) => one.finished)
  const mark = over ? 'done' : MARKS[row.state]
  return {
    mark,
    glyph: markGlyph(mark, now),
    word: over ? 'finished' : row.state,
    tone: mark === 'queued' ? 'hint' : MARK_TONES[mark],
  }
}

/**
 * The rows for the project you are standing in.
 *
 * The same rule as the rows an extension keeps (`rowsHere`): one fold serves
 * every reader, so what the subject holds is every project's, and the section
 * narrows it before it decides anything about itself — a project with none has
 * no heading either, and the badge counts what is in it here.
 */
export function inboxHere(rows: readonly InboxRow[], project: string | null): InboxRow[] {
  return rows.filter((row) => project === null || row.project === project)
}

/** What a row says quietly under its name: who asked, and what it is stamped from. */
export function inboxSays(row: InboxRow): string {
  const bits = [
    row.requester ? `@${row.requester}` : 'nobody said who',
    row.source,
    row.template ? `${row.template.name}@${row.template.version}` : 'one task',
  ]
  return bits.join(' · ')
}

/**
 * What an empty INTAKE section says, in the words of the reason it is empty.
 *
 * `queueEmptySays`' argument, and it applies here harder: the commonest reason
 * there is nothing in this list is that the surface is off, which is the
 * default and is a sentence rather than a bug — and a single "nothing yet"
 * over all three cases reads as broken the moment one of them is untrue.
 */
export function inboxEmptySays(grant: { on: boolean; accept: boolean }): string {
  if (!grant.on) return 'off — nothing outside this machine can make work here'
  if (!grant.accept) return 'no source is turned on'
  return 'nothing has been handed over'
}

/** The longer form of the same, for a section with the room to say it. */
export function inboxEmptyMeans(grant: { on: boolean; accept: boolean }): string {
  if (!grant.on) {
    return 'Work from outside this machine is off. Turn it on in Settings, one source at a time: what arrives is somebody else’s words, read by an agent that runs as you.'
  }
  if (!grant.accept) {
    return 'Intake is on and no source is: each one is its own act, in Settings, with its own list of projects and whose requests count.'
  }
  return 'Nothing has been handed over yet. A request that arrives is made as a parked task and waits here for you to approve it.'
}
