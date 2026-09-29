import {
  type AttentionSettings,
  type Awaitable,
  type Channel,
  DEFAULT_ATTENTION,
  decideAttention,
  describeEvent,
  type Intent,
  type KnownTask,
  parseUtterance,
  REST_ON_SCREEN,
  type ResolveOptions,
  resolveAnswer,
  resolveTarget,
  SPOKEN_LIMITS,
  type Surface,
  speakable,
  speakableSoFar,
  spokenSummary,
  summarise,
  type TadeEvent,
  type Target,
  type Unsubscribe,
  type Vocabulary,
  type WorkHistory,
} from '@tade/core'
import type { Speaker, Tone } from '@tade/voice-tts'

// Voice as a surface, not as the architecture. It listens to text (from a
// transcriber, a dictation app, or a keyboard), works out which agent you
// meant, and says back what happened.
//
// Three rules run through all of it: it never guesses which of several things
// you meant, it asks instead; a bare yes can never carry out something
// destructive; and every answer can explain itself.

/** The slice of Tade this surface uses. `Workbench` satisfies it. */
export interface VoiceWorkbench {
  pendingApprovals(
    task?: string,
  ): Awaitable<
    Array<{ run: string; requestId: string; task: string; summary: string; tier: string }>
  >
  decideApproval(
    run: string,
    requestId: string,
    /** `said` is the exact utterance that decided it, kept in the ledger. */
    decision: { allow: boolean; reason?: string; said?: string },
  ): Promise<void>
  runs(): Awaitable<Array<{ run: string; task: string }>>
  /** Tell the agent working on a task something, without stopping it. */
  steerAgent(task: string, message: string): Promise<void>
  /** Switch a running agent's model, said as people say it. Optional: a surface without it says so. */
  setAgentModel?(task: string, said: string): Promise<{ provider: string; id: string }>
  parkTask(task: string, parked: boolean): Promise<{ task: string; parked: boolean }>
  createTask(request: {
    project: string
    slug: string
    intent: string
    by?: string
  }): Promise<{ id: string; worktree: string }>
  startAgent(request: { task: string; cwd: string; prompt: string }): Promise<unknown>
  /**
   * Watch the journal. What comes back is how to stop watching: a surface
   * that cannot let go of the event stream leaks past its own lifetime, so
   * this is required where `remember` is not.
   */
  subscribe(handler: (event: TadeEvent) => void): Awaitable<Unsubscribe>
  /**
   * Optional: write something down. Without it the surface says plainly that
   * it cannot remember, rather than pretending to.
   */
  remember?(text: string, scope: string | null, by?: string): Awaitable<unknown>
}

/** What voice can do with terminals. `name` is as said, or null for the one in front of you. */
export interface VoiceTerminals {
  open(name: string | null): Promise<string>
  show(name: string | null): Promise<string>
  close(name: string | null): Promise<string>
  rename(name: string | null, to: string): Promise<string>
  /** Type a command in, unsent. */
  run(name: string | null, command: string): Promise<string>
  search(name: string | null, text: string): Promise<string>
  /** Send a command typed by voice, if its words are the ones said; null when none is waiting. */
  confirm(phrase: string): Promise<string | null>
}

/** What the surface did with something you said, for the app to show. */
export interface Turn {
  utterance: string
  intent: Intent['kind']
  /** The task it decided on, when the verb needed one. */
  task?: string | null
  /** Why that one: shown so a wrong guess is obvious and correctable. */
  why?: string | null
  reply: string
  at: number
}

export interface VoiceOptions {
  tade: VoiceWorkbench
  speaker: Speaker
  /** Live task and project names, for recognising what you said. */
  vocabulary: () => Promise<Vocabulary>
  /** Where things stand, in a sentence. */
  status: (scope: string | null) => Promise<string>
  /** Where a task lives on disk, for parking it. */
  worktreeOf: (task: string) => Promise<string | null>
  /**
   * Put a task in front of the human, and say how it went. Without it, asking
   * to be shown something can only be answered with directions.
   */
  show?: (task: string) => Promise<string>
  /**
   * Open the settings in place. Without it — `tade chat`, a test — asking for
   * them is answered with the command that opens them.
   */
  openSettings?: () => Promise<string>
  /** The brief, on demand: what is stopped, what is moving, and what extensions found. */
  brief?: () => Promise<string>
  /** Live tasks with their states. Without it, names are taken literally. */
  tasks?: () => Promise<KnownTask[]>
  /** The journal rolled up, so "it" can mean what just moved. */
  history?: () => Promise<WorkHistory>
  /**
   * The terminals along the bottom of the window. Each answers in a sentence.
   * `run` types the command without pressing enter: a misheard command must
   * never run on its own, so it waits for enter, or for "confirm" and its words.
   */
  terminals?: VoiceTerminals
  /**
   * What an extension listens for — "how much is Tade using" — answered in a
   * sentence, or null when none of them does. Asked before the orchestrator.
   */
  extension?: (said: string) => Promise<string | null>
  /** Anything the grammar doesn't recognise, if an orchestrator is running. */
  ask?: (text: string) => Promise<string>
  /** Called when the surface decides which agent you meant. */
  onTurn?: (turn: Turn) => void
  now?: () => number
  /** Local hour, 0–23, for quiet hours. Supplied so machines agree. */
  localHour?: () => number
  surface?: Surface
  settings?: AttentionSettings
  /** Task you are currently typing in, which drops it to earcons. */
  focusedTask?: () => { task: string | null; lastInputAt: number | null }
}

interface Pending {
  intent: Intent
  question: string
  candidates: string[]
}

export class VoiceSurface {
  private readonly opts: VoiceOptions
  private readonly settings: AttentionSettings
  private readonly spokenAt: number[] = []
  /** Things that earned speech but were held back, for the next summary. */
  private readonly held: TadeEvent[] = []
  /** A question we asked, waiting for you to pick one. */
  private pending: Pending | null = null
  private lastAddressed: string | null = null
  private unsubscribe: Unsubscribe | null = null
  /**
   * What is being said, with everything waiting to be said after it: one
   * voice at a time. A reply said over an announcement, or over itself, is
   * noise, whichever of them was worth hearing.
   */
  private speaking: Promise<void> = Promise.resolve()
  /**
   * Which run of speech what is queued belongs to. Silencing moves it on, and
   * everything queued under the old one is dropped where it waits: dropping
   * the chain alone would only stop what had not been chained yet.
   */
  private generation = 0
  /** The words of a streaming reply short of a sentence's end, not said yet. */
  private unsaid = ''
  /** Whether the message arriving now is being said as it streams. */
  private streaming = false
  /** Whether the reply to what was said last has been spoken as it arrived. */
  private spokeReply = false
  /** How much of the answer arriving now has been said out loud, for the limit. */
  private saidOfAnswer = { sentences: 0, chars: 0, rest: false }
  /** Whether the reply to what was said last came from the model, not the grammar. */
  private fromModel = false

  private constructor(opts: VoiceOptions) {
    this.opts = opts
    this.settings = opts.settings ?? DEFAULT_ATTENTION[opts.surface ?? 'voice']
  }

  static async start(opts: VoiceOptions): Promise<VoiceSurface> {
    const surface = new VoiceSurface(opts)
    surface.unsubscribe = await opts.tade.subscribe((event) => void surface.onEvent(event))
    return surface
  }

  /** What has been spoken in the last hour, which is what the budget counts. */
  get spokenInLastHour(): number {
    const cutoff = this.now() - 3_600_000
    return this.spokenAt.filter((at) => at >= cutoff).length
  }

  /** The question we are waiting on an answer to, if any. */
  get awaiting(): { question: string; candidates: string[] } | null {
    return this.pending
      ? { question: this.pending.question, candidates: this.pending.candidates }
      : null
  }

  /** Everything held back, as one sentence. Empty when there is nothing. */
  async flush(): Promise<string> {
    if (this.held.length === 0) return ''
    const text = summarise([...this.held])
    this.held.length = 0
    await this.say(text)
    return text
  }

  async stop(): Promise<void> {
    const unsubscribe = this.unsubscribe
    this.unsubscribe = null
    unsubscribe?.()
  }

  /**
   * Quiet, now. What is being said is cut off where it is and what was queued
   * behind it is dropped — not said later, when whatever made you reach for
   * the mute button has passed.
   */
  async silence(): Promise<void> {
    this.generation += 1
    this.speaking = Promise.resolve()
    this.unsaid = ''
    this.streaming = false
    this.spokeReply = false
    this.startAnswer()
    await this.opts.speaker.stop()
  }

  /** Handle one thing you said. Returns what was said back. */
  async handle(utterance: string): Promise<string> {
    const at = this.now()
    this.spokeReply = false
    this.fromModel = false
    this.startAnswer()

    // Answering the question we just asked.
    if (this.pending) {
      const chosen = resolveAnswer(utterance, this.pending.candidates)
      if (chosen) {
        const { intent } = this.pending
        this.pending = null
        return this.finish(
          utterance,
          intent,
          await this.perform(intent, chosen),
          chosen,
          'you picked it',
          at,
        )
      }
      // Not an answer: drop the question rather than badgering you for it.
      this.pending = null
    }

    const intent = parseUtterance(utterance, await this.opts.vocabulary())
    if (!needsTarget(intent)) {
      return this.finish(utterance, intent, await this.act(intent, utterance), null, null, at)
    }

    const target = await this.resolve(intent)
    if (target.kind === 'ask') {
      this.pending = { intent, question: target.question, candidates: target.candidates }
      const reply = `${target.question} ${target.candidates.map(short).join(', ')}`
      return this.finish(utterance, intent, reply, null, 'more than one matches', at)
    }
    if (target.kind === 'none') {
      return this.finish(
        utterance,
        intent,
        `I couldn't tell which one: ${target.why}.`,
        null,
        target.why,
        at,
      )
    }
    return this.finish(
      utterance,
      intent,
      await this.perform(intent, target.task),
      target.task,
      target.why,
      at,
    )
  }

  private async finish(
    utterance: string,
    intent: Intent,
    reply: string,
    task: string | null,
    why: string | null,
    at: number,
  ): Promise<string> {
    if (task) this.lastAddressed = task
    this.opts.onTurn?.({ utterance, intent: intent.kind, task, why, reply, at })
    if (this.spokeReply) {
      // Said as it arrived: what is left of it, and never the whole of it again.
      this.spokeReply = false
      this.spokenAt.push(this.now())
      this.flushSpeech()
      await this.speaking
    } else if (this.fromModel) {
      // A whole answer, all at once: the finding, not the essay around it.
      await this.say(spokenSummary(reply))
    } else {
      await this.say(reply)
    }
    return reply
  }

  /** Work out which agent a verb was aimed at. */
  private async resolve(intent: Intent): Promise<Target> {
    const spoken = 'task' in intent ? intent.task : ''
    if (!this.opts.tasks) {
      // No context available: take what was said literally.
      return spoken
        ? { kind: 'resolved', task: spoken, why: 'you said so' }
        : { kind: 'none', why: 'I need to know which one' }
    }
    const [tasks, history] = await Promise.all([
      this.opts.tasks(),
      this.opts.history?.() ?? Promise.resolve({ tasks: [], projects: [] }),
    ])
    const focused = this.opts.focusedTask?.() ?? { task: null, lastInputAt: null }
    return resolveTarget(
      spoken || null,
      {
        tasks,
        history,
        focused: focused.task,
        lastAddressed: this.lastAddressed,
        now: this.now(),
      },
      // What the verb implies is an option, not part of the context: spread
      // into the context it is silently ignored.
      preference(intent),
    )
  }

  /** Carry out a verb against a task we have settled on. */
  private async perform(intent: Intent, task: string): Promise<string> {
    switch (intent.kind) {
      case 'park':
      case 'resume': {
        const worktree = await this.opts.worktreeOf(task)
        if (!worktree) return `I don't know where ${short(task)} lives.`
        const parked = intent.kind === 'park'
        await this.opts.tade.parkTask(task, parked)
        return `${parked ? 'Parked' : 'Picked up'} ${short(task)}.`
      }
      case 'steer': {
        const runs = await this.opts.tade.runs()
        if (!runs.some((r) => r.task === task)) return `Nothing is running on ${short(task)}.`
        await this.opts.tade.steerAgent(task, intent.message)
        return `Told ${short(task)}.`
      }
      case 'model': {
        if (!this.opts.tade.setAgentModel) return "I can't change an agent's model from here."
        const chosen = await this.opts.tade.setAgentModel(task, intent.model)
        return `Switching ${short(task)} to ${chosen.id}.`
      }
      case 'focus': {
        // Showing you something is the surface's job: the window can move its
        // own pane, and a driver whose lanes are real windows can raise one.
        // With neither, say where to look rather than pretending it happened.
        const shown = await this.opts.show?.(task)
        return shown ?? `${short(task)}: run tade attach ${task}`
      }
      default:
        return `I can't do that to ${short(task)}.`
    }
  }

  private async act(intent: Intent, utterance: string): Promise<string> {
    switch (intent.kind) {
      case 'status':
        return this.opts.status(intent.scope)

      case 'approve':
      case 'deny':
        return this.decide(intent.kind === 'approve', utterance)

      case 'confirm':
        return this.confirm(intent.phrase, utterance)

      case 'start': {
        const slug = slugify(intent.intent)
        const created = await this.opts.tade.createTask({
          project: intent.project,
          slug,
          // Word for word: nothing else can reconstruct why you started.
          intent: intent.intent,
          by: 'you',
        })
        await this.opts.tade.startAgent({
          task: created.id,
          cwd: created.worktree,
          prompt: intent.intent,
        })
        this.lastAddressed = created.id
        return `Starting ${slug} in ${intent.project}.`
      }

      case 'terminal': {
        const terminals = this.opts.terminals
        if (!terminals) return 'There are no terminals here: open the window to use them.'
        switch (intent.action) {
          case 'open':
            return terminals.open(intent.name)
          case 'show':
            return terminals.show(intent.name)
          case 'close':
            return terminals.close(intent.name)
          case 'rename':
            return terminals.rename(intent.name, intent.to ?? '')
          case 'run':
            return terminals.run(intent.name, intent.command ?? '')
          case 'search':
            return terminals.search(intent.name, intent.text ?? '')
        }
        return "I didn't catch that."
      }

      case 'brief':
        return this.opts.brief ? this.opts.brief() : 'Run `tade brief` for it.'

      case 'settings': {
        // The window can open them in place; anywhere else, say the command.
        const opened = await this.opts.openSettings?.()
        return opened ?? 'Run `tade config` to change settings.'
      }

      case 'remember': {
        if (!this.opts.tade.remember) return "I can't remember things yet."
        // Attached to whatever you were just talking about, and said out loud,
        // because filing it under the wrong task silently would be worse than
        // asking you to correct it.
        const scope = this.lastAddressed
        await this.opts.tade.remember(intent.text, scope, 'voice')
        return scope ? `Noted, about ${short(scope)}.` : 'Noted.'
      }

      default: {
        const heard = await this.opts.extension?.(utterance)
        if (typeof heard === 'string') return heard
        if (this.opts.ask) {
          this.fromModel = true
          return this.opts.ask(utterance)
        }
        return "I didn't catch that."
      }
    }
  }

  /**
   * A spoken yes only ever answers a soft request, and only when there is
   * exactly one. Anything destructive needs the phrase read back.
   */
  private async decide(allow: boolean, said: string): Promise<string> {
    const pending = await this.opts.tade.pendingApprovals()
    if (pending.length === 0) return 'Nothing is waiting.'
    if (pending.length > 1) return `${pending.length} things are waiting. Say which one.`
    const [request] = pending
    if (!request) return 'Nothing is waiting.'
    if (allow && request.tier === 'hard') {
      return `That one needs confirming: ${request.summary}. Say confirm, then what it does.`
    }
    await this.opts.tade.decideApproval(request.run, request.requestId, {
      allow,
      // Kept verbatim in the ledger, so a decision can be explained later in
      // the words that made it.
      said,
      ...(allow ? {} : { reason: 'you said no' }),
    })
    this.lastAddressed = request.task
    return allow ? `Approved: ${request.summary}` : `Denied: ${request.summary}`
  }

  /** The distinct phrase a destructive command requires. */
  private async confirm(phrase: string, said: string): Promise<string> {
    const pending = await this.opts.tade.pendingApprovals()
    const words = phrase
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
    const matches = pending.filter((p) => {
      const summary = p.summary.toLowerCase()
      return words.length > 0 && words.every((word) => summary.includes(word))
    })
    if (matches.length === 0) {
      // Not an approval: perhaps the command voice typed into a terminal.
      const sent = await this.opts.terminals?.confirm(phrase)
      if (sent) return sent
      return `Nothing waiting matches "${phrase}".`
    }
    if (matches.length > 1) return `More than one thing matches "${phrase}". Say more of it.`
    const [request] = matches
    if (!request) return `Nothing waiting matches "${phrase}".`
    await this.opts.tade.decideApproval(request.run, request.requestId, { allow: true, said })
    this.lastAddressed = request.task
    return `Confirmed: ${request.summary}`
  }

  private async onEvent(event: TadeEvent): Promise<void> {
    const focused = this.opts.focusedTask?.() ?? { task: null, lastInputAt: null }
    const decision = decideAttention(
      event,
      {
        now: this.now(),
        surface: this.opts.surface ?? 'voice',
        spokenInLastHour: this.spokenInLastHour,
        focusedTask: focused.task,
        lastKeyboardInputAt: focused.lastInputAt,
        ...(this.opts.localHour ? { localHour: this.opts.localHour() } : {}),
      },
      this.settings,
    )
    if (decision.channel === 'speak') {
      await this.say(`${short(event.task ?? '')} ${describeEvent(event)}`.trim())
      return
    }
    await this.tone(event, decision.channel)
  }

  private async tone(event: TadeEvent, channel: Channel): Promise<void> {
    if (channel !== 'earcon') return
    const tone = toneFor(event)
    if (tone) await this.opts.speaker.earcon(tone)
    // Anything that would have been spoken waits for the next summary, so it
    // is delayed rather than lost.
    if (wouldSpeak(event)) this.held.push(event)
  }

  private async say(text: string): Promise<void> {
    // Tade's own sentences are short already; what they are not is free of
    // the marks a screen wants and an ear does not.
    const words = speakable(text)
    if (words === '') return
    this.spokenAt.push(this.now())
    await this.enqueue(words)
  }

  /**
   * A piece of a reply as it streams in. Each sentence is said as soon as it
   * ends, so a long answer starts being heard before it has finished arriving
   * — its words only: a code block waits for its closing fence and is then
   * dropped, because "backtick backtick backtick t s" is not an answer.
   */
  speakChunk(text: string): void {
    if (!this.streaming) this.startAnswer()
    this.streaming = true
    this.spokeReply = true
    this.unsaid += text
    const { say, keep } = speakableSoFar(this.unsaid)
    this.unsaid = keep
    for (const sentence of say) this.sayOfAnswer(sentence)
  }

  /**
   * A whole message, once all of it has arrived. One that streamed has been
   * said already, all but its last words; only one that did not is said now.
   */
  speakMessage(text: string): void {
    if (!this.streaming) {
      this.startAnswer()
      this.spokeReply = true
      this.unsaid += text
    }
    this.flushSpeech()
  }

  /** Say what is left of a streaming reply, however short of a sentence it is. */
  flushSpeech(): void {
    const rest = this.unsaid
    this.unsaid = ''
    this.streaming = false
    if (rest.trim() === '') return
    const left = this.leftToSay()
    if (!left) return
    const words = spokenSummary(rest, left)
    if (words !== '') this.count(words)
  }

  /** An answer is a new budget: what the last one used is not held against it. */
  private startAnswer(): void {
    this.saidOfAnswer = { sentences: 0, chars: 0, rest: false }
  }

  /**
   * One sentence of an answer, while there is room for it. Past that, the
   * rest is said to be on the screen — once — and left there. A spoken answer
   * is a summary of what was found; the whole of it is to be read.
   */
  private sayOfAnswer(sentence: string): void {
    const left = this.leftToSay()
    if (!left) return
    this.count(sentence.length > left.chars ? spokenSummary(sentence, left) : sentence)
  }

  /** What is left of this answer's budget, or null once it is spent. */
  private leftToSay(): { sentences: number; chars: number } | null {
    const said = this.saidOfAnswer
    const sentences = SPOKEN_LIMITS.sentences - said.sentences
    const chars = SPOKEN_LIMITS.chars - said.chars
    if (sentences > 0 && chars > 0) return { sentences, chars }
    if (!said.rest) {
      said.rest = true
      void this.enqueue(REST_ON_SCREEN)
    }
    return null
  }

  private count(words: string): void {
    if (words === '') return
    this.saidOfAnswer.sentences += 1
    this.saidOfAnswer.chars += words.length
    if (words.endsWith(REST_ON_SCREEN)) this.saidOfAnswer.rest = true
    void this.enqueue(words)
  }

  /** Said once everything already waiting has been, never over it. */
  private enqueue(text: string): Promise<void> {
    const generation = this.generation
    const spoken = this.speaking.then(async () => {
      // Silenced while it waited its turn: dropped, not said afterwards.
      if (generation !== this.generation) return
      try {
        await this.opts.speaker.speak(text)
      } catch (err) {
        // Said where it can be read, rather than going quiet.
        const reason = err instanceof Error ? err.message : String(err)
        this.opts.onTurn?.({
          utterance: '',
          intent: 'status',
          reply: `Speech failed: ${reason}`,
          at: this.now(),
        })
      }
    })
    this.speaking = spoken
    return spoken
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}

/** Verbs that are aimed at one agent. */
function needsTarget(intent: Intent): boolean {
  return (
    intent.kind === 'park' ||
    intent.kind === 'resume' ||
    intent.kind === 'steer' ||
    intent.kind === 'model' ||
    intent.kind === 'focus'
  )
}

/** What sort of task a verb implies, when you didn't name one. */
function preference(intent: Intent): { prefer?: ResolveOptions['prefer'] } {
  if (intent.kind === 'steer' || intent.kind === 'model') return { prefer: 'running' }
  return {}
}

/**
 * The sound for something worth a sound: waiting on you, or failing. An agent
 * answering is not — a beep every time one finished a turn was a beep every
 * few seconds, and the transcript already shows it.
 */
function toneFor(event: TadeEvent): Tone | null {
  if (event.type === 'permission_request') return 'blocked'
  if (event.type === 'failed') return 'failed'
  if (event.type === 'state_change') {
    const state = String(event.detail.state)
    if (state === 'blocked') return 'blocked'
    if (state === 'failed') return 'failed'
  }
  return null
}

function wouldSpeak(event: TadeEvent): boolean {
  return event.urgency === 'blocking' || event.type === 'state_change'
}

/** Task ids are `project/name`; say the name. */
function short(task: string): string {
  return task.split('/').at(-1) ?? task
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join('-')
  return slug.length > 0 ? slug : 'task'
}
