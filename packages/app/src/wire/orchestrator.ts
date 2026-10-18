import {
  type Arm,
  type Config,
  composeBrief,
  type LaneId,
  loadConfig,
  needsReflection,
  orchestratorAccount,
  reflectionPrompt,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '@tade/core'
import type { Frame } from '../frame.ts'
import { readImage } from '../images.ts'
import {
  addEnded,
  addNews,
  type Ended,
  machinesSaid,
  type News,
  TADE_WORDS,
  THEIR_WORDS,
  taskNews,
  unended,
  whereYouAre,
  withNews,
} from '../inbox.ts'
import type { Machines } from '../machines.ts'
import {
  type AppState,
  focusTask,
  notice,
  ORCHESTRATOR_TAB,
  setQuestion,
  shownName,
  type TaskSnapshot,
  withTranscript,
} from '../model.ts'
import {
  deviceSaid,
  fromThinker,
  interrupted,
  problem,
  said,
  suggest,
  tadeDid,
  thinking,
  youSaid,
} from '../transcript.ts'
import { writeRecorded } from './config-written.ts'
import {
  type Actions,
  clockOf,
  configPathOf,
  notify,
  type Subject,
  type Thinker,
  type Wiring,
  why,
} from './context.ts'
import { Keeping } from './keeping.ts'
import { armOfThinker, cannotTalk, stopTurn, whoseTurn } from './orchestrator-away.ts'
import { describeLive } from './orchestrator-status.ts'

// The thing you talk to, seen from the window.
//
// It is a model in another process, so it is settable rather than given: the
// window opens without waiting for it, because an empty terminal while
// something else starts is the worst first second Tade could have. Everything
// except free text works meanwhile, and when it does arrive that is said out
// loud rather than silently — knowing when it changed is the difference
// between waiting and retyping.
//
// Tade tells it; it never talks over it. What happened waits in `news` and
// goes with the next thing you say; what needs it now goes after its current
// turn (`tell`). A conversation that goes quiet is the worst failure this has,
// because it looks like thinking — so a refusal, a throw and a turn that
// ended with nothing said all reach the transcript in words.
//
// It is the heart's (`heart.ts`): told things and deciding with no screen at
// all under `tade serve`. What it did with the screen — a form on a borrowed
// terminal, the conversation kept where you were reading it — is the face's
// (`screens.ts`), reached through `anchored`.

/** What this subject needs from the rest of the window. */
export interface OrchestratorDeps {
  /** The conversation grown, kept where somebody scrolled back to (`Screens.anchored`). */
  anchored(next: AppState): AppState
  /** What is said out loud, and what answers a sentence addressed to Tade. */
  voice: {
    ready(): boolean
    awaiting(): AppState['question']
    handle(said: string): Promise<string>
    speakChunk(text: string): void
    speakMessage(text: string): void
    flushSpeech(): void
  }
  /** What you said is kept, verbatim, for up and ctrl+r. */
  remember(said: string): void
  /** The config was written by this subject's own hand: read it back. */
  useConfig(config: Config): void
  /**
   * What is wrong with how the provider paying for it is paid, or null where
   * nothing is — which is the usual answer, and the strip draws nothing for it.
   */
  credentialProblem(provider: string | null): string | null
  /** Other machines this window links to, as each last said: a line said with every message. */
  machines?: () => Machines | undefined
  /** "Nobody is here", said above Tade's own words on a turn it starts (`nobodyHere`), or null. */
  nobodyHere?: () => string | null
}

export class Orchestrator implements Subject {
  private readonly wire: Wiring
  private readonly deps: OrchestratorDeps
  /**
   * Where free text goes, once there is something to send it to.
   *
   * Settable, because the orchestrator is a model in another process and can
   * take a few seconds to come up. The window opens without waiting for it:
   * an empty terminal while something else starts is the worst first second
   * Tade could have, and everything except free text works meanwhile.
   */
  private thinker: Thinker | null = null
  /**
   * Stops hearing the thinker this one replaced. One stopped to start it again,
   * on another account or model, ends after its successor is up — Claude Code
   * with 143, from the TERM it was sent — and heard, that read as the new one
   * stopping, under `orchestrator ready`.
   */
  private unheard: (() => void) | null = null
  /** The pictures that went with what was said last, until the orchestrator is asked. */
  private sending: string[] = []
  /**
   * The files attached to what the orchestrator is answering, for the agents it
   * starts while it does. Only until it has answered: a picture belongs to the
   * message it came with, not to whatever is started next.
   */
  private answering: readonly string[] = []
  /** This turn is being read out loud as it streams. */
  private speakingTurn = false
  /** Tasks being looked back at right now, so two polls cannot double up. */
  private readonly reflecting = new Set<string>()
  /** What happened that the orchestrator has not heard yet: it goes with the next thing said to it. */
  private newsWaiting: News[] = []
  /** The tasks as last seen, so what changed between two looks is news. */
  private seenTasks: readonly TaskSnapshot[] | null = null
  /** Its conversation, kept short and told what it is told now (`keeping.ts`). */
  private readonly keeping: Keeping

  constructor(wire: Wiring, deps: OrchestratorDeps) {
    this.wire = wire
    this.deps = deps
    this.keeping = new Keeping(wire)
    // Where the window was opened with one, it is taken up here and nothing is
    // said about it: it was there before you looked. `attach` is the other
    // path — one that arrived while you waited — and that one says so.
    if (wire.opts.thinker) this.use(wire.opts.thinker)
  }

  /** Who you are talking to: what it runs on, how hard it thinks, and who pays for it. */
  facts(): Partial<Frame> {
    return {
      orchestratorModel: this.model(),
      orchestratorThinking: this.wire.opts.config.orchestrator.thinking ?? null,
      orchestratorAccount: this.account(),
      orchestratorOffers: this.offers(),
    }
  }

  actions(): Actions {
    return {
      'ask:': (text) => this.say(text),
      brief: async () => {
        await this.brief()
      },
      'transcript-end': () => {
        this.wire.put({ ...this.wire.state, transcriptScroll: 0 })
        this.wire.draw()
      },
    }
  }

  /** Whether there is an orchestrator to ask yet: it is started after the window opens. */
  get started(): boolean {
    return this.thinker !== null
  }

  offers(): Thinker['offers'] | null {
    return this.thinker?.offers ?? null
  }

  /** The pictures the orchestrator is answering about, for the agents it starts meanwhile. */
  attached(): readonly string[] {
    return this.answering
  }

  /** Something happened it has not heard yet: it goes with the next thing you say. */
  note(text: string): void {
    this.newsWaiting = addNews(this.newsWaiting, text, this.wire.now())
  }

  /** What changed between two looks at the tasks is news, and the first look is not. */
  noteTasks(tasks: readonly TaskSnapshot[]): void {
    if (this.seenTasks) {
      for (const text of taskNews(this.seenTasks, tasks)) this.note(text)
    }
    this.seenTasks = tasks
    void this.keeping.beat()
  }

  /**
   * An agent is gone, however it went: told rather than discovered by the
   * orchestrator steering something that is not there any more.
   */
  noteEnded(ended: Ended): void {
    this.newsWaiting = addEnded(this.newsWaiting, ended, this.wire.now())
  }

  /** It is running again, so what was said about it ending is no longer true. */
  noteStarted(task: string): void {
    this.newsWaiting = unended(this.newsWaiting, task)
  }

  /** Nothing is speaking this turn: the mute was pressed. */
  stopSpeaking(): void {
    this.speakingTurn = false
  }

  /**
   * Hand the window the orchestrator, once it has started.
   *
   * Said out loud in the strip rather than silently: until this happens, a
   * sentence Tade's own grammar does not recognise has nowhere to go, and
   * knowing when that changed is the difference between waiting and retyping.
   */
  attach(thinker: Thinker): void {
    this.use(thinker)
    notify(this.wire, 'orchestrator ready')
    this.wire.draw()
  }

  /** Take free text to this thinker, and show what it does as it does it. */
  private use(thinker: Thinker): void {
    this.unheard?.()
    this.thinker = thinker
    this.keeping.attached(thinker)
    this.unheard =
      thinker.onEvent?.((event) => {
        // Said as it streams. The whole message follows its pieces, and only
        // closes them off: said again, every answer was heard twice at once.
        if (this.speakingTurn && event.type === 'delta' && event.text) {
          this.deps.voice.speakChunk(event.text)
        } else if (this.speakingTurn && event.type === 'message' && event.text) {
          this.deps.voice.speakMessage(event.text)
        }
        this.wire.put(
          this.deps.anchored(
            withTranscript(
              this.wire.state,
              fromThinker(this.wire.state.transcript, event, this.wire.now()),
            ),
          ),
        )
        this.wire.draw()
      }) ?? null
  }
  /**
   * Write down the model the orchestrator ended up on when none was chosen,
   * so it stays on it. Otherwise the harness's default decides every start,
   * and that default is whatever an agent last switched to.
   */
  keepModel(model: { provider?: string; id: string }): void {
    if (this.wire.opts.config.orchestrator.model) return
    this.saveModel(model)
  }

  /**
   * The orchestrator switched its own model, because it was asked to: kept for
   * the next start and shown on its tab, without restarting what it is doing.
   * What they said is written down beside it, as `tade_setting_change` writes
   * theirs, so whoever finds the change finds why.
   */
  movedTo(model: { provider: string; id: string }, said = ''): void {
    this.saveModel(model, 'orchestrator', said)
    notify(this.wire, `the orchestrator is now on ${model.provider}/${model.id}`)
    this.wire.draw()
  }

  private saveModel(model: { provider?: string; id: string }, by = 'window', said = ''): void {
    try {
      writeRecorded(this.wire, 'orchestrator.provider', model.provider, by, said)
      writeRecorded(this.wire, 'orchestrator.model', model.id, by, said)
      this.deps.useConfig({
        ...this.wire.opts.config,
        orchestrator: {
          ...this.wire.opts.config.orchestrator,
          model: model.id,
          ...(model.provider ? { provider: model.provider } : {}),
        },
      })
    } catch {
      // Not writable: it still runs, only without the promise to stay put.
    }
  }

  /**
   * Start it again on the account the config now names (`orchestrator.account`):
   * its conversation is carried there as it starts (`Orchestrator.start`), so it
   * goes on rather than being introduced again.
   *
   * At once for a person's press — a plan that has run out is a conversation
   * that cannot answer, so there is nothing to wait for. Where it changed its
   * own account (`afterTurn`), once that turn is over: started again under it,
   * the turn that asked would end with its answer unsaid.
   */
  moveAccount(afterTurn: boolean): void {
    const restart = this.wire.opts.restartThinker
    if (!restart) return
    const go = () => {
      const as = orchestratorAccount(this.wire.opts.config) ?? 'its own sign-in'
      notify(this.wire, `the orchestrator is starting again as ${as}`)
      this.wire.draw()
      void restart().catch((err: unknown) => this.failed(why(err)))
    }
    const thinker = this.thinker
    if (!afterTurn || !thinker?.busy?.()) {
      go()
      return
    }
    const off = thinker.onEvent?.((event) => {
      if (event.type !== 'idle' && event.type !== 'failed' && event.type !== 'exited') return
      off?.()
      go()
    })
    if (!off) go()
  }

  /**
   * The orchestrator could not be started, said where you would have waited for it — not
   * swallowed, which left a window that never answered anything and gave no reason.
   */
  failed(reason: string): void {
    this.wire.put(
      withTranscript(
        this.wire.state,
        problem(
          this.wire.state.transcript,
          `The orchestrator did not start: ${reason}`,
          this.wire.now(),
        ),
      ),
    )
    notify(this.wire, null)
    this.wire.draw()
  }
  /**
   * How hard the orchestrator thinks, from its next reply on. Written to the
   * config, like the model it is on, so it stays — but unlike the model it
   * needs no restart: the level is asked of the process it is already in, and
   * the conversation carries on.
   */
  async chooseThinking(level: string): Promise<void> {
    const chosen = THINKING_LEVELS.find((one) => one === level.trim().toLowerCase())
    if (!chosen) {
      notify(this.wire, `${level} is not a thinking level`)
      this.wire.draw()
      return
    }
    try {
      writeRecorded(this.wire, 'orchestrator.thinking', chosen)
      const loaded = await loadConfig(configPathOf(this.wire.opts))
      if (loaded.ok) this.deps.useConfig(loaded.config)
    } catch (err) {
      notify(this.wire, why(err))
      this.wire.draw()
      return
    }
    const trouble = await this.tellThinking(chosen)
    notify(
      this.wire,
      trouble
        ? `the orchestrator will think at ${chosen} when it next starts: ${trouble}`
        : `the orchestrator thinks at ${chosen} from its next reply, and starts there`,
    )
    this.wire.draw()
  }

  /**
   * Ask the orchestrator to think at a level now. Answers why it could not be
   * told — it is still starting, or stopped — rather than throwing: the level
   * is in the config either way, so the next start has it.
   */
  async tellThinking(level: ThinkingLevel): Promise<string | null> {
    const move = this.thinker?.setThinking
    if (!this.thinker || !move) return 'it is not running yet'
    try {
      await move.call(this.thinker, level)
      return null
    } catch (err) {
      return why(err)
    }
  }
  /**
   * Stop the turn the orchestrator is on, and nothing else.
   *
   * What it already said stays, its session does not change and the next
   * thing you say carries on the same conversation — it is never introduced
   * again, so interrupting it must never be a way of restarting it. What is
   * typed on the line is not touched: escape is the key you press to stop
   * something, not to lose a sentence.
   *
   * A harness that cannot do this mid-turn says so in its own words rather
   * than swallowing the key, which would look exactly like a stop that did
   * not work.
   */
  async interrupt(): Promise<void> {
    const offers = this.thinker?.offers
    if (!this.thinker?.interrupt || !offers?.interrupt.shown) {
      const why = offers?.interrupt.note ?? 'cannot be stopped once it has started'
      notify(this.wire, `${offers?.harness ?? 'the orchestrator'} ${why}`)
      this.wire.draw()
      return
    }
    try {
      await this.thinker.interrupt()
      // Said in the conversation rather than on a line that goes: scrolled
      // back to next week, it is the reason the turn above it stops mid-way.
      this.wire.put(
        notice(
          withTranscript(this.wire.state, interrupted(this.wire.state.transcript)),
          'stopped the orchestrator',
          this.wire.now(),
        ),
      )
    } catch (err) {
      notify(this.wire, why(err))
    }
    this.wire.draw()
  }
  /** Free text, which only the orchestrator can answer; `about` is Tade's, above their words. */
  async ask(text: string, about: string | null = null): Promise<string> {
    if (!this.thinker) return 'The orchestrator is still starting.'
    this.wire.put(
      withTranscript(this.wire.state, thinking(this.wire.state.transcript, this.wire.now())),
    )
    this.wire.draw()
    const images = this.sending.flatMap((path) => readImage(path) ?? [])
    this.sending = []
    this.speakingTurn =
      this.wire.opts.config.surfaces.voice.speak && !this.wire.opts.config.surfaces.voice.muted
    // What happened since it last heard goes with what you said, so what
    // answers you knows it — and is shown, since it is part of what was asked.
    if (this.newsWaiting.length > 0) {
      const told = this.newsWaiting.map((one) => one.text).join('; ')
      this.wire.put(
        withTranscript(
          this.wire.state,
          tadeDid(this.wire.state.transcript, `told the orchestrator: ${told}`, this.wire.now()),
        ),
      )
    }
    // Where they are, derived on this turn and never stored: with several projects open, "start
    // an agent on the flaky test" is unanswerable without it, and a remembered one is stale.
    const pane = this.wire.state.panes.find((one) => one.task === this.wire.state.focused)
    const here = whereYouAre({
      project: this.wire.state.project,
      agent: pane ? shownName(pane) : null,
      projects: this.wire.state.known,
      elsewhere: this.wire.state.elsewhere,
    })
    const there = machinesSaid(this.deps.machines?.(), clockOf)
    const above = [here, there, about].filter(Boolean).join('\n\n') || null
    const message = withNews(text, this.newsWaiting, clockOf, THEIR_WORDS, above)
    this.newsWaiting = []
    try {
      return await this.thinker.ask(message, images)
    } catch (err) {
      this.wire.put(
        withTranscript(
          this.wire.state,
          problem(this.wire.state.transcript, why(err), this.wire.now()),
        ),
      )
      return ''
    } finally {
      this.speakingTurn = false
      this.deps.voice.flushSpeech()
    }
  }

  /** How far the turn in flight reaches: what the `ToolHost` asks at every call. */
  arm(): Arm {
    return armOfThinker(this.thinker)
  }

  /** Whether a turn is in flight, as its harness folds the signals. */
  busy(): boolean {
    return this.thinker?.busy?.() ?? false
  }

  /** Whose turn is in flight, as `byOf` writes it. Empty for none. */
  whose(): string {
    return whoseTurn(this.thinker)
  }

  /** Why a paired device cannot be answered here, or null when it can. */
  cannotTalk(): string | null {
    return cannotTalk(this.thinker)
  }

  /** Stop the turn in flight, if its harness can. False where it cannot. */
  stopTurn(): Promise<boolean> {
    return stopTurn(this.thinker, () => this.interrupt())
  }

  /**
   * Something a paired device said, into the same conversation.
   *
   * **Three things this is not**, each of which would be the hole Phase 3 was
   * written around:
   *
   * - it is **not** `say`, so `deps.remember` is never called and no `said`
   *   line is written. That is necessary and nowhere near sufficient — an old
   *   `said` line of the person's is still in the journal and `namedBy` reads
   *   forty of them — which is why the real refusals are the two tables the
   *   arm is checked against at every tool call.
   * - it is **not** `voice.handle`, so the spoken grammar never sees it. That
   *   grammar parks, steers and starts things directly, by-passing every gate
   *   the away view has; a sentence from a phone reaching it would be the
   *   verbs without the scope checks.
   * - it does **not** take the news that is waiting. News is what Tade tells
   *   *the person's* conversation, and a question from a phone must not
   *   consume it — the next thing they say still carries it.
   */
  async askRemote(text: string, arm: Arm): Promise<void> {
    const thinker = this.thinker
    const askFrom = thinker?.askFrom
    const cannot = this.cannotTalk()
    if (!thinker || !askFrom || cannot) {
      throw new Error(cannot ?? 'this Tade cannot answer a paired device')
    }
    // Shown before the words are handed over, so a turn Tade is already on is
    // never a spinner with nothing above it.
    this.wire.put(
      withTranscript(this.wire.state, thinking(this.wire.state.transcript, this.wire.now())),
    )
    this.wire.draw()
    await askFrom.call(thinker, text, arm)
  }

  /**
   * A device's words, in the conversation, marked as theirs.
   *
   * Said here rather than left to whatever answers, for the reason the local
   * path shows what you typed the moment it is sent: a turn whose question is
   * invisible is a turn the person at the machine cannot make sense of. And it
   * carries the device's id, because a line from a phone that read as
   * something they typed is the `said` confusion in the one place somebody
   * actually reads the words.
   */
  remoteSaid(text: string, device: string): void {
    this.wire.put(
      withTranscript(
        { ...this.wire.state, bottom: ORCHESTRATOR_TAB },
        deviceSaid(this.wire.state.transcript, text, this.wire.now(), device),
      ),
    )
    this.wire.draw()
  }

  /** Everything addressed to Tade arrives here, however it was said. */
  say(said: string): void {
    if (said === '' || !this.deps.voice.ready()) return
    this.deps.remember(said)
    // Shown the moment it is sent, not once something has answered it. The
    // pictures waiting go with it, and only with it.
    this.sending = this.wire.state.attached
    const attached = [...this.wire.state.attached]
    this.answering = attached
    this.wire.put(
      withTranscript(
        { ...this.wire.state, attached: [] },
        youSaid(this.wire.state.transcript, said, this.wire.now(), this.wire.state.attached),
      ),
    )
    this.wire.draw()
    void this.deps.voice
      .handle(said)
      .then(() => {
        this.wire.put(setQuestion(this.wire.state, this.deps.voice.awaiting()))
        this.wire.draw()
      })
      .catch((err: unknown) => {
        this.wire.put(
          withTranscript(
            this.wire.state,
            problem(this.wire.state.transcript, why(err), this.wire.now()),
          ),
        )
        this.wire.draw()
      })
      .finally(() => {
        // Answered: what came with it goes to no agent started after.
        if (this.answering === attached) this.answering = []
      })
  }
  account(): NonNullable<Frame['orchestratorAccount']> {
    const { provider, model } = this.wire.opts.config.orchestrator
    const paying = provider ?? (model?.includes('/') ? (model.split('/')[0] ?? null) : null)
    return {
      provider: paying,
      problem: this.deps.credentialProblem(paying),
    }
  }

  /** The orchestrator's model as the config has it: `provider/id`, or the id alone. */
  model(): string | null {
    const { provider, model } = this.wire.opts.config.orchestrator
    return model ? (provider ? `${provider}/${model}` : model) : null
  }
  /**
   * The brief, on demand: what is stopped, what is moving, and what the
   * extensions found — with what to ask about each offered to click. Returned
   * as it would be said, for a surface that speaks it.
   */
  async brief(): Promise<string> {
    const tasks = (this.wire.live?.tasks ?? []).map((task) => ({
      task: task.task,
      state: task.state,
      waiting: task.approval?.summary ?? null,
      reason: '',
    }))
    const found = (await this.wire.opts.extensions?.brief().catch(() => null)) ?? {
      items: [],
      problems: [],
    }
    const composed = composeBrief(tasks, {
      localHour: new Date(this.wire.now()).getHours(),
      extras: found.items.map((item) => item.said),
    })
    const at = this.wire.now()
    let transcript = said(this.wire.state.transcript, composed.spoken, at)
    for (const item of found.items) {
      if (item.ask) transcript = suggest(transcript, item.said, item.ask, at)
    }
    this.wire.put(withTranscript({ ...this.wire.state, bottom: ORCHESTRATOR_TAB }, transcript))
    if (found.problems.length > 0) notify(this.wire, found.problems.join(' · '))
    this.wire.draw()
    return composed.spoken
  }

  async show(task: string): Promise<string> {
    const known = this.wire.state.panes.some((pane) => pane.task === task)
    if (!known) return `I don't have a pane for ${task}.`
    this.wire.put(focusTask(this.wire.state, task))
    this.wire.draw()

    const lane = `${task}/agent` as LaneId
    if (!this.wire.opts.client.driver.capabilities.focus) return `Showing ${task}.`
    try {
      await this.wire.opts.client.focusLane(lane)
      return `Showing ${task}.`
    } catch {
      // The lane may not exist, or the terminal may have moved on. The pane
      // moved either way, which is the part this window can promise.
      return `Showing ${task}.`
    }
  }

  /**
   * Look back at tasks that have finished.
   *
   * Nothing was ever prompting the orchestrator to notice a lesson; a tool it
   * may call whenever it likes is one it calls to be helpful rather than when
   * it has learned something. A finished task is the one moment there is
   * something to learn from, and the journal remembers which have been looked
   * at, so nothing is reflected on twice.
   *
   * Quiet by design: it proposes, and what it proposes waits for you in
   * `tade skills` and the next brief. Nothing is said out loud.
   */
  async reflect(tasks: readonly TaskSnapshot[]): Promise<void> {
    const thinker = this.thinker
    if (!thinker || !this.wire.opts.config.orchestrator.reflect) return
    const finished = needsReflection(
      tasks.map((task) => ({ task: task.task, state: task.state })),
      this.wire.live?.events ?? [],
    ).filter((task) => !this.reflecting.has(task))

    for (const task of finished) {
      this.reflecting.add(task)
      // Recorded before asking, not after: an ask that fails or is interrupted
      // must not make Tade ask again about the same task every two seconds.
      await this.wire.opts.client.log
        .append({ type: 'reflected', task, detail: { by: 'orchestrator' } })
        .catch(() => {})
      await this.tell(reflectionPrompt(task)).catch(() => {})
    }
  }
  /**
   * Tell the orchestrator something now rather than with the next thing you
   * say: after the turn it is on, never across it. Sent in the middle of your
   * question, it used to be refused, and was lost.
   */
  async tell(text: string): Promise<void> {
    const thinker = this.thinker
    if (!thinker) return
    // Whether anybody is here goes above Tade's words as where they stand goes
    // above theirs: a fact of this turn, derived now and never remembered.
    const above = this.deps.nobodyHere?.() ?? null
    const message = withNews(text, this.newsWaiting, clockOf, TADE_WORDS, above)
    this.newsWaiting = []
    if (thinker.tell) await thinker.tell(message)
    else await thinker.ask(message)
  }
  /** What `status` answers: one agent's work, or the shape of everything (`orchestrator-status.ts`). */
  describe(scope: string | null): string {
    return describeLive(this.wire, scope)
  }
}
