import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  Arm,
  Config,
  Effort,
  Note,
  SkillActivity,
  TadeEvent,
  ThinkingLevel,
  Unsubscribe,
} from '@tade/core'
import {
  AWAY_WORDS,
  cameFromAway,
  composePrompt,
  expandHome,
  LOCAL,
  livingSkills,
  orchestratorRoute,
  wentQuiet,
} from '@tade/core'
import {
  type HarnessModels,
  modelsOffered,
  type WorkerAdapter,
  type WorkerCapabilities,
  type WorkerExtras,
  type WorkerImage,
  type WorkerModel,
} from '@tade/harnesses-core'
import { sessionIdFor } from '@tade/harnesses-pi'
import { HARNESS_ADAPTERS } from '@tade/workbench/harnesses'
import { composeBriefing } from './briefing.ts'
import { activeSkills, enabledTools } from './extensions.ts'
import { skillsRoot, TOOLS_MCP, toolEnv, writeToolServer } from './launch.ts'
import { modelNamed, startingModel } from './model.ts'
import { canBeArmed } from './origin.ts'

// Re-exported, so a file split for size is not a rename of everybody's
// imports: both are what a harness is handed at launch, and `launch.ts` is
// where they are written.
export { TOOLS_MCP, writeToolServer }

// The thing you talk to. An agent like any other, except that its tools are
// Tade's own and nobody supervises it: it is the interface, not the work.

export const TOOLS_EXTENSION = fileURLToPath(new URL('./tools-extension.ts', import.meta.url))

export const ORCHESTRATOR_RUN = 'orchestrator'
export const ORCHESTRATOR_TASK = 'tade/orchestrator'
/**
 * The one conversation Tade has with you, for as long as this home exists.
 *
 * Named rather than generated, for the same reason an agent's session is:
 * pi creates a session with this id the first time and continues it every
 * time after, so closing Tade and opening it again is not a special case —
 * the same command line starts the conversation once and resumes it for ever.
 * A generated id was why reopening the window met someone who had never heard
 * of you.
 */
export const ORCHESTRATOR_SESSION = sessionIdFor(ORCHESTRATOR_TASK)

export interface OrchestratorOptions {
  /** Tade's state directory, passed through to the tools. */
  home: string
  /** The `ToolHost` socket its tools call back through. */
  socket: string
  /** Where the orchestrator's own session files live. */
  runDir: string
  /** Working directory for the session. */
  cwd?: string
  config?: Config
  /**
   * What you have told Tade, for the prompt. Passed in rather than fetched so
   * composing the prompt stays a pure function of facts.
   */
  notes?: readonly Note[]
  /**
   * What has happened lately, which decides which lessons still apply. Without
   * it nothing has happened anywhere, so every lesson about something in
   * particular is treated as quiet.
   */
  activity?: SkillActivity
  /** Supplied so the same facts always compose the same prompt. */
  now?: number
  model?: WorkerModel
  /**
   * What extensions add: the tools it may call (run by the window), what it is
   * told about them, and harness-native pieces they ship.
   */
  extensions?: { prompt: string; extras: WorkerExtras }
  /**
   * The journal, for the briefing it opens with: what happened while it was
   * not running, so a conversation that carries on knows the world moved.
   * Passed in rather than read here, so composing stays a pure function of
   * facts; without it the briefing is only what the queue says.
   */
  journal?: readonly TadeEvent[]
  /**
   * What is queued and scheduled, in the queue's own words — the same answer
   * `tade_queue` gives. Only a window has a queue, so only a window has this.
   */
  queue?: string
  /**
   * The changes that span repositories, as the window folded them out of the
   * task files. Passed in for the same reason the queue is: it is a fold of
   * what is on disk now, and composing a briefing stays pure.
   */
  efforts?: readonly Effort[]
  /** Extra pi arguments. Tests use this to inject a scripted model. */
  args?: string[]
  env?: NodeJS.ProcessEnv
  /**
   * Whether a paired device may talk to this conversation
   * (`surfaces.web.orchestrator`).
   *
   * **It changes nothing about how the conversation is run**, which is the
   * point: the gate on its tool calls is registered either way and answers
   * *yes* to every local one, so the orchestrator is ungated for the person at
   * the keyboard exactly as it was.
   *
   * What it is read for is **saying so at the start**. A harness that cannot
   * be narrowed serves no remote turn (`canBeArmed`), and the person who
   * turned the setting on is the one who needs to hear that nothing will come
   * of it — at start-up, rather than from a phone being refused an hour later.
   */
  talking?: boolean
  /**
   * Start with none of the self-written extensions loaded. This is the way
   * back when one of them is what broke, so it must not depend on any of them.
   */
  safe?: boolean
  /**
   * What each of its own turns cost. The orchestrator is a model like any
   * agent, and spend that is not recorded is spend the window cannot show.
   */
  onUsage?: (usage: OrchestratorUsage) => void
  /** Something that went wrong but did not stop it: never swallowed. */
  onWarning?: (message: string) => void
}

export interface OrchestratorUsage {
  model: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  usd: number
  /** Which harness it is talking in, so its spend is filed like an agent's. */
  harness: string
  /**
   * Whether that money was priced or guessed, as the harness declares it. The
   * same word an agent's turn is written down with — the orchestrator spends
   * real money and belongs in the same total, which may never add an exact
   * dollar to an estimated one without saying which it did.
   */
  priced: 'exact' | 'estimate' | 'none'
}

/**
 * Everything the orchestrator does that a person should be able to watch: what
 * it is saying as it says it, which tool it reached for with what, how that
 * went, and — the part that used to vanish — that it failed, and why.
 */
export type OrchestratorEvent =
  | { type: 'delta'; text: string }
  | { type: 'message'; text: string }
  | { type: 'tool'; id: string; tool: string; input: unknown }
  | { type: 'tool_done'; id: string; ok: boolean; text: string }
  /**
   * The turn ended on a tool call having said nothing after it: the silence
   * that reads as thinking. Carries the tool it ended on, because that is the
   * only true thing a surface can say about it. Sent before `idle`, so
   * whatever stops drawing a spinner on `idle` has the reason already.
   */
  | { type: 'quiet'; tool: string }
  | { type: 'idle' }
  | { type: 'failed'; reason: string }
  /** A turn the model could not finish — a refused request — while the harness keeps running. */
  | { type: 'error'; reason: string }
  | { type: 'exited'; code: number | null }

export class Orchestrator {
  private readonly adapter: WorkerAdapter
  private readonly messageListeners = new Set<(text: string) => void>()
  private readonly toolListeners = new Set<(tool: string) => void>()
  private readonly idleListeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: OrchestratorEvent) => void>()
  private readonly errorListeners = new Set<(reason: string) => void>()
  /** Why it stopped, once it has: asking it anything after that cannot work. */
  private gone: string | null = null
  /**
   * The tool this turn reached for last with nothing said since, or null while
   * words are the last thing it produced.
   *
   * The whole of catching a turn that goes quiet, and it has to be a fold of
   * the signals as they arrive: by the time `idle` says the turn is over there
   * is nothing left to look at, and a harness that reports a turn's shape
   * afterwards is a harness we would be inventing.
   */
  private quietOn: string | null = null
  /**
   * The arm the turn in flight runs under, or null between turns.
   *
   * **One at a time, and held from the prompt until `idle`.** That window is
   * deliberately wider than the remote turn's own tool calls, and the
   * direction it errs in is the whole point: a call Tade cannot attribute to a
   * turn is judged against the *narrower* arm, so the worst that happens is
   * the person at the keyboard being refused something for a few seconds —
   * said out loud, with escape as the way out — rather than a stranger's words
   * reaching a tool after their turn was supposed to be over.
   *
   * Released on `idle`, which the harness sends when there is no turn in
   * flight *and* nothing queued, and never on `abort` alone: clearing it the
   * moment a stop is asked for would re-widen the host while a tool call from
   * the dying turn is still in the air.
   */
  private leased: Arm | null = null
  /**
   * Whether anything is in flight, folded from the signals rather than asked.
   *
   * A prompt sent mid-turn is *steered into that turn* by every harness here,
   * so "is it busy" cannot be read after the fact — and a remote message
   * steered into a local turn would be a stranger's words inside a turn whose
   * arm is the person's. So a remote ask is refused while this is true, and
   * the phone is told plainly rather than having its words disappear into
   * somebody else's question.
   */
  private working = false
  /** Why this harness cannot run a remote turn, or null when it can. */
  private unarmable: string | null = null

  private constructor(adapter: WorkerAdapter) {
    this.adapter = adapter
  }

  /** What the harness it runs in can be asked to do: what a surface offers for it. */
  get capabilities(): WorkerCapabilities {
    return this.adapter.capabilities
  }

  static async start(opts: OrchestratorOptions): Promise<Orchestrator> {
    const route = opts.config ? orchestratorRoute(opts.config) : null
    const harness = route?.harness ?? 'pi'
    const make = HARNESS_ADAPTERS[harness]
    if (!make) {
      throw new Error(
        `no harness called ${harness}: Tade runs ${Object.keys(HARNESS_ADAPTERS).join(', ')}`,
      )
    }
    const adapter = make({
      runDir: opts.runDir,
      socketDir: opts.runDir,
      approvals: 'bypass',
      // Tade's own interface: gating its tool calls on an approval would mean
      // asking permission to answer "where are we".
      //
      // **And the gate on a turn from away is not this.** It is a `tool_call`
      // hook inside Tade's own tools extension, asking the `ToolHost` at the
      // call (`origin/allow`) — so it needs no approval mode, no supervision
      // channel, and nothing about a local turn changes. It had to be there
      // rather than here for a mechanical reason as well: the supervision
      // extension and the tools extension both register this run's extension
      // tools, and pi refuses to start on the collision.
      supervised: false,
      ...(opts.args ? { args: [...opts.args] } : {}),
    })
    // Drawn by Tade rather than drawing itself: a harness that cannot be run
    // that way can run agents, and says so rather than starting something
    // nobody can see.
    if (!adapter.capabilities.headless) {
      throw new Error(
        `${harness} ${adapter.capabilities.why.headless ?? 'cannot be the one you talk to'}: it runs agents`,
      )
    }
    // Whether a remote turn could be run at all, decided before one arrives
    // and **said** rather than discovered: a harness that cannot be narrowed
    // serves no remote turn, and the person who turned the setting on is the
    // one who needs to know that nothing will come of it.
    const armed = canBeArmed(adapter.capabilities)
    if (opts.talking === true && !armed.ok) {
      opts.onWarning?.(
        `${harness} ${armed.why}, so a paired device cannot talk to Tade through it — nothing from away will be answered, and every message is refused with that reason`,
      )
    }

    // The exact model, settled before anything starts and among what this
    // harness offers: a name it cannot place makes it exit before it reads a
    // word, which looked like an orchestrator that never answered.
    const named = modelNamed(route)
    const found = opts.model || !named ? null : await adapter.resolveModel(named)
    const starting = startingModel(opts.model, named, found, harness)
    if (starting.warning) opts.onWarning?.(starting.warning)
    const model = starting.model

    // Tade's own tools always load. The ones it wrote for itself load after
    // them, so a self-written tool can never shadow `status` or `approve` —
    // and only the ones somebody turned on load at all.
    const written = opts.safe
      ? []
      : enabledTools(
          expandHome(opts.config?.orchestrator.extensions ?? join(opts.home, 'extensions')),
          opts.config?.extensions ?? {},
        )

    // What it missed. The conversation comes back by itself; the world it was
    // talking about does not, so the journal is read back to it as of now.
    const briefing = composeBriefing({
      now: opts.now ?? Date.now(),
      events: opts.journal ?? [],
      projects: Object.keys(opts.config?.projects ?? {}),
      ...(opts.efforts ? { efforts: opts.efforts } : {}),
      ...(opts.queue ? { queue: opts.queue } : {}),
    })

    // What it is, and where things stood: one is true whenever it is read,
    // the other a snapshot with times on it, so they are said apart. Appended
    // to the harness's own instructions, never replacing them.
    const instructions = [
      opts.config
        ? composePrompt({
            config: opts.config,
            ...(opts.notes ? { notes: opts.notes } : {}),
            // Only the lessons that still apply: one about a project nobody
            // has touched in a month is noise in every prompt.
            skills: livingSkills(
              activeSkills(skillsRoot(opts)),
              opts.activity ?? { lastSeenAt: {}, known: Object.keys(opts.config.projects) },
              opts.now ?? Date.now(),
            ),
            ...(opts.extensions?.prompt ? { extensions: opts.extensions.prompt } : {}),
          })
        : '',
      briefing,
      opts.extensions?.extras.instructions ?? '',
    ]
      .filter(Boolean)
      .join('\n\n')

    // Tade's own tools, given to this harness the way it takes them: modules
    // it loads, or an MCP server it starts. Asked of the harness rather than
    // decided here, so a harness that speaks neither is told about, not
    // handed something it will ignore.
    const mine: WorkerExtras = { ...opts.extensions?.extras }
    if (adapter.capabilities.nativeExtensions) {
      // Tade's own load first, so a tool it wrote for itself can never shadow
      // `status` or `approve` — and only the ones somebody turned on load.
      mine.extensions = [TOOLS_EXTENSION, ...written, ...(mine.extensions ?? [])]
    } else if (adapter.capabilities.mcp) {
      mine.mcp = [...(mine.mcp ?? []), writeToolServer(opts)]
      if (written.length > 0) {
        opts.onWarning?.(
          `${harness} loads no extension modules, so the ${written.length} tool${written.length === 1 ? '' : 's'} Tade wrote for itself did not load`,
        )
      }
    } else {
      throw new Error(
        `${harness} cannot be given Tade's own tools: it takes neither an extension nor an MCP server`,
      )
    }
    if (instructions) mine.instructions = instructions

    const orchestrator = new Orchestrator(adapter)
    orchestrator.unarmable = armed.ok ? null : armed.why
    const emit = (event: OrchestratorEvent) => {
      for (const listener of orchestrator.eventListeners) listener(event)
    }
    adapter.onSignal(ORCHESTRATOR_RUN, (signal) => {
      // Whether this turn has anything left unsaid, folded as the signals
      // arrive. Only real words count: an empty final message is exactly how
      // a turn ends up saying nothing, so reading one as speech would hide
      // the case this exists to catch. And a turn that ended for a reason
      // already said — you stopped it, the model could not finish it — is not
      // a turn that went quiet: reporting those as silence would blame the
      // model for what you did, or say one failure twice. A mid-turn
      // `problem` is neither, because pi carries on after one and the turn
      // can still end on a tool call with nothing said.
      if (signal.type === 'tool_call') orchestrator.quietOn = signal.tool
      else if (
        (signal.type === 'message' || signal.type === 'message_delta') &&
        signal.text.trim() !== ''
      ) {
        orchestrator.quietOn = null
      } else if (signal.type === 'turn_done' && signal.status !== 'ok') {
        orchestrator.quietOn = null
      }
      if (signal.type === 'message') {
        for (const listener of orchestrator.messageListeners) listener(signal.text)
        emit({ type: 'message', text: signal.text })
      } else if (signal.type === 'message_delta') {
        emit({ type: 'delta', text: signal.text })
      } else if (signal.type === 'tool_call') {
        for (const listener of orchestrator.toolListeners) listener(signal.tool)
        emit({ type: 'tool', id: signal.callId, tool: signal.tool, input: signal.input })
      } else if (signal.type === 'tool_result') {
        emit({ type: 'tool_done', id: signal.callId, ok: signal.ok, text: signal.summary })
      } else if (
        (signal.type === 'turn_done' && signal.status === 'error') ||
        signal.type === 'problem'
      ) {
        const reason =
          signal.type === 'problem' ? signal.text : (signal.reason ?? 'the model returned an error')
        for (const listener of orchestrator.errorListeners) listener(reason)
        emit({ type: 'error', reason })
      } else if (signal.type === 'idle') {
        // The turn is over: nothing in flight and nothing queued, which is the
        // one moment the lease can be let go without re-widening the host
        // while a call from the turn is still in the air.
        orchestrator.leased = null
        orchestrator.working = false
        // The turn is over, so this is the last moment anything can notice it
        // ended on a tool call and said nothing. Said before `idle`, because
        // `idle` is what stops the spinner and the reason has to be on screen
        // by then rather than a frame later.
        const quiet = orchestrator.quietOn
        orchestrator.quietOn = null
        if (quiet) emit({ type: 'quiet', tool: quiet })
        for (const listener of orchestrator.idleListeners) listener()
        emit({ type: 'idle' })
      } else if (signal.type === 'failed') {
        orchestrator.leased = null
        orchestrator.working = false
        orchestrator.gone = signal.error
        emit({ type: 'failed', reason: signal.error })
      } else if (signal.type === 'exited') {
        orchestrator.leased = null
        orchestrator.working = false
        orchestrator.gone ??=
          signal.code === 0 ? 'it stopped' : `it exited with code ${signal.code}`
        emit({ type: 'exited', code: signal.code })
        // Anyone waiting for it to finish a turn would wait forever.
        for (const listener of orchestrator.idleListeners) listener()
      } else if (signal.type === 'usage') {
        const { type: _type, run: _run, at: _at, ...usage } = signal
        opts.onUsage?.({
          ...usage,
          harness: adapter.id,
          priced: adapter.capabilities.spend.usd,
        })
      }
    })

    await adapter.start({
      run: ORCHESTRATOR_RUN,
      task: ORCHESTRATOR_TASK,
      cwd: opts.cwd ?? process.cwd(),
      prompt: '',
      ...(model ? { model } : {}),
      // How hard it thinks, from its first turn: chosen like an agent's, and
      // the harness's own default when nobody has.
      ...(route?.thinking ? { thinking: route.thinking } : {}),
      extras: mine,
      // What its tools need to find their way back to Tade, whichever harness
      // they are loaded into.
      env: toolEnv(opts),
    })
    // A harness that refused to start — a model it could not resolve, most
    // often — has already said why, and that is the answer to give.
    if (orchestrator.gone) throw new Error(orchestrator.gone)
    return orchestrator
  }

  /** Say something, with pictures if there are any. Replies arrive through `onMessage`. */
  async ask(text: string, images: readonly WorkerImage[] = []): Promise<void> {
    if (this.gone) throw new Error(`The orchestrator is not running: ${this.gone}`)
    this.working = true
    await this.adapter.prompt(ORCHESTRATOR_RUN, text, images)
  }

  /**
   * How far the turn in flight reaches: what the `ToolHost` asks at every
   * call, and the window's own answer to *whose turn is this*.
   *
   * `LOCAL` between turns, which is the honest answer and not a permissive
   * one: there is no turn to narrow, and anything calling the host outside one
   * is the window's own child doing what the window asked.
   */
  get arm(): Arm {
    return this.leased ?? LOCAL
  }

  /** Whether a turn is in flight, so a surface can say *still answering* rather than guessing. */
  get busy(): boolean {
    return this.working
  }

  /**
   * Why this harness cannot answer a paired device, or null when it can.
   *
   * Read by whatever offers the capability, so a phone is told *this harness
   * cannot be narrowed* rather than being answered by a conversation nothing
   * was holding back. Never a silent unrestricted run: `askFrom` refuses on
   * the same answer.
   */
  get unarmed(): string | null {
    return this.unarmable
  }

  /**
   * Say something a paired device asked, under an arm that narrows what the
   * turn may reach.
   *
   * Four refusals before anything is sent, and each is a sentence rather than
   * a dropped message:
   *
   * 1. **not running** — nothing to say it to;
   * 2. **this harness cannot be narrowed** (`canBeArmed`), which is the one
   *    that must never become a silent unrestricted run;
   * 3. **a local arm asked for** — there is no path here for a turn that
   *    claims to be the person's, because the one caller of this is the away
   *    view's own door and the local path is `ask`;
   * 4. **something is already in flight.** A prompt sent mid-turn is *steered
   *    into that turn* by every harness here, so a remote message arriving
   *    while the person's question is being answered would put a stranger's
   *    words inside it — and inside its arm. Refused, with the phone told
   *    plainly, which is also why the page keeps what somebody typed: only a
   *    `200` clears the box.
   *
   * Nothing waits for the answer. The reply streams through `onEvent` like any
   * other turn, and the lease is let go on `idle`.
   */
  async askFrom(text: string, arm: Arm): Promise<void> {
    if (this.gone) throw new Error(`The orchestrator is not running: ${this.gone}`)
    if (this.unarmable) {
      throw new Error(
        `Tade cannot answer a paired device here: ${this.adapter.id} ${this.unarmable}`,
      )
    }
    if (arm.how !== 'remote') throw new Error('a turn asked for from away is never a local arm')
    if (this.leased !== null || this.working) {
      throw new Error('Tade is still answering the last thing it was asked')
    }
    // **Set before the prompt is sent, and that order is the whole of it.** A
    // lease taken after the harness has the message is a window in which the
    // turn's first tool call is judged as the person's.
    this.leased = arm
    this.working = true
    try {
      await this.adapter.prompt(
        ORCHESTRATOR_RUN,
        [cameFromAway(arm), '', AWAY_WORDS, text].join('\n'),
      )
    } catch (error) {
      // It never started, so nothing is in flight and the host must not stay
      // narrowed: a lease nothing will ever release is an orchestrator whose
      // own tools are refused until Tade is restarted.
      this.leased = null
      this.working = false
      throw error
    }
  }

  /**
   * Say something that is not an interruption: a turn of its own when it is
   * free, and after the turn it is on when it is not. What Tade tells it
   * unasked arrives this way, so it never cuts across what you asked.
   */
  async tell(text: string): Promise<void> {
    if (this.gone) throw new Error(`The orchestrator is not running: ${this.gone}`)
    this.working = true
    await this.adapter.prompt(ORCHESTRATOR_RUN, text, [], { whenBusy: 'queue' })
  }

  /**
   * What it could run on, as its own harness offers them — never another
   * harness's: its model is resolved by the harness it talks through, and an
   * empty answer comes back with that harness's own words for why.
   */
  models(): Promise<HarnessModels> {
    return modelsOffered(this.adapter)
  }

  /** A model said the way people say it, among its harness's. Throws what to ask. */
  async resolveModel(said: string): Promise<{ provider: string; id: string }> {
    const found = await this.adapter.resolveModel(said)
    if (!found.ok) throw new Error(found.reason)
    return { provider: found.provider, id: found.id }
  }

  /** Why it is not running, or null while it is. */
  get stopped(): string | null {
    return this.gone
  }

  /** The model it is actually thinking with, as the harness reports it. */
  model(): Promise<WorkerModel | null> {
    return this.adapter.modelOf(ORCHESTRATOR_RUN)
  }

  /**
   * Stop the turn it is on, and nothing else.
   *
   * Interrupting is not stopping: the process stays up, its session id does
   * not change, and the next thing you say carries on the same conversation —
   * which is the whole difference between this and `stop()`. What it managed
   * to say before you cut it off is already in the conversation and stays
   * there, so it knows what it was doing when you interrupted it.
   *
   * Whether its harness can do this mid-turn is declared (`capabilities.abort`)
   * and read through `offer()`; a harness that cannot says so rather than
   * being asked and quietly doing nothing.
   */
  async interrupt(): Promise<void> {
    if (this.gone) throw new Error(`The orchestrator is not running: ${this.gone}`)
    await this.adapter.abort(ORCHESTRATOR_RUN)
  }

  /**
   * How hard it thinks, from its next reply on. Asked of the process it is
   * already in — unlike a model, which it is restarted on — so the
   * conversation carries on mid-sentence.
   */
  async setThinking(level: ThinkingLevel): Promise<void> {
    if (this.gone) throw new Error(`The orchestrator is not running: ${this.gone}`)
    await this.adapter.setThinking(ORCHESTRATOR_RUN, level)
  }

  /**
   * Say something and wait for the answer, for surfaces that speak in turns.
   *
   * Bounded on purpose: a surface that waits forever on a thinking agent is a
   * surface that has hung, and saying so is better than looking broken.
   */
  async askFor(
    text: string,
    timeoutMs = 120_000,
    images: readonly WorkerImage[] = [],
  ): Promise<string> {
    const parts: string[] = []
    const errors: string[] = []
    // The tool a turn that said nothing ended on. A list, like the two above,
    // so what the callback does is push rather than assign: a captured `let`
    // narrows to its initial value at the read and the answer is lost.
    const quiet: string[] = []
    const offMessage = this.onMessage((part) => parts.push(part))
    const offError = this.onError((reason) => errors.push(reason))
    const offEvent = this.onEvent((event) => {
      if (event.type === 'quiet') quiet.push(event.tool)
    })
    let offIdle: Unsubscribe = () => {}
    const settled = new Promise<void>((resolve) => {
      offIdle = this.onIdle(resolve)
    })
    try {
      await this.ask(text, images)
      const timer = new Promise<'slow'>((resolve) => {
        const handle = setTimeout(() => resolve('slow'), timeoutMs)
        handle.unref?.()
      })
      if ((await Promise.race([settled.then(() => 'done' as const), timer])) === 'slow') {
        return parts.join(' ').trim() || 'Still thinking about that one.'
      }
      if (this.gone && parts.length === 0) return `The orchestrator stopped: ${this.gone}`
      if (parts.length === 0 && errors.length > 0) {
        return `The orchestrator could not answer: ${errors.at(-1)}`
      }
      const answer = parts.join(' ').trim()
      // The one thing a surface that speaks in turns must never be handed is
      // an empty string, which it can only read as "still thinking" and say
      // nothing at all about — which is how a quiet turn reached a voice as
      // literal silence, with the window's own line about it sitting on a
      // screen nobody was looking at. Only in place of an empty answer:
      // whatever it did say before reaching for the tool has already been
      // said out loud, and saying it twice is its own bug.
      const ended = quiet.at(-1)
      if (answer === '' && ended) return wentQuiet(ended)
      return answer
    } finally {
      offError()
      offEvent()
      offMessage()
      offIdle()
    }
  }

  onMessage(listener: (text: string) => void): Unsubscribe {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  /** Fires when a turn ends in an error the model could not get past. */
  onError(listener: (reason: string) => void): Unsubscribe {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  /** Which tool it reached for, so a surface can show its working. */
  onTool(listener: (tool: string) => void): Unsubscribe {
    this.toolListeners.add(listener)
    return () => this.toolListeners.delete(listener)
  }

  /** Everything it does, as it does it. */
  onEvent(listener: (event: OrchestratorEvent) => void): Unsubscribe {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** Fires when it has finished and is waiting on you. */
  onIdle(listener: () => void): Unsubscribe {
    this.idleListeners.add(listener)
    return () => this.idleListeners.delete(listener)
  }

  async stop(): Promise<void> {
    await this.adapter.shutdown()
  }
}
