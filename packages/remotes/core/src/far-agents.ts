import { type AgentMark, noSpend } from '@tade/core'
import type { AgentIn, AgentLane, Can, Outcome, TaskIn, WebActing } from '@tade/web'

// The far end's agents: what another machine's window would hold of each —
// a task row, the screen its lane shows — and what it does when an owner asks
// for a verb, written down rather than done. For the window's tests of an
// agent there, which need a remote with agents in it to look at and act on.
//
// What may be asked of one is worked out the way the real window works it out
// (`ableOn` in `@tade/app`'s `away.ts`): park always, answer while it is held
// on an approval, steer and stop while it runs, reopen once it has stopped,
// queue while it waits. A fixture kinder than that would be a window tested
// against controls a real remote never offers.

/** One agent there, as a test says it is. */
export interface FarAgent {
  /** `<project>/<task>` there. */
  task: string
  title?: string
  mark?: AgentMark
  /** `deriveState`'s clause there. */
  reason?: string
  /** What its lane's screen shows, as the driver there hands it over: anything at all. */
  screen?: string
  /**
   * What it is held on, by the harness's id for it and the tool's name — and
   * the command it asks to run, as the harness summarised it, where it says.
   */
  approval?: { id: string; tool: string; command?: string }
  lane?: AgentLane
  parked?: boolean
  /** Queued work there, waiting to start. */
  queued?: boolean
  /** Finished there, with its agent stopped. */
  finished?: boolean
  /** A branch of its own there, in a worktree; absent, it works in that machine's checkout. */
  branch?: string
}

/** A verb an owner asked of the far end: its name and what the window there was handed. */
export interface FarAct {
  verb: string
  call: Readonly<Record<string, unknown>>
}

/** What may be asked of it, as the real window would say. */
function canOf(agent: FarAgent): Can[] {
  const lane = agent.lane ?? 'running'
  const can: Can[] = [{ verb: 'park', how: 'now' }]
  if (agent.approval) can.push({ verb: 'answer', how: 'now' })
  if (lane === 'running') can.push({ verb: 'steer', how: 'now' }, { verb: 'stop', how: 'now' })
  if (lane === 'stopped') can.push({ verb: 'reopen', how: 'now' })
  if (agent.queued) can.push({ verb: 'queue', how: 'now' })
  return can
}

/** Its row, as the window there would hand it to the projection. */
export function farTask(agent: FarAgent, now: number): TaskIn {
  const project = agent.task.slice(0, agent.task.indexOf('/'))
  const lane = agent.lane ?? 'running'
  return {
    id: agent.task,
    project,
    state: agent.queued
      ? 'queued'
      : agent.finished
        ? 'review'
        : agent.approval
          ? 'blocked'
          : 'working',
    mark: agent.mark ?? (agent.finished ? 'done' : agent.approval ? 'needs-you' : 'working'),
    reason: agent.approval
      ? { kind: 'approval', tool: agent.approval.tool, also: 0 }
      : { kind: 'clause', said: agent.reason ?? 'agent running' },
    stalled: false,
    parked: agent.parked === true,
    createdAt: now - 3_600_000,
    movedAt: now - 60_000,
    title: agent.title ?? '',
    intent: '',
    branch: agent.branch ?? '',
    ahead: null,
    behind: null,
    dirty: null,
    workspace: agent.branch ? 'worktree' : 'checkout',
    shared: !agent.branch,
    effort: '',
    done: 'said',
    produces: null,
    harness: 'pi',
    model: '',
    account: '',
    origin: { kind: 'you', name: 'you' },
    agents: lane === 'running' ? 1 : 0,
    lanes: lane === 'none' ? 0 : 1,
    question: false,
    approval: agent.approval
      ? {
          id: agent.approval.id,
          tool: agent.approval.tool,
          sinceAt: now - 30_000,
          command: agent.approval.command ?? null,
        }
      : null,
    finished: agent.finished === true,
    queue: agent.queued ? 'waiting' : '',
    lane,
    starts: lane === 'none' ? 0 : 1,
    can: canOf(agent),
    cannot: [],
    spend: noSpend(),
    checks: { state: 'unknown', failed: [], missing: [], overridden: false },
    review: null,
  }
}

/** What the window there holds of its lane, for a device looking at it. */
export function farLane(agent: FarAgent, now: number): AgentIn {
  return {
    activity: [],
    earlier: null,
    lane:
      agent.screen === undefined
        ? { kind: 'none', why: 'no agent' }
        : { kind: 'read', text: agent.screen, at: now },
    known: [],
  }
}

/** A window there that writes down every verb it is asked for, and says each was done. */
export function farActing(acted: FarAct[]): WebActing {
  const did =
    (verb: string) =>
    async (call: object): Promise<Outcome> => {
      acted.push({ verb, call: { ...call } })
      return { did: true, rev: `after-${acted.length}`, said: `${verb} done there` }
    }
  return {
    unlocked: () => true,
    park: did('park'),
    answer: did('answer'),
    steer: did('steer'),
    queue: did('queue'),
    done: did('done'),
    note: did('note'),
    context: did('context'),
    intake: did('intake'),
    stop: did('stop'),
    reopen: did('reopen'),
    close: did('close'),
    open: did('open'),
  }
}
