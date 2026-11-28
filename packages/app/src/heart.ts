import { AsyncLocalStorage } from 'node:async_hooks'
import { type Arming, loadConfig, printable, type TadeEvent, titlesOf } from '@tade/core'
import type { StatusAsk } from '@tade/status'
import {
  type FaceCapabilities,
  type FaceOwn,
  NOBODY_LOOKING,
  ownFrom,
  ownOf,
  seenBy,
  sharedFrom,
} from './faces.ts'
import { colourWith } from './highlight.ts'
import { agentEnded, eventNews } from './inbox.ts'
import type { LayoutPrefs } from './layout.ts'
import { Live } from './live.ts'
import { talkIn } from './machines.ts'
import {
  type AppState,
  initialState,
  notice,
  onEvent,
  type TaskSnapshot,
  withProjects,
  withTasks,
  withTerminals,
  withTranscript,
} from './model.ts'
import type { ThereLine } from './transcript.ts'
import { type Entry, REPEAT_MS, tadeDid } from './transcript.ts'
import { AccountsHere } from './wire/accounts-here.ts'
import { MachineActs } from './wire/acts.ts'
import { agentMenuDoors } from './wire/agent-doors.ts'
import { Agents, type AgentsDeps } from './wire/agents.ts'
import { Batches } from './wire/batches.ts'
import { CloseWhenDone } from './wire/close-when-done.ts'
import {
  type AppOptions,
  clockOf,
  configPathOf,
  type Thinker,
  type Wiring,
  why,
  wiringFor,
} from './wire/context.ts'
import { type ConversationPlace, FleetConversation } from './wire/conversation.ts'
import { FleetDuties } from './wire/duties.ts'
import { Earlier } from './wire/earlier.ts'
import { type FleetFeeds, fleetFeedsFor } from './wire/feeds.ts'
import { FleetTalk, type TalkThere } from './wire/fleet-talk.ts'
import { type Tellable, tellNow, tellOrKeep } from './wire/handed.ts'
import { requireHighlighter } from './wire/highlighter.ts'
import { Intake } from './wire/intake.ts'
import { Inventories, type InventoriesDeps, type InventoryTools } from './wire/inventory.ts'
import { LinearTokens, lending } from './wire/linear-tokens.ts'
import { type MachinesSeen, machinesSeenFor } from './wire/machines-seen.ts'
import { WaitingThere } from './wire/notes-shared.ts'
import { Orchestrator, type OrchestratorDeps } from './wire/orchestrator.ts'
import { OwnCode } from './wire/own-code.ts'
import type { Places } from './wire/placing.ts'
import { type ProjectSync, projectSyncFor } from './wire/project-sync.ts'
import { copiesJoined, ProjectionsHeld } from './wire/projection-shared.ts'
import { Projects, type ProjectsDeps, type ProjectTools } from './wire/projects.ts'
import { Queue, type QueueTools } from './wire/queue.ts'
import { type Remotes, remotesFor } from './wire/remotes.ts'
import { Schedules, type WatchTools } from './wire/schedules.ts'
import { Settings, type SettingsDeps, type SettingTools } from './wire/settings.ts'
import { TaskRequests } from './wire/task-requests.ts'
import { Updates, type UpdateTools } from './wire/updates.ts'
import { noTwins, type WatchTwinsHere } from './wire/watch-where.ts'
import { Away, type AwayDeps } from './wire/web.ts'
import { talkingThrough } from './wire/web-asking.ts'
import { knownHere } from './wire/web-lanes.ts'
import { reloadStopsOf } from './wire/window.ts'

// The part of the window that runs with no screen: the beat, and on it the
// queue, schedules and watches, intake, and the full checks once a batch where
// a project batches them; the orchestrator, told what
// happened and deciding; the away view and the notifications it sends; and
// the subjects those act through — the one door a setting is written by,
// opening and closing a project, stopping and opening an agent again.
//
// `tade app` is this with a face over it (`App`), and `tade serve` is the same
// window opened unseen (`App.start`'s `unseen`), for a machine nobody sits at:
// a phone's full view needs the subjects only a window has, so the face is
// there and declares nobody is looking. It is the same program holding the same
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
//
// That one is the machine's own face, which the heart is made with. Any number
// of others may come and go while it beats (`attach`): each with its own size,
// its own capabilities and its own place in the window — the project it stands
// in, the agent in front of it, its scrolling and its open panel — and every
// one drawing the same facts (`faces.ts` says which fields are which). While
// one of them is drawn or answered (`AttachedFace.as`), every subject reads the
// state as that face sees it and writes it back through that face, so a
// subject never has to know there is more than one.

/** The Settings page's half: what the accounts, models, sounds and clipboard of a screen answer. */
export type SettingsFace = Omit<
  SettingsDeps,
  'tellThinking' | 'moveThinker' | 'away' | 'machineAction'
>
/** An agent's menu and the line you type on: what a press in front of somebody reaches. */
export type AgentsFace = Omit<AgentsDeps, 'useConfig' | 'changeQueue' | 'closesWhenDone'>
/** Where the window was, written down as a project opens or closes. */
export type ProjectsFace = Pick<ProjectsDeps, 'rememberWindow'>
/** The conversation's screen: where it is scrolled, what is said aloud, the line it was typed on. */
export type OrchestratorFace = Omit<OrchestratorDeps, 'useConfig' | 'nobodyHere'>
/** The pairing link's `Copy`, which is a clipboard; a restart's two halves; the window shared with a phone. */
export type AwayFace = Pick<AwayDeps, 'copy' | 'reloadStops' | 'reloadAll' | 'window'>

/**
 * What the links to other machines borrow of a face: its screens for a flow
 * that needs one, its viewer for a file or a change there, its clipboard.
 * Absent with no screen, where the links go on without them.
 */
export type RemotesFace = Partial<
  Pick<Parameters<typeof remotesFor>[1], 'screens' | 'files' | 'copy'>
>

/** What a face adds to the heart. */
export interface Face {
  /** What this face can do on its machine, declared by whoever made it (`faces.ts`). */
  readonly capabilities: FaceCapabilities
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
  /**
   * What another machine a watch is left to has already found with it
   * (`watch-seen.ts`), as it answered: asked over the link. Null where it has
   * nothing to say about it (an older Tade); throws where it could not be asked.
   */
  watchThere?(machine: string, project: string, watch: string): Promise<unknown>
  /** Where a plan's work may go besides here (`placing.ts`): the face's links, or null for none. */
  places?(): Places | null
  /** What only the face's links know, handed to every look: other machines' branches here. */
  asked(): Pick<StatusAsk, 'elsewhere'>
  /** A beat's tasks, taken into the state, before the queue and the schedules have them. */
  sawTasks(tasks: readonly TaskSnapshot[]): void
  /** The same beat after them, with whether it found anything the last did not. */
  beat(tasks: readonly TaskSnapshot[], moved: boolean): void
  /** A journal line, once the state has taken it in and the orchestrator has been told it. */
  heard(event: TadeEvent): void
  /**
   * A terminal turned an MCP server or an extension on or off, or changed one,
   * and the heart has taken the config again (`takeConfig`): what the face
   * shows of the extensions, asked again.
   */
  serversMoved(): void
  /**
   * What the face holds of the machines this one links to, for what each has
   * (`inventory.ts`), and whether its Machines page is open. Absent with no
   * screen: this machine's own, and what machines that link here told it.
   */
  inventories?: Pick<InventoriesDeps, 'remotes' | 'settingsOpen'>
  /** What the links borrow of the face; absent with no screen. */
  remotes?: RemotesFace
  settings: SettingsFace
  agents: AgentsFace
  projects: ProjectsFace
  orchestrator: OrchestratorFace
  away: AwayFace
}

/** A face that comes to a heart already beating: what it is, and how it is asked for a frame. */
export interface FaceSpec {
  /** What it can do on its machine (`faces.ts`), declared and never sniffed. */
  readonly capabilities: FaceCapabilities
  /** Ask it for a frame: the heart has something new for every face. */
  draw(): void
  /** Where it starts looking; where the machine's own face is, holding nothing, unless given (`ownFrom`). */
  readonly own?: FaceOwn
  /**
   * How big it draws, where that is not this machine's terminal: a phone's
   * columns and rows. What a subject lays out to a size while this face is
   * served — a file's body, a diff's, the Extensions panel — is laid out to
   * this (`Heart.room`), so a phone's panel folds at the phone's width.
   */
  room?(): { columns: number; rows: number }
}

/** A face attached to a heart (`Heart.attach`): its own view of the one state, until it goes. */
export interface AttachedFace {
  /** What it can do on its machine. */
  readonly capabilities: FaceCapabilities
  /** The state as this face sees it: the heart's facts, and where it is looking. */
  readonly state: AppState
  /** Write as this face: its own fields stay with it, the rest is every face's. */
  put(next: AppState): void
  /**
   * Run `fn` as this face: every subject's `wire.state` is this face's view,
   * its `put` writes through this face, and `wire.face` is its capabilities.
   * Synchronous only, and that is the point — a frame is made in one go, and
   * anything that waits would come back to somebody else's view.
   */
  as<T>(fn: () => T): T
  /** Gone: never drawn or asked again. The machine's own face is not one of these, and never goes. */
  detach(): void
}

/** A face attached to a heart, as the heart holds it. */
interface Guest {
  readonly capabilities: FaceCapabilities
  readonly draw: () => void
  readonly room: (() => { columns: number; rows: number }) | null
  own: FaceOwn
  /** The last view made for it, kept while neither half has moved (`Heart.seen`). */
  seen: { heart: AppState; own: FaceOwn; state: AppState } | null
}

/**
 * The face the work running now was started for (`Heart.as`): carried across
 * every await of what an attached face's act started, so a door that writes
 * after one writes as that face. Empty for everything the machine's own window
 * and the beat start, which is the machine's own face.
 */
const carried = new AsyncLocalStorage<Guest>()

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
  readonly wire: Pick<Wiring, 'now' | 'opts'>
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
 * The orchestrator as the heart tells it, written in the log too, where there
 * is one, while it is not running. Told then, it is kept as news rather than
 * let go, so that one coming up is told it.
 */
function toldOrSaid(orchestrator: Tellable, said: ((text: string) => void) | null): Tellable {
  return {
    get started() {
      return orchestrator.started
    },
    tell: async (text) => {
      if (orchestrator.started) return orchestrator.tell(text)
      orchestrator.note(text)
      said?.(text)
    },
    note: (text) => {
      orchestrator.note(text)
      if (!orchestrator.started) said?.(text)
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
    capabilities: NOBODY_LOOKING,
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
    serversMoved: () => {},
    settings: {
      loadAccounts: () => {},
      refreshModels: nothing,
      lookAtWhatIsInstalled: () => {},
      setupChanged: () => {},
      openSetup: () => false,
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
      openChanges: async () => false,
      openPlace: nothing,
      copyToClipboard: async () => false,
      routes: () => ({ offersFor: () => null, openModels: nothing, openAccount: nothing }),
      handsOver: () => null,
      there: () => null,
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
      // The person's own words that came another way — their own device, or
      // a line typed on another machine's tab — are a `said` line here as at
      // a keyboard, because that is what `namedBy` reads. With no screen there
      // is no history to keep beside it.
      remember: (said) => {
        void heart()
          .wire.opts.client.log.append({ type: 'said', task: null, detail: { text: said } })
          .catch((err: unknown) => {
            process.stderr.write(`the person's words could not be written down: ${String(err)}\n`)
          })
      },
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
  // What was read back out of the record goes above what was there, and was
  // said long ago: only what came after the last line there is new.
  const last = was.at(-1)
  const from = last === undefined ? -1 : now.indexOf(last)
  return now.slice(from + 1).filter((entry): entry is Said => !before.has(entry) && settled(entry))
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
  /** The faces attached besides the machine's own, in the order they came. */
  private readonly guests = new Set<Guest>()
  /** The face being drawn or answered now (`AttachedFace.as`); null is the machine's own. */
  private serving: Guest | null = null
  /** What every subject is handed: the face's as well as the heart's own. */
  readonly wire: Wiring
  /** Queued work: what is ready, what is held, and what starts it. */
  readonly queue: Queue
  /** What is due, what a watch found, and what one run of either does. */
  readonly schedules: Schedules
  /** What has been handed to this machine from outside, and what is due to be said back. */
  readonly intake: Intake
  /** The full checks once a batch on HEAD, where a project batches them. */
  readonly batches: Batches
  /** The tasks a terminal asked for while this holds the journal: `tade task create` beside it. */
  readonly taskRequests: TaskRequests
  /**
   * Settings › Accounts for this machine and every one it links to, for the
   * phone and another machine's window, and what a terminal beside this asked
   * of the accounts: `tade accounts add` beside `tade serve` (`accounts-here.ts`).
   */
  readonly accounts: AccountsHere
  /** The one door a setting is written by, and the page a face draws for it. */
  readonly settings: Settings
  /** Opening, closing and naming projects. */
  readonly projects: Projects
  /** Making an agent, opening one again, stopping it, taking it away. */
  readonly agents: Agents
  /** Finished agents' lanes, closed by themselves where the setting says (`close_when_done`). */
  private readonly closing: CloseWhenDone
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
  /** Whether Tade's own checkout moved under it since it started, where it runs from one (`own-code.ts`). */
  readonly ownCode: OwnCode
  /** The person's other machines as this one has seen them: up, asleep, closed, lost (`machines-seen.ts`). */
  readonly machinesSeen: MachinesSeen
  /** What every machine that links here told this one of its projection, for the page (`projection-shared.ts`). */
  readonly projections: ProjectionsHeld
  /**
   * The links to the machines this one links to (`tade remote`), on the
   * heart's own beat so a machine with no screen — a `tade serve` Mac — still
   * follows them, tells each its projection and is one conversation with them.
   */
  readonly remotes: Remotes
  /** Each project's branch kept in step with origin and the person's other machines (`project-sync.ts`). */
  readonly sync: ProjectSync
  /** What this machine has, and what each of the person's others said it has (`inventory.ts`). */
  readonly inventory: Inventories
  /** Every machine's journal, kept here and handed on to the next (`feeds.ts`). */
  readonly feeds: FleetFeeds
  /**
   * What each other machine holds of this one's changes to notes taken there,
   * for a press there: told by its share both ways (`notes-shared.ts`), drawn
   * on the away view's Machines page.
   */
  readonly waitingThere = new WaitingThere()
  /** The orchestrator's conversation, one on every machine (`conversation.ts`). */
  readonly conversation: FleetConversation
  /** And drawn as one: another machine's turns in this strip as they run there (`fleet-talk.ts`). */
  readonly fleetTalk: FleetTalk
  /** Whose each duty is where one repository is a project on several machines (`duties.ts`). */
  readonly duties: FleetDuties
  /** Its tool calls run on another machine through that machine's own gate, and theirs here (`acts.ts`). */
  readonly acts: MachineActs
  /**
   * What was said to the orchestrator before what the conversation holds, read
   * back out of its record: by a face scrolled to the top, and by a page on a
   * phone scrolled past what it holds — so the heart's, with or without a face.
   */
  readonly earlier: Earlier
  /** What `tade_updates` and `tade_reload` are answered with where there is no screen; made when asked. */
  private updates: Updates | null = null

  constructor(opts: AppOptions, face: Face, said: ((line: Said) => void) | null = null) {
    // Code is coloured with the machine's highlight.js; `highlight.ts` asks for
    // it rather than importing it, so the same drawing runs in a browser.
    colourWith(requireHighlighter)
    this.opts = opts
    this.face = face
    this.said = said
    this.wire = wiringFor(opts, {
      state: () => {
        const guest = this.served()
        return guest ? this.seen(guest) : this.current
      },
      put: (next) => {
        const guest = this.served()
        if (guest) this.putAs(guest, next)
        else this.put(next)
      },
      live: () => this.looked,
      now: () => this.now(),
      layout: () => face.layout(),
      draw: () => this.draw(),
      typed: () => face.typed(),
      face: () => this.served()?.capabilities ?? face.capabilities,
    })
    this.settings = new Settings(this.wire, {
      ...face.settings,
      tellThinking: (level) => this.orchestrator.tellThinking(level),
      moveThinker: (afterTurn) => this.orchestrator.moveAccount(afterTurn),
      silence: () => {
        this.orchestrator.stopSpeaking()
        face.settings.silence()
      },
      away: () => this.away,
      machineAction: (choice) => this.inventory.action(choice),
    })
    this.orchestrator = new Orchestrator(this.wire, {
      ...face.orchestrator,
      // Read at each turn, by when the record of machines is made below.
      seen: () => this.machinesSeen?.all() ?? [],
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
      there: () => face.agents.there(),
      orchestrator: () => this.told,
      comingBack: () => this.agents.comingBack(),
      places: () => face.places?.() ?? null,
      schedules: {
        views: () => this.schedules.views(),
        set: (req) => this.schedules.set(req),
        runNow: (id, asked) => this.schedules.runNow(id, asked),
      },
    })
    this.duties = new FleetDuties(this.wire, {
      seen: () => this.machinesSeen?.all() ?? [],
      say: (said) => {
        this.put(notice(this.current, said, this.now()))
        this.draw()
      },
    })
    this.schedules = new Schedules(this.wire, {
      there: () => face.agents.there(),
      news: (words) => this.told.note(words),
      duties: this.duties,
      orchestrator: () => this.told,
      advanceQueue: () => void this.advanceQueue(),
      twins: (project) => face.twins(project),
      ...(face.watchThere && {
        watchThere: (machine: string, project: string, watch: string) =>
          face.watchThere?.(machine, project, watch) ?? Promise.resolve(null),
      }),
    })
    this.intake = new Intake(this.wire, { advanceQueue: () => void this.advanceQueue() })
    this.batches = new Batches(this.wire, () => this.told, this.duties)
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
      closesWhenDone: (task) => this.closing.owes(task),
    })
    this.taskRequests = new TaskRequests(this.wire)
    this.accounts = new AccountsHere(this.wire, {
      use: () => this.settings.use(this.wire.opts.client.config),
      reread: () => face.settings.loadAccounts(),
    })
    this.closing = new CloseWhenDone(this.wire, {
      orchestrator: this.orchestrator,
      close: (task) => this.agents.closeFinished(task),
      // Nobody is looking at anything where nothing draws, whatever is focused.
      looking: (task) => said === null && this.current.focused === task,
    })
    this.linear = new LinearTokens({
      config: () => this.wire.opts.config,
      settings: this.settings,
      now: () => this.now(),
      told: (words) => this.told.note(words),
    })
    this.wire.opts.extensions?.useConnected(lending(this.linear))
    this.earlier = new Earlier(this.wire)
    this.machinesSeen = machinesSeenFor(this.wire)
    this.projections = new ProjectionsHeld({
      home: this.wire.opts.home,
      now: () => this.now(),
      say: (said) => this.told.note(said),
      // Constructed below; a copy read back off the disk before then is folded at the first beat.
      moved: () => this.fleetTalk?.fold(),
    })
    this.sync = projectSyncFor(this.wire, () => this.told, this.duties)
    this.inventory = new Inventories(this.wire, {
      news: (words) => this.told.note(words),
      synced: () => this.feeds.synced(),
      ...(face.inventories ?? {}),
    })
    this.feeds = fleetFeedsFor(this.wire, (said) => {
      this.put(notice(this.current, said, this.now()))
      this.draw()
    })
    this.conversation = new FleetConversation(this.wire, {
      say: (said) => {
        this.put(notice(this.current, said, this.now()))
        this.draw()
      },
      later: (said) => void this.earlier.later(said),
    })
    this.fleetTalk = new FleetTalk(this.wire, { sources: () => this.talkThere() })
    this.acts = new MachineActs(this.wire, {
      say: (said) => {
        this.put(notice(this.current, said, this.now()))
        this.draw()
      },
      seen: () => this.machinesSeen.all(),
    })
    this.ownCode = new OwnCode(this.opts.checkout ?? null)
    this.away = new Away(this.wire, {
      machines: this.machinesSeen,
      acts: this.acts,
      inventory: this.inventory,
      waiting: this.waitingThere,
      feeds: this.feeds,
      conversation: this.conversation,
      duties: this.duties,
      earlier: () => this.earlier.more(),
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
      // The one door a setting is written by: the key nothing types, a carry, a connect page.
      settings: this.settings,
      // Stopping and closing from away, through the same doors a press goes through.
      lifecycle: {
        agents: () => this.agents,
        projects: () => this.projects,
        // The rest of an agent's menu, through the same calls its row's presses make.
        menus: () => agentMenuDoors(this.wire, this.agents),
      },
      doorbell: { wake: (id, item) => this.schedules.wake(id, item) },
      // One project as this window draws it, for another of the person's machines.
      side: { schedules: () => this.schedules.views(), intake: () => this.intake.facts() },
      linear: this.linear,
      // A sign-in made here from another machine's `/login`, once any turn is over.
      restartOrchestrator: () => this.orchestrator.moveAccount(true),
      // Every machine's accounts, from the phone and another machine's Settings.
      accounts: this.accounts,
      // Every other machine's projection on the person's own page: what this
      // window's links hold, and what each machine that links here told it.
      projections: this.projections,
      copies: () =>
        copiesJoined(
          this.projections.copies(),
          this.remotes.held().map((held) => ({ name: held.remote, projection: held.projection })),
        ),
    })
    this.remotes = remotesFor(this.wire, {
      ...face.remotes,
      seen: (held) => {
        this.machinesSeen.linked(held)
        // The hub's turn, streaming, drawn here as it arrives.
        this.fleetTalk.fold()
        // An `outbox` frame from a hub: what waits there for this machine is collected now.
        this.acts.heard(held)
      },
      figures: () => this.machinesSeen.host(),
      inventory: () => this.inventory.latest(),
      synced: (project) => this.sync.poke(project),
      settings: () => this.settings,
      fold: () => this.foldConfig(true),
      feeds: this.feeds,
      waiting: this.waitingThere,
      oneWith: () => this.conversation.oneWith(),
      sharesWith: () => this.conversation.sharesWith(),
      acts: () => this.acts,
      // This machine's own work, told every machine it links to for their pages.
      own: () => this.away.own(),
    })
    // The orchestrator's conversation reaches the hub over the same links.
    this.conversation.withReach((name) => this.remotes.reachFor(name))
    // And whose each duty is, asked of the hub over them too (`duties.ts`).
    this.duties.withReach((name) => this.remotes.reachFor(name))
    // And so do acts on another machine (`tade_remote_act`).
    this.acts.withReach((name) => this.remotes.reachFor(name))
    // And every machine's accounts, for Settings › Accounts here and on the phone.
    this.accounts.withReach((name) => this.remotes.reachFor(name))
    // And a parting is fetched afresh over them before a merge is proposed for it.
    this.sync.withLookAgain(
      async (project, machines) => await this.remotes.mirrored()?.lookAgain(project, machines),
    )
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
   * Ask every face for a frame: the machine's own, and each attached one. A
   * face that has nothing new to draw draws nothing (pi-tui writes only the
   * rows that changed), so this costs a face what it shows and no more.
   */
  draw(): void {
    // Asked for outside any face an act carried (`carried`): a frame is
    // scheduled now and made later, and one made inside a phone's act would be
    // made — and drawn on the machine's own screen — as that phone sees it.
    carried.exit(() => {
      this.face.draw()
      for (const guest of this.guests) guest.draw()
    })
  }

  /**
   * A face comes to the heart while it beats: a second window, a phone. It
   * draws the same facts as every other face, at its own size and from its
   * own place in the window, and does on its machine only what it declares.
   * Nothing is read, looked at or started for it: what it costs is its frames.
   */
  attach(spec: FaceSpec): AttachedFace {
    const guest: Guest = {
      capabilities: spec.capabilities,
      draw: () => spec.draw(),
      room: spec.room
        ? () => (spec.room as () => { columns: number; rows: number }).call(spec)
        : null,
      own: spec.own ?? ownFrom(this.current),
      seen: null,
    }
    this.guests.add(guest)
    const seen = () => this.seen(guest)
    return {
      capabilities: spec.capabilities,
      get state() {
        return seen()
      },
      put: (next) => this.putAs(guest, next),
      as: (fn) => this.as(guest, fn),
      detach: () => {
        this.guests.delete(guest)
      },
    }
  }

  /**
   * How big the face being served draws, where it said (`FaceSpec.room`);
   * null for the machine's own face, which is its terminal's size.
   */
  room(): { columns: number; rows: number } | null {
    return this.served()?.room?.() ?? null
  }

  /** How many faces are attached besides the machine's own. */
  get faces(): number {
    return this.guests.size
  }

  /** The state as one attached face sees it, made again only where either half moved. */
  private seen(guest: Guest): AppState {
    const kept = guest.seen
    if (kept && kept.heart === this.current && kept.own === guest.own) return kept.state
    const state = seenBy(this.current, guest.own)
    guest.seen = { heart: this.current, own: guest.own, state }
    return state
  }

  /** A write as an attached face: where it looks stays its own, and the facts are every face's. */
  private putAs(guest: Guest, next: AppState): void {
    guest.own = ownOf(next)
    this.put(sharedFrom(next, this.current))
  }

  /**
   * Serve one attached face for the length of `fn`, and whichever was served
   * before after it — and for whatever `fn` started that is still going after
   * it returns. A phone's act (§10 T3) runs a door that awaits — a press held
   * while its action answers, a panel a menu opens once its choice is made —
   * and what that door writes after its await is still that phone's: carried
   * with the work it started (`carried`), never left to land on whichever face
   * happens to be served by then. A face that has gone by the time it lands
   * writes as nobody's but the machine's own.
   */
  private as<T>(guest: Guest, fn: () => T): T {
    if (!this.guests.has(guest)) throw new Error('that face has gone from this heart')
    const was = this.serving
    this.serving = guest
    try {
      return carried.run(guest, fn)
    } finally {
      this.serving = was
    }
  }

  /**
   * Run `fn` as the machine's own face, whatever face is served or carried
   * now: the machine's own window's frame, which may be made in a turn some
   * phone's act scheduled, and must never be made as that phone sees it.
   */
  asOwn<T>(fn: () => T): T {
    const was = this.serving
    this.serving = null
    try {
      return carried.exit(fn)
    } finally {
      this.serving = was
    }
  }

  /** The face being served: the one `as` is serving now, or the one the work running now was started for. */
  private served(): Guest | null {
    if (this.serving) return this.serving
    const carriedFor = carried.getStore()
    return carriedFor && this.guests.has(carriedFor) ? carriedFor : null
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
    // Which machines were up when this one last looked, read back before anything links.
    void this.machinesSeen.seed()
    // And what each machine that links here last said it was doing, drawn as of then.
    void this.projections.open()
    // Which repository each project is, for whose each duty is (`duties.ts`).
    void this.duties.begin()
    // What Tade's own checkout is as it starts, before an agent can commit to it.
    void this.ownCode.begin()
    // Who each sign-in is, once, where another machine reads its plans: the
    // mark that says one subscription on two machines is one plan
    // (`identityOf`). Asked again whenever somebody looks at the accounts.
    if (Object.keys(config.remotes).length > 0 || config.surfaces.web.enabled) {
      void this.wire.opts.client.accounts().catch((err: unknown) => {
        this.told.note(`Who each sign-in is could not be asked: ${why(err)}`)
      })
    }
    const live = await Live.start({
      client: this.opts.client,
      config: this.opts.config,
      home: this.opts.home,
      tadeHome: this.opts.home,
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
      ...(this.opts.beatMs ? { pollMs: this.opts.beatMs } : {}),
      openedAt: this.wire.openedAt,
      status: this.opts.status,
      onTasks: (tasks, moved) => {
        this.put(withTasks(this.current, tasks))
        // Every other face takes the beat as well: a focus on an agent that has
        // gone moves for it as it does here, by the same rule.
        for (const guest of this.guests)
          guest.own = ownOf(withTasks(seenBy(this.current, guest.own), tasks))
        this.orchestrator.noteTasks(tasks)
        face.sawTasks(tasks)
        void this.queue.recordRulesMet()
        void this.closing.beat()
        void this.schedules.runDue().then(() => this.advanceQueue())
        void this.orchestrator.reflect(tasks)
        void this.batches.beat()
        this.machinesSeen.beat()
        void this.sync.beat()
        this.inventory.beat()
        this.conversation.beat(this.orchestrator.busy())
        this.fleetTalk.fold()
        this.duties.beat()
        this.acts.beat(Object.keys(this.wire.opts.config.remotes))
        this.projections.beat()
        this.away.beat()
        // Once a minute at most, and never again once owed: the strip, the
        // away bar and `tade_updates` all read it from here.
        this.ownCode.beat(this.now(), () => {
          this.away.restart()
          this.draw()
        })
        void this.foldConfig()
        void this.taskRequests.beat()
        this.accounts.beat()
        this.remotes.beat()
        face.beat(tasks, moved)
      },
      onEvent: (event) => {
        this.put(onEvent(this.current, event, this.now()))
        this.heard(event)
        face.heard(event)
      },
      onWarning: (message) => {
        this.put(notice(this.current, message, this.now()))
        this.draw()
      },
      onChange: () => this.draw(),
      onDue: () => face.due(),
      // An agent that started without a branch has changed something, so its work needs one.
      onWork: (task) => void this.agents.nameAgent(task),
      onTerminals: (terminals) => {
        this.put(withTerminals(this.current, terminals))
        this.draw()
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
    const told = this.closing.heard(event) || tellNow(this.wire, this.told, event)
    const news = told ? null : eventNews(event, () => knownHere(this.wire, this.wire.opts.config))
    if (news) this.orchestrator.note(news)
    const ended = agentEnded(event)
    if (ended) this.orchestrator.noteEnded(ended)
    if (event.type === 'run_started' && event.task) this.orchestrator.noteStarted(event.task)
  }

  /**
   * Read the config again and let everything that holds one take it, the
   * extensions with it: what turning a server or an extension on or off is
   * taken by, from the Extensions page's own switch (`reloadExtensions`) and
   * from a terminal's, on the beat (`serversMoved`). Off is at once, and so is
   * the end of a server's session; the orchestrator is started again where
   * what it can call changed. Nothing that was not loaded is loaded.
   */
  async takeConfig(): Promise<void> {
    const host = this.wire.opts.extensions
    if (!host) return
    const offered = () =>
      host
        .specs('orchestrator')
        .map((one) => one.name)
        .join()
    const before = offered()
    const loaded = await loadConfig(configPathOf(this.wire.opts))
    if (!loaded.ok) throw new Error(loaded.issues[0]?.message ?? 'the config would not load')
    this.settings.use(loaded.config)
    await host.reconfigure(loaded.config.extensions)
    if (offered() !== before) void this.wire.opts.restartThinker?.()
  }

  /**
   * A terminal turned an MCP server or an extension on or off, or changed one,
   * while this held the journal (`Settings.taken`): taken as the page's own
   * switch takes it, then the face's page asked again. One turned on connects
   * the next time Tade starts, which is the rule and never a hot reload. A
   * window is somebody's to look at; where nothing draws, the log is the only
   * place that is said.
   */
  private async serversMoved(): Promise<void> {
    const was = this.wire.opts.config.mcp.servers
    await this.takeConfig()
    this.face.serversMoved()
    if (this.said === null) return
    const connected = new Set(
      (this.wire.opts.extensions?.list() ?? [])
        .filter((one) => one.state !== 'off')
        .map((one) => one.name),
    )
    for (const [name, server] of Object.entries(this.wire.opts.config.mcp.servers)) {
      if (server?.enabled !== true || was[name]?.enabled === true) continue
      if (connected.has(`mcp-${name}`)) continue
      this.put(
        withTranscript(
          this.current,
          tadeDid(
            this.current.transcript,
            `${name} was turned on from a terminal — it connects the next time Tade starts`,
            this.now(),
          ),
        ),
      )
    }
  }

  /** The heart's part of a look: the inbox folded where the journal grew, and what a reader found due. */
  /**
   * What a terminal changed in the config, folded into the journal: on every
   * beat, and awaited before every carry (`Carries`), which waits out a fold
   * already under way and then makes its own.
   */
  foldConfig(fresh = false): Promise<void> {
    return this.settings.fold(() => this.serversMoved(), fresh)
  }

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
    return {
      ...this.settings.tools(),
      ...this.projects.tools(),
      syncProject: (req) => this.sync.now(req),
    }
  }

  /** What the `ToolHost` asks at every call. `Away.arming` has the argument. */
  awayTools(): Arming {
    return this.away.arming()
  }

  /** What the orchestrator's `tade_machines` and `tade_env_move` do, answered here. */
  inventoryTools(): InventoryTools {
    return this.inventory.tools()
  }

  /** What makes the orchestrator's conversation one on every machine, for whoever starts it. */
  conversationPlace(): ConversationPlace {
    return this.conversation.place()
  }

  /** The copy of another machine's conversation last read, by the projection it was read out of. */
  private copiesRead = new Map<string, { projection: unknown; lines: readonly ThereLine[] }>()

  /**
   * Every machine whose turns are this conversation's, with its lines as its
   * projection carries them: the hub this machine links to, from the stream
   * it follows, and each machine that links here and exchanges it, from what
   * it told this one (`ProjectionsHeld`) — the hub's half, so a `tade serve`
   * with no screen draws the Mac's turns on its page as they run.
   */
  private talkThere(): TalkThere[] {
    const out: TalkThere[] = []
    const hub = this.conversation.sharesWith()
    if (hub !== null && this.remotes) {
      const machine = this.remotes.machines().remotes.find((one) => one.name === hub)
      const device = this.remotes.reachFor(hub)?.remote.session.device
      if (machine?.talk) {
        out.push({
          machine: hub,
          lines: machine.talk.lines,
          own: device === undefined ? null : `device ${device}`,
        })
      }
    }
    const names = new Set<string>()
    for (const copy of this.projections.copies()) {
      if (copy.name === hub || !this.conversation.joinedBy(copy.name)) continue
      names.add(copy.name)
      let read = this.copiesRead.get(copy.name)
      if (read?.projection !== copy.projection) {
        const talk = talkIn(copy.projection as unknown as Record<string, unknown>, 0)
        read = { projection: copy.projection, lines: talk?.lines ?? [] }
        this.copiesRead.set(copy.name, read)
      }
      out.push({ machine: copy.name, lines: read.lines, own: null })
    }
    for (const name of [...this.copiesRead.keys()])
      if (!names.has(name)) this.copiesRead.delete(name)
    return out
  }

  /** Its tool calls run on another machine, and other machines' run here (`acts.ts`). */
  machineActs(): MachineActs {
    return this.acts
  }

  /**
   * What the orchestrator's update and reload tools do with no screen (`tade
   * serve`): what is installed and current is read, and Tade is started again
   * by whatever keeps it (`AppOptions.reloadWindow`, systemd's restart under
   * the unit Tade wrote). A window answers them itself (`App.updateTools`).
   */
  updateTools(): UpdateTools {
    this.updates ??= new Updates(this.wire, {
      faceless: true,
      // Only ever where nothing would stop, or the person's phone asked:
      // `Updates` refuses every other reload with no screen.
      reload: () => {
        this.wire.opts
          .reloadWindow?.()
          .catch((err: unknown) =>
            this.wire.note(new Error(`Starting Tade again failed: ${why(err)}`)),
          )
      },
      reloadStops: () => reloadStopsOf(this.wire),
      arm: () => this.orchestrator.arm(),
      // Never reached: running an update is refused with no screen.
      terminal: async () => null,
      news: (said) => this.orchestrator.note(said),
      ownCode: () => ({ changed: this.ownCode.owed(), startedOn: this.ownCode.startedOn() }),
    })
    return this.updates.tools()
  }

  /**
   * Hand the heart the orchestrator, once it has started — said, because
   * until then a sentence Tade's own grammar does not recognise has nowhere to go.
   */
  attachThinker(thinker: Thinker): void {
    this.orchestrator.attach(thinker)
    this.conversation.started()
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
    this.conversation.failed(reason)
    this.orchestrator.failed(reason)
  }

  /** What stopping closes, each named, for whoever says on the way out what did not close. */
  closes(): { name: string; close: () => Promise<void> }[] {
    return [
      { name: 'the away view', close: () => this.away.stop() },
      { name: 'the status look', close: async () => this.looked?.stop() },
      { name: 'the remote links', close: () => this.remotes.stop() },
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
