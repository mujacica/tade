import {
  type Config,
  HARNESS_CHOICES,
  loadConfig,
  modelChosen,
  orchestratorRoute,
  resolveRoute,
  THINKING_LEVELS,
} from '@tade/core'
import type { HarnessModels } from '@tade/harnesses-core'
import { taskFilePath } from '@tade/workbench'
import { markOf } from '../checkout-look.ts'
import type { Frame } from '../frame.ts'
import { notice, ORCHESTRATOR_TAB, shownName, type TaskSnapshot } from '../model.ts'
import {
  type AgentOffers,
  accountMenuItems,
  agentOffers,
  harnessMenuItems,
  type MenuPanel,
  menuPanel,
  thinkingMenuItems,
} from '../panels/menu/state.ts'
import {
  type ModelChoice,
  type ModelPanel,
  modelChoices,
  modelPanel,
  priceSaid,
} from '../panels/models/state.ts'
import type { AccountShown } from '../panels/settings/accounts.ts'
import type { Choice } from '../panels/settings/state.ts'
import { writeRecorded } from './config-written.ts'
import {
  type Actions,
  configPathOf,
  type Menus,
  notify,
  type Pressed,
  type Subject,
  type Submits,
  type Wiring,
  why,
} from './context.ts'

// What an agent runs on, and who pays for it: its harness, the account of that
// harness it runs as, its model, and how hard it thinks.
//
// Four questions with one shape — each is asked of an agent or of the
// orchestrator, and each is answered in a menu beside the thing it is about.
// An agent's answer is that agent's alone: what new agents start on is the
// project's default, a setting on its own row (Settings › Models), and
// choosing for one agent never writes it. That is why they
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
//
// Models are the exception, and deliberately: a picker is only ever a list of
// what one harness runs, asked of that harness. There is no everybody's list
// to fall back to — a model of another harness is no model at all here — so a
// harness that cannot say comes back with its own sentence and the picker
// says that instead.

/**
 * Where a dropdown opens: at the control that was pressed, which the drawing
 * hangs it under or over. Asked for with no control — typed rather than
 * clicked — it takes the middle, as a menu nobody pointed at does, rather than
 * a corner of the window that belongs to no control at all.
 */
function atControl(from: Pressed | undefined): MenuPanel['anchor'] {
  return from ? { row: from.row, col: from.col, control: true } : null
}

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

/**
 * Said after an agent's own switch, because "and new agents?" is the next
 * question: they keep the default, and where that is changed.
 */
const ALONE = '; new agents keep the default, in Settings › Models'

export class Routes implements Subject {
  private readonly wire: Wiring
  private readonly deps: RoutesDeps
  /**
   * What each agent's harness lets a person ask of it, by task: learned as the
   * tasks refresh, so drawing never waits on it. Absent is "not known yet",
   * which offers everything, as the window always did.
   */
  private readonly offersByTask = new Map<string, AgentOffers>()
  /** What each task's offers were learned from: see `learnHarness`. */
  private readonly learnedFrom = new Map<string, { from: string; config: Config }>()
  /**
   * What each harness offers to run, by harness id, as it last answered.
   * Asked of the harness itself and kept apart harness by harness: there is
   * no list of everybody's models, because there is no harness that could run
   * one.
   */
  private readonly offered = new Map<string, HarnessModels>()
  /**
   * What the open picker offers: the models of the one harness it is choosing
   * for, asked when it was opened — with that harness's own words where it
   * had none to offer, and `asking` until it has answered (`openModels`).
   */
  private picker: (HarnessModels & { asking?: boolean }) | null = null
  /** The harnesses a Settings list is asking right now (`learnListed`), so it asks each once. */
  private readonly listing = new Set<string>()

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
      mcp: this.toolServers(),
    }
  }

  /**
   * Tade's own tools, lent into the agents as an MCP server each: how many
   * agents should have one, and how many the last look at the machine found.
   *
   * The two halves come from different places because only one of them can be
   * looked up. What *should* have one is the window's own knowledge — it
   * launched these runs, and whether a harness takes its tools this way is that
   * harness's declared answer (`capabilities.mcp`), never a guess from its
   * name. What *has* one is a look at the machine, because the server is the
   * harness's child: Tade did not start it and is never told when it goes.
   *
   * Counted here and never kept, every frame, out of two things already held.
   */
  private toolServers(): Frame['mcp'] {
    const client = this.wire.opts.client
    const expected = client
      .runs()
      .filter((run) => client.capabilitiesOf(run.harness ?? '')?.mcp === true).length
    const servers = this.wire.live?.servers
    return { expected, alive: servers?.alive ?? 0, looked: servers?.looked ?? false }
  }

  /** Which model to start on, and — in Settings — which ones there are. */
  panel(): Frame['panel'] {
    const panel = this.wire.state.panel
    if (panel?.kind === 'settings') {
      this.learnListed(panel.dropdown?.path ?? '')
      return { choices: this.choices() }
    }
    if (panel?.kind !== 'model') return {}
    const pane = this.wire.state.panes.find((one) => one.task === panel.for)
    return {
      models: this.offeredModels(),
      // Whose models these are, and its own sentence where there are none.
      modelsFrom: this.picker,
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
      'thinking:': (task, from) => this.openThinking(task, from),
      'harness:': (task, from) => {
        this.wire.put({
          ...this.wire.state,
          panel: menuPanel(
            { kind: 'harness', task, current: this.harnessShown(task) },
            'Harness',
            atControl(from),
          ),
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
        items: (subject) => thinkingMenuItems(subject.current, this.levelsFor(subject.task)),
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
  private openThinking(task: string, from?: Pressed): void {
    const project = task.split('/')[0]
    const orchestrator = task === ORCHESTRATOR_TAB
    const current = orchestrator
      ? (this.wire.opts.config.orchestrator.thinking ?? null)
      : (this.wire.live?.vitals(task)?.thinking ??
        resolveRoute(this.wire.opts.config, project ? { project } : {}).thinking ??
        null)
    // At the control it belongs to: under it in the pane's header, over it in
    // the strip at the foot of the window.
    const menu = menuPanel({ kind: 'thinking', task, current }, 'Thinking', atControl(from))
    // The keyboard starts on the level it is at, among the levels offered.
    const index = Math.max(0, (this.levelsFor(task) ?? THINKING_LEVELS).indexOf(current ?? ''))
    this.wire.put({ ...this.wire.state, panel: { ...menu, index } })
    this.wire.draw()
  }

  /**
   * How hard this one can be told to think, as its own harness declares it.
   * The orchestrator answers for itself — it is a harness choice like any
   * other, and not every harness has every level. Nothing known yet offers
   * them all, as the window always did.
   */
  private levelsFor(task: string): readonly string[] | undefined {
    return task === ORCHESTRATOR_TAB
      ? this.wire.opts.thinker?.offers?.levels
      : this.offersFor(task)?.levels
  }

  /** Which account an agent runs as, asked of its harness first so the menu marks the one it is on. */
  async openAccount(task: string): Promise<void> {
    const known = await this.wire.opts.client.agentHarness(task).catch(() => null)
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

  /**
   * Models a setting can be set to, as choices grouped by provider, each
   * marked with the harness that runs it — so a list for one harness's model
   * setting never shows another harness's.
   */
  private choices(): Choice[] {
    return [...this.offered.values()].flatMap((offered) =>
      offered.models.map((model) => {
        const price = priceSaid(model)
        return {
          value: model.id,
          label: model.id.split('/').slice(1).join('/') || model.id,
          group: model.provider,
          harness: offered.harness,
          ...(price ? { note: price } : {}),
        }
      }),
    )
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

  /**
   * Every model any harness that has been asked offers. For reading a
   * provider off a name and for search — never for offering a choice, which
   * is always one harness's.
   */
  models(): readonly ModelChoice[] {
    return [...this.offered.values()].flatMap((offered) => [...offered.models])
  }

  /** What the open picker offers: the models of the harness it is for, and nothing else. */
  offeredModels(): readonly ModelChoice[] {
    return this.picker?.models ?? []
  }

  /** What this agent's harness lets a person ask of it, or nothing when it is not known yet. */
  offersFor(task: string): AgentOffers | null {
    return this.offersByTask.get(task) ?? null
  }

  /**
   * Ask again what the harnesses in play run: the one new agents start in and
   * the one the orchestrator talks through, which are the two Settings offers
   * a model for. Only those — asking a harness costs what asking it costs
   * (Codex runs a program to answer), and a catalog nobody is choosing from
   * is one nobody needed.
   */
  async refreshModels(): Promise<void> {
    const config = this.wire.opts.config
    const harnesses = new Set([resolveRoute(config).harness, config.orchestrator.harness])
    // Side by side: asking one harness is a program run (Codex), and two of
    // them one after the other is that wait twice over.
    await Promise.all([...harnesses].map((harness) => this.learnModels(harness)))
  }

  /**
   * A model row's list opened for a harness nobody has asked yet — a default
   * under a route's `harnesses`, or a route of another harness — asks it then,
   * once, and draws what it says. `refreshModels` asks only the two harnesses
   * in play, because asking one costs a program run (Codex), and a catalog
   * nobody opens is one nobody needed. Never waited on: it is drawn.
   */
  private learnListed(path: string): void {
    const row = /^workers\.routes\.([a-z0-9-]+)\.(?:harnesses\.([a-z0-9-]+)\.)?model$/.exec(path)
    if (!row?.[1]) return
    const harness = row[2] ?? this.wire.opts.config.workers.routes[row[1]]?.harness ?? 'pi'
    if (this.offered.has(harness) || this.listing.has(harness)) return
    this.listing.add(harness)
    void this.learnModels(harness).then(() => {
      this.listing.delete(harness)
      this.wire.draw()
    })
  }

  /**
   * What one harness runs, asked of it and written down. What comes back is
   * kept under the harness that answered, so the next question about that
   * harness is answered without asking again — and a harness that could not
   * be asked keeps whatever it last said rather than emptying.
   */
  private async learnModels(harness: string): Promise<HarnessModels> {
    const ask = this.wire.opts.models ?? ((id: string) => this.wire.opts.client.harnessModels(id))
    const asked = await ask(harness).catch(() => null)
    const offered = asked ??
      this.offered.get(harness) ?? {
        harness,
        models: [],
        why: 'could not be asked which models it runs',
      }
    this.offered.set(offered.harness, offered)
    return offered
  }

  /** How hard an agent thinks from its next turn: that agent's, and nobody else's. */
  async chooseThinking(task: string, level: string): Promise<void> {
    if (task === ORCHESTRATOR_TAB) return this.deps.chooseThinkerThinking(level)
    try {
      const chosen = await this.wire.opts.client.setAgentThinking(task, level)
      notify(this.wire, `${task} thinks at ${chosen.level} from its next turn${ALONE}`)
    } catch (err) {
      notify(this.wire, why(err))
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

  /**
   * A task's harness is its task file's word, else its project's route in the
   * config, so it is asked again only when one of those has moved: the file's
   * marks, or a config that is not the one it was learned under — every config
   * written is a new one. It was two YAML files read and parsed for every task
   * on every two-second beat, to learn what was already known. The marks are
   * read before the ask, so an edit that lands during it is asked about again.
   */
  private async learnHarness(task: string): Promise<boolean> {
    const worktree = this.wire.live?.worktreeOf(task)
    if (!worktree) return false
    const config = this.wire.opts.config
    const from = `${worktree}\0${await markOf(taskFilePath(this.wire.opts.home, task))}`
    const learned = this.learnedFrom.get(task)
    if (learned?.from === from && learned.config === config) return false
    const known = await this.wire.opts.client.agentHarness(task).catch(() => null)
    if (!known) return false
    this.learnedFrom.set(task, { from, config })
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
      notify(this.wire, `I cannot find where ${task} works`)
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
      notify(
        this.wire,
        `${task} runs as ${as}${done.carried ? ', its conversation with it' : ''}${done.restarted ? ', started again there' : ' from its next start'}`,
      )
    } catch (err) {
      notify(this.wire, why(err))
    }
    await this.deps.loadAccounts()
    this.wire.draw()
  }

  /** Run an agent in another harness, starting it again there if it is running. */
  async chooseHarness(task: string, harness: string): Promise<void> {
    const worktree = this.wire.live?.worktreeOf(task)
    if (!worktree) {
      notify(this.wire, `I cannot find where ${task} works`)
      this.wire.draw()
      return
    }
    try {
      const done = await this.wire.opts.client.setAgentHarness({ task, worktree, harness })
      await this.learnHarness(task)
      notify(
        this.wire,
        `${task} runs in ${done.harness}${done.restarted ? ', started again there' : ' from its next start'}`,
      )
    } catch (err) {
      notify(this.wire, why(err))
    }
    await this.wire.live?.refresh()
    this.wire.draw()
  }

  /**
   * What a picker may offer: the models of the one harness it is choosing for,
   * asked of that harness — the orchestrator's own, or the agent's, on the
   * account it runs as.
   *
   * There is no everybody's list behind this and there must not be: a model
   * of another harness is no model at all here, and offering one is offering
   * a choice that fails at the next launch. Where the harness itself cannot
   * be reached, its own words come back instead, from the harness the agent
   * is in either way.
   */
  private async modelsFor(target: string): Promise<HarnessModels> {
    if (target === 'orchestrator') {
      const asked = await this.wire.opts.orchestratorModels?.().catch(() => null)
      if (asked) this.offered.set(asked.harness, asked)
      return asked ?? (await this.learnModels(this.wire.opts.config.orchestrator.harness))
    }
    const worktree = this.wire.live?.worktreeOf(target)
    const asked = worktree
      ? await this.wire.opts.client.agentModels(target).catch(() => null)
      : null
    if (asked) this.offered.set(asked.harness, asked)
    // Nowhere to ask about this agent in particular: its harness is known all
    // the same, and what that harness runs is the same answer.
    return asked ?? (await this.learnModels(this.harnessShown(target)))
  }

  /**
   * Choose a model for the orchestrator, or for one agent's session.
   *
   * Opened at once, on what its harness said the last time it was asked, and
   * saying that it is being asked again: asking is a program run for Codex, and
   * a picker that appears a second after the click is a click that seemed to
   * miss. The answer replaces the list, the keyboard staying on its model.
   */
  async openModels(target: string): Promise<void> {
    const harness =
      target === 'orchestrator'
        ? this.wire.opts.config.orchestrator.harness
        : this.harnessShown(target)
    const shown = {
      harness,
      models: this.offered.get(harness)?.models ?? [],
      why: null,
      asking: true,
    }
    this.picker = shown
    const opened = { ...modelPanel(target), index: this.inUse(target, shown.models) }
    this.wire.put({ ...this.wire.state, panel: opened })
    this.wire.draw()
    const offered = await this.modelsFor(target)
    // Closed, or opened again, while it was asked: what it said is kept all the
    // same (`modelsFor`), and nothing on screen is about it any more.
    const panel = this.wire.state.panel
    if (this.picker !== shown || panel?.kind !== 'model' || panel.for !== target) return
    this.picker = offered
    const on = modelChoices(shown.models, panel.query)[panel.index]?.id
    const at = on ? modelChoices(offered.models, panel.query).findIndex((one) => one.id === on) : -1
    const index = at >= 0 ? at : panel.query ? 0 : this.inUse(target, offered.models)
    this.wire.put({ ...this.wire.state, panel: { ...panel, index } })
    this.wire.draw()
  }

  /** Where the model in use is in a list: so enter is a no-op and ↑↓ is "the one next to it". */
  private inUse(target: string, models: readonly ModelChoice[]): number {
    const current =
      target === 'orchestrator'
        ? this.deps.thinkerModel()
        : (this.wire.live?.vitals(target)?.model ?? null)
    if (!current) return 0
    return Math.max(
      0,
      models.findIndex((one) => one.id === current || one.id.endsWith(`/${current}`)),
    )
  }

  /**
   * Switch to a model. An agent switches its own session there and then, and
   * nothing else moves: new agents keep the project's default. The
   * orchestrator's is written to the config — so it stays — and it is started
   * again on it, carrying on the same conversation.
   */
  async chooseModel(panel: ModelPanel, id: string): Promise<void> {
    try {
      if (panel.for === 'orchestrator') {
        // The same split the Settings page writes by, because there is one
        // way a model is stored: a bare name used to put itself in `provider`
        // and leave `model` empty here, which is a route that starts on
        // nothing and a provider nobody can pay.
        const chosen = modelChosen(id)
        writeRecorded(this.wire, 'orchestrator.provider', chosen.provider)
        writeRecorded(this.wire, 'orchestrator.model', chosen.model)
        const loaded = await loadConfig(configPathOf(this.wire.opts))
        if (loaded.ok) this.deps.useConfig(loaded.config)
        this.wire.put({ ...this.wire.state, panel: null })
        notify(this.wire, `the orchestrator is moving to ${chosen.model ?? id}`)
        this.wire.draw()
        await this.wire.opts.restartThinker?.()
      } else {
        const chosen = await this.wire.opts.client.setAgentModel(panel.for, id)
        this.wire.put(
          notice(
            { ...this.wire.state, panel: null },
            `${panel.for} is switching to ${chosen.id}${ALONE}`,
            this.wire.now(),
          ),
        )
      }
    } catch (err) {
      this.wire.put({ ...this.wire.state, panel: { ...panel, busy: false, error: why(err) } })
    }
    this.wire.draw()
  }
}
