import { readFile } from 'node:fs/promises'
import {
  describeProposals,
  describeWhen,
  joined,
  madeByWords,
  PROPOSAL_DECISIONS,
  type Proposal,
  type ProposedFrom,
  proposalsIn,
  queueStateOf,
  relatedWork,
  type Schedule,
  type WorkNow,
} from '@tade/core'
import type { ExtensionHost, Finding } from '@tade/extensions-core'
import { addToContext, readTaskFile, taskContextPath } from '@tade/workbench'
import { withTranscript } from '../model.ts'
import { nowSays } from '../queue.ts'
import { problem, tadeDid } from '../transcript.ts'
import { clockOf, type Wiring, why } from './context.ts'
import type { Tellable } from './handed.ts'

// Work a schedule or a watch would have started, put to the orchestrator
// first — and what it decided. The rule and the words are core's
// (`proposals.ts`); this is where the window makes the work, tells the
// orchestrator, and carries the decision out.
//
// Out of `schedules.ts`, which was at its budget, and its own subject: what a
// look's findings become, which is the one place a watch's work is started.
//
// **Nothing a schedule leaves to the orchestrator starts without its word, or
// a person's.** A proposal is parked, and what lifts the park is a decision
// through `decideProposal` — or a person in the queue, which is the person
// deciding. Only a schedule that says `decides: itself` has its work queued
// here by rule, the way every watch's was before.
// When the orchestrator cannot be told, the work stays parked and that is
// said on screen and kept as news, never dropped and never started instead.

type Looked = Awaited<ReturnType<ExtensionHost['look']>>

/** What one look's findings came to. */
export interface FoundCame {
  /** Queued, by the watch's own rule (`decides: itself`). */
  started: string[]
  /** Not started, deliberately: a person's proposal, a rule that said no, a retry waiting. */
  decided: string[]
  /** What could not be started on, with why. */
  failed: string[]
  /** Made parked, for the orchestrator to decide. */
  proposed: Proposal[]
  /** What became of those, as the look's own line ends with it; empty where there were none. */
  offered: string
}

/**
 * Make the work for each finding one look acts on: queued, or — where the
 * schedule leaves it to the orchestrator — parked as a proposal, and every
 * proposal of the look told in one message (`offerProposals`).
 *
 * Two kinds of finding are never proposals. Work from outside this machine
 * goes through the owner's grant (`takeIntake`), which already decides
 * whether it starts and is the person's own rule about that source; and work
 * a watch says is a proposal *for a person* (`WatchAgent.parked`) is theirs.
 */
export async function actOnFound(
  wire: Wiring,
  one: Schedule,
  looked: Pick<Looked, 'agent'>,
  acting: readonly Finding[],
  how: {
    /** Who decides, where the orchestrator does; null where the schedule decides itself. */
    orchestrator: Tellable | null
    /** Found and waiting for the next look. */
    left: number
  },
): Promise<FoundCame> {
  const client = wire.opts.client
  const proposing = how.orchestrator !== null
  const came: FoundCame = { started: [], decided: [], failed: [], proposed: [], offered: '' }
  for (const finding of acting) {
    try {
      const agent = await looked.agent(finding).catch(async (err: unknown) => {
        // Written down as found, with why: tried again at every look, it would say so at every look.
        await client.watchFound(one.id, finding, { problem: why(err) }).catch(() => {})
        throw err
      })
      const proposed = proposing && !finding.intake && !agent.parked
      const links = agent.links ?? finding.links ?? []
      const { task, said } = await client.watchFound(one.id, finding, {
        agent: { ...agent, links },
        ...(proposed ? { proposed: true } : {}),
      })
      if (task && proposed) {
        came.proposed.push({
          task,
          schedule: one.id,
          key: finding.key,
          title: finding.title,
          links: links.map((link) => link.url),
        })
      } else if (task && agent.parked) {
        // A proposal is made parked (`WatchAgent.parked`): it waits for a person.
        came.decided.push(`${task} is parked for somebody to pick up`)
      } else if (task) came.started.push(task)
      else if (said) came.decided.push(said)
      // Nothing is said back from here. A status is due when it becomes
      // true, not when a look happened, so the one place that posts is the
      // inbox's own fold (`wire/intake-reply.ts`) — which refolds on the
      // `intake_accepted` line this just wrote. One path, and `outcome` is
      // only what this look came to.
    } catch (err) {
      came.failed.push(`${finding.title} (${why(err)})`)
    }
  }
  if (how.orchestrator && came.proposed.length > 0) {
    const watch = one.does.kind === 'watch' ? one.does.watch : null
    came.offered = offerProposals(wire, how.orchestrator, {
      from: { name: one.name, project: one.project, who: madeByWords(one.by), watch },
      proposals: came.proposed,
      left: how.left,
    })
  }
  return came
}

/**
 * A run of a schedule that starts an agent, made parked: told to the
 * orchestrator as a proposal, with what is still working from runs before it.
 */
export function offerRun(
  wire: Wiring,
  orchestrator: Tellable,
  one: Schedule,
  task: string,
): string {
  return offerProposals(wire, orchestrator, {
    from: {
      name: one.name,
      project: one.project,
      who: madeByWords(one.by),
      watch: null,
      when: describeWhen(one.when),
    },
    proposals: [{ task, schedule: one.id, key: null, title: one.name, links: [] }],
    left: 0,
  })
}

/**
 * The tasks as related work is looked for in: the last look's, each with when
 * its agent's open run began and the links of the finding it was made from —
 * and the proposals being made now, which no look has seen yet and which are
 * each other's first relation when one look finds two red commits.
 */
export function workNow(wire: Wiring, making: readonly Proposal[]): WorkNow[] {
  const live = wire.live
  const since = new Map<string, number>()
  for (const run of live?.runs.openRuns ?? []) {
    if (run.task) since.set(run.task, Math.min(since.get(run.task) ?? run.at, run.at))
  }
  // What each task was made from, read off every schedule's own fold: a
  // finding's title and links, and whether it is a proposal still.
  const made = new Map<string, { title: string; links: readonly string[]; proposed: boolean }>()
  for (const schedule of wire.opts.client.schedules()) {
    for (const found of live?.watchedOf(schedule.id).findings ?? []) {
      if (!found.task) continue
      made.set(found.task, {
        title: found.title,
        links: found.links ?? [],
        proposed: found.proposed === true,
      })
    }
    for (const run of live?.runsOf(schedule.id).runs ?? []) {
      if (run.task)
        made.set(run.task, { title: schedule.name, links: [], proposed: run.proposed === true })
    }
  }
  const now: WorkNow[] = (live?.tasks ?? []).map((task) => {
    const from = made.get(task.task)
    return {
      task: task.task,
      state: task.state,
      title: from?.title ?? task.title ?? firstLine(task.intent ?? '') ?? task.task,
      by: task.by ?? null,
      since: since.get(task.task) ?? null,
      finished: Boolean(task.finished),
      links: from?.links ?? [],
      proposed: task.state === 'parked' && from?.proposed === true,
    }
  })
  const seen = new Set(now.map((one) => one.task))
  for (const proposal of making) {
    if (seen.has(proposal.task)) continue
    now.push({
      task: proposal.task,
      state: 'parked',
      title: proposal.title,
      by: `schedule:${proposal.schedule}`,
      since: null,
      finished: false,
      links: proposal.links,
      proposed: true,
    })
  }
  return now
}

/**
 * Tell the orchestrator about work made parked for it to decide, now — or,
 * where it cannot be told, keep it as news and say so on screen. Either way
 * the work stays parked: nothing here starts it, and nothing drops it.
 *
 * Answers with the clause the look's own line ends with, so what is drawn
 * and what the orchestrator hears agree about where the work is.
 */
export function offerProposals(
  wire: Wiring,
  orchestrator: Tellable,
  req: { from: ProposedFrom; proposals: readonly Proposal[]; left: number },
): string {
  const work = workNow(wire, req.proposals)
  const text = describeProposals({
    from: req.from,
    told: req.proposals.map((proposal) => ({
      proposal,
      related: relatedWork(proposal, work),
    })),
    left: req.left,
    now: wire.now(),
  })
  const names = joined(req.proposals.map((one) => one.task))
  const waits = req.proposals.length === 1 ? 'waits' : 'wait'
  const kept = (because: string) => {
    orchestrator.note(text)
    const it =
      req.proposals.length === 1 ? { goes: 'it goes', it: 'it' } : { goes: 'they go', it: 'one' }
    const said = `${names} ${waits} parked: ${because}, so ${it.goes} to the orchestrator with the next thing you say. Nothing has started — pick ${it.it} up in the queue to start ${it.it} yourself.`
    wire.put(withTranscript(wire.state, problem(wire.state.transcript, said, wire.now())))
    wire.draw()
  }
  if (!orchestrator.started) {
    kept('no orchestrator is running to decide')
    return `${names} ${waits} parked for the orchestrator, which is not running yet`
  }
  void orchestrator
    .tell(text)
    .catch((err) => kept(`the orchestrator could not be told (${why(err)})`))
  return `${names} ${waits} for the orchestrator to decide`
}

/** What the orchestrator's decision tool asks for. */
export interface ProposalRequest {
  task: string
  decision: string
  because: string
  /** The task it waits on (`after`), or whose agent is told (`steer`). */
  on?: string
  /** For `steer`: what its agent is told. */
  message?: string
  by?: 'you' | 'orchestrator'
}

/** What deciding needs of the queue, so the queue's own doors do the work. */
export interface ProposalQueue {
  change(req: {
    task: string
    change: string
    after?: readonly { task: string; why: string }[]
    by?: 'you' | 'orchestrator'
  }): Promise<string>
  advance(): Promise<string[]>
}

/**
 * Carry out what was decided about one proposal, then write it down.
 *
 * Each decision goes through the door that already does it — a park lifted,
 * a wait written, a removal, a steer — so nothing here is a second way of
 * doing any of them, and a refusal from one of those doors is this one's
 * refusal. The order is what keeps it safe: a wait is written while the work
 * is still parked, so it is never ready without it; a steer is checked to
 * have an agent to reach before anything is changed; and the decision is
 * written down after it happened, never before.
 */
export async function decideProposal(
  wire: Wiring,
  queue: ProposalQueue,
  req: ProposalRequest,
): Promise<string> {
  const client = wire.opts.client
  const decision = PROPOSAL_DECISIONS.find((one) => one === req.decision)
  if (!decision) {
    throw new Error(
      `${req.decision || 'nothing'} is not a decision: ${PROPOSAL_DECISIONS.join(', ')}`,
    )
  }
  const because = req.because.trim()
  if (!because) {
    throw new Error('say why in a sentence: it is the only record of what was decided and why')
  }
  const by = req.by ?? 'orchestrator'
  // The queue's doors read the last look, which may be a moment behind the
  // work this was made as.
  await wire.live?.refresh()
  const standing = proposalsIn(await client.events({ task: req.task })).at(-1)
  if (!standing) {
    throw new Error(
      `${req.task} is not work a schedule or a watch put to you: tade_queue_change changes queued work`,
    )
  }
  if (standing.settled) throw new Error(`${req.task} is already settled: ${standing.settled}`)
  const file = await readTaskFile(wire.opts.home, req.task)
  if (!file?.parked)
    throw new Error(`${req.task} is not parked any more, so there is nothing to decide`)
  const on = req.on?.trim() ?? ''
  if ((decision === 'after' || decision === 'steer') && !on) {
    throw new Error(
      `${decision} needs on: the task it ${decision === 'after' ? 'waits on' : 'hands this to'}`,
    )
  }
  let answer: string
  if (decision === 'start' || decision === 'after') {
    if (decision === 'after') {
      await queue.change({
        task: req.task,
        change: 'after',
        after: [{ task: on, why: because }],
        by,
      })
    }
    await client.parkTask(req.task, false, { by })
    // A pass already under way read the world while it was parked: it
    // finishes first, and a fresh one reads it picked up.
    await queue.advance().catch(() => [])
    await wire.live?.refresh()
    await queue.advance()
    answer = client.runs().some((run) => run.task === req.task)
      ? `${req.task} has started`
      : nowOf(wire, req.task)
  } else if (decision === 'steer') {
    const message = req.message?.trim() ?? ''
    if (!message) throw new Error(`steer needs message: what ${on}'s agent is told`)
    if (!client.runs().some((run) => run.task === on)) {
      throw new Error(
        `no agent is running on ${on}, so there is nobody to tell: start, after or leave`,
      )
    }
    const context = await readFile(taskContextPath(wire.opts.home, req.task), 'utf8').catch(
      () => '',
    )
    const added = context.trim()
      ? await addToContext(
          { home: wire.opts.home, log: client.log },
          {
            task: on,
            add: `${standing.proposal.title}\n\n${context.trim()}`,
            by: `schedule:${standing.proposal.schedule}`,
            at: wire.now(),
          },
        )
      : null
    await client.steerAgent(
      on,
      added
        ? `${message}\n\nWhat was found is in your context file, under "${added.heading}".`
        : message,
    )
    await queue.change({ task: req.task, change: 'remove', by })
    answer = `${on}'s agent is told, and ${req.task} is dropped`
  } else {
    await queue.change({ task: req.task, change: 'remove', by })
    answer = `${req.task} is dropped: nothing started`
  }
  await client.log.append({
    type: 'proposal_decided',
    task: req.task,
    detail: {
      schedule: standing.proposal.schedule,
      ...(standing.proposal.key ? { key: standing.proposal.key } : {}),
      decision,
      because,
      ...(on ? { on } : {}),
      by,
    },
  })
  const said = `${req.task}: ${by === 'you' ? 'you' : 'the orchestrator'} decided ${decision} — ${because}`
  wire.put(withTranscript(wire.state, tadeDid(wire.state.transcript, said, wire.now())))
  wire.draw()
  return `${answer}. What you decided, and why, is written down.`
}

/** Where queued work stands after a decision, as the queue says it. */
function nowOf(wire: Wiring, task: string): string {
  const live = wire.live
  const item = live?.queued.find((one) => one.task === task)
  return nowSays(task, item && live ? queueStateOf(item, live.queueFacts()) : null, clockOf)
}

function firstLine(text: string): string | null {
  const line = text.split('\n')[0]?.trim() ?? ''
  return line ? line.slice(0, 100) : null
}
