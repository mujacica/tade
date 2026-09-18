import type { TadeEvent } from '@tade/core'
import type { TaskSnapshot } from './model.ts'

// What Tade tells the orchestrator without being asked.
//
// Two kinds, because they cost different things. News — an agent finished,
// one failed, the queue started one — is worth knowing and not worth a turn of
// its own: it waits, and goes with the next thing you say, so what answers you
// already knows it. Something that needs deciding cannot wait for you to speak,
// so it is told on its own, after whatever turn the orchestrator is on.
//
// Pure: what happened, in; what to send, out.

export interface News {
  at: number
  text: string
}

/** Enough for a morning away; older news falls off the front. */
export const NEWS_MAX = 40

/** Kept once: the same thing said twice in a row is one thing. */
export function addNews(news: readonly News[], text: string, at: number): News[] {
  if (news.at(-1)?.text === text) return [...news]
  return [...news, { at, text }].slice(-NEWS_MAX)
}

/**
 * What changed about tasks between two looks at them, as news. Only what moved
 * while this window watched: a task already finished when it opened is not
 * something that just happened.
 */
export function taskNews(
  before: readonly TaskSnapshot[],
  after: readonly TaskSnapshot[],
): string[] {
  const was = new Map(before.map((task) => [task.task, task.state]))
  const out: string[] = []
  for (const task of after) {
    const previous = was.get(task.task)
    if (previous === undefined || previous === task.state) continue
    const why = task.reason ? `: ${task.reason}` : ''
    if (task.state === 'merged') out.push(`${task.task} was merged${why}`)
    else if (task.state === 'review') out.push(`${task.task} has work to review${why}`)
    else if (task.state === 'failed') out.push(`${task.task} failed${why}`)
  }
  return out
}

/** What a journal event is worth telling, when it is: a task finishing, and who said so. */
export function eventNews(event: TadeEvent): string | null {
  if (event.type !== 'task_done' || !event.task) return null
  const summary = typeof event.detail.summary === 'string' ? event.detail.summary.trim() : ''
  const who =
    event.detail.by === 'agent'
      ? 'its agent said so'
      : event.detail.by === 'rule'
        ? `its rule, ${String(event.detail.rule ?? '')}, was met`
        : event.detail.by === 'orchestrator'
          ? 'you marked it'
          : 'the person marked it'
  return `${event.task} finished (${who})${summary ? `: ${summary}` : ''}`
}

/** The heading the person's own words go under, which the orchestrator is told to look for. */
export const THEIR_WORDS = 'What they said:'

/**
 * A message with the news that has waited for it, if there is any. The words
 * go last, under a heading, so the orchestrator can tell what was said to it
 * from what it is being told — and record only the first as somebody's intent.
 */
export function withNews(
  message: string,
  news: readonly News[],
  clock: (at: number) => string,
  heading = THEIR_WORDS,
): string {
  if (news.length === 0) return message
  return [
    'Since you last heard from Tade:',
    ...news.map((one) => `- ${clock(one.at)} ${one.text}`),
    '',
    heading,
    message,
  ].join('\n')
}
