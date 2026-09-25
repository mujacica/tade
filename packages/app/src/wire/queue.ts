import {
  describeQueueState,
  expandHome,
  holdSaid,
  inWrittenOrder,
  joined,
  orderFirst,
  type Plan,
  type PlanBusy,
  projectsIn,
  QUEUE_CHANGES,
  queueStateOf,
  readyToStart,
  startFrom,
} from '@tade/core'
import {
  notice,
  queueViewOf,
  type ScheduleView,
  showPlan,
  showQueue,
  withTranscript,
} from '../model.ts'
import { describeQueue, describeSchedule, heldMessage, planAnswer, whyStarting } from '../queue.ts'
import { QUEUE_SCOPES } from '../queue-view.ts'
import { tadeDid } from '../transcript.ts'
import { type Actions, clockOf, type Subject, type Wiring, whenShort, why } from './context.ts'
// Type-only, so it is erased and no module edge exists between the two
// subjects: the queue's tools answer for schedules as well, and this is the
// shape of what `queue_schedule` takes. What it *does* is the schedules'.
import type { ScheduleRequest } from './schedules.ts'

// Queued work is a task that has not started, and this is what starts it.
//
// The window starts it by rule on every look at the tasks — never a model
// deciding again — as far as `max_parallel` leaves room, and writes why. What
// a plan guessed is checked against the tree at the moment of starting, and
// overlap it did not expect holds it, through the one hold path there is.
// Evidence may only ever hold: it reaches `readyToStart` through `queueStateOf`,
// so it can never start what the rule would not.

/**
 * What can be done to one piece of queued work, from its row or its menu.
 *
 * Not `QUEUE_CHANGES`, which is what the orchestrator's tool takes: `first` and
 * `remove` are the window's words for an order written and a piece dropped.
 */
const CHANGES = ['start', 'first', 'pause', 'resume', 'wait', 'remove'] as const

/** What this subject needs from the rest of the window. */
export interface QueueDeps {
  /** Something happened the orchestrator has not heard yet: it goes with the next thing said. */
  news(said: string): void
  /** Tell the orchestrator now rather than with the next thing you say. */
  tell(text: string): Promise<void>
  /** The schedules, which the queue's tools answer for as well. */
  schedules: {
    views(): ScheduleView[]
    set(req: ScheduleRequest): Promise<string>
    runNow(id: string, asked: boolean): Promise<string>
  }
}

/** What the orchestrator's queue tools do, answered from this window. */
export interface QueueTools {
  advance(): Promise<string[]>
  describe(): Promise<string>
  change(req: {
    task?: string
    schedule?: string
    project?: string
    change: string
    name?: string
    order?: readonly string[]
    by?: 'you' | 'orchestrator'
  }): Promise<string>
  plan(plan: Plan): Promise<string>
  schedule(req: ScheduleRequest): Promise<string>
}

export class Queue implements Subject {
  private readonly wire: Wiring
  private readonly deps: QueueDeps
  /** The queue pass under way, if one is. */
  private advancing: Promise<string[]> | null = null
  /** Queued work being started now, so a refresh in the middle does not start it twice. */
  private readonly starting = new Set<string>()
  /** Tasks whose rule was met and is being written down, so it is written once. */
  private readonly marking = new Set<string>()

  constructor(wire: Wiring, deps: QueueDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * There is no pause-everything button: pausing is done to one piece of work,
   * beside its name. The whole queue can still be held from the orchestrator
   * (`tade_queue_change` with a project and no task).
   */
  actions(): Actions {
    return {
      ...Object.fromEntries(
        CHANGES.map((change) => [`queue-${change}:`, (task: string) => this.change(task, change)]),
      ),
      'queue-plan': () => {
        this.wire.put(showPlan(this.wire.state))
        this.wire.draw()
      },
      // Two controls, because the queue is showing the answers to two
      // questions: how much of the tree, and whether what is on a clock is in
      // it. Each is remembered for the project it was pressed in.
      'queue-scope:': (name) => {
        const scope = QUEUE_SCOPES.find((one) => one === name)
        if (scope) this.wire.put(showQueue(this.wire.state, { scope }))
        this.wire.draw()
      },
      'queue-timed': () => {
        this.wire.put(showQueue(this.wire.state, { timed: !queueViewOf(this.wire.state).timed }))
        this.wire.draw()
      },
    }
  }

  /**
   * Start whatever queued work is ready, and say what is held. By rule, on
   * every look at the tasks: a plan keeps going whether or not the orchestrator
   * is busy, or there at all. One pass at a time, so nothing starts twice.
   */
  advance(): Promise<string[]> {
    this.advancing ??= this.doAdvance().finally(() => {
      this.advancing = null
    })
    return this.advancing
  }

  private async doAdvance(): Promise<string[]> {
    const live = this.wire.live
    if (!live) return []
    const items = live.queued.filter((item) => !this.starting.has(item.task))
    // What the tree says now, for whatever is about to start in it: `touches`
    // was one person's reading of the code when the work was planned, and
    // agents have been changing files ever since. Looked at here, at the
    // moment of starting, because that is the moment it is true.
    await live.lookAtTrees(items).catch(() => {})
    const facts = live.queueFacts()
    for (const item of items) {
      const state = queueStateOf(item, facts)
      if (state.kind !== 'held') continue
      // A start that failed wrote its own hold when it failed; what waits on
      // trouble and what the tree moved under are written here.
      const how =
        state.on !== null
          ? { on: state.on }
          : state.changed
            ? { changed: state.changed, by: state.by ?? [] }
            : null
      if (!how) continue
      if (holdSaid(item.task, state, facts.events)) continue
      await this.wire.opts.client.holdQueued(item.task, state.because, how).catch(() => {})
      this.said(`${item.task} is held: ${state.because}`)
      void this.deps.tell(heldMessage(item.task, state.because, state.changed)).catch(() => {})
    }
    // Room only where a project says how many may run: the queue waits for a
    // slot rather than failing the start the way a limit used to.
    const room = new Map<string, number>()
    for (const [project, settings] of Object.entries(this.wire.opts.config.projects)) {
      if (!settings.max_parallel) continue
      const running = this.wire.opts.client
        .runs()
        .filter((run) => run.task.startsWith(`${project}/`)).length
      room.set(project, settings.max_parallel - running)
    }
    const started: string[] = []
    // In the order last written for it, which is a fact in the journal like
    // every other choice about the queue. The rule is unchanged: what starts
    // is what `readyToStart` says is ready, as far as there is room.
    for (const task of readyToStart(inWrittenOrder(items, facts.events), facts, room)) {
      const item = items.find((one) => one.task === task)
      const worktree = live.worktreeOf(task)
      if (!item || !worktree) continue
      this.starting.add(task)
      const because = whyStarting(item, facts)
      try {
        await this.wire.opts.client.startQueued({
          task,
          worktree,
          why: because,
          from: startFrom(item.start.after, live.upstream, live.baseOf(task), item.project),
        })
        started.push(task)
        this.deps.news(`started ${task}: ${because}`)
        this.said(`started ${task}: ${because}`)
      } catch (err) {
        // Held with why, and said: work that silently never starts looks like waiting.
        this.starting.delete(task)
        await this.wire.opts.client.holdQueued(task, why(err), { start: 'failed' }).catch(() => {})
        this.said(`${task} could not start: ${why(err)}`)
        void this.deps.tell(heldMessage(task, `it could not start: ${why(err)}`)).catch(() => {})
      }
    }
    if (started.length > 0) await live.refresh()
    this.wire.draw()
    return started
  }

  /**
   * A choice about queued work made in the window: written down as yours, and
   * acted on at once rather than at the next look — pressing Start and waiting
   * two seconds for anything to happen reads as broken.
   */
  async change(task: string, change: string): Promise<void> {
    try {
      // "Do this one first" is an order written like any other: this task in
      // front of whatever order the queue is already in.
      const live = this.wire.live
      const order =
        change === 'first' && live ? orderFirst(live.queued, live.queueFacts().events, task) : []
      const answer = await this.tools().change(
        change === 'first' ? { change: 'order', order, by: 'you' } : { task, change, by: 'you' },
      )
      this.wire.put(notice(this.wire.state, answer))
    } catch (err) {
      this.wire.note(err)
    }
    this.wire.draw()
  }

  /** A task's own rule met — an idle turn, committed work, a merge — written down, once. */
  async recordRulesMet(): Promise<void> {
    for (const { task, rule } of this.wire.live?.rulesMet ?? []) {
      if (this.marking.has(task)) continue
      this.marking.add(task)
      await this.wire.opts.client.markDone(task, { by: 'rule', rule }).catch(() => {})
    }
  }

  /** What the orchestrator's queue tools do, answered from this window. */
  tools(): QueueTools {
    return {
      advance: () => this.advance(),
      describe: async () => {
        await this.wire.live?.refresh()
        const live = this.wire.live
        if (!live) return 'Tade is still opening.'
        const now = this.wire.now()
        const schedules = this.deps.schedules.views()
        return [
          describeQueue(live.queued, live.queueFacts(), clockOf),
          ...(schedules.length > 0
            ? [
                '',
                'Schedules:',
                ...schedules.map((one) => describeSchedule(one, (at) => whenShort(at, now))),
              ]
            : []),
        ].join('\n')
      },
      schedule: (req) => this.deps.schedules.set(req),
      change: async (req) => {
        if (req.schedule) return this.changeSchedule(req)
        const change = QUEUE_CHANGES.find((one) => one === req.change)
        if (req.change === 'remove') return this.remove(req.task)
        if (!change) {
          throw new Error(
            `${req.change} is not something to do to queued work: ${[...QUEUE_CHANGES, 'remove'].join(', ')}`,
          )
        }
        // An order is written down like every other choice about the queue,
        // and changes only which of what is already ready goes first.
        const order =
          change === 'order'
            ? (req.order ?? []).filter((task) =>
                (this.wire.live?.queued ?? []).some((one) => one.task === task),
              )
            : []
        if (change === 'order' && order.length === 0) {
          throw new Error(
            `nothing in that order is queued work${req.order?.length ? ` (${joined([...req.order])})` : ''}: say which queued tasks come first`,
          )
        }
        await this.wire.opts.client.changeQueued({
          ...(req.task ? { task: req.task } : {}),
          ...(req.project ? { project: req.project } : {}),
          ...(change === 'order' ? { order } : {}),
          change,
          by: req.by ?? 'orchestrator',
        })
        await this.wire.live?.refresh()
        const started = await this.advance()
        if (started.length > 0) return `Done. Started ${joined(started)}.`
        if (change === 'order')
          return `Done: ${joined(order)}, in that order, as each becomes ready.`
        return `Done: ${req.task ?? 'the queue'} ${change === 'pause' ? 'is paused' : change === 'resume' ? 'is back on' : change === 'wait' ? 'waits again' : 'starts as soon as there is room'}.`
      },
      plan: async (plan) => {
        // Checked against what the projects are already on, which no plan can
        // see: agents working now, and work an earlier plan left to start.
        // Every repository the plan reaches into, since it may reach several.
        const reaches = projectsIn(plan)
        const busy: PlanBusy[] = []
        for (const task of this.wire.live?.tasks ?? []) {
          if (!reaches.some((project) => task.task.startsWith(`${project}/`))) continue
          const touches = task.queued ? task.queued.touches : (task.touches ?? [])
          if (touches.length === 0) continue
          const said = task.queued
            ? 'queued'
            : task.state === 'working'
              ? 'working'
              : task.state === 'blocked'
                ? 'waiting on you'
                : ''
          if (said) busy.push({ task: task.task, said, touches })
        }
        const made = await this.wire.opts.client.planTasks(plan, 'orchestrator', busy)
        await this.wire.live?.refresh()
        const started = await this.advance()
        const live = this.wire.live
        const facts = live?.queueFacts()
        const waiting = made.made
          .map((task) => task.id)
          .filter((task) => !started.includes(task))
          .map((task) => {
            const item = live?.queued.find((one) => one.task === task)
            return {
              task,
              state:
                item && facts ? describeQueueState(queueStateOf(item, facts), clockOf) : 'queued',
            }
          })
        return planAnswer({
          projects: reaches.filter((project) => made.made.some((task) => task.project === project)),
          ...(plan.effort ? { effort: plan.effort } : {}),
          made: made.made.map((task) => task.id),
          started,
          waiting,
          warnings: made.warnings,
        })
      },
    }
  }

  /** What `queue_change` does when it names a schedule rather than a task. */
  private async changeSchedule(req: {
    schedule?: string
    change: string
    name?: string
    by?: 'you' | 'orchestrator'
  }): Promise<string> {
    const id = req.schedule ?? ''
    const by = req.by ?? 'orchestrator'
    if (req.change === 'start') {
      const name = this.wire.opts.client.schedules().find((each) => each.id === id)?.name ?? id
      const said = await this.deps.schedules.runNow(id, true)
      return said ? `${said}.` : `${name} ran now.`
    }
    if (
      req.change === 'rename' ||
      req.change === 'pause' ||
      req.change === 'resume' ||
      req.change === 'remove'
    ) {
      const kept = await this.wire.opts.client.changeSchedule({
        id,
        change: req.change,
        by,
        ...(req.name ? { name: req.name } : {}),
      })
      this.wire.draw()
      return req.change === 'remove'
        ? `${id} is removed.`
        : `${kept?.name ?? id} is ${req.change === 'rename' ? 'renamed' : req.change === 'pause' ? 'paused' : 'back on'}.`
    }
    throw new Error(
      `${req.change} is not something to do to a schedule: start, pause, resume, rename, remove`,
    )
  }

  /** Take one piece of queued work away, with its worktree and its branch. */
  private async remove(task: string | undefined): Promise<string> {
    if (!task) throw new Error('remove is for one piece of work: say which')
    const facts = this.wire.live?.factsOf(task)
    const worktree = this.wire.live?.worktreeOf(task)
    if (!facts || !worktree) throw new Error(`there is no queued work called ${task}`)
    const root = this.wire.opts.config.projects[facts.project]?.root
    const result = await this.wire.opts.client.removeTask({
      root: root ? expandHome(root) : worktree,
      worktree,
      branch: facts.branch,
      task,
      force: true,
    })
    if (!result.removed) throw new Error(result.reason)
    await this.wire.live?.refresh()
    return `${task} is removed: anything waiting on it is held`
  }

  /** Something the queue did, where you would look for it. */
  private said(text: string): void {
    this.wire.put(
      withTranscript(this.wire.state, tadeDid(this.wire.state.transcript, text, this.wire.now())),
    )
  }
}
