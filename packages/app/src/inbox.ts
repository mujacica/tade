import { producedClause, type TadeEvent } from '@tade/core'
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
  /**
   * Set when this is an agent that is no longer there. Kept apart from the
   * words so a batch of them — the cleanup button closing six at once — is
   * said as one line with a count, rather than six lines to read.
   */
  ended?: Ended
}

/** An agent that is no longer there, and why, in the words the orchestrator is told. */
export interface Ended {
  task: string
  /** Stopped, removed with its task, exited on its own, or its lane went. */
  why: string
  /**
   * How much this event knows, for the several the journal writes about one
   * ending: the lane closing behind a stop says less than the stop did, and
   * the removal that follows both says more. The most knowing one is said.
   */
  knows: number
}

/** Enough for a morning away; older news falls off the front. */
export const NEWS_MAX = 40

/** Kept once: the same thing said twice in a row is one thing. */
export function addNews(news: readonly News[], text: string, at: number): News[] {
  if (news.at(-1)?.text === text) return [...news]
  return [...news, { at, text }].slice(-NEWS_MAX)
}

/**
 * An agent ending, from the journal: who ended and why, or null when the event
 * is about something else. Read from the log rather than written at each place
 * that ends one, because there are five of those — the window's stop and its
 * cleanup, `tade_run_stop`, `tade_run_cleanup`, removing a task — and an agent
 * that quit on its own is a sixth nobody calls at all.
 */
export function agentEnded(event: TadeEvent): Ended | null {
  if (!event.task) return null
  const task = event.task
  // Removal ends the agent and takes the work with it, which is the most any
  // of these events knows: it lands after the stop that precedes it.
  if (event.type === 'task_removed') {
    return { task, why: 'the task was removed, worktree and all', knows: 2 }
  }
  if (event.type === 'run_exited') {
    if (event.detail.stopped === true) return { task, why: 'stopped', knows: 1 }
    const code = event.detail.code
    if (typeof code === 'number') {
      return {
        task,
        why: code === 0 ? 'it exited on its own' : `it exited on its own, code ${code}`,
        knows: 1,
      }
    }
    // No code and nobody stopped it: the lane went out from under it.
    return { task, why: 'its lane went', knows: 1 }
  }
  // An agent's own lane closed, which is how one nobody was supervising ends:
  // the run said nothing, because there was no run to say it.
  if (event.type === 'lane_closed' && event.lane === `${task}/agent`) {
    return { task, why: 'its lane was closed', knows: 0 }
  }
  return null
}

/**
 * What one of them reads as on its own, and in the transcript. Never "the task
 * ended", which is what `task_done` means and this is not: the work may be
 * half done, and all that is known is that nothing is working on it.
 */
export function endedText(ended: Ended): string {
  return `${ended.task}: its agent is gone (${ended.why})`
}

/**
 * An agent ending, as news. One line per task, the reason that knows most
 * winning: stopping an agent and removing its task writes three events between
 * them, and one agent went.
 */
export function addEnded(news: readonly News[], ended: Ended, at: number): News[] {
  const already = news.find((one) => one.ended?.task === ended.task)?.ended
  if (already && already.knows > ended.knows) return [...news]
  const kept = news.filter((one) => one.ended?.task !== ended.task)
  return [...kept, { at, text: endedText(ended), ended }].slice(-NEWS_MAX)
}

/**
 * An agent is working on it again, so it is not gone. Dropped rather than
 * followed by a correction: an agent stopped and started again — a harness
 * changed under it, a lane relaunched — never ended as far as anyone asking
 * where we are is concerned.
 */
export function unended(news: readonly News[], task: string): News[] {
  return news.filter((one) => one.ended?.task !== task)
}

/**
 * Agents that are gone, as one line: which, how many, and why each. It says to
 * go and ask, because this is a notification and not a second list to steer
 * from — what is running is `tade_status`'s to answer, as it always was.
 */
export function endedNews(ended: readonly Ended[]): string {
  const ask = 'tade_status says what is running.'
  if (ended.length === 1 && ended[0]) return `${endedText(ended[0])}. ${ask}`
  const each = ended.map((one) => `${one.task} (${one.why})`).join(', ')
  return `${ended.length} agents are gone: ${each}. ${ask}`
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

/**
 * What a journal event is worth telling, when it is: a task finishing, who
 * said so, and the document it produced — or an agent the machine cut off
 * being put back to work.
 *
 * A task that was made to plan, audit or research says what it writes, and
 * that path goes on the line that says it finished — so a research task
 * reaching the orchestrator is a document it can go and read rather than one
 * line about one, which is the step somebody used to have to ask for every
 * time. Nothing has been done about it at this moment by construction: Tade
 * tells, and starts nothing off a document by itself.
 *
 * A sleeping laptop is the same shape: Tade is what noticed and what put the
 * agents back to work, and the orchestrator hears it happened rather than
 * being the thing that does it — which would be a model deciding, one message
 * in each agent's conversation, behind the one conversation the sleep also
 * cut off. It is told here because this is the channel it is already told
 * through, and because an agent that went quiet over lunch and is working
 * again is exactly the kind of thing it would otherwise steer into.
 */
export function eventNews(event: TadeEvent): string | null {
  if (!event.task) return null
  if (event.type === 'agent_continued') {
    const slept = typeof event.detail.slept === 'string' ? event.detail.slept : 'a while'
    return `${event.task} was cut off mid-turn while this machine slept for ${slept}, and has been told to carry on where it stopped. Nobody needs to start it again.`
  }
  // A person decided about a document at the machine, so the orchestrator
  // stops being told it is unread — and hears what they decided, in their
  // words, because the next thing they say may well assume it.
  if (event.type === 'document_triaged') {
    const decided = typeof event.detail.decided === 'string' ? event.detail.decided.trim() : ''
    const by = event.detail.by === 'person' ? 'The person' : 'Somebody'
    return `${by} read the document ${event.task} produced and decided: ${decided || 'nothing said'}. It is no longer waiting on anybody.`
  }
  if (event.type !== 'task_done') return null
  const summary = typeof event.detail.summary === 'string' ? event.detail.summary.trim() : ''
  const who =
    event.detail.by === 'agent'
      ? 'its agent said so'
      : event.detail.by === 'rule'
        ? `its rule, ${String(event.detail.rule ?? '')}, was met`
        : event.detail.by === 'orchestrator'
          ? 'you marked it'
          : 'the person marked it'
  const head = `${event.task} finished (${who})${summary ? `: ${summary}` : ''}`
  const path = typeof event.detail.produces === 'string' ? event.detail.produces.trim() : ''
  if (!path) return head
  const clause = producedClause({
    path,
    missing: event.detail.missing === true,
    bytes: typeof event.detail.bytes === 'number' ? event.detail.bytes : null,
  })
  // A summary is somebody's own sentence and may or may not end in a stop:
  // two full stops in the middle of one line read as a bug.
  return `${head}${/[.!?]$/.test(head) ? '' : '.'} It ${clause}`
}

/** The heading the person's own words go under, which the orchestrator is told to look for. */
export const THEIR_WORDS = 'What they said:'

/**
 * Where the person is standing, in one line, for the turn they are standing
 * there in.
 *
 * With five projects open, "start an agent on the flaky test" is not a
 * question anybody could answer: the orchestrator had no idea which tab was in
 * front of them, so it guessed or asked. This is the one thing it genuinely
 * lacked — not knowledge, which `tade_status` answers fresh, but *location*.
 *
 * Derived at the moment of asking and never stored, and deliberately not in
 * the briefing: a briefing that says "you were in sentry" is wrong the instant
 * somebody presses a tab, which is the same class of bug as a remembered
 * branch. Null with nothing open and with one project and nothing focused,
 * where there is nothing to disambiguate and a line saying so is noise.
 */
export function whereYouAre(here: {
  project: string | null
  /** The agent in front of them, by the name the window shows. */
  agent: string | null
  /** Every project open, so it knows the size of what it is choosing between. */
  projects: readonly string[]
}): string | null {
  const many = here.projects.length > 1
  if (!here.project && !here.agent) return null
  if (!many && !here.agent) return null
  const at = here.agent
    ? `${here.project ?? here.projects[0] ?? ''} › ${here.agent}`
    : (here.project ?? '')
  const rest = many
    ? ` ${here.projects.length} projects are open: ${here.projects.join(', ')}.`
    : ''
  return `You are looking at ${at}.${rest}`
}

/**
 * A message with the news that has waited for it, if there is any, and where
 * the person is standing as they say it. The words go last, under a heading,
 * so the orchestrator can tell what was said to it from what it is being told
 * — and record only the first as somebody's intent.
 *
 * Where they are goes above that heading for the same reason: it is Tade's
 * sentence, not theirs, and it must never be recorded as something they said.
 */
export function withNews(
  message: string,
  news: readonly News[],
  clock: (at: number) => string,
  heading = THEIR_WORDS,
  /** `whereYouAre`, for the turn being asked. Null when there is nothing to say. */
  where: string | null = null,
): string {
  if (news.length === 0 && !where) return message
  const ended = news.flatMap((one) => (one.ended ? [one.ended] : []))
  // Every agent that went is said where the last of them went, so a batch is
  // one line in the order the rest of the news happened.
  const collapse = news.findLastIndex((one) => one.ended !== undefined)
  const lines: string[] = []
  news.forEach((one, at) => {
    if (one.ended && at !== collapse) return
    lines.push(`- ${clock(one.at)} ${one.ended ? endedNews(ended) : one.text}`)
  })
  const said = news.length > 0 ? ['Since you last heard from Tade:', ...lines, ''] : []
  return [...said, ...(where ? [where, ''] : []), heading, message].join('\n')
}
