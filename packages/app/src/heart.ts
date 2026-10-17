import { type Arming, printable, type TadeEvent, titlesOf } from '@tade/core'
import type { StatusAsk } from '@tade/status'
import { agentEnded, eventNews } from './inbox.ts'
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
import { Agents, type AgentsDeps } from './wire/agents.ts'
import { type AppOptions, clockOf, type Thinker, type Wiring, wiringFor } from './wire/context.ts'
import { type Tellable, tellNow, tellOrKeep } from './wire/handed.ts'
import { Intake } from './wire/intake.ts'
import { LinearTokens, lending } from './wire/linear-tokens.ts'
import { Orchestrator, type OrchestratorDeps } from './wire/orchestrator.ts'
import { Projects, type ProjectsDeps, type ProjectTools } from './wire/projects.ts'
import { Queue, type QueueTools } from './wire/queue.ts'
import { Schedules, type WatchTools } from './wire/schedules.ts'
import { Settings, type SettingsDeps, type SettingTools } from './wire/settings.ts'
import { noTwins, type WatchTwinsHere } from './wire/watch-where.ts'
import { Away, type AwayDeps } from './wire/web.ts'
import { talkingThrough } from './wire/web-asking.ts'

// The part of the window that runs with no screen: the beat, and on it the
// queue, schedules and watches, and intake; the orchestrator, told what
// happened and deciding; the away view and the notifications it sends; and
// the subjects those act through — the one door a setting is written by,
// opening and closing a project, stopping and opening an agent again.
//
// `tade app` is this with a face over it (`App`), and `tade serve` is this
// alone, for a machine nobody sits at. It is the same program holding the same
// lock, so every rule that says "while a window is open" is still literally
// true: a window may simply have no screen. Nothing here draws, reads a key or
// takes a terminal — `test/heart.test.ts` holds what it may reach to that — and
// everything that would have been drawn is still put in the state, which is
// where a face finds it and where `said` hears it when there is none.
//
// What a face adds is `Face`: a frame to ask for, the links' answers about
// other machines, its own halves of a beat, and the screen's half of each
// subject made here — a page to refresh, a sound to stop, a clipboard. None of
// it is needed for the work to go on, so a face that is not there answers
// every member with nothing (`screenless`), and the work goes on the same.

/** The Settings page's half: what the accounts, models, sounds and clipboard of a screen answer. */
export type SettingsFace = Omit<SettingsDeps, 'tellThinking' | 'away'>
/** An agent's menu and the line you type on: what a press in front of somebody reaches. */
export type AgentsFace = Omit<AgentsDeps, 'useConfig' | 'changeQueue'>
/** Where the window was, written down as a project opens or closes. */
export type ProjectsFace = Pick<ProjectsDeps, 'rememberWindow'>
/** The conversation's screen: where it is scrolled, what is said aloud, the line it was typed on. */
export type OrchestratorFace = Omit<OrchestratorDeps, 'useConfig' | 'nobodyHere'>
/** The pairing link's `Copy`, which is a clipboard. */
export type AwayFace = Pick<AwayDeps, 'copy'>

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
  /** What the links know of other machines' watches on one project's repository. */
  twins(project: string): WatchTwinsHere
  /** What only the face's links know, handed to every look: other machines' branches here. */
  asked(): Pick<StatusAsk, 'elsewhere'>
  /** A beat's tasks, taken into the state, before the queue and the schedules have them. */
  sawTasks(tasks: readonly TaskSnapshot[]): void
  /** The same beat after them, with whether it found anything the last did not. */
  beat(tasks: readonly TaskSnapshot[], moved: boolean): void
  /** A journal line, once the state has taken it in and the orchestrator has been told it. */
  heard(event: TadeEvent): void
  /** A terminal turned an MCP server on or off: the extensions read again (`Settings.fold`). */
  serversMoved(): Promise<void>
  settings: SettingsFace
  agents: AgentsFace
  projects: ProjectsFace
  orchestrator: OrchestratorFace
  away: AwayFace
}

/**
 * A line said in the conversation: what a face draws, and what is written
 * where there is none — Tade's own lines and its trouble, and the
 * conversation with the orchestrator, settled (`saidSince`).
 */
export type Said = Extract<Entry, { kind: 'tade' | 'problem' | 'said' | 'you' | 'tool' }>

/** What a face that is not there reads of the heart: its look, its state and its clock. */
export interface Beating {
  look(): void
  readonly state: AppState
  readonly wire: Pick<Wiring, 'now'>
}

/** How the words that went to an orchestrator that is not running begin, in the log. */
export const NOBODY_TO_TELL = 'for the orchestrator, which is not running:'

/**
 * What an orchestrator that came up is told, where what came for it while it
 * was starting is waiting and nothing draws: under the news it carries.
 */
export const WHILE_STARTING =
  'What is above came for you while you were starting. Nobody types here to bring it with their next words, so it is told now: act on it as you would have when it came.'

/**
 * Where there is no screen, what is told an orchestrator that is not running
 * — still starting, or never started — is said in the log as well.
 *
 * It is still kept as news where it was (`Orchestrator.note`), so one that
 * comes up hears it (`WHILE_STARTING`). Most of it the conversation has just
 * said in the same words, and that is not said twice, so what is left is what
 * was only ever for it: what a schedule asks, the work a watch parked for it to
 * decide — and that is what is `owed` it. Looked at once what made it has
 * finished, the same turn, because a schedule tells before it says.
 */
function nobodyToTell(
  heart: () => Beating,
  said: (line: Said) => void,
  owed: () => void,
): (text: string) => void {
  return (text) =>
    queueMicrotask(() => {
      const { state, wire } = heart()
      const at = wire.now()
      const was = state.transcript.heard[text]
      if (was !== undefined && at - was < REPEAT_MS) return
      owed()
      said({ kind: 'tade', text: `${NOBODY_TO_TELL} ${text}`, at })
    })
}

/**
 * The orchestrator as the heart tells it, written in the log too while it is
 * not running. Told then, it is kept as news rather than let go, so that one
 * coming up is told it.
 */
function toldOrSaid(orchestrator: Tellable, said: ((text: string) => void) | null): Tellable {
  if (said === null) return orchestrator
  return {
    get started() {
      return orchestrator.started
    },
    tell: async (text) => {
      if (orchestrator.started) return orchestrator.tell(text)
      orchestrator.note(text)
      said(text)
    },
    note: (text) => {
      orchestrator.note(text)
      if (!orchestrator.started) said(text)
    },
  }
}

/**
 * The answers of a face that is not there: nothing drawn, no other machine,
 * and the screen's half of every subject nothing — no page to refresh, no
 * sound to stop, no clipboard, no line to put words back on. What a press
 * would have reached is never reached, because nothing presses.
 */
export function screenless(heart: () => Beating): Face {
  const nothing = async () => {}
  return {
    draw: () => {},
    typed: () => {},
    layout: () => ({}),
    // With no screen there is no look on a clock of its own: the heart looks
    // on its beat, and as soon as a reader asks.
    due: () => heart().look(),
    twins: () => noTwins(),
    asked: () => ({}),
    sawTasks: () => {},
    beat: () => heart().look(),
    heard: () => {},
    serversMoved: nothing,
    settings: {
      loadAccounts: () => {},
      refreshModels: nothing,
      lookAtWhatIsInstalled: () => {},
      setupChanged: () => {},
      silence: () => {},
      accountAction: nothing,
      remoteAction: nothing,
      updateAction: nothing,
      testMicrophone: nothing,
      openFile: nothing,
      copy: async () => false,
      releases: () => false,
      holdSleep: () => {},
    },
    agents: {
      prefill: () => {},
      openChange: nothing,
      openPlace: nothing,
      copyToClipboard: async () => false,
      routes: () => ({ offersFor: () => null, openModels: nothing, openAccount: nothing }),
      handsOver: () => null,
    },
    projects: { rememberWindow: () => {} },
    orchestrator: {
      // Nothing scrolls back where nothing is drawn.
      anchored: (next) => next,
      voice: {
        ready: () => false,
        awaiting: () => null,
        handle: async () => '',
        speakChunk: () => {},
        speakMessage: () => {},
        flushSpeech: () => {},
      },
      remember: () => {},
      credentialProblem: () => null,
    },
    away: { copy: async () => false },
  }
}

/**
 * A line said, as a log writes it where there is no screen: its time, the
 * conversation's `✗` where it is trouble, who said it where it was not Tade,
 * and the text made printable — it may carry a ticket's title, a provider's
 * error or a device's words.
 */
export function saidLine(line: Said): string {
  const words = (() => {
    switch (line.kind) {
      case 'problem':
        return `✗ ${line.text}`
      case 'said':
        return line.by === 'orchestrator' ? `orchestrator: ${line.text}` : line.text
      case 'you':
        return `${line.from}: ${line.text}`
      case 'tool': {
        const what = [line.tool, line.detail].filter(Boolean).join(' ')
        return `orchestrator ran ${what}: ${line.state === 'ok' ? 'done' : `failed${line.result ? ` — ${line.result}` : ''}`}`
      }
      default:
        return line.text
    }
  })()
  return `${clockOf(line.at)} ${printable(words)}`
}

/** Whether a line is settled enough to be said: a reply that is still arriving, or a tool still running, is not yet. */
function settled(entry: Entry): entry is Said {
  switch (entry.kind) {
    case 'tade':
    case 'problem':
    case 'you':
      return true
    case 'said':
      return !entry.streaming
    case 'tool':
      return entry.state !== 'running'
    default:
      return false
  }
}

/** The lines in `now` that `was` did not have, oldest first: what was said since. */
export function saidSince(was: readonly Entry[], now: readonly Entry[]): Said[] {
  if (was === now) return []
  const before = new Set(was)
  return now.filter((entry): entry is Said => !before.has(entry) && settled(entry))
}

export class Heart {
  private readonly opts: AppOptions
  private readonly face: Face
  private current: AppState = initialState()
  private looked: Live | null = null
  /** What hears every line Tade says, where nothing draws it; none under a face. */
  private readonly said: ((line: Said) => void) | null
  /** The orchestrator as everything here tells it (`toldOrSaid`). */
  private readonly told: Tellable
  /** Something only for the orchestrator came while it was not running, and nothing draws. */
  private owed = false
  /** What every subject is handed: the face's as well as the heart's own. */
  readonly wire: Wiring
  /** Queued work: what is ready, what is held, and what starts it. */
  readonly queue: Queue
  /** What is due, what a watch found, and what one run of either does. */
  readonly schedules: Schedules
  /** What has been handed to this machine from outside, and what is due to be said back. */
  readonly intake: Intake
  /** The one door a setting is written by, and the page a face draws for it. */
  readonly settings: Settings
  /** Opening, closing and naming projects. */
  readonly projects: Projects
  /** Making an agent, opening one again, stopping it, taking it away. */
  readonly agents: Agents
  /**
   * The Linear app's tokens, refreshed when a look or the connect page asks.
   * Held here rather than by the away view, which may be off: the watches read
   * with it whether or not anything serves /connect.
   */
  readonly linear: LinearTokens
  /** The thing you talk to: what it is told, what it answers, and whose turn it is. */
  readonly orchestrator: Orchestrator
  /** The away view and its notifications: who may read Tade from off this machine. */
  readonly away: Away

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
    this.settings = new Settings(this.wire, {
      ...face.settings,
      tellThinking: (level) => this.orchestrator.tellThinking(level),
      silence: () => {
        this.orchestrator.stopSpeaking()
        face.settings.silence()
      },
      away: () => this.away,
    })
    this.orchestrator = new Orchestrator(this.wire, {
      ...face.orchestrator,
      useConfig: (config) => this.settings.use(config),
      nobodyHere: () => this.away.nobodyHere(),
    })
    this.told = toldOrSaid(
      this.orchestrator,
      said === null
        ? null
        : nobodyToTell(
            () => this,
            said,
            () => {
              this.owed = true
            },
          ),
    )
    this.queue = new Queue(this.wire, {
      news: (words) => this.told.note(words),
      tell: (text) => this.told.tell(text),
      schedules: {
        views: () => this.schedules.views(),
        set: (req) => this.schedules.set(req),
        runNow: (id, asked) => this.schedules.runNow(id, asked),
      },
    })
    this.schedules = new Schedules(this.wire, {
      news: (words) => this.told.note(words),
      orchestrator: () => this.told,
      advanceQueue: () => void this.advanceQueue(),
      twins: (project) => face.twins(project),
    })
    this.intake = new Intake(this.wire, { advanceQueue: () => void this.advanceQueue() })
    this.projects = new Projects(this.wire, {
      ...face.projects,
      useConfig: (loaded) => this.settings.use(loaded),
      changeSetting: (req) => this.settings.change(req),
      writeSetting: (path, value) => this.settings.write(path, value),
      openSettings: (page, find, project) => this.settings.open(page, find, project),
    })
    this.agents = new Agents(this.wire, {
      ...face.agents,
      useConfig: (config) => this.settings.use(config),
      changeQueue: (task, change) => this.queue.change(task, change),
    })
    this.linear = new LinearTokens({
      config: () => this.wire.opts.config,
      settings: this.settings,
      now: () => this.now(),
      told: (words) => this.told.note(words),
    })
    this.wire.opts.extensions?.useConnected(lending(this.linear))
    this.away = new Away(this.wire, {
      ...face.away,
      decided: (allow) => this.agents.decide(allow),
      news: (words) => this.told.note(words),
      // The conversation, through the one subject that holds it: `Talking` is
      // five methods, so what a route can reach is that list and not `say`.
      talk: talkingThrough(() => this.orchestrator),
      // The queue's own rule, so a device approving work that came from
      // outside meets the same grant, plan and source checks a start does.
      stands: (row) => this.queue.standsFor(row),
      // The factory floor, as the inbox subject already folds it: no page starts work.
      factory: () => this.intake.factory(),
      // A file edit writes no journal line, so the fold is told.
      saved: () => this.intake.markStale(),
      // The one door a setting is written by: the key nothing types, and a change from away.
      settings: this.settings,
      // Stopping and closing from away, through the same doors a press goes through.
      lifecycle: { agents: () => this.agents, projects: () => this.projects },
      doorbell: { wake: (id, item) => this.schedules.wake(id, item) },
      linear: this.linear,
    })
  }

  /**
   * The heart with no face: it looks on its own beat, and every line it says
   * goes to `said` — a service's log, where a window would have drawn it.
   */
  static async alone(opts: AppOptions, said: (line: Said) => void): Promise<Heart> {
    // Read only once the beat has begun, by when `heart` is this one.
    const heart: Heart = new Heart(
      opts,
      screenless(() => heart),
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
   * clock, each of its answers taken in and handed to the work and the face;
   * then the agents that were working when Tade closed opened again, and the
   * away view listening where a person turned it on.
   */
  async begin(): Promise<Live> {
    const face = this.face
    // Every project, before any of them has a task: an empty one is still a
    // tab you can be standing in when you start work.
    const config = this.opts.config
    this.put(withProjects(this.current, Object.keys(config.projects), titlesOf(config)))
    const live = await Live.start({
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
        this.orchestrator.noteTasks(tasks)
        face.sawTasks(tasks)
        void this.queue.recordRulesMet()
        void this.schedules.runDue().then(() => this.advanceQueue())
        void this.orchestrator.reflect(tasks)
        this.away.beat()
        void this.settings.fold(() => face.serversMoved())
        face.beat(tasks, moved)
      },
      onEvent: (event) => {
        this.put(onEvent(this.current, event, this.now()))
        this.heard(event)
        face.heard(event)
      },
      onWarning: (message) => {
        this.put(notice(this.current, message, this.now()))
        face.draw()
      },
      onChange: () => face.draw(),
      onDue: () => face.due(),
      // An agent that started without a branch has changed something, so its work needs one.
      onWork: (task) => void this.agents.nameAgent(task),
      onTerminals: (terminals) => {
        this.put(withTerminals(this.current, terminals))
        face.draw()
      },
      asked: () => face.asked(),
    })
    this.looked = live
    void live.looked.then(() => this.agents.reopenLost())
    // Only where a person turned it on: off, nothing is constructed and no socket exists.
    await this.away.open()
    return live
  }

  /**
   * A journal line, told the orchestrator: a document handed over, or what an
   * agent left, now (or kept as news where it cannot be: `tellNow`); anything
   * else as news; and an agent that is gone, however it went, rather than
   * discovered by the orchestrator steering something that is not there.
   *
   * The news is kept for it and not written in the log where it is not
   * running: it is the journal's own line said again, and the journal is
   * already the record of it. A document or what an agent left is only ever
   * for the orchestrator, so that is said.
   */
  private heard(event: TadeEvent): void {
    const told = tellNow(this.wire, this.told, event)
    const news = told ? null : eventNews(event)
    if (news) this.orchestrator.note(news)
    const ended = agentEnded(event)
    if (ended) this.orchestrator.noteEnded(ended)
    if (event.type === 'run_started' && event.task) this.orchestrator.noteStarted(event.task)
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

  /** What the orchestrator's settings and project tools do, answered here. */
  configTools(): SettingTools & ProjectTools {
    return { ...this.settings.tools(), ...this.projects.tools() }
  }

  /** What the `ToolHost` asks at every call. `Away.arming` has the argument. */
  awayTools(): Arming {
    return this.away.arming()
  }

  /**
   * Hand the heart the orchestrator, once it has started — said, because
   * until then a sentence Tade's own grammar does not recognise has nowhere to go.
   */
  attachThinker(thinker: Thinker): void {
    this.orchestrator.attach(thinker)
    // Where nothing draws, nobody will say the next thing that would carry
    // what came for it while it was starting: that is told now, once. A window
    // has somebody at it, and what waits goes with their next words.
    if (!this.owed) return
    this.owed = false
    tellOrKeep(this.wire, this.told, WHILE_STARTING, 'what came while it was starting')
  }

  /** Write down the model the orchestrator ended up on when none was chosen, so it stays on it. */
  keepThinkerModel(model: { provider?: string; id: string }): void {
    this.orchestrator.keepModel(model)
  }

  /** The orchestrator switched its own model, because it was asked to: kept for the next start. */
  thinkerMovedTo(model: { provider: string; id: string }, said = ''): void {
    this.orchestrator.movedTo(model, said)
  }

  /** The orchestrator could not be started, said where somebody would have waited for it. */
  thinkerFailed(reason: string): void {
    this.orchestrator.failed(reason)
  }

  /** What stopping closes, each named, for whoever says on the way out what did not close. */
  closes(): { name: string; close: () => Promise<void> }[] {
    return [
      { name: 'the away view', close: () => this.away.stop() },
      { name: 'the status look', close: async () => this.looked?.stop() },
    ]
  }

  /** Stop listening, and stop the beat. The agents are the workbench's, and go on. */
  async stop(): Promise<void> {
    await Promise.all(this.closes().map((one) => one.close()))
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}
