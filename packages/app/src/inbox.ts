import {
  AWAY_WORDS,
  documentSize,
  documentsIn,
  producedClause,
  type TadeEvent,
  THEIR_WORDS,
} from '@tade/core'
import type { Machine, Machines } from './machines.ts'
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

/**
 * What a journal event needs the orchestrator for **now**, rather than with the
 * next thing somebody says: a document handed over, whether its agent asked
 * something (`document_ready`) or finished (`task_done` with one written).
 *
 * The person asked for exactly this — a document written goes back to the
 * orchestrator, which says where things stand and puts what is next to them —
 * and news cannot do it: news waits for somebody to speak, and a planner that
 * stopped to ask "A or B?" waits for that answer, so somebody coming back an
 * hour later found two things waiting on each other. Told, it is said after
 * whatever turn the orchestrator is on, never across it.
 *
 * Paths and never contents, for `documentsWaitingSays`'s reason: what the
 * document says is read from the file, as material. And the instruction is
 * the same short one each time — read it, say where things stand, ask, queue
 * nothing first — because the rule is in its prompt and this is the moment.
 *
 * `journal` is every line about documents, this one included, so a task that
 * finishes the run somebody already answered is said to have finished on that
 * answer rather than put to the person a second time.
 */
export function eventTell(event: TadeEvent, journal: readonly TadeEvent[]): string | null {
  if (!event.task) return null
  const path = typeof event.detail.produces === 'string' ? event.detail.produces.trim() : ''
  if (!path || event.detail.missing === true) return null
  if (event.type === 'task_done') {
    const decided = documentsIn(journal).find((one) => one.task === event.task && one.path === path)
    if (decided?.triaged) {
      return `${event.task} finished, on what was decided about the document it produced, ${path}: ${decided.triaged.decided}. Tell the person in a sentence where that leaves things.`
    }
    const news = eventNews(event) ?? ''
    return `${news}${/[.!?]$/.test(news) ? '' : '.'} ${READ_IT_AND_ASK}`
  }
  if (event.type !== 'document_ready') return null
  const asked = typeof event.detail.asked === 'string' ? event.detail.asked.trim() : ''
  const size = documentSize(typeof event.detail.bytes === 'number' ? event.detail.bytes : null)
  const head = `${event.task} handed over the document it produces, ${path}${size}`
  const question = asked ? ` Its agent asks: ${asked}${/[.!?]$/.test(asked) ? '' : '.'}` : ''
  const waits =
    event.detail.waits === false
      ? ' It is carrying on while you read it.'
      : ' It has stopped until the person answers: when they do, give it their answer with tade_steer.'
  return `${head}, and is not finished.${question}${waits} ${READ_IT_AND_ASK}`
}

/** What the orchestrator does with a document it was just handed: the rule, at the moment. */
const READ_IT_AND_ASK =
  'Read the file now, then tell the person in a few sentences where things stand and put what is next to them — the options, and which you would choose. Queue nothing and start nothing until they answer, and record what they decide with tade_document_triage.'

/** The heading the person's own words go under, which the orchestrator is told to look for. */
export { THEIR_WORDS }

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
  /**
   * A project on another machine they stand in, where no agent here is in
   * front: said as that machine's, because a project here may have its name
   * and nothing done here reaches it.
   */
  elsewhere?: { machine: string; project: string; agent?: string } | null
}): string | null {
  if (here.elsewhere && !here.agent) {
    const { machine, project, agent } = here.elsewhere
    // The agent there they opened, by its task there: "this one" means it, and it is not one here.
    if (agent !== undefined) {
      return `You are looking at ${agent} on ${machine}, an agent of another machine's Tade — not one here.`
    }
    return `You are looking at ${project} on ${machine}, another machine's Tade — not a project here.`
  }
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
 * Every other machine this window links to, as each last said, in one line:
 * `Other machines, as each last said: vps: 3 working, 1 wants you; lab:
 * nothing running.` — said with every message, beside where they are
 * standing, for the same reason that is: it is a fact about now (REMOTE-TADE.md
 * §9.4).
 *
 * **Not in the briefing**, which is composed once as the window opens, before
 * any link has dialled: a line written then would say every machine was being
 * linked, and go on saying it all day. What a machine's own work is, its own
 * orchestrator answers for (`tade_remote_tell`); this is enough to know which
 * one to ask, and that there is something to ask about. Null where none is.
 *
 * A machine that is down is said as down, with when it was last heard from
 * and what it said then — never as nothing running, which is the one thing
 * it cannot say.
 */
export function machinesSaid(
  machines: Machines | undefined,
  clock: (at: number) => string,
): string | null {
  const remotes = machines?.remotes ?? []
  if (remotes.length === 0) return null
  const each = remotes.map((machine) => {
    const counts = countsOf(machine)
    if (machine.link === 'ended') return `${machine.name}: signed this machine out`
    if (!machine.heard) return `${machine.name}: not heard from yet`
    if (machine.link === 'live') return `${machine.name}: ${counts}`
    const at = machine.asOf === null ? '' : ` since ${clock(machine.asOf)}`
    return `${machine.name}: not linked${at} — then, ${counts}`
  })
  return `Other machines, as each last said: ${each.join('; ')}.`
}

/** A machine's agents by what they are doing, as its own marks say. */
function countsOf(machine: Machine): string {
  const agents = machine.projects.flatMap((project) => project.agents)
  const count = (n: number, said: string) => (n > 0 ? [`${n} ${said}`] : [])
  const parts = [
    ...count(agents.filter((one) => !one.queued && one.mark === 'working').length, 'working'),
    ...count(agents.filter((one) => one.mark === 'needs-you').length, 'wants you'),
    ...count(agents.filter((one) => one.mark === 'failed').length, 'failed'),
    ...count(agents.filter((one) => !one.queued && one.mark === 'done').length, 'done'),
    ...count(agents.filter((one) => one.queued && one.mark !== 'needs-you').length, 'queued'),
  ]
  return parts.length > 0 ? parts.join(', ') : 'nothing running'
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

/** The heading what Tade tells it on its own goes under (`tell`), when news went with it. */
export const TADE_WORDS = 'Tade says:'

const SINCE = 'Since you last heard from Tade:'

/**
 * A message as `withNews` composed it, taken apart again: the news that went
 * with it, and the words under whichever heading they were under — the
 * person's (`THEIR_WORDS`), a paired device's (`AWAY_WORDS`), Tade's own
 * (`TADE_WORDS`), or none, where nothing went with the words and they were sent
 * as they were. Tade's line about where they were standing, and its paragraph
 * above a request from away, are neither, and are left out.
 *
 * For a conversation read back out of its harness's record, which keeps what
 * was sent and not who it was from.
 */
export function unwrapped(message: string): {
  news: string[]
  heading: 'them' | 'away' | 'tade' | null
  words: string
} {
  let rest = message
  const news: string[] = []
  if (rest.startsWith(`${SINCE}\n`)) {
    const lines = rest.split('\n')
    let at = 1
    for (; at < lines.length && (lines[at] ?? '').startsWith('- '); at++) {
      news.push((lines[at] ?? '').slice(2).replace(/^\d{1,2}:\d{2} /, ''))
    }
    rest = lines.slice(at).join('\n').replace(/^\n/, '')
  }
  const headings = [
    [THEIR_WORDS, 'them'],
    [AWAY_WORDS, 'away'],
    [TADE_WORDS, 'tade'],
  ] as const
  for (const [heading, whose] of headings) {
    // At the start, or on a line of its own below Tade's.
    const at = `\n${rest}`.indexOf(`\n${heading}\n`)
    if (at >= 0) return { news, heading: whose, words: rest.slice(at + heading.length + 1) }
  }
  return { news, heading: null, words: rest }
}
