import {
  type AttentionSettings,
  type Channel,
  DEFAULT_ATTENTION,
  decideAttention,
  describeEvent,
  type Intent,
  parseUtterance,
  type Surface,
  summarise,
  type Vocabulary,
  type WilcoEvent,
} from '@wilco/core'
import type { Speaker, Tone } from './speaker.ts'

// Voice as a surface, not as the architecture. It listens to text (from a
// transcriber, a dictation app, or a keyboard), turns it into one of a small
// set of verbs, and says back what happened. Anything it doesn't recognise
// goes to the orchestrator untouched.
//
// Two rules run through all of it: it never guesses which of several things
// you meant, and a bare yes can never carry out something destructive.

/** The slice of the daemon this surface uses. `DaemonClient` satisfies it. */
export interface VoiceDaemon {
  pendingApprovals(
    task?: string,
  ): Promise<Array<{ run: string; requestId: string; task: string; summary: string; tier: string }>>
  decideApproval(
    run: string,
    requestId: string,
    decision: { allow: boolean; reason?: string },
  ): Promise<void>
  runs(): Promise<Array<{ run: string; task: string }>>
  steerRun(run: string, message: string): Promise<void>
  parkTask(worktree: string, parked: boolean): Promise<{ task: string; parked: boolean }>
  createTask(request: {
    project: string
    slug: string
    intent: string
  }): Promise<{ id: string; worktree: string }>
  startRun(request: { task: string; cwd: string; prompt: string }): Promise<{ run: string }>
  subscribe(handler: (event: WilcoEvent) => void): Promise<string>
}

export interface VoiceOptions {
  daemon: VoiceDaemon
  speaker: Speaker
  /** Live task and project names, for resolving what you said. */
  vocabulary: () => Promise<Vocabulary>
  /** Where things stand, in a sentence. */
  status: (scope: string | null) => Promise<string>
  /** Where a task lives on disk, for parking it. */
  worktreeOf: (task: string) => Promise<string | null>
  /** Anything the grammar doesn't recognise, if an orchestrator is running. */
  ask?: (text: string) => Promise<string>
  now?: () => number
  /**
   * Local hour, 0–23, for quiet hours. Supplied rather than derived so the
   * same inputs behave the same way on every machine.
   */
  localHour?: () => number
  surface?: Surface
  settings?: AttentionSettings
  /** Task you are currently typing in, which drops it to earcons. */
  focusedTask?: () => { task: string | null; lastInputAt: number | null }
}

export class VoiceSurface {
  private readonly opts: VoiceOptions
  private readonly settings: AttentionSettings
  private readonly spokenAt: number[] = []
  /** Things that earned speech but were held back, for the next summary. */
  private readonly held: WilcoEvent[] = []
  private subscription: string | null = null

  private constructor(opts: VoiceOptions) {
    this.opts = opts
    this.settings = opts.settings ?? DEFAULT_ATTENTION[opts.surface ?? 'voice']
  }

  static async start(opts: VoiceOptions): Promise<VoiceSurface> {
    const surface = new VoiceSurface(opts)
    surface.subscription = await opts.daemon.subscribe((event) => void surface.onEvent(event))
    return surface
  }

  /** What has been spoken in the last hour, which is what the budget counts. */
  get spokenInLastHour(): number {
    const cutoff = this.now() - 3_600_000
    return this.spokenAt.filter((at) => at >= cutoff).length
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
    this.subscription = null
  }

  /** Handle one thing you said. Returns what was said back. */
  async handle(utterance: string): Promise<string> {
    const vocabulary = await this.opts.vocabulary()
    const intent = parseUtterance(utterance, vocabulary)
    const reply = await this.act(intent, utterance)
    await this.say(reply)
    return reply
  }

  private async act(intent: Intent, utterance: string): Promise<string> {
    switch (intent.kind) {
      case 'status':
        return this.opts.status(intent.scope)

      case 'park':
      case 'resume': {
        const worktree = await this.opts.worktreeOf(intent.task)
        if (!worktree) return `I don't know a task called ${short(intent.task)}`
        const parked = intent.kind === 'park'
        await this.opts.daemon.parkTask(worktree, parked)
        return `${parked ? 'Parked' : 'Picked up'} ${short(intent.task)}.`
      }

      case 'steer': {
        const runs = await this.opts.daemon.runs()
        const run = runs.find((r) => r.task === intent.task)
        if (!run) return `Nothing is running on ${short(intent.task)}.`
        await this.opts.daemon.steerRun(run.run, intent.message)
        return `Told ${short(intent.task)}.`
      }

      case 'approve':
      case 'deny':
        return this.decide(intent.kind === 'approve')

      case 'confirm':
        return this.confirm(intent.phrase)

      case 'focus': {
        // Raising a window is the workspace driver's job, and the default one
        // cannot do it, so say where to look instead of pretending.
        return `${short(intent.task)}: run wilco attach ${intent.task}`
      }

      case 'start': {
        const slug = slugify(intent.intent)
        const created = await this.opts.daemon.createTask({
          project: intent.project,
          slug,
          // Word for word: nothing else can reconstruct why you started.
          intent: intent.intent,
        })
        await this.opts.daemon.startRun({
          task: created.id,
          cwd: created.worktree,
          prompt: intent.intent,
        })
        return `Starting ${slug} in ${intent.project}.`
      }

      case 'remember':
        return "I can't remember things yet."

      default:
        if (this.opts.ask) return this.opts.ask(utterance)
        return "I didn't catch that."
    }
  }

  /**
   * A spoken yes only ever answers a soft request, and only when there is
   * exactly one. Anything destructive needs the phrase read back.
   */
  private async decide(allow: boolean): Promise<string> {
    const pending = await this.opts.daemon.pendingApprovals()
    if (pending.length === 0) return 'Nothing is waiting.'
    if (pending.length > 1) {
      return `${pending.length} things are waiting. Say which one.`
    }
    const [request] = pending
    if (!request) return 'Nothing is waiting.'
    if (allow && request.tier === 'hard') {
      return `That one needs confirming: ${request.summary}. Say confirm, then what it does.`
    }
    await this.opts.daemon.decideApproval(request.run, request.requestId, {
      allow,
      ...(allow ? {} : { reason: 'you said no' }),
    })
    return allow ? `Approved: ${request.summary}` : `Denied: ${request.summary}`
  }

  /** The distinct phrase a destructive command requires. */
  private async confirm(phrase: string): Promise<string> {
    const pending = await this.opts.daemon.pendingApprovals()
    const words = phrase
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2)
    const matches = pending.filter((p) => {
      const summary = p.summary.toLowerCase()
      return words.length > 0 && words.every((word) => summary.includes(word))
    })
    if (matches.length === 0) return `Nothing waiting matches "${phrase}".`
    if (matches.length > 1) return `More than one thing matches "${phrase}". Say more of it.`
    const [request] = matches
    if (!request) return `Nothing waiting matches "${phrase}".`
    await this.opts.daemon.decideApproval(request.run, request.requestId, { allow: true })
    return `Confirmed: ${request.summary}`
  }

  private async onEvent(event: WilcoEvent): Promise<void> {
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

  private async tone(event: WilcoEvent, channel: Channel): Promise<void> {
    if (channel !== 'earcon') return
    const tone = toneFor(event)
    if (tone) await this.opts.speaker.earcon(tone)
    // Anything that would have been spoken waits for the next summary, so it
    // is delayed rather than lost.
    if (wouldSpeak(event)) this.held.push(event)
  }

  private async say(text: string): Promise<void> {
    if (text.trim() === '') return
    this.spokenAt.push(this.now())
    await this.opts.speaker.speak(text)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}

function toneFor(event: WilcoEvent): Tone | null {
  if (event.type === 'permission_request') return 'blocked'
  if (event.type === 'failed') return 'failed'
  if (event.type === 'turn_done') return 'review'
  if (event.type === 'state_change') {
    const state = String(event.detail.state)
    if (state === 'blocked') return 'blocked'
    if (state === 'review') return 'review'
    if (state === 'failed') return 'failed'
  }
  return null
}

function wouldSpeak(event: WilcoEvent): boolean {
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
