import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { Terminal } from '@earendil-works/pi-tui'
import {
  type Config,
  composeBrief,
  describeWork,
  type LaneId,
  loadConfig,
  needsReflection,
  reflectionPrompt,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '@tade/core'
import type { Frame } from '../frame.ts'
import { readImage } from '../images.ts'
import { addEnded, addNews, type Ended, type News, taskNews, unended, withNews } from '../inbox.ts'
import {
  type AppState,
  focusTask,
  markOf,
  notice,
  ORCHESTRATOR_TAB,
  setQuestion,
  type TaskSnapshot,
  withTranscript,
} from '../model.ts'
import { runScreen, ScreenCancelled, type Ui } from '../screen.ts'
import { addProject, editSettings, writeSetting } from '../settings.ts'
import { PLAIN } from '../skin.ts'
import {
  fromThinker,
  interrupted,
  problem,
  said,
  suggest,
  tadeDid,
  thinking,
  youSaid,
} from '../transcript.ts'
import { transcriptLines } from '../transcript-view.ts'
import {
  type Actions,
  clockOf,
  configPathOf,
  type Subject,
  type Thinker,
  type Wiring,
  why,
} from './context.ts'

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
// The screen is borrowed rather than shared: two things drawing at once is the
// bug the whole design avoids, so while a form has the terminal the window
// stops drawing and starts again where it left off.

/** What this subject needs from the rest of the window. */
export interface OrchestratorDeps {
  /** The terminal a borrowed screen is drawn on. */
  terminal: Terminal
  /** Stop drawing, and start again: the screen is somebody else's for a moment. */
  suspend(): void
  resume(): void
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
  /** How the provider paying for it is paid: signed in, or a key. */
  credential(provider: string | null): string | null
  /**
   * Scrolled back, the lines you are reading stay where they are while new
   * ones arrive below.
   */
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
  /** Another screen has the terminal, so this window must not draw over it. */
  private borrowing = false
  /** What happened that the orchestrator has not heard yet: it goes with the next thing said to it. */
  private newsWaiting: News[] = []
  /** The tasks as last seen, so what changed between two looks is news. */
  private seenTasks: readonly TaskSnapshot[] | null = null

  constructor(wire: Wiring, deps: OrchestratorDeps) {
    this.wire = wire
    this.deps = deps
    // Where the window was opened with one, it is taken up here and nothing is
    // said about it: it was there before you looked. `attach` is the other
    // path — one that arrived while you waited — and that one says so.
    if (wire.opts.thinker) this.use(wire.opts.thinker)
  }

  /** Another screen has the terminal: nothing here may draw over it. */
  borrowed(): boolean {
    return this.borrowing
  }

  /** What its harness can be asked of a turn in flight, or nothing before it has started. */
  /**
   * Scrolled back, the lines you are reading stay where they are while new
   * ones arrive below: the distance from the bottom grows by what was added.
   */
  anchored(next: AppState): AppState {
    const before = this.wire.state
    if (next.transcriptScroll === 0 || next.transcript === before.transcript) return next
    const count = (transcript: AppState['transcript']) =>
      transcriptLines(
        transcript,
        this.deps.terminal.columns,
        PLAIN,
        { hover: null, pressed: null },
        0,
      ).length
    const grown = count(next.transcript) - count(before.transcript)
    return { ...next, transcriptScroll: Math.max(0, next.transcriptScroll + grown) }
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
    this.wire.put(notice(this.wire.state, 'orchestrator ready'))
    this.wire.draw()
  }

  /** Take free text to this thinker, and show what it does as it does it. */
  private use(thinker: Thinker): void {
    this.thinker = thinker
    thinker.onEvent?.((event) => {
      // Said as it streams. The whole message follows its pieces, and only
      // closes them off: said again, every answer was heard twice at once.
      if (this.speakingTurn && event.type === 'delta' && event.text) {
        this.deps.voice.speakChunk(event.text)
      } else if (this.speakingTurn && event.type === 'message' && event.text) {
        this.deps.voice.speakMessage(event.text)
      }
      this.wire.put(
        this.anchored(
          withTranscript(
            this.wire.state,
            fromThinker(this.wire.state.transcript, event, this.wire.now()),
          ),
        ),
      )
      this.wire.draw()
    })
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
   */
  movedTo(model: { provider: string; id: string }): void {
    this.saveModel(model)
    this.wire.put(
      notice(this.wire.state, `the orchestrator is now on ${model.provider}/${model.id}`),
    )
    this.wire.draw()
  }

  private saveModel(model: { provider?: string; id: string }): void {
    try {
      writeSetting(configPathOf(this.wire.opts), 'orchestrator.provider', model.provider)
      writeSetting(configPathOf(this.wire.opts), 'orchestrator.model', model.id)
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
   * The orchestrator could not be started, said where you would have waited
   * for it — not swallowed, which left a window that never answered anything
   * and gave no reason.
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
    this.wire.put(notice(this.wire.state, null))
    this.wire.draw()
  }
  /** Borrow the terminal for a flow on the shared screen, then put the window back. */
  async onScreenWith(flow: (ui: Ui) => Promise<void>): Promise<void> {
    if (this.borrowing) return
    this.borrowing = true
    this.deps.suspend()
    try {
      await runScreen({ title: 'Tade', terminal: this.deps.terminal }, flow)
    } catch (err) {
      if (!(err instanceof ScreenCancelled)) {
        this.wire.put(notice(this.wire.state, why(err)))
      }
    } finally {
      this.borrowing = false
      this.deps.resume()
      this.wire.draw()
    }
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
      this.wire.put(notice(this.wire.state, `${level} is not a thinking level`))
      this.wire.draw()
      return
    }
    try {
      writeSetting(configPathOf(this.wire.opts), 'orchestrator.thinking', chosen)
      const loaded = await loadConfig(configPathOf(this.wire.opts))
      if (loaded.ok) this.deps.useConfig(loaded.config)
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
      this.wire.draw()
      return
    }
    const trouble = await this.tellThinking(chosen)
    this.wire.put(
      notice(
        this.wire.state,
        trouble
          ? `the orchestrator will think at ${chosen} when it next starts: ${trouble}`
          : `the orchestrator thinks at ${chosen} from its next reply, and starts there`,
      ),
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
      this.wire.put(notice(this.wire.state, `${offers?.harness ?? 'the orchestrator'} ${why}`))
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
        ),
      )
    } catch (err) {
      this.wire.put(notice(this.wire.state, why(err)))
    }
    this.wire.draw()
  }
  /** Ask, on a screen of its own, and put the window back afterwards. */
  async onScreen(command: string): Promise<void> {
    if (this.borrowing) return
    this.borrowing = true
    this.deps.suspend()
    try {
      await runScreen(
        {
          title: command,
          context: [join(this.wire.opts.home, 'config.yaml')],
          terminal: this.deps.terminal,
        },
        async (ui) => {
          try {
            const done = await this.runCommand(command, ui)
            if (done) this.wire.put(notice(this.wire.state, done))
          } catch (err) {
            // Shown here and waited on, rather than thrown out to a window
            // that is about to redraw over it: an explanation that leaves with
            // the screen is an explanation nobody read.
            if (err instanceof ScreenCancelled) throw err
            await ui.pause(`  ${err instanceof Error ? err.message : String(err)}`)
          }
        },
      )
    } catch (err) {
      // ctrl+c closes the form, not Tade.
      if (!(err instanceof ScreenCancelled)) {
        this.wire.put(notice(this.wire.state, err instanceof Error ? err.message : String(err)))
      }
    } finally {
      this.borrowing = false
      this.deps.resume()
      this.wire.draw()
    }
  }

  /** Free text, which only the orchestrator can answer. */
  async ask(text: string): Promise<string> {
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
    const message = withNews(text, this.newsWaiting, clockOf)
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
      credential: this.deps.credential(paying),
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
    if (found.problems.length > 0)
      this.wire.put(notice(this.wire.state, found.problems.join(' · ')))
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
    const message = withNews(text, this.newsWaiting, clockOf, 'Tade says:')
    this.newsWaiting = []
    if (thinker.tell) await thinker.tell(message)
    else await thinker.ask(message)
  }
  /** What each command actually does, once it has a screen to ask on. */
  async runCommand(command: string, ui: Ui): Promise<string> {
    const path = join(this.wire.opts.home, 'config.yaml')
    switch (command) {
      case '/settings':
        await editSettings(ui, path)
        return 'settings closed'
      case '/project': {
        const root = resolve(await ui.ask('repository path', this.wire.opts.cwd ?? process.cwd()))
        if (!existsSync(join(root, '.git'))) throw new Error(`${root} is not a git repository`)
        const fallback = basename(root)
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
        const name = await ui.ask('call it what?', fallback)
        addProject(path, name, root)
        return `added ${name} → ${root}, from the next time Tade starts`
      }
      default:
        return ''
    }
  }

  describe(scope: string | null): string {
    const live = this.wire.live
    const tasks = live?.tasks ?? []
    // Asked about one agent, answer with what it has been doing. Asked about
    // everything, answer with the shape of it: an account of nine tasks at
    // once is unusable, spoken or read.
    if (live && scope && tasks.some((task) => task.task === scope)) {
      return describeWork(live.workOn(scope), this.wire.now())
    }
    const wanted = scope
      ? tasks.filter((t) => t.task === scope || t.task.startsWith(`${scope}/`))
      : tasks
    if (wanted.length === 0) return scope ? `nothing going on in ${scope}.` : 'nothing going on.'
    // Waiting on you is a decision to make: an agent idle at its prompt is not one.
    const blocked = wanted.filter((t) => markOf(t) === 'needs-you').length
    const working = wanted.filter((t) => markOf(t) === 'working').length
    const parts = [`${wanted.length} task${wanted.length === 1 ? '' : 's'}`]
    if (working > 0) parts.push(`${working} working`)
    parts.push(blocked > 0 ? `${blocked} waiting on you` : 'nothing blocked')
    return `${parts.join(', ')}.`
  }
}
