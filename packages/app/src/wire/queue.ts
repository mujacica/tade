import {
  describeQueueState,
  expandHome,
  holdSaid,
  type InboxRow,
  type IntakeItem,
  intakeFrom,
  intakeOf,
  inWrittenOrder,
  joined,
  orderFirst,
  type Plan,
  planStandings,
  projectsIn,
  QUEUE_CHANGES,
  queueStateOf,
  readyToStart,
  startFrom,
} from '@tade/core'
import { type HandedOn, handOnWaits, intakeStands } from '@tade/workbench'
import { acknowledge } from '../flash.ts'
import { type ScheduleView, showPlan, showQueue, withTranscript } from '../model.ts'
import { promptPanel } from '../panels/small/state.ts'
import {
  changedSays,
  describeQueue,
  describeSchedule,
  heldMessage,
  nowSays,
  planAnswer,
  planBusyOf,
  unnamedSays,
  whyStarting,
} from '../queue.ts'
import { QUEUE_SCOPES } from '../queue-view.ts'
import { tadeDid } from '../transcript.ts'
import {
  type Actions,
  clockOf,
  notify,
  type Prompts,
  type Subject,
  type Wiring,
  whenShort,
  why,
} from './context.ts'
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
 * `after` and `retell` ask for a line first — what it waits on, what it is told.
 */
const CHANGES = ['start', 'first', 'pause', 'resume', 'wait', 'after', 'retell', 'remove'] as const

/** What is done to one piece of queued work and never to a whole project's queue. */
const ONE_PIECE: ReadonlySet<string> = new Set(['start', 'wait', 'after', 'retell', 'remove'])

/** What this subject needs from the rest of the window. */
export interface QueueDeps {
  /** Something happened the orchestrator has not heard yet: it goes with the next thing said. */
  news(said: string): void
  /** Tell the orchestrator now rather than with the next thing you say. */
  tell(text: string): Promise<void>
  /** The schedules, which the queue's tools answer for as well. */
  schedules: {
    views(): readonly ScheduleView[]
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
    /** For `after`: what it waits on, each with why. */
    after?: readonly { task: string; why: string }[]
    /** For `after`: the list replaces what it waits on, rather than adding to it. */
    replace?: boolean
    /** For `retell`: what its agent is told when it starts. */
    prompt?: string
    /** For `retell`: what it says it will change. */
    touches?: readonly string[]
    /** For `remove`: what waited on it is held (the default), or waits on what it waited on. */
    dependents?: 'hold' | 'inherit'
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
  /**
   * Queued work taking over the waits of a task being removed, which passes
   * leave alone until it has: one in between would hold each on a task that
   * had gone, and say so, about a wait a moment from being handed on.
   */
  private readonly handing = new Set<string>()
  /** Tasks whose rule was met and is being written down, so it is written once. */
  private readonly marking = new Set<string>()
  /**
   * Queued work the orchestrator is being answered about now: a hold found in
   * the look after its change is written down as ever, and goes in the answer
   * it is reading rather than in a second message a turn later.
   */
  private readonly answering = new Set<string>()

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
      // How much of the tree the queue is showing, remembered for the project
      // it was pressed in. The `timed` switch that stood beside it went with
      // the split: the argument is `QueueView`'s.
      'queue-scope:': (name) => {
        const scope = QUEUE_SCOPES.find((one) => one === name)
        if (scope) this.wire.put(showQueue(this.wire.state, { scope }))
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
    const transcript = this.wire.state.transcript
    const items = live.queued.filter(
      (item) => !this.starting.has(item.task) && !this.handing.has(item.task),
    )
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
      if (this.answering.has(item.task)) continue
      // Who answers is read now, not at start: Settings replaces the config.
      const told = {
        holds: this.wire.opts.config.queue.holds,
        working: facts.reality?.get(item.project)?.working ?? [],
      }
      void this.deps.tell(heldMessage(item.task, state, told)).catch(() => {})
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
    // What came from outside this machine is asked again here, for the reason
    // the trees are: a grant is permission at the moment of acting, and a
    // request can be closed, rewritten or un-granted while its task waits.
    const intake = intakeFrom(facts.events)
    // In the order last written for it, which is a fact in the journal like
    // every other choice about the queue. The rule is unchanged: what starts
    // is what `readyToStart` says is ready, as far as there is room.
    for (const task of readyToStart(inWrittenOrder(items, facts.events), facts, room)) {
      const item = items.find((one) => one.task === task)
      const worktree = live.worktreeOf(task)
      if (!item || !worktree) continue
      const hold = await this.intakeHold(intakeOf(intake, task), task)
      if (hold) {
        // Through the one hold path there is, so what the window draws, what
        // the orchestrator is told and what `queueStateOf` reads are one fact.
        if (!holdSaid(task, { because: hold }, facts.events)) {
          await this.wire.opts.client.holdQueued(task, hold, { start: 'failed' }).catch(() => {})
          this.said(`${task} is held: ${hold}`)
          const told = { holds: this.wire.opts.config.queue.holds }
          void this.deps.tell(heldMessage(task, { because: hold }, told)).catch(() => {})
        }
        continue
      }
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
        const held = { because: `it could not start: ${why(err)}` }
        const told = { holds: this.wire.opts.config.queue.holds }
        void this.deps.tell(heldMessage(task, held, told)).catch(() => {})
      }
    }
    if (started.length > 0) await live.refresh()
    // Drawn where it did something: what it says goes in the conversation
    // (`said`), and a beat with nothing ready — nearly every beat — says nothing.
    if (started.length > 0 || this.wire.state.transcript !== transcript) this.wire.draw()
    return started
  }

  /**
   * Why an intake-originated start does not go ahead now, or null — for
   * anything else, null without asking anybody anything.
   *
   * The rule is `intakeStands`'; what is here is the three things only the
   * window has: the config as it stands, the plan standings it already folds for
   * the strip, and the extension host that can ask a watch about its source.
   * A source whose watch is gone — the extension turned off, the schedule
   * removed — holds, because a request nobody can check is a request nobody has
   * confirmed still stands.
   */
  /**
   * The same question, asked of an inbox row rather than of a start.
   *
   * **Here because the rule has to be one rule.** A paired device asking to
   * approve a request that came from outside gets the grant, the plan and the
   * source asked again — which is what the queue asks at the moment it
   * would start one, and a second reading of it in the away view's own wiring
   * would be a second answer to one question. The window hands this to
   * `webActing` as `stands`.
   *
   * A row Tade has no record of holds: approving a request whose own item is
   * not in the journal is approving something nothing can check.
   */
  async standsFor(row: InboxRow): Promise<string | null> {
    const events = this.wire.live?.events ?? (await this.wire.opts.client.events({}))
    const one = intakeFrom(events).get(row.item) ?? null
    if (!one) {
      return `has no record on this machine that Tade can check: approve it at the machine`
    }
    return this.intakeHold(one, row.tasks[0] ?? '')
  }

  private async intakeHold(one: IntakeItem | null, task: string): Promise<string | null> {
    if (!one) return null
    const host = this.wire.opts.extensions
    const schedule = this.wire.opts.client.schedules().find((kept) => kept.id === one.schedule)
    const input = schedule?.does.kind === 'watch' ? schedule.does.input : {}
    const held = await intakeStands({
      config: this.wire.opts.config,
      item: one,
      task,
      plans: planStandings(this.wire.opts.client.planUsage(), this.wire.now()),
      recheck: async (key) => {
        if (!host) throw new Error('this window runs no extensions')
        if (!one.watch) throw new Error('nothing says which watch found it')
        return host.recheck(one.watch, { project: one.project, input, key })
      },
    })
    return held?.because ?? null
  }

  /**
   * A choice about queued work made in the window: written down as yours, and
   * acted on at once rather than at the next look — pressing Start and waiting
   * two seconds for anything to happen reads as broken.
   */
  async change(task: string, change: string): Promise<void> {
    if (change === 'after' || change === 'retell') {
      this.ask(task, change)
      return
    }
    try {
      // "Do this one first" is an order written like any other: this task in
      // front of whatever order the queue is already in.
      const live = this.wire.live
      const order =
        change === 'first' && live ? orderFirst(live.queued, live.queueFacts().events, task) : []
      const answer = await this.tools().change(
        change === 'first' ? { change: 'order', order, by: 'you' } : { task, change, by: 'you' },
      )
      notify(this.wire, answer)
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
        // The workbench refuses these too; the window is what can say what
        // there is to name.
        if (!req.task && ONE_PIECE.has(req.change)) {
          throw new Error(
            unnamedSays(
              req.change,
              (this.wire.live?.queued ?? []).map((one) => one.task),
            ),
          )
        }
        if (req.dependents && req.change !== 'remove') {
          throw new Error(
            `dependents says what becomes of what waited on work being removed, so it goes with remove, not ${req.change}`,
          )
        }
        if (req.change === 'remove') return this.remove(req.task, req.by, req.dependents)
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
          ...(change === 'after' ? { after: req.after ?? [], replace: req.replace === true } : {}),
          ...(change === 'retell' && req.prompt !== undefined ? { prompt: req.prompt } : {}),
          ...(change === 'retell' && req.touches ? { touches: req.touches } : {}),
          change,
          by: req.by ?? 'orchestrator',
        })
        // Answered with where things stand once the queue has looked again,
        // never with what the change meant to do: the piece it was about, the
        // pieces of an order, or a whole queue let go again. A whole queue
        // paused is one sentence and needs no list saying so of each piece.
        const about = req.task
          ? [req.task]
          : change === 'order'
            ? order
            : change === 'resume'
              ? (this.wire.live?.queued ?? [])
                  .filter((one) => !req.project || one.project === req.project)
                  .map((one) => one.task)
              : []
        const started = await this.settle(about, req.by)
        const lead =
          change === 'order'
            ? `Done: ${joined(order)}, in that order, as each becomes ready.`
            : req.task
              ? 'Done.'
              : `Done: ${req.project ? `${req.project}'s queue` : 'the queue'} is ${change === 'pause' ? 'paused' : 'back on'}.`
        return changedSays(lead, started, this.nowOf(about.filter((one) => !started.includes(one))))
      },
      plan: async (plan) => {
        // Checked against what the projects are already on, which no plan can
        // see: agents working now, and work an earlier plan left to start.
        // Every repository the plan reaches into, since it may reach several.
        const reaches = projectsIn(plan)
        const busy = planBusyOf(this.wire.live?.tasks ?? [], reaches)
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

  /**
   * Take one piece of queued work away, with its worktree and its branch, and
   * say what became of what waited on it. With `hold`, the default, each is
   * held on the removal until somebody answers it; with `inherit` each waits
   * on what the removed one waited on instead (`handOnWaits`), so taking one
   * task out of a chain holds nothing after it.
   */
  private async remove(
    task: string | undefined,
    by?: 'you' | 'orchestrator',
    dependents: 'hold' | 'inherit' = 'hold',
  ): Promise<string> {
    if (!task) throw new Error('remove is for one piece of work: say which')
    const facts = this.wire.live?.factsOf(task)
    const worktree = this.wire.live?.worktreeOf(task)
    if (!facts || !worktree) throw new Error(`there is no queued work called ${task}`)
    const waited = (this.wire.live?.queued ?? [])
      .filter((one) => one.task !== task && one.start.after.some((dep) => dep.task === task))
      .map((one) => one.task)
    const root = this.wire.opts.config.projects[facts.project]?.root
    const removing = async () => {
      const result = await this.wire.opts.client.removeTask({
        root: root ? expandHome(root) : worktree,
        worktree,
        branch: facts.branch,
        task,
        force: true,
      })
      if (!result.removed) throw new Error(result.reason)
    }
    if (dependents === 'inherit') return this.handOn(task, waited, by, removing)
    await removing()
    const started = await this.settle(waited, by)
    if (waited.length === 0)
      return changedSays(`${task} is removed. Nothing waited on it.`, started, [])
    return changedSays(
      `${task} is removed. ${joined(waited)} waited on it:`,
      started,
      this.nowOf(waited.filter((one) => !started.includes(one))),
    )
  }

  /**
   * Remove a task and hand its waits on to what waited on it, answered with
   * where each stands once the queue has looked again. Asked of the task
   * files rather than of the last look, which may be a moment behind them.
   */
  private async handOn(
    task: string,
    waited: readonly string[],
    by: 'you' | 'orchestrator' | undefined,
    removing: () => Promise<void>,
  ): Promise<string> {
    for (const one of waited) this.handing.add(one)
    let handed: HandedOn[]
    try {
      // A pass under way read them before they were left alone.
      await this.advancing?.catch(() => {})
      handed = await handOnWaits(
        this.wire.opts.client,
        { task, by: by ?? 'orchestrator' },
        removing,
      )
    } finally {
      for (const one of waited) this.handing.delete(one)
    }
    const about = handed.map((one) => one.task)
    const started = await this.settle(about, by)
    const took = handed.flatMap((one) => ('after' in one ? [one.task] : []))
    const lines = [
      ...handed.flatMap((one) =>
        'problem' in one
          ? [`${one.task} could not take over what ${task} waited on: ${one.problem}`]
          : [],
      ),
      ...this.nowOf(about.filter((one) => !started.includes(one))),
    ]
    if (about.length === 0)
      return changedSays(`${task} is removed. Nothing waited on it.`, started, [])
    const lead =
      took.length > 0
        ? `${task} is removed, and ${joined(took)} ${took.length === 1 ? 'takes' : 'take'} over its waits`
        : `${task} is removed`
    return changedSays(`${lead}${lines.length > 0 ? ':' : '.'}`, started, lines)
  }

  /**
   * Look again after a change, and start what it made ready. A pass already
   * under way read the world before the change, so it finishes first and a
   * fresh one reads it after. What that pass holds is told to the
   * orchestrator in its answer rather than again a turn later (`answering`);
   * a change made at the keyboard is told as ever.
   */
  private async settle(about: readonly string[], by?: 'you' | 'orchestrator'): Promise<string[]> {
    const quiet = by === 'you' ? [] : about
    for (const task of quiet) this.answering.add(task)
    try {
      // Only waited for: how that pass went is its own caller's to say.
      await this.advancing?.catch(() => {})
      await this.wire.live?.refresh()
      return await this.advance()
    } finally {
      for (const task of quiet) this.answering.delete(task)
    }
  }

  /** Where each piece of queued work stands now, in a sentence each. */
  private nowOf(tasks: readonly string[]): string[] {
    const live = this.wire.live
    if (!live) return []
    const facts = live.queueFacts()
    return tasks.map((task) => {
      const item = live.queued.find((one) => one.task === task)
      return nowSays(task, item ? queueStateOf(item, facts) : null, clockOf)
    })
  }

  /**
   * What it waits on, or what it is told, asked for in a line that starts from
   * what its task file says now — so editing the line is changing it, and
   * clearing the waits is waiting on nothing. A prompt of several lines is not
   * put in a one-line field, which would join its lines when it was saved.
   */
  private ask(task: string, change: 'after' | 'retell'): void {
    const item = this.wire.live?.queued.find((one) => one.task === task)
    if (!item) {
      notify(this.wire, `there is no queued work called ${task}`)
      this.wire.draw()
      return
    }
    const name = task.split('/').slice(1).join('/')
    const own = (dep: string) =>
      dep.startsWith(`${item.project}/`) ? dep.slice(item.project.length + 1) : dep
    const panel =
      change === 'after'
        ? promptPanel(
            'queue-after',
            `What ${name} waits on`,
            'TASKS',
            item.start.after.map((dep) => own(dep.task)).join(' '),
          )
        : promptPanel(
            'queue-retell',
            `What ${name} is told`,
            'PROMPT',
            item.start.prompt.includes('\n') ? '' : item.start.prompt,
          )
    this.wire.put({ ...this.wire.state, panel: { ...panel, target: task } })
    this.wire.draw()
  }

  prompts(): Prompts {
    const done = (answer: string) =>
      this.wire.put(acknowledge({ ...this.wire.state, panel: null }, answer, this.wire.now()))
    return {
      'queue-after': async (panel, text) => {
        const task = panel.target ?? ''
        const item = this.wire.live?.queued.find((one) => one.task === task)
        // The reasons already written stay with the waits they were written for.
        const why = new Map((item?.start.after ?? []).map((dep) => [dep.task, dep.why]))
        const project = task.split('/')[0] ?? ''
        const after = text
          .split(/[\s,]+/)
          .filter((one) => one !== '')
          .map((one) => ({
            task: one,
            why: why.get(one.includes('/') ? one : `${project}/${one}`) ?? '',
          }))
        done(await this.tools().change({ task, change: 'after', after, replace: true, by: 'you' }))
      },
      'queue-retell': async (panel, text) => {
        const task = panel.target ?? ''
        done(await this.tools().change({ task, change: 'retell', prompt: text, by: 'you' }))
      },
    }
  }

  /** Something the queue did, where you would look for it. */
  private said(text: string): void {
    this.wire.put(
      withTranscript(this.wire.state, tadeDid(this.wire.state.transcript, text, this.wire.now())),
    )
  }
}
