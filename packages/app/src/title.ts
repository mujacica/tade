import { spinner } from './model.ts'

// What the terminal window calls itself.
//
// The title is the one part of Tade you can read with the window buried behind
// something else — in a tab bar, in the dock, in a window switcher — so it says
// what is happening rather than where Tade's code happens to live. It used to
// say neither: whatever ran in Tade's own process group last is what Terminal
// named the window after, so it flickered between `pi < node /long/path` and
// `osascript` all day. Probes and model processes now run detached (their own
// process group, so no terminal ever names itself after one) and this is the
// only thing that writes a title.
//
// Pure: facts in, one line out, so what it says is tested without a terminal.

/** What the title is composed from: the agents, the orchestrator, and where you are. */
export interface TitleFacts {
  /** Agents working right now. */
  working: number
  /** Agents with something only you can decide. */
  waiting: number
  /** Agents that failed and have not been dealt with. */
  failed: number
  /** Agents there are at all, whatever they are doing. */
  agents: number
  /** What the thing you talk to is doing. */
  orchestrator: 'thinking' | 'listening' | 'quiet'
  /** Where you are: the task in front of you, or the project. */
  where: string | null
  /** The clock, which is what makes the indicator turn. */
  now: number
}

/**
 * The one glyph in front, the way an agent's own mark works: it turns while
 * anything is working, so a glance at the title says whether Tade is moving.
 * The microphone wins it — that is never something to have to infer — and
 * after that work, then a decision waiting, then a failure, then rest.
 */
export function titleMark(facts: TitleFacts): string {
  if (facts.orchestrator === 'listening') return '⏺'
  if (facts.working > 0 || facts.orchestrator === 'thinking') return spinner(facts.now)
  if (facts.waiting > 0) return '!'
  if (facts.failed > 0) return '✕'
  return facts.agents > 0 ? '●' : '·'
}

/** Longer than this and a tab bar cuts it anyway, so the tail is dropped first. */
const ROOM = 72

/**
 * The window's title: an indicator, Tade's name, what is going on, and where
 * you are — `⠹ tade · 2 working · 1 waiting — tade › ui-chrome`.
 *
 * The counts are the sidebar's own words, so the title and the window never
 * say the same thing two ways. Where you are is the first thing dropped when
 * there is no room for all of it: what is happening outlives what you are
 * looking at.
 */
export function windowTitle(facts: TitleFacts): string {
  const said: string[] = []
  if (facts.working > 0) said.push(`${facts.working} working`)
  if (facts.waiting > 0) said.push(`${facts.waiting} waiting`)
  if (facts.failed > 0) said.push(`${facts.failed} failed`)
  if (facts.orchestrator !== 'quiet') said.push(facts.orchestrator)
  if (said.length === 0) said.push(facts.agents > 0 ? `${facts.agents} idle` : 'nothing running')

  const head = `${titleMark(facts)} tade · ${said.join(' · ')}`
  const where = facts.where?.trim()
  if (!where) return head
  const whole = `${head} — ${where}`
  return whole.length <= ROOM ? whole : head
}
