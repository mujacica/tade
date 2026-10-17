import {
  type Config,
  chatTaskOf,
  documentSize,
  documentsIn,
  expandHome,
  waitingDocuments,
} from '@tade/core'
import { slugify } from '@tade/voice-core'
import { lostChats, reopenChat, type Workbench } from '@tade/workbench'
import { acknowledge } from '../flash.ts'
import type { Frame } from '../frame.ts'
import { doneTasks, focusTask, nextWaiting, notice, shownName, whichProject } from '../model.ts'
import { type AgentOffers, type MenuItem, menuItems, queueMenuItems } from '../panels/menu/state.ts'
import {
  type CloseDonePanel,
  type ConfirmRemovePanel,
  closeDonePanel,
  confirmRemovePanel,
  promptPanel,
} from '../panels/small/state.ts'
import { answering, unanswered } from '../pending.ts'
import { approvalId } from '../reality.ts'
import {
  type Actions,
  flash,
  type Menus,
  notify,
  type Prompts,
  type Subject,
  type Submits,
  type Wiring,
  why,
} from './context.ts'
import { type Waker, wakerOf } from './sleep.ts'

// The agents: making one, opening one again, stopping it, answering it, and
// taking it away. What one *runs on* is `wire/routes.ts`, which its own menu
// reaches through three deps — the two are one question only where that menu
// offers both.
//
// A name is never used twice. pi keeps a conversation by the task's name, so
// a new agent given an old one's would carry on its conversation, which is
// why `startTask` walks past every name a `task_created` ever mentioned
// rather than only the ones on screen.
//
// Opening is never starting. `reopenAgent` reattaches to the conversation the
// agent already has and says nothing to it; the opening instruction belongs
// to the launch that created it, and an agent told its first instruction a
// second time does the work twice. The two sets that guard it — what is being
// opened now, and what this window has already reopened by itself — are here
// for that reason, and so is the promise that an agent stopped on purpose is
// never started again behind your back.
//
// **Nothing here starts an agent nobody asked for.** Adding a project used to
// make one so there was somewhere to type; the empty screen (`view/empty.ts`)
// is that somewhere now, and it is the whole of what a project with no agents
// shows. So an agent comes from a task, from `+ New agent`, or from the
// orchestrator — never from a project existing. What that buys is the promise
// the old one had to carve out by hand: a project whose agents you removed
// stays without one, and closing the window and opening it again brings back
// what was *working* (`reopenLost`) and nothing else.

/** What this subject needs from the rest of the window. */
export interface AgentsDeps {
  /** The config was written by somebody else's hand: read it back. */
  useConfig(config: Config): void
  /** Put a half-written command back on the line, ready to be finished. */
  prefill(line: string): void
  /** Where an agent's own menu leads. */
  openChange(task: string | null, path: string): Promise<void>
  openPlace(target: { path: string }): Promise<void>
  /** Queued work is changed through the queue, so what did it and why is written down. */
  changeQueue(task: string, change: string): Promise<void>
  /** Put text on the clipboard: true when it got there. */
  copyToClipboard(text: string): Promise<boolean>
  /** What an agent runs on is its own subject (`wire/routes.ts`), and its menu offers three of those. */
  routes(): AgentRoutes
  /** Handing it to another machine, which the remotes do (`moves.ts`); null where the window moves nothing. */
  handsOver(): HandsOver | null
}

/** What its harness lets a person ask of an agent, and the two pickers. */
export interface AgentRoutes {
  offersFor(task: string): AgentOffers | null
  openModels(task: string): Promise<void>
  openAccount(task: string): Promise<void>
}

/**
 * An agent handed to another machine from its own menu, which is where a
 * person looks before closing the lid: an item per machine that holds its
 * project's repository, and the press.
 */
export interface HandsOver {
  handItems(task: string): MenuItem[]
  hand(task: string, machine: string): void
}

export class Agents implements Subject {
  private readonly wire: Wiring
  private readonly deps: AgentsDeps
  /** A new agent is being made. */
  private starting = false
  /** Tasks whose agent is being opened right now. */
  private readonly opening = new Set<string>()
  /** Agents this window has opened again on its own, so it never does it twice. */
  private readonly reopened = new Set<string>()
  /** Agents whose branch is being named, so a slow git is not asked twice. */
  private readonly naming = new Set<string>()
  /**
   * The machine going away under the agents, and who is told to carry on when
   * it comes back (`sleep.ts`). Here because a laptop waking is the third of
   * the same kind of thing this subject already does — `reopenLost` for a
   * window that closed, `reopenStopped` for an agent that stopped — and all
   * three are held to the same rule: once each, never a loop, and never the
   * opening instruction said a second time.
   */
  private readonly waker: Waker

  constructor(wire: Wiring, deps: AgentsDeps) {
    this.wire = wire
    this.deps = deps
    this.waker = wakerOf(wire)
  }

  /**
   * The window's beat, which is how the machine having been away is noticed
   * at all: a beat that arrives an hour after the last one is a laptop that
   * went to sleep, and the agents it cut off mid-turn are told to carry on.
   */
  beats(): void {
    this.waker.beats(this.wire.now())
  }

  /** What removing the agent in front of you would lose. */
  panel(): Frame['panel'] {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'confirm-remove') return {}
    const facts = this.wire.live?.factsOf(panel.task)
    return {
      changes: this.wire.live?.changes(panel.task) ?? [],
      ahead: facts?.ahead ?? null,
      branch: facts?.branch ?? null,
      base: this.wire.live?.baseOf(panel.task) ?? null,
    }
  }

  actions(): Actions {
    return {
      'new-agent': () => this.newAgent(''),
      'open-agent': async () => {
        // Queued work has no agent yet: starting it goes through the queue, so
        // what started it and why is written down.
        const pane = this.wire.state.panes.find((one) => one.task === this.wire.state.focused)
        if (pane?.queued) await this.deps.changeQueue(pane.task, 'start')
        else await this.openAgent()
      },
      'close-task:': (task) => this.closeAgent(task),
      'close-done': () => {
        // Nothing finished is nothing to clean up: said, rather than an empty
        // question nobody can answer.
        const done = doneTasks(this.wire.state)
        this.wire.put(
          done.length === 0
            ? notice(this.wire.state, 'no agent here has finished yet', this.wire.now())
            : {
                ...this.wire.state,
                // The ones carrying a document nobody has read, named before
                // the press: this button is how six analyses went in two
                // seconds, before documents outlived their tasks.
                panel: closeDonePanel(
                  done.map((pane) => pane.task),
                  done.flatMap((pane) => (this.unreadDocument(pane.task) ? [pane.task] : [])),
                ),
              },
        )
        this.wire.draw()
      },
      approve: () => this.decide(true),
      deny: () => this.decide(false),
      'next-waiting': () => {
        const next = nextWaiting(this.wire.state)
        if (next) this.wire.put(focusTask(this.wire.state, next))
        this.wire.draw()
      },
      ...this.toastActions(),
      '/new': (rest) => this.newAgent(rest),
      '/stop': (rest) => this.stopAgent(rest),
      '/open': (rest) => {
        const task = this.findTask(rest)
        if (!task) {
          notify(this.wire, rest ? `no agent like ${rest}` : 'which agent? /open name')
          this.deps.prefill('/open ')
          return
        }
        this.wire.put(focusTask(this.wire.state, task))
        this.wire.draw()
      },
    }
  }

  /**
   * A toast is answered from the toast: whichever button was pressed, it goes.
   * Show also puts the agent in front, and allow and deny answer it.
   */
  private toastActions(): Actions {
    const dismiss = (task: string) => {
      this.wire.put({
        ...this.wire.state,
        toasts: this.wire.state.toasts.filter((one) => one.task !== task),
      })
    }
    return {
      'toast-close:': (task) => {
        dismiss(task)
        this.wire.draw()
      },
      'toast-show:': (task) => {
        dismiss(task)
        this.wire.put(focusTask(this.wire.state, task))
        this.wire.draw()
      },
      'toast-allow:': async (task) => {
        dismiss(task)
        await this.decideFor(task, true)
        this.wire.draw()
      },
      'toast-deny:': async (task) => {
        dismiss(task)
        await this.decideFor(task, false)
        this.wire.draw()
      },
    }
  }

  menus(): Menus {
    return {
      task: {
        title: (subject) => {
          const pane = this.wire.state.panes.find((one) => one.task === subject.task)
          return pane ? shownName(pane) : subject.task
        },
        items: (subject) => {
          const pane = this.wire.state.panes.find((one) => one.task === subject.task)
          if (pane?.queued) return queueMenuItems(pane.queued)
          return pane
            ? menuItems(
                pane,
                this.wire.live?.changes(subject.task).length ?? 0,
                this.deps.routes().offersFor(subject.task) ?? undefined,
                this.deps.handsOver()?.handItems(subject.task),
              )
            : []
        },
        choose: (subject, item) => this.fromTaskMenu(subject.task, item),
      },
    }
  }

  submits(): Submits {
    return {
      'confirm-remove': (panel) => this.removeTask(panel),
      'close-done': (panel) => this.closeDone(panel),
    }
  }

  prompts(): Prompts {
    return {
      'rename-agent': async (panel, text) => {
        if (!panel.target) return
        const worktree = this.wire.live?.worktreeOf(panel.target)
        if (!worktree) throw new Error(`I do not know where ${panel.target} works`)
        const title = await this.wire.opts.client.renameAgent({
          task: panel.target,
          worktree,
          title: text,
        })
        await this.wire.live?.refresh()
        this.wire.put(
          acknowledge(
            { ...this.wire.state, panel: null },
            `${panel.target} is now called ${title}`,
            this.wire.now(),
          ),
        )
      },
    }
  }

  async fromTaskMenu(task: string, item: string): Promise<void> {
    const facts = this.wire.live?.factsOf(task)
    const worktree = this.wire.live?.worktreeOf(task)
    if (item.startsWith('queue-')) {
      await this.deps.changeQueue(task, item.slice('queue-'.length))
      return
    }
    if (item.startsWith('hand:')) {
      this.deps.handsOver()?.hand(task, item.slice('hand:'.length))
      return
    }
    switch (item) {
      case 'open': {
        this.wire.put(focusTask(this.wire.state, task))
        const pane = this.wire.state.panes.find((p) => p.task === task)
        // Queued work opens as what it is: a plan, not an agent. Start now starts it.
        if (pane && !pane.queued && !pane.lane) await this.openAgent()
        break
      }
      case 'start':
        this.wire.put(focusTask(this.wire.state, task))
        await this.openAgent()
        break
      case 'stop':
        await this.stopAgent(task)
        break
      case 'changes': {
        const first = this.wire.live?.changes(task)[0]
        if (first) await this.deps.openChange(task, first.path)
        return
      }
      case 'editor':
        if (worktree) await this.deps.openPlace({ path: worktree })
        return
      case 'rename': {
        const pane = this.wire.state.panes.find((p) => p.task === task)
        this.wire.put({
          ...this.wire.state,
          panel: {
            ...promptPanel('rename-agent', 'Rename agent', 'NAME', pane ? shownName(pane) : ''),
            target: task,
          },
        })
        break
      }
      case 'model':
        await this.deps.routes().openModels(task)
        return
      case 'account':
        await this.deps.routes().openAccount(task)
        return
      case 'copy-branch':
        if (facts) {
          const copied = await this.deps.copyToClipboard(facts.branch)
          if (copied) flash(this.wire, `copied ${facts.branch}`)
          else notify(this.wire, facts.branch)
        }
        break
      case 'mark-done':
        try {
          await this.wire.opts.client.markDone(task, { by: 'you' })
          // Said when it is so, not a look later.
          flash(this.wire, `${task} is finished`)
          this.wire.draw()
          await this.wire.live?.refresh()
        } catch (err) {
          notify(this.wire, why(err))
        }
        break
      case 'park': {
        if (!worktree) break
        const pane = this.wire.state.panes.find((p) => p.task === task)
        const parked = pane?.state !== 'parked'
        try {
          await this.wire.opts.client.parkTask(task, parked)
          flash(this.wire, parked ? `parked ${task}` : `picked ${task} up again`)
          this.wire.draw()
          await this.wire.live?.refresh()
        } catch (err) {
          notify(this.wire, why(err))
        }
        break
      }
      case 'remove':
        this.wire.put({ ...this.wire.state, panel: confirmRemovePanel(task) })
        break
      default:
        break
    }
    this.wire.draw()
  }
  /**
   * Close an agent: stop it and take it off the list. Asked first only when
   * that would lose something — work in a worktree of its own that is not
   * merged.
   *
   * A document nobody has read used to be the other reason: it lived only in
   * the task's folder, so closing the agent destroyed it, and twelve of
   * thirteen on one machine went that way. It is kept in the project's
   * documents folder now (`producesPath`), so it is said in the question
   * where there is one and never the reason to ask it.
   */
  async closeAgent(task: string): Promise<void> {
    const facts = this.wire.live?.factsOf(task)
    const unmerged =
      facts?.workspace === 'worktree' &&
      ((this.wire.live?.changes(task).length ?? 0) > 0 || (facts.ahead ?? 0) > 0)
    const panel = confirmRemovePanel(task, this.unreadDocument(task))
    if (unmerged) {
      this.wire.put({ ...this.wire.state, panel })
      this.wire.draw()
      return
    }
    await this.removeTask(panel)
    // Nothing to ask about, so nothing to leave open: a failure is said where you look.
    if (this.wire.state.panel?.kind === 'confirm-remove' && this.wire.state.panel.error) {
      const error = this.wire.state.panel.error
      this.wire.put(notice({ ...this.wire.state, panel: null }, error, this.wire.now()))
    }
    this.wire.draw()
  }

  async removeTask(panel: ConfirmRemovePanel): Promise<void> {
    const error = await this.removeOne(panel.task)
    if (error) {
      this.wire.put({ ...this.wire.state, panel: { ...panel, busy: false, error } })
      return
    }
    await this.wire.live?.refresh()
    this.wire.put(
      acknowledge({ ...this.wire.state, panel: null }, `removed ${panel.task}`, this.wire.now()),
    )
  }

  /**
   * Stop one agent and take its task off the list, its worktree and branch
   * with it. Says what stopped it from happening, or nothing when it did.
   */
  private async removeOne(task: string): Promise<string | null> {
    const facts = this.wire.live?.factsOf(task)
    const worktree = this.wire.live?.worktreeOf(task)
    const root = facts ? this.wire.opts.config.projects[facts.project]?.root : undefined
    if (!facts || !worktree || !root) return 'I cannot find where this agent works.'
    try {
      // Stopped on purpose, as `stopAgent` says. A look taken while git takes
      // the worktree away lists the task once more — failed, "worktree
      // missing", with no lane — which is what `reopenStopped` reopens, and
      // it did: in a folder that was gone (TADE-2).
      this.reopened.add(task)
      // Its agent first: a worktree cannot go out from under a process using it.
      await this.wire.opts.client.stopAgent(task).catch(() => {})
      const result = await this.wire.opts.client.removeTask({
        root: expandHome(root),
        worktree,
        branch: facts.branch,
        task,
        force: true,
      })
      return result.removed ? null : result.reason
    } catch (err) {
      return why(err)
    }
  }

  /**
   * The document this task produced that nobody has decided about, as a clause
   * to put in front of somebody closing its agent — or null where there is
   * none.
   *
   * Out of the journal the window already holds, so it costs no look at the
   * disk: the fold is pure and the question is asked at the moment of the
   * press, not kept.
   */
  private unreadDocument(task: string): string | null {
    const events = this.wire.live?.events
    if (!events) return null
    const waiting = waitingDocuments(documentsIn(events), Date.now()).filter(
      (one) => one.task === task && one.state === 'written',
    )
    if (waiting.length === 0) return null
    const names = waiting.map(
      (one) => `${one.path.split('/').at(-1) ?? one.path}${documentSize(one.bytes)}`,
    )
    return `${names.join(', ')} — nobody has read ${waiting.length === 1 ? 'it' : 'them'} yet`
  }

  /**
   * Close every agent that has finished, one after another: git cannot be
   * asked to remove two worktrees of the same repository at once. What could
   * not be closed stays on the list and is said — the rest still went.
   */
  async closeDone(panel: CloseDonePanel): Promise<void> {
    const failed: string[] = []
    for (const task of panel.tasks) {
      const error = await this.removeOne(task)
      if (error) failed.push(`${task.split('/').at(-1) ?? task}: ${error}`)
    }
    await this.wire.live?.refresh()
    const closed = panel.tasks.length - failed.length
    const said =
      failed.length === 0
        ? `closed ${closed} finished agent${closed === 1 ? '' : 's'}`
        : `closed ${closed} of ${panel.tasks.length} — ${failed.join('; ')}`
    this.wire.put(notice({ ...this.wire.state, panel: null }, said, this.wire.now()))
  }
  /**
   * A new agent in the project you are in: its own branch and worktree, pi in
   * it, and your eyes on it. Nothing is asked first. It is named for what you
   * said, or `agent-2` when you said nothing, and what you said — if anything —
   * is the first thing it hears. Name another project first to start one there.
   */
  async newAgent(said: string): Promise<void> {
    const projects = Object.keys(this.wire.opts.config.projects)
    if (projects.length === 0) {
      notify(this.wire, 'no projects yet — Open project adds one')
      this.wire.draw()
      return
    }
    const { project, intent } = whichProject(said, projects, this.wire.state.project)
    if (!project) {
      notify(this.wire, `which project? /new ${projects.join(' · ')}`)
      this.deps.prefill('/new ')
      return
    }
    // A second click before the first agent exists must not make a second one.
    if (this.starting) return
    this.starting = true
    flash(this.wire, `starting a new agent in ${project}…`)
    this.wire.draw()
    try {
      const id = await this.startTask(project, intent)
      this.wire.put(focusTask(acknowledge(this.wire.state, `${id} is ready`, this.wire.now()), id))
    } catch (err) {
      notify(this.wire, why(err))
    } finally {
      this.starting = false
    }
    this.wire.draw()
  }

  /**
   * A branch, a worktree and an agent in it. The name is the first free one:
   * a branch left behind by an agent you removed still holds its name. The pane
   * is refreshed before anything tries to focus it, because a pane you cannot
   * see yet cannot take focus.
   */
  private async startTask(project: string, intent: string): Promise<string> {
    // A name is never used twice: pi keeps a conversation by the task's name,
    // so a new agent given an old one's would carry on its conversation.
    const before = await this.wire.opts.client.events({ types: ['task_created'] }).catch(() => [])
    const taken = new Set([
      ...this.wire.state.panes.filter((pane) => pane.project === project).map((pane) => pane.name),
      ...before
        .map((event) => event.task ?? '')
        .filter((task) => task.startsWith(`${project}/`))
        .map((task) => task.slice(project.length + 1)),
    ])
    // Said without words, it is an agent to look around with: no branch until
    // it changes something, and then one named for what it did.
    const detached = intent === ''
    const stem = (intent ? slugify(intent) : '') || 'agent'
    for (let n = 1; n <= 100; n++) {
      const slug = intent && n === 1 ? stem : `${stem}-${n}`
      if (taken.has(slug)) continue
      let task: Awaited<ReturnType<Workbench['createTask']>>
      try {
        task = await this.wire.opts.client.createTask({
          project,
          slug,
          intent,
          detached,
          by: 'you',
        })
      } catch (err) {
        if (/already exists|used before/.test(why(err))) continue
        throw err
      }
      await this.wire.opts.client.startAgent({ task: task.id, cwd: task.worktree, prompt: intent })
      await this.wire.live?.refresh()
      return task.id
    }
    throw new Error(`every name like ${stem} is taken in ${project}`)
  }

  /**
   * An agent that started without a branch has changed something: give it one,
   * named for its work. Once — a failure is said, not retried every two seconds.
   */
  async nameAgent(task: {
    id: string
    project: string
    worktree: string
    title: string
  }): Promise<void> {
    const root = this.wire.opts.config.projects[task.project]?.root
    if (!root || this.naming.has(task.id)) return
    this.naming.add(task.id)
    try {
      const branch = await this.wire.opts.client.nameTask({
        task: task.id,
        root: expandHome(root),
        worktree: task.worktree,
        title: task.title,
      })
      await this.wire.live?.refresh()
      notify(this.wire, `${task.title} is working on ${branch}`)
    } catch (err) {
      notify(this.wire, why(err))
    }
    this.wire.draw()
  }

  /** Open the agent in front of you: the conversation picks up where it stopped. */
  /**
   * Agents that were working when Tade last closed — not stopped, not
   * removed, and not ended on their own — opened again where they left off, as
   * though the window had never gone. Once each per window, and without taking
   * you away from where you are.
   */
  reopenLost(): void {
    const lanes = this.wire.opts.client.lanes()
    // A chat was working too, and comes back for the same reason — but it has
    // no task file, no pane and no worktree, so the walk below steps straight
    // over it. Where it stood is on its own stored lane spec and nowhere else,
    // which is what `reopenChat` reads it off.
    for (const lane of lostChats(lanes)) {
      const task = chatTaskOf(lane.id)
      if (this.reopened.has(task) || this.opening.has(task)) continue
      this.reopened.add(task)
      void reopenChat(this.wire.opts.client, lane)
        .then(() => this.wire.live?.refresh())
        .then(() => this.wire.draw())
        .catch((err: unknown) => this.wire.note(err))
    }
    const lost = lanes.filter((lane) => lane.kind === 'agent' && !lane.alive && lane.lost === true)
    for (const lane of lost) {
      const pane = this.wire.state.panes.find((one) => one.task === lane.task)
      if (!pane || pane.lane || this.reopened.has(lane.task) || this.opening.has(lane.task))
        continue
      if (!this.wire.live?.worktreeOf(lane.task)) continue
      this.reopened.add(lane.task)
      void this.openAgent(lane.task, false)
    }
  }

  async openAgent(task: string | null = this.wire.state.focused, focus = true): Promise<void> {
    if (!task) return
    const worktree = this.wire.live?.worktreeOf(task)
    if (!worktree) {
      notify(this.wire, `I do not know where ${task} works`)
      this.wire.draw()
      return
    }
    // Two clicks before the first agent has registered must not start two.
    if (this.opening.has(task)) return
    this.opening.add(task)
    // Said before anything is waited on, and again once it is open, before the
    // look that lists its lane: starting a harness is the slow part.
    flash(this.wire, `opening ${task} where it left off…`)
    this.wire.draw()
    try {
      // Reattached, never restarted: its lane and its conversation come back
      // exactly where they were, and nothing is said to it. An agent told its
      // first instruction a second time would do the work again.
      await this.wire.opts.client.reopenAgent({ task: task as never, cwd: worktree })
      const told = acknowledge(this.wire.state, this.cameBack(task), this.wire.now())
      this.wire.put(focus ? focusTask(told, task) : told)
      this.wire.draw()
      await this.wire.live?.refresh()
    } catch (err) {
      // Not opening after all, and not left saying it is.
      this.wire.put({ ...this.wire.state, flash: null })
      notify(this.wire, why(err))
    } finally {
      this.opening.delete(task)
    }
    this.wire.draw()
  }

  /**
   * What bringing a task's agent back did, in words that are true of its
   * harness: where it left off, or — for a harness that cannot say it comes
   * back to a conversation — started again, in that harness's own words.
   */
  private cameBack(task: string): string {
    const client = this.wire.opts.client
    const harness = client.lane(`${task}/agent` as never)?.harness ?? 'pi'
    let offered: ReturnType<Workbench['resumeOf']>
    try {
      offered = client.resumeOf(harness)
    } catch (err) {
      return `opened ${task} again; whether ${harness} came back to its conversation it cannot say: ${why(err)}`
    }
    return offered.shown
      ? `opened ${task} where it left off`
      : `opened ${task} again — ${harness} ${offered.note}`
  }

  /**
   * The agent in front of you is not running — the window it ran in closed, or
   * it stopped — so open it again, where it left off, without being asked.
   * Once per agent per window: one that stops again straight away is left for
   * you to look at, with its button, rather than started in a loop.
   */
  reopenStopped(): void {
    const pane = this.wire.state.panes.find((one) => one.task === this.wire.state.focused)
    // Only an agent whose run stopped: one never started waits to be asked,
    // and one that finished is waiting for review, not for another run.
    if (!pane || pane.lane || pane.state !== 'failed') return
    if (this.reopened.has(pane.task) || this.opening.has(pane.task)) return
    if (!this.wire.live?.worktreeOf(pane.task)) return
    this.reopened.add(pane.task)
    void this.openAgent(pane.task)
  }

  /**
   * Stop one agent by its exact task, for a request from away: the same stop as
   * `/stop`, marked stopped on purpose so nothing opens it again behind anyone's
   * back, and said where you look so it never happens silently. Throws.
   */
  async stopExactly(task: string, by: string): Promise<void> {
    this.reopened.add(task)
    await this.wire.opts.client.stopAgent(task)
    await this.wire.live?.refresh()
    notify(this.wire, `${task} stopped by ${by} — its branch and worktree stay`)
    this.wire.draw()
  }

  /**
   * Open one stopped agent again where it left off, for a request from away:
   * `openAgent`'s reattach, saying nothing to it, and throwing rather than
   * putting a failure on the notice line nobody away can read.
   */
  async reopenExactly(task: string, by: string): Promise<'opened' | 'busy' | 'nowhere'> {
    const worktree = this.wire.live?.worktreeOf(task)
    if (!worktree) return 'nowhere'
    if (this.opening.has(task)) return 'busy'
    this.opening.add(task)
    try {
      await this.wire.opts.client.reopenAgent({ task: task as never, cwd: worktree })
      await this.wire.live?.refresh()
      notify(this.wire, `${by} opened ${task} where it left off`)
    } finally {
      this.opening.delete(task)
    }
    this.wire.draw()
    return 'opened'
  }

  /** Stop the agent you are watching, or the one you name. Its work stays. */
  async stopAgent(said: string): Promise<void> {
    const task = this.findTask(said) ?? this.wire.state.focused
    if (!task) {
      notify(this.wire, 'which agent? /stop name')
      this.deps.prefill('/stop ')
      return
    }
    try {
      // Stopped on purpose: not something to start again behind your back.
      this.reopened.add(task)
      await this.wire.opts.client.stopAgent(task)
      await this.wire.live?.refresh()
      flash(this.wire, `${task} stopped — its branch and worktree stay`)
    } catch (err) {
      notify(this.wire, why(err))
    }
    this.wire.draw()
  }

  /** The task somebody meant by a word or two of its name. */
  findTask(said: string): string | null {
    const want = said.trim().toLowerCase()
    if (want === '') return null
    const tasks = this.wire.state.panes.map((pane) => pane.task)
    return (
      tasks.find((task) => task.toLowerCase() === want) ??
      tasks.find((task) => task.toLowerCase().includes(want)) ??
      null
    )
  }
  /** Answer what the focused agent is waiting on. */
  async decide(allow: boolean): Promise<void> {
    const task = this.wire.state.focused
    if (!task) return
    await this.decideFor(task, allow)
  }

  /**
   * Answer what one agent is waiting on, wherever you are looking.
   *
   * The card goes the moment it is pressed (`answering`) and the workbench
   * hears after: a card that sat there for the round trip read as a press that
   * missed. Answered is the request on the card, never whichever is oldest by
   * then; and a second press — the card it hit already gone — says so.
   */
  async decideFor(task: string, allow: boolean): Promise<void> {
    const shown = this.wire.state.panes.find((one) => one.task === task)?.approval ?? null
    if (!shown && task in this.wire.state.answered) {
      flash(this.wire, `already answered — ${task} goes on`)
      this.wire.draw()
      return
    }
    this.wire.put(answering(this.wire.state, task))
    this.wire.draw()
    try {
      const waiting = await this.wire.opts.client.pendingApprovals(task)
      const pending = waiting.find((one) => !shown?.id || approvalId(one) === shown.id)
      if (!pending) {
        notify(
          this.wire,
          shown ? `${task}'s ${shown.tool} was already answered` : `${task} is not waiting on you`,
        )
      } else {
        await this.wire.opts.client.decideApproval(pending.run, pending.requestId, {
          allow,
          ...(allow ? {} : { reason: 'denied from the window' }),
        })
        flash(this.wire, `${allow ? 'approved' : 'denied'}: ${pending.summary}`)
      }
    } catch (err) {
      // Not answered after all: the card is the next look's to draw again.
      this.wire.put(unanswered(this.wire.state, task))
      notify(this.wire, err instanceof Error ? err.message : String(err))
      void this.wire.live?.refresh()
    }
    this.wire.draw()
  }
}
