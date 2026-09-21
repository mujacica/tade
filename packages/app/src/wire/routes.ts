import {
  type Config,
  HARNESS_CHOICES,
  loadConfig,
  orchestratorRoute,
  resolveRoute,
  THINKING_LEVELS,
} from '@tade/core'
import type { Frame } from '../frame.ts'
import { notice, ORCHESTRATOR_TAB, shownName, type TaskSnapshot } from '../model.ts'
import {
  type AgentOffers,
  accountMenuItems,
  agentOffers,
  harnessMenuItems,
  menuPanel,
  thinkingMenuItems,
} from '../panels/menu/state.ts'
import { type ModelChoice, type ModelPanel, modelPanel, priceSaid } from '../panels/models/state.ts'
import type { AccountShown, Choice } from '../panels/settings/state.ts'
import { writeSetting } from '../settings.ts'
import {
  type Actions,
  configPathOf,
  type Menus,
  type Subject,
  type Submits,
  type Wiring,
  why,
} from './context.ts'

// What an agent runs on, and who pays for it: its harness, the account of that
// harness it runs as, its model, and how hard it thinks.
//
// Four questions with one shape — each is asked of an agent or of the
// orchestrator, each is answered in a menu beside the thing it is about, and
// each writes what was chosen where new agents will read it. That is why they
// are one subject and not four, and why they are not the agent's: making,
// opening and stopping an agent is a different question from what it is
// running on, and the two only meet where an agent's own menu offers both.
//
// A model is always resolved by the harness it is for, never handed across:
// what a route asks for and what a harness answers can differ — a route says
// `anthropic/claude-opus-5` and Claude Code answers `claude-opus-5` — so both
// are said, side by side, rather than one being guessed from the other.
//
// What each harness offers is learned in the background rather than waited on:
// absent means "not known yet", which offers everything, as the window always
// did.

/** What this subject needs from the rest of the window. */
export interface RoutesDeps {
  /** How big the terminal is, for putting a menu where there is room for it. */
  size(): { columns: number; rows: number }
  /** The config was written by somebody else's hand: read it back. */
  useConfig(config: Config): void
  /** Which accounts each harness has, read again after one is chosen. */
  loadAccounts(): Promise<void>
  /** The orchestrator is on the same menus, and answers for its own thinking and model. */
  chooseThinkerThinking(level: string): Promise<void>
  thinkerModel(): string | null
  /** How a provider is paid for, as the machine subject read it. */
  credential(provider: string | null): string | null
  paidBy(provider: string): 'signed-in' | 'api-key' | 'env-key' | undefined
  /** The accounts each harness has, for the menu that chooses one. */
  accounts(): readonly AccountShown[]
}

export class Routes implements Subject {
  private readonly wire: Wiring
  private readonly deps: RoutesDeps
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

  constructor(wire: Wiring, deps: RoutesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * What the agent in front of you runs on, what its harness lets you ask of
   * it, and what it says it is actually on. Said as configured and as reported
   * side by side, because a route asking for `anthropic/claude-opus-5` and a
   * harness answering `claude-opus-5` are one agent, not two.
   */
  facts(): Partial<Frame> {
    const state = this.wire.state
    const focused = state.panes.find((pane) => pane.task === state.focused)
    const route = focused
      ? resolveRoute(this.wire.opts.config, { project: focused.project })
      : orchestratorRoute(this.wire.opts.config)
    const model = this.wire.live?.vitals(state.focused)?.model ?? route.model ?? null
    const provider = this.providerOf(model, route.provider ?? null)
    return {
      route: {
        harness: state.focused ? this.harnessShown(state.focused) : route.harness,
        model: route.model ?? null,
        thinking: route.thinking ?? null,
        provider,
        credential: this.deps.credential(provider),
      },
      vitals: this.wire.live?.vitals(state.focused) ?? null,
      offers: state.focused ? this.offersFor(state.focused) : null,
    }
  }

  /** Which model to start on, and — in Settings — which ones there are. */
  panel(): Frame['panel'] {
    const panel = this.wire.state.panel
    if (panel?.kind === 'settings') return { choices: this.choices() }
    if (panel?.kind !== 'model') return {}
    const pane = this.wire.state.panes.find((one) => one.task === panel.for)
    return {
      models: this.offeredModels(),
      modelTarget:
        panel.for === 'orchestrator' ? 'the orchestrator' : pane ? shownName(pane) : panel.for,
      currentModel:
        panel.for === 'orchestrator'
          ? this.deps.thinkerModel()
          : (this.wire.live?.vitals(panel.for)?.model ?? null),
    }
  }

  inputs() {
    return {
      choices: this.choices(),
      models: this.wire.state.panel?.kind === 'model' ? this.offeredModels() : this.models(),
    }
  }

  actions(): Actions {
    return {
      'model:': (target) => this.openModels(target),
      'thinking:': (task) => this.openThinking(task),
      'harness:': (task) => {
        this.wire.put({
          ...this.wire.state,
          panel: menuPanel({ kind: 'harness', task, current: this.harnessShown(task) }, 'Harness', {
            row: 3,
            col: Math.max(0, this.deps.size().columns - 40),
          }),
        })
        this.wire.draw()
      },
    }
  }

  menus(): Menus {
    return {
      harness: {
        title: () => 'Harness',
        items: (subject) => harnessMenuItems(HARNESS_CHOICES, subject.current),
        choose: (subject, item) => this.chooseHarness(subject.task, item),
      },
      account: {
        title: () => 'Account',
        items: (subject) =>
          accountMenuItems(this.deps.accounts(), this.harnessShown(subject.task), subject.current),
        choose: (subject, item) => this.chooseAccount(subject.task, item),
      },
      thinking: {
        title: () => 'Thinking',
        items: (subject) =>
          thinkingMenuItems(subject.current, this.offersFor(subject.task)?.levels),
        choose: (subject, item) => this.chooseThinking(subject.task, item),
      },
    }
  }

  submits(): Submits {
    return { model: (panel, choice) => this.chooseModel(panel, choice ?? '') }
  }

  /**
   * How hard an agent thinks, chosen from the control beside it. The
   * orchestrator is not an agent: what it thinks at is its own setting, and
   * its control sits in the strip at the foot of the window.
   */
  private openThinking(task: string): void {
    const project = task.split('/')[0]
    const orchestrator = task === ORCHESTRATOR_TAB
    const current = orchestrator
      ? (this.wire.opts.config.orchestrator.thinking ?? null)
      : (this.wire.live?.vitals(task)?.thinking ??
        resolveRoute(this.wire.opts.config, project ? { project } : {}).thinking ??
        null)
    const menu = menuPanel({ kind: 'thinking', task, current }, 'Thinking', {
      // Below the control it belongs to: the pane's header, or the strip at
      // the foot of the window, where it is clamped back into view.
      row: orchestrator ? Math.max(0, this.deps.size().rows - 2) : 3,
      col: Math.max(0, this.deps.size().columns - 30),
    })
    // The keyboard starts on the level it is at.
    const index = Math.max(0, THINKING_LEVELS.indexOf((current ?? '') as never))
    this.wire.put({ ...this.wire.state, panel: { ...menu, index } })
    this.wire.draw()
  }

  /** Which account an agent runs as, asked of its harness first so the menu marks the one it is on. */
  async openAccount(task: string): Promise<void> {
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
  }

  /** Models an agent can start on, as choices grouped by provider. */
  private choices(): Choice[] {
    return this.models().map((model) => {
      const price = priceSaid(model)
      return {
        value: model.id,
        label: model.id.split('/').slice(1).join('/') || model.id,
        group: model.provider,
        ...(price ? { note: price } : {}),
      }
    })
  }

  /**
   * Which provider a model is reached through: the one configured, or the one
   * the model's own id names, or — for a bare name like `claude-opus-5` — the
   * provider you have credentials for that offers it. The last is a reading of
   * the catalog, which is what the harness itself does with a bare name.
   */
  private providerOf(model: string | null, configured: string | null): string | null {
    if (configured) return configured
    if (!model) return null
    const exact = this.models().find((known) => known.id === model)
    if (exact) return exact.provider
    const named = model.includes('/') ? (model.split('/')[0] ?? null) : null
    if (named && this.deps.paidBy(named)) return named
    const offering = this.models().filter((known) => known.id.endsWith(`/${model}`))
    return (
      offering.find((known) => this.deps.paidBy(known.provider))?.provider ??
      offering[0]?.provider ??
      named
    )
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
