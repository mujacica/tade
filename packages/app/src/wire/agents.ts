import { type Config, expandHome, loadConfig, resolveRoute } from '@tade/core'
import { slugify } from '@tade/voice-core'
import type { Workbench } from '@tade/workbench'
import {
  focusTask,
  notice,
  ORCHESTRATOR_TAB,
  shownName,
  type TaskSnapshot,
  whichProject,
} from '../model.ts'
import { type AgentOffers, agentOffers, menuPanel } from '../panels/menu/state.ts'
import { type ModelChoice, type ModelPanel, modelPanel } from '../panels/models/state.ts'
import {
  type CloseDonePanel,
  type ConfirmRemovePanel,
  confirmRemovePanel,
  promptPanel,
} from '../panels/small/state.ts'
import { writeSetting } from '../settings.ts'
import { configPathOf, type Wiring, why } from './context.ts'

// The agents: making one, opening one again, stopping it, taking it away —
// and the four things you can change about one that is already running.
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
// opened now, and what this window has already opened by itself — are here
// for that reason, and so is the promise that an agent stopped on purpose is
// never started again behind your back.
//
// What a harness lets you ask of one agent is learned in the background
// (`offersByTask`) rather than waited on: absent means "not known yet", which
// offers everything, as the window always did.

/** What this subject needs from the rest of the window. */
export interface AgentsDeps {
  /** How big the terminal is, for putting a menu where there is room for it. */
  size(): { columns: number; rows: number }
  /** The config was written by somebody else's hand: read it back. */
  useConfig(config: Config): void
  /** Which accounts each harness has, read again after one is chosen. */
  loadAccounts(): Promise<void>
  /** Put a half-written command back on the line, ready to be finished. */
  prefill(line: string): void
  /** Where an agent's own menu leads. */
  openDiff(task: string, path: string): Promise<void>
  openPlace(target: { path: string }): Promise<void>
  /** Queued work is changed through the queue, so what did it and why is written down. */
  changeQueue(task: string, change: string): Promise<void>
  /** The orchestrator is on the same menu, and answers for its own thinking and model. */
  chooseThinkerThinking(level: string): Promise<void>
  thinkerModel(): string | null
  /** Put text on the clipboard: true when it got there. */
  copyToClipboard(text: string): Promise<boolean>
}

export class Agents {
  private readonly wire: Wiring
  private readonly deps: AgentsDeps
  /** A new agent is being made. */
  private starting = false
  /** Tasks whose agent is being opened right now. */
  private readonly opening = new Set<string>()
  /** Projects this window has already opened an agent in on its own. */
  private readonly opened = new Set<string>()
  /** Agents this window has opened again on its own, so it never does it twice. */
  private readonly reopened = new Set<string>()
  /** Agents whose branch is being named, so a slow git is not asked twice. */
  private readonly naming = new Set<string>()
  /**
   * What each agent's harness lets a person ask of it, by task: learned as the
   * tasks refresh, so drawing never waits on it. Absent is "not known yet",
   * which offers everything, as the window always did.
   */
  private readonly offersByTask = new Map<string, AgentOffers>()
  /** The models an agent can be started on, once they have been read. */
  private modelChoices: ModelChoice[] = []
  /**
   * The models the open picker offers, when it is for one agent: its
   * harness's, which are not the orchestrator's or another harness's.
   */
  private pickerModels: ModelChoice[] | null = null

  constructor(wire: Wiring, deps: AgentsDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** Every model new agents may start on, as last read. */
  models(): readonly ModelChoice[] {
    return this.modelChoices
  }

  /** What the open picker offers: one agent's harness's models, or all of them. */
  offeredModels(): readonly ModelChoice[] {
    return this.pickerModels ?? this.modelChoices
  }

  /** What this agent's harness lets a person ask of it, or nothing when it is not known yet. */
  offersFor(task: string): AgentOffers | null {
    return this.offersByTask.get(task) ?? null
  }

  /** Read the models again, after something that could have changed them. */
  async refreshModels(): Promise<void> {
    this.modelChoices = (await this.wire.opts.models?.().catch(() => [])) ?? this.modelChoices
  }

  /** How hard an agent thinks from its next turn, and new agents from their first. */
  async chooseThinking(task: string, level: string): Promise<void> {
    if (task === ORCHESTRATOR_TAB) return this.deps.chooseThinkerThinking(level)
    try {
      const chosen = await this.wire.opts.client.setAgentThinking(task, level)
      const loaded = await loadConfig(configPathOf(this.wire.opts))
      if (loaded.ok) this.deps.useConfig(loaded.config)
      this.wire.put(
        notice(
          this.wire.state,
          `${task} thinks at ${chosen} from its next turn, and new agents start there`,
        ),
      )
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
    }
    this.wire.draw()
  }
  /** The harness a task's agent is shown as running in: its own, else its route's. */
  harnessShown(task: string): string {
    return (
      this.offersByTask.get(task)?.harness ??
      resolveRoute(this.wire.opts.config, { project: task.split('/')[0] ?? '' }).harness
    )
  }

  /**
   * Learn what each task's harness offers, in the background: which harness
   * it is in and what it can be asked. Redrawn only when something changed.
   */
  async learnHarnesses(tasks: readonly TaskSnapshot[]): Promise<void> {
    let changed = false
    for (const task of tasks) {
      if (await this.learnHarness(task.task)) changed = true
    }
    if (changed) this.wire.draw()
  }

  private async learnHarness(task: string): Promise<boolean> {
    const worktree = this.wire.live?.worktreeOf(task)
    if (!worktree) return false
    const known = await this.wire.opts.client.agentHarness(task, worktree).catch(() => null)
    if (!known) return false
    const was = this.offersByTask.get(task)
    const now = agentOffers(known.harness, known.capabilities)
    if (was && JSON.stringify(was) === JSON.stringify(now)) return false
    this.offersByTask.set(task, now)
    return true
  }

  /**
   * Run an agent as another account of its harness, its conversation carried
   * along, starting it again there if it is running.
   */
  async chooseAccount(task: string, account: string): Promise<void> {
    const worktree = this.wire.live?.worktreeOf(task)
    if (!worktree) {
      this.wire.put(notice(this.wire.state, `I cannot find where ${task} works`))
      this.wire.draw()
      return
    }
    try {
      const done = await this.wire.opts.client.setAgentAccount({
        task,
        worktree,
        account: account || null,
      })
      const as = done.account ?? 'its own sign-in'
      this.wire.put(
        notice(
          this.wire.state,
          `${task} runs as ${as}${done.carried ? ', its conversation with it' : ''}${done.restarted ? ', started again there' : ' from its next start'}`,
        ),
      )
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
    }
    await this.deps.loadAccounts()
    this.wire.draw()
  }

  /** Run an agent in another harness, starting it again there if it is running. */
  async chooseHarness(task: string, harness: string): Promise<void> {
    const worktree = this.wire.live?.worktreeOf(task)
    if (!worktree) {
      this.wire.put(notice(this.wire.state, `I cannot find where ${task} works`))
      this.wire.draw()
      return
    }
    try {
      const done = await this.wire.opts.client.setAgentHarness({ task, worktree, harness })
      await this.learnHarness(task)
      this.wire.put(
        notice(
          this.wire.state,
          `${task} runs in ${done.harness}${done.restarted ? ', started again there' : ' from its next start'}`,
        ),
      )
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
    }
    await this.wire.live?.refresh()
    this.wire.draw()
  }
  async fromTaskMenu(task: string, item: string): Promise<void> {
    const facts = this.wire.live?.factsOf(task)
    const worktree = this.wire.live?.worktreeOf(task)
    if (item.startsWith('queue-')) {
      await this.deps.changeQueue(task, item.slice('queue-'.length))
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
        if (first) await this.deps.openDiff(task, first.path)
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
        await this.openModels(task)
        return
      case 'account': {
        const known = await this.wire.opts.client
          .agentHarness(task, this.wire.live?.worktreeOf(task) ?? '')
          .catch(() => null)
        await this.deps.loadAccounts()
        this.wire.put({
          ...this.wire.state,
          panel: menuPanel({ kind: 'account', task, current: known?.account ?? '' }, 'Account', {
            row: 3,
            col: Math.max(0, this.deps.size().columns - 40),
          }),
        })
        this.wire.draw()
        return
      }
      case 'copy-branch':
        if (facts) {
          const copied = await this.deps.copyToClipboard(facts.branch)
          this.wire.put(notice(this.wire.state, copied ? `copied ${facts.branch}` : facts.branch))
        }
        break
      case 'mark-done':
        try {
          await this.wire.opts.client.markDone(task, { by: 'you' })
          await this.wire.live?.refresh()
          this.wire.put(notice(this.wire.state, `${task} is finished`))
        } catch (err) {
          this.wire.put(notice(this.wire.state, why(err)))
        }
        break
      case 'park': {
        if (!worktree) break
        const pane = this.wire.state.panes.find((p) => p.task === task)
        const parked = pane?.state !== 'parked'
        try {
          await this.wire.opts.client.parkTask(worktree, parked, task)
          await this.wire.live?.refresh()
          this.wire.put(
            notice(this.wire.state, parked ? `parked ${task}` : `picked ${task} up again`),
          )
        } catch (err) {
          this.wire.put(notice(this.wire.state, why(err)))
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
   * merged. An agent in the project's checkout loses nothing by going: its work
   * is in the checkout, and only its task folder goes with it.
   */
  async closeAgent(task: string): Promise<void> {
    const facts = this.wire.live?.factsOf(task)
    const unmerged =
      facts?.workspace === 'worktree' &&
      ((this.wire.live?.changes(task).length ?? 0) > 0 || (facts.ahead ?? 0) > 0)
    const panel = confirmRemovePanel(task)
    if (unmerged) {
      this.wire.put({ ...this.wire.state, panel })
      this.wire.draw()
      return
    }
    await this.removeTask(panel)
    // Nothing to ask about, so nothing to leave open: a failure is said where you look.
    if (this.wire.state.panel?.kind === 'confirm-remove' && this.wire.state.panel.error) {
      const error = this.wire.state.panel.error
      this.wire.put(notice({ ...this.wire.state, panel: null }, error))
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
    this.wire.put(notice({ ...this.wire.state, panel: null }, `removed ${panel.task}`))
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
    this.wire.put(notice({ ...this.wire.state, panel: null }, said))
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
      this.wire.put(notice(this.wire.state, 'no projects yet — Open project adds one'))
      this.wire.draw()
      return
    }
    const { project, intent } = whichProject(said, projects, this.wire.state.project)
    if (!project) {
      this.wire.put(notice(this.wire.state, `which project? /new ${projects.join(' · ')}`))
      this.deps.prefill('/new ')
      return
    }
    // A second click before the first agent exists must not make a second one.
    if (this.starting) return
    this.starting = true
    this.wire.put(notice(this.wire.state, `starting a new agent in ${project}…`))
    this.wire.draw()
    try {
      const id = await this.startTask(project, intent)
      this.wire.put(focusTask(notice(this.wire.state, `${id} is ready`), id))
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
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
   * An agent in a project you have just added, so there is somewhere to type.
   * Only then: a project whose agents you removed stays without one — opening
   * the window again must never bring back what you took away.
   */
  ensureAgent(project: string | null): void {
    if (!project || !this.wire.live || this.opened.has(project)) return
    if (!this.wire.opts.config.projects[project]) return
    this.opened.add(project)
    if (this.wire.state.panes.some((pane) => pane.project === project)) return
    void this.newAgent('')
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
      this.wire.put(notice(this.wire.state, `${task.title} is working on ${branch}`))
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
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
    const lost = this.wire.opts.client
      .lanes()
      .filter((lane) => lane.kind === 'agent' && !lane.alive && lane.lost === true)
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
      this.wire.put(notice(this.wire.state, `I do not know where ${task} works`))
      this.wire.draw()
      return
    }
    // Two clicks before the first agent has registered must not start two.
    if (this.opening.has(task)) return
    this.opening.add(task)
    try {
      // Reattached, never restarted: its lane and its conversation come back
      // exactly where they were, and nothing is said to it. An agent told its
      // first instruction a second time would do the work again.
      await this.wire.opts.client.reopenAgent({ task: task as never, cwd: worktree })
      await this.wire.live?.refresh()
      const told = notice(this.wire.state, `opened ${task} where it left off`)
      this.wire.put(focus ? focusTask(told, task) : told)
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
    } finally {
      this.opening.delete(task)
    }
    this.wire.draw()
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

  /** Stop the agent you are watching, or the one you name. Its work stays. */
  async stopAgent(said: string): Promise<void> {
    const task = this.findTask(said) ?? this.wire.state.focused
    if (!task) {
      this.wire.put(notice(this.wire.state, 'which agent? /stop name'))
      this.deps.prefill('/stop ')
      return
    }
    try {
      // Stopped on purpose: not something to start again behind your back.
      this.reopened.add(task)
      await this.wire.opts.client.stopAgent(task)
      await this.wire.live?.refresh()
      this.wire.put(notice(this.wire.state, `${task} stopped — its branch and worktree stay`))
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
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

  /** Answer what one agent is waiting on, wherever you are looking. */
  async decideFor(task: string, allow: boolean): Promise<void> {
    try {
      const [pending] = await this.wire.opts.client.pendingApprovals(task)
      if (!pending) return
      await this.wire.opts.client.decideApproval(pending.run, pending.requestId, {
        allow,
        ...(allow ? {} : { reason: 'denied from the window' }),
      })
      this.wire.put(notice(this.wire.state, `${allow ? 'approved' : 'denied'}: ${pending.summary}`))
    } catch (err) {
      this.wire.put(notice(this.wire.state, err instanceof Error ? err.message : String(err)))
    }
    this.wire.draw()
  }
  /** Choose a model for the orchestrator, or for one agent's session. */
  async openModels(target: string): Promise<void> {
    if (this.modelChoices.length === 0) {
      this.modelChoices = (await this.wire.opts.models?.().catch(() => [])) ?? []
    }
    const worktree = target === 'orchestrator' ? null : this.wire.live?.worktreeOf(target)
    this.pickerModels =
      target === 'orchestrator'
        ? ((await this.wire.opts.orchestratorModels?.().catch(() => null)) ?? null)
        : worktree
          ? await this.wire.opts.client.agentModels(target, worktree).catch(() => null)
          : null
    const offered = this.pickerModels ?? this.modelChoices
    // Starting on the one in use, so enter is a no-op and ↑↓ is "the one next to it".
    const current =
      target === 'orchestrator'
        ? this.deps.thinkerModel()
        : (this.wire.live?.vitals(target)?.model ?? null)
    const index = current
      ? Math.max(
          0,
          offered.findIndex((one) => one.id === current || one.id.endsWith(`/${current}`)),
        )
      : 0
    this.wire.put({ ...this.wire.state, panel: { ...modelPanel(target), index } })
    this.wire.draw()
  }

  /**
   * Switch to a model. An agent switches its own session there and then. The
   * orchestrator's is written to the config — so it stays — and it is started
   * again on it, carrying on the same conversation.
   */
  async chooseModel(panel: ModelPanel, id: string): Promise<void> {
    try {
      if (panel.for === 'orchestrator') {
        const [provider, ...rest] = id.split('/')
        writeSetting(configPathOf(this.wire.opts), 'orchestrator.provider', provider)
        writeSetting(configPathOf(this.wire.opts), 'orchestrator.model', rest.join('/'))
        const loaded = await loadConfig(configPathOf(this.wire.opts))
        if (loaded.ok) this.deps.useConfig(loaded.config)
        this.wire.put({ ...this.wire.state, panel: null })
        this.wire.put(notice(this.wire.state, `the orchestrator is moving to ${rest.join('/')}`))
        this.wire.draw()
        await this.wire.opts.restartThinker?.()
      } else {
        const chosen = await this.wire.opts.client.setAgentModel(panel.for, id)
        // It is new agents' model now too: read back what the workbench wrote.
        const loaded = await loadConfig(configPathOf(this.wire.opts))
        if (loaded.ok) this.wire.opts.config = loaded.config
        this.wire.put(
          notice(
            { ...this.wire.state, panel: null },
            `${panel.for} is switching to ${chosen.id}, and new agents start on it`,
          ),
        )
      }
    } catch (err) {
      this.wire.put({ ...this.wire.state, panel: { ...panel, busy: false, error: why(err) } })
    }
    this.wire.draw()
  }
}
