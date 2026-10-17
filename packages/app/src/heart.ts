import { printable, type TadeEvent, titlesOf } from '@tade/core'
import type { StatusAsk } from '@tade/status'
import type { LayoutPrefs } from './layout.ts'
import { Live } from './live.ts'
import {
  type AppState,
  initialState,
  notice,
  onEvent,
  type TaskSnapshot,
  withProjects,
  withTasks,
  withTerminals,
} from './model.ts'
import { type Entry, REPEAT_MS } from './transcript.ts'
import { type AppOptions, clockOf, type Wiring, wiringFor } from './wire/context.ts'
import type { Tellable } from './wire/handed.ts'
import { Intake } from './wire/intake.ts'
import { Queue, type QueueTools } from './wire/queue.ts'
import { Schedules, type WatchTools } from './wire/schedules.ts'
import { noTwins, type WatchTwinsHere } from './wire/watch-where.ts'

// The part of the window that runs with no screen: the beat, and on it the
// queue, schedules and watches, and intake.
//
// `tade app` is this with a face over it (`App`), and `tade serve` is this
// alone, for a machine nobody sits at. It is the same program holding the same
// lock, so every rule that says "while a window is open" is still literally
// true: a window may simply have no screen. Nothing here draws, reads a key or
// takes a terminal — `test/heart.test.ts` holds what it may reach to that — and
// everything that would have been drawn is still put in the state, which is
// where a face finds it and where `said` hears it when there is none.
//
// What a face adds is `Face`: a frame to ask for, the orchestrator to tell,
// the links' answers about other machines, and its own halves of a beat. None
// of it is needed for the work to go on, so a face that is not there answers
// every member with nothing (`screenless`), and the work goes on the same.

/** What a face adds to the heart. */
export interface Face {
  /** Ask for a frame. */
  draw(): void
  /** Something was typed into a lane (`Outbox`). */
  typed(): void
  /** How the window is divided right now. */
  layout(): LayoutPrefs
  /** A reader found a look due: look soon. */
  due(): void
  /**
   * The orchestrator, to tell now or keep news for. Asked for at the moment
   * of telling, because a face makes its own after the heart.
   */
  orchestrator(): Tellable
  /** What the links know of other machines' watches on one project's repository. */
  twins(project: string): WatchTwinsHere
  /** What only the face's links know, handed to every look: other machines' branches here. */
  asked(): Pick<StatusAsk, 'elsewhere'>
  /** A beat's tasks, taken into the state, before the queue and the schedules have them. */
  sawTasks(tasks: readonly TaskSnapshot[]): void
  /** The same beat after them, with whether it found anything the last did not. */
  beat(tasks: readonly TaskSnapshot[], moved: boolean): void
  /** A journal line, once the state has taken it in. */
  heard(event: TadeEvent): void
  /** An agent that started without a branch has changed something, so its work needs one. */
  work(task: { id: string; project: string; worktree: string; title: string }): void
}

/** A line Tade said in the conversation: what a face draws, and what is written where there is none. */
export type Said = Extract<Entry, { kind: 'tade' | 'problem' }>

/** What a face that is not there reads of the heart: its look, its state and its clock. */
export interface Beating {
  look(): void
  readonly state: AppState
  readonly wire: Pick<Wiring, 'now'>
}

/** How the words that went to an orchestrator that is not there begin, in the log. */
export const NOBODY_TO_TELL = 'for the orchestrator, which is not here:'

/**
 * The orchestrator where there is none: never started, so nothing is told now.
 *
 * What would have waited for it as news is said instead — most of it the
 * conversation has just said in the same words, and it is not said twice, so
 * what is left is what was only ever for it: what a schedule asks, the work a
 * watch parked for it to decide. Looked at once what made it has finished, the
 * same turn, because a schedule tells before it says.
 */
function nobodyToTell(heart: () => Beating, said: (line: Said) => void): Tellable {
  return {
    started: false,
    tell: async () => {},
    note: (text) =>
      queueMicrotask(() => {
        const { state, wire } = heart()
        const at = wire.now()
        const was = state.transcript.heard[text]
        if (was !== undefined && at - was < REPEAT_MS) return
        said({ kind: 'tade', text: `${NOBODY_TO_TELL} ${text}`, at })
      }),
  }
}

/**
 * The answers of a face that is not there: nothing drawn, nobody to tell and
 * so what was for the orchestrator said, and no other machine.
 */
export function screenless(heart: () => Beating, said: (line: Said) => void): Face {
  const nobody = nobodyToTell(heart, said)
  return {
    draw: () => {},
    typed: () => {},
    layout: () => ({}),
    // With no screen there is no look on a clock of its own: the heart looks
    // on its beat, and as soon as a reader asks.
    due: () => heart().look(),
    orchestrator: () => nobody,
    twins: () => noTwins(),
    asked: () => ({}),
    sawTasks: () => {},
    beat: () => heart().look(),
    heard: () => {},
    work: () => {},
  }
}

/**
 * A line said, as a log writes it where there is no screen: its time, the
 * conversation's `✗` where it is trouble, and the text made printable — it may
 * carry a ticket's title or a provider's error.
 */
export function saidLine(line: Said): string {
  return `${clockOf(line.at)} ${line.kind === 'problem' ? '✗ ' : ''}${printable(line.text)}`
}

/** The lines in `now` that `was` did not have, oldest first: what was said since. */
export function saidSince(was: readonly Entry[], now: readonly Entry[]): Said[] {
  if (was === now) return []
  const before = new Set(was)
  return now.filter(
    (entry): entry is Said =>
      !before.has(entry) && (entry.kind === 'tade' || entry.kind === 'problem'),
  )
}

export class Heart {
  private readonly opts: AppOptions
  private readonly face: Face
  private current: AppState = initialState()
  private looked: Live | null = null
  /** What hears every line Tade says, where nothing draws it; none under a face. */
  private readonly said: ((line: Said) => void) | null
  /** What every subject is handed: the face's as well as the heart's own. */
  readonly wire: Wiring
  /** Queued work: what is ready, what is held, and what starts it. */
  readonly queue: Queue
  /** What is due, what a watch found, and what one run of either does. */
  readonly schedules: Schedules
  /** What has been handed to this machine from outside, and what is due to be said back. */
  readonly intake: Intake

  constructor(opts: AppOptions, face: Face, said: ((line: Said) => void) | null = null) {
    this.opts = opts
    this.face = face
    this.said = said
    this.wire = wiringFor(opts, {
      state: () => this.current,
      put: (next) => this.put(next),
      live: () => this.looked,
      now: () => this.now(),
      layout: () => face.layout(),
      draw: () => face.draw(),
      typed: () => face.typed(),
    })
    this.queue = new Queue(this.wire, {
      news: (said) => face.orchestrator().note(said),
      tell: (text) => face.orchestrator().tell(text),
      schedules: {
        views: () => this.schedules.views(),
        set: (req) => this.schedules.set(req),
        runNow: (id, asked) => this.schedules.runNow(id, asked),
      },
    })
    this.schedules = new Schedules(this.wire, {
      news: (said) => face.orchestrator().note(said),
      orchestrator: () => face.orchestrator(),
      advanceQueue: () => void this.advanceQueue(),
      twins: (project) => face.twins(project),
    })
    this.intake = new Intake(this.wire, { advanceQueue: () => void this.advanceQueue() })
  }

  /**
   * The heart with no face: it looks on its own beat, and every line it says
   * goes to `said` — a service's log, where a window would have drawn it.
   */
  static async alone(opts: AppOptions, said: (line: Said) => void): Promise<Heart> {
    // Read only once the beat has begun, by when `heart` is this one.
    const heart: Heart = new Heart(
      opts,
      screenless(() => heart, said),
      said,
    )
    await heart.begin()
    return heart
  }

  /** The state as it is: what a face draws, and what the work writes. */
  get state(): AppState {
    return this.current
  }

  /** The only writer, for the face as for the work; what was said goes to `said`, if anything hears. */
  put(next: AppState): void {
    const was = this.current.transcript.entries
    this.current = next
    if (this.said) for (const line of saidSince(was, next.transcript.entries)) this.said(line)
  }

  /** The world as last looked at, or null before the beat has started. */
  get live(): Live | null {
    return this.looked
  }

  /**
   * Start the beat: every project in the state, then the status look on its
   * clock, each of its answers taken in and handed to the work and the face.
   */
  async begin(): Promise<Live> {
    const face = this.face
    // Every project, before any of them has a task: an empty one is still a
    // tab you can be standing in when you start work.
    const config = this.opts.config
    this.put(withProjects(this.current, Object.keys(config.projects), titlesOf(config)))
    this.looked = await Live.start({
      client: this.opts.client,
      config: this.opts.config,
      home: this.opts.home,
      tadeHome: this.opts.home,
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
      openedAt: this.wire.openedAt,
      status: this.opts.status,
      onTasks: (tasks, moved) => {
        this.put(withTasks(this.current, tasks))
        face.sawTasks(tasks)
        void this.queue.recordRulesMet()
        void this.schedules.runDue().then(() => this.advanceQueue())
        face.beat(tasks, moved)
      },
      onEvent: (event) => {
        this.put(onEvent(this.current, event, this.now()))
        face.heard(event)
      },
      onWarning: (message) => {
        this.put(notice(this.current, message, this.now()))
        face.draw()
      },
      onChange: () => face.draw(),
      onDue: () => face.due(),
      onWork: (task) => face.work(task),
      onTerminals: (terminals) => {
        this.put(withTerminals(this.current, terminals))
        face.draw()
      },
      asked: () => face.asked(),
    })
    return this.looked
  }

  /** The heart's part of a look: the inbox folded where the journal grew, and what a reader found due. */
  look(): void {
    this.intake.look()
    void this.looked?.lookAgain()
  }

  /** Start whatever queued work is ready, and say what is held. */
  advanceQueue(): Promise<string[]> {
    return this.queue.advance()
  }

  /** What the orchestrator's queue tools do, answered here. */
  queueTools(): QueueTools {
    return this.queue.tools()
  }

  /** What the orchestrator's watch tools do, answered here. */
  watchTools(): WatchTools {
    return this.schedules.tools()
  }

  /** Stop the beat. The agents are the workbench's, and go on. */
  async stop(): Promise<void> {
    await this.looked?.stop()
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}
