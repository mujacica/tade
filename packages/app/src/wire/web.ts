import {
  type Arming,
  type Config,
  type InboxRow,
  planStandings,
  startOfToday,
  titlesOf,
  type Workspace,
} from '@tade/core'
import {
  AGENT,
  type AgentIn,
  agentOf,
  type Confirmed,
  type Device,
  factsOf,
  has,
  type PairingAsk,
  type Projector,
  projector,
  type Reach,
  reachOf,
  readDevices,
  type SnapshotInput,
  Streams,
  settingsFor,
  surfaceOf,
  type TaskFacts,
  Tickets,
  type Told,
  type WebReading,
  type WebServer,
  webServer,
} from '@tade/web'
import { awayCollections } from '../away.ts'
import { activityIn } from '../away-activity.ts'
import type { Frame } from '../frame.ts'
import { AWAY_CONTROLS, awayPanel } from '../panels/away/state.ts'
import type { AwayView } from '../panels/away/view.ts'
import type { PanelInputs } from '../panels.ts'
import type { Actions, Subject, Submits, Wiring } from './context.ts'
import type { Settings } from './settings.ts'
import { armingFor, seenFrom, type Talking } from './web-asking.ts'
import {
  type AwayBeat,
  type AwayHeld,
  beatParts,
  type FactoryHeld,
  type Held,
  nothingYet,
  steeringFor,
  talkFor,
  upSinceOf,
} from './web-beat.ts'
import { builtFrom, turnTo } from './web-follow.ts'
import { widen } from './web-grants.ts'
import { halvesFor } from './web-halves.ts'
import { knownKeys, Lanes } from './web-lanes.ts'
import type { Lifecycle } from './web-lifecycle.ts'
import { carryLink, isLink } from './web-link.ts'
import { awayView, codeShownOn, keepCode, mintPairing } from './web-panel.ts'
import { pushFor, type WebPush } from './web-push.ts'
import { letGoOfRevoked, revokeEvery, revokeOne, type Sessions } from './web-sessions.ts'
import { toldTo } from './web-told.ts'

// The window's end of the away view: the server's lifetime, the pairing panel,
// and the beat that moves the projection on.
//
// **The server lives in this process, behind the lock holder, and dies with
// it.** Four reasons, and the one that decides it: half the state only exists
// here. Pending approvals live in the supervisor, lane liveness is the
// driver's answer, and `Live` already computes the rest on a beat — a second
// process would either take `tade.lock` (refused) or write behind it
// (corrupt), and would double every `git` and `ps` call to give two answers to
// one question. The cost is stated rather than papered over: **the away view
// answers only while this window is open**, and a phone that taps the bookmark
// with Tade closed gets the browser's own connection error
// (`AWAY_IS_WHILE_OPEN`).
//
// **Nothing here is reachable by the orchestrator.** Every key it reads is in
// `reach.ts`'s `never` subtree, so a page an agent wrote cannot turn the
// listener on, move it to the network, change its port or add a trusted host.
// Pairing, granting and revoking are not settings at all: they are a keypress
// at this machine, which is the one authorisation nothing remote can obtain.
//
// **Idle costs nothing.** With `enabled: false` there is no server and `beat`
// returns on its first line. With it on and nobody connected, `beat` builds
// **no projection**: `streams.listening()` is empty, so there is nothing to
// project for. `test/away.test.ts` asserts that as a count of calls rather
// than as a sentence.

/** What the away subject needs of the rest of the window. */
export interface AwayDeps {
  /** What the approve/deny keys do when no device is waiting to be let in. */
  decided(allow: boolean): void | Promise<void>
  /** Said in the strip, where somebody who was not looking at the panel sees it. */
  news(said: string): void
  /**
   * What the away view is allowed to know of the conversation: five methods,
   * and the orchestrator subject happens to have all five.
   *
   * **Named one by one rather than taking that subject**, which is the same
   * decision `ActingDeps` makes about the workbench: a parameter typed as the
   * subject would put `say` — the one function that writes a `said` line —
   * one property access away from a route.
   *
   * The transcript is **not** here, because it is not the subject's to answer:
   * it is in `AppState`, which this subject already holds. A sixth method for
   * it would be a second way to read one value.
   */
  talk: Talking
  /**
   * Why work that came from outside this machine may not go ahead now, or
   * null — the queue's own question (`intakeStands`), asked at the moment a
   * paired device asks to approve one.
   *
   * Handed in rather than asked here, because answering it needs the
   * extension host that can reach the watch, and the subject that already
   * does is the queue. **A throw holds**: a source nobody could ask has not
   * said yes.
   */
  stands(row: InboxRow): Promise<string | null>
  /**
   * The factory floor, as the subject that folds the inbox already holds it.
   *
   * Handed in for `stands`' reason and one more: the away view may start no
   * work to answer a request, so everything it reads has to be a value the
   * window keeps — and the inbox, the request bodies and the stored workflows
   * are three reads that belong to the subject which already does them. This
   * file knows nothing about any of the three.
   */
  factory(): FactoryHeld
  /**
   * A draft was saved from away, so whatever folds the templates reads them
   * again rather than waiting out its own clock.
   *
   * One method and no argument: the fold reads every template anyway, and a
   * name here would be a second thing to keep in step for no gain.
   */
  saved(): void
  /** Three methods of `Settings`, never the subject: the generated key, what a granted device
   * reads, and the one change it may make (`web-settings.ts`). */
  settings: Pick<Settings, 'rows' | 'write' | 'writeKey'>
  /** The agents and projects subjects, for stopping and closing from away (`web-lifecycle.ts`). */
  lifecycle: Lifecycle
  /** The window's clipboard, for the pairing link's `Copy` (`web-link.ts`). */
  copy(text: string): Promise<boolean>
}

export class Away implements Subject {
  private readonly wire: Wiring
  private readonly deps: AwayDeps
  private server: WebServer | null = null
  private readonly streams = new Streams({
    tell: (said) =>
      void this.log({ type: 'warning', detail: { warning: said.why, device: said.device } }),
  })
  private readonly tickets = new Tickets()
  private readonly push: WebPush
  /** One projector per device, made on demand and dropped when it is revoked. */
  private readonly projectors = new Map<string, Projector>()
  /** The revision each projector last saw a *beat*, so a read can catch it up. */
  private beatAt = 0
  private readonly caughtUp = new Map<string, number>()
  private devices: readonly Device[] = []
  /** The device waiting to be let in, and how to answer it. */
  private asking: {
    ask: PairingAsk
    at: number
    answer: (said: Confirmed) => void
  } | null = null
  private problem: string | null = null
  /**
   * When the machine came up, or null where it could not be read.
   *
   * Read once rather than per beat: it does not change while Tade is open, and
   * it is what lets a page say *the machine was asleep for 2h 11m* rather than
   * leaving a hole where an agent's missing hour was. `null` is `unknown` and
   * is never drawn as nought.
   */
  private readonly upSince: number | null = upSinceOf()
  private held: AwayHeld | null = null
  /** Agents' screens, read only while a device granted them is looking. */
  private readonly lanes: Lanes
  /** One line in the journal, said in the strip if it would not go in (`web-told.ts`). */
  private readonly log: (told: Told) => Promise<void>
  /** What the listener was last brought up for (`builtFrom`), null for down, and the turn doing it. */
  private wanted: string | null = null
  private turning: Promise<void> = Promise.resolve()
  /** The devices the strip's chip last drew: one more or fewer since is a frame owed. */
  private readers = 0

  constructor(wire: Wiring, deps: AwayDeps) {
    this.wire = wire
    this.deps = deps
    this.log = toldTo(wire, (said) => deps.news(said))
    this.lanes = new Lanes({
      capture: (lane, lines) => wire.opts.client.capture(lane as never, lines, false),
      now: () => wire.now(),
    })
    // Out of the collections the beat already built: no look at the world.
    this.push = pushFor(
      wire,
      { writeKey: (...key) => deps.settings.writeKey(...key) },
      {
        tasks: () => this.collections().tasks,
        devices: () => this.devices,
        tell: (told) => void this.log(told),
      },
    )
  }

  /** The listener made to match the config as a setting changes (`Settings.use`, `web-follow.ts`). */
  follow(): void {
    const want = builtFrom(surfaceOf(this.config().surfaces.web))
    const was = this.wanted
    if (want === was) return
    this.wanted = want
    const failed = (what: string, err: unknown) => {
      this.problem = err instanceof Error ? err.message : String(err)
      this.deps.news(`the away view could not ${what}: ${this.problem}`)
    }
    const mint = () => (codeShownOn(this.wire.state.panel) === null ? undefined : this.mint())
    const away = { open: () => this.open(), stop: () => this.stop(), mint, failed }
    // One turn after another, never two listeners on a port.
    this.turning = this.turning.then(() => turnTo(was, want, away)).finally(() => this.wire.draw())
  }

  /**
   * Start listening, if a person turned it on: from `begin`, and from `follow`.
   *
   * A `web_enabled` line goes in the journal with what it came up as and what
   * it actually bound — the second half being what a config cannot say, and
   * the half somebody reading the journal a month later needs in order to
   * know whether anything was reachable at all.
   */
  async open(): Promise<void> {
    const surface = surfaceOf(this.config().surfaces.web)
    this.wanted = builtFrom(surface)
    if (!surface.enabled || this.server !== null) return
    this.problem = null
    const server = webServer({
      home: this.wire.opts.home,
      surface,
      readingFor: (reach) => this.readingFor(reach),
      confirm: (ask) => this.confirm(ask),
      ...halvesFor(surface, {
        notifications: () => ({ half: this.push.half(), key: () => this.push.key() }),
        tade: this.wire.opts.client,
        home: this.wire.opts.home,
        config: () => this.config(),
        seen: (task) => this.factsOn(task),
        projects: () => this.collections().projects,
        lifecycle: this.deps.lifecycle,
        stands: (row) => this.deps.stands(row),
        queue: () => ({
          items: this.wire.live?.queued ?? [],
          events: this.wire.live?.queueFacts().events ?? [],
        }),
        talking: () => this.talking(),
        devices: () => this.devices,
        conversation: () => this.conversation(),
        talk: this.deps.talk,
        saved: () => this.deps.saved(),
        settings: {
          rows: () => this.deps.settings.rows(),
          known: () => this.known(),
          write: (path, value, by) => this.deps.settings.write(path, value, by),
        },
        now: () => this.wire.now(),
      }),
      tickets: this.tickets,
      streams: this.streams,
      tell: (told) => void this.log(told),
      now: () => this.wire.now(),
    })
    this.server = server
    const bound = await server.listen()
    await this.log({
      type: 'web_enabled',
      detail: { enabled: true, bind: surface.bind, port: surface.port, bound: bound.join(' ') },
    })
    if (bound.length === 0) {
      // Every address refused the bind. Named, never a quiet success: a URL in
      // somebody's hand that goes nowhere is worse than a surface that said it
      // could not come up. The per-address reason is already a `warning`.
      this.problem = `nothing could listen on port ${surface.port}`
      this.deps.news(`the away view could not listen on port ${surface.port}`)
    }
    this.devices = (await readDevices(this.wire.opts.home)).devices
    await this.push.open()
  }

  /** Close every stream, then the listener; no code or question at the door outlives it. Safe twice. */
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.projectors.clear()
    this.caughtUp.clear()
    this.tickets.clear()
    this.asking?.answer({ let: false, why: 'nobody answered' })
    this.asking = null
    if (server === null) return
    await server.close()
    await this.log({ type: 'web_enabled', detail: { enabled: false } })
  }

  /**
   * One beat, on `Live`'s existing refresh.
   *
   * **Nothing at all is built for nobody.** The beat marks what the last one
   * built as stale and then does two things: advances the projection for each
   * device with a stream open, and lets the streams do their own time-based
   * work. With nobody connected both are empty loops — so an enabled away
   * view nobody is looking at costs one assignment every two seconds, and in
   * particular runs none of the four folds over the journal that building a
   * projection needs. `test/away.test.ts` asserts that as a count of reads
   * rather than as this sentence.
   *
   * The collections are built *on demand* instead (`collections`), because a
   * request is not idle — and memoised until the next beat, so four tabs of
   * one phone asking at once is one build.
   */
  beat(): void {
    if (this.server === null) return
    const now = this.wire.now()
    this.held = null
    this.beatAt = now
    for (const device of this.streams.listening()) {
      const held = this.devices.find((one) => one.id === device)
      if (held === undefined) continue
      const delta = this.projectorFor(reachOf(held)).beat(this.inputFor(reachOf(held)), now)
      // Marked as caught up, so a request arriving between beats answers from
      // what this beat built rather than building a second projection for the
      // same input to be told nothing changed.
      this.caughtUp.set(device, now)
      if (delta !== null) this.streams.push(device, delta, now)
    }
    // Heartbeats, clients that stopped reading, sessions that ran out: all of
    // it on this beat and nowhere else, which is what "no unbounded timers"
    // means mechanically.
    this.streams.beat(now)
    // Agents' screens, for whoever is still looking: a comparison and a return
    // when nobody is (`web-lanes.ts`), and never a wait on the driver.
    this.lanes.beat(now)
    // And the one thing `streams.beat` cannot know: a device revoked somewhere
    // other than this window — `tade web revoke`, `tade web off`. Fired and
    // not awaited, because the beat is synchronous and the window draws on
    // this thread; `web-sessions.ts` has the whole argument.
    void letGoOfRevoked(this.sessions())
    // And the notifications: nothing awaited — somebody else's latency.
    this.push.beat()
    if (this.asking !== null || this.streams.listening().length !== this.readers) this.wire.draw()
  }

  /**
   * The collections, built at most once per beat and only if somebody asked.
   *
   * `null` for the world before the first look is **not** an empty workspace:
   * `unknown` is first-class, and an empty one would reach a phone as *nothing
   * is running*. What it reaches the page as instead is a projection with no
   * rows and its own freshness, which the page draws as *nothing read yet*.
   */
  private collections(): AwayHeld {
    const held = this.held
    if (held !== null) return held
    const live = this.wire.live
    const world = live?.world ?? null
    const made =
      live === null || world === null ? nothingYet() : awayCollections(this.partsOf(live, world))
    // **The conversation goes over the top**, because it is the window's and
    // not the world's: `null` from `nothingYet` would say *talking is not
    // turned on* until `Live` has looked once — the first second of a window.
    this.held = { ...made, talk: this.talkNow() }
    return this.held
  }

  /**
   * The beat's own parts, out of held values only.
   *
   * `seenActions` is the last look and never a look; `spendToday` is a kept
   * fold; `overridesFrom`, `writtenOrder`, `documentsIn` and `ranOn` are folds
   * over the journal the window already has; `planUsage` is what each harness
   * already said. **No `git`, no `ps`, no `collectStatus`** — a page refresh
   * starts no work at all, which is the promise a test asserts as a count of
   * calls (`test/away.test.ts`).
   */
  private partsOf(live: Held, world: Workspace): AwayBeat {
    return beatParts(
      {
        events: live.events,
        rootLines: live.rootLines,
        pending: live.pending,
        seenActions: (task) => live.seenActions(task),
        spendToday: () => live.spendToday(),
        queued: live.queued,
        queueFacts: () => live.queueFacts(),
        notes: (project) => live.notes(project),
        tasks: live.tasks,
        titles: titlesOf(this.config()),
        plans: planStandings(this.wire.opts.client.planUsage(), this.wire.now()),
        machineUpSince: this.upSince,
        // The period `spendToday` covers, handed over beside the fold so the
        // page says what the figures are of rather than guessing. Through
        // `startOfToday`, which is the same rule `Live` folds by — one rule,
        // so the label and the number cannot be of two different days.
        spendSince: startOfToday(this.wire.now()),
      },
      world,
      (task) => steeringFor(this.wire.opts.client, task),
      this.deps.factory(),
    )
  }

  /**
   * The devices again, after one was paired or signed out.
   *
   * Read **whether or not anything is listening**, because the list is the
   * mitigation: a window with the away view off still has to be able to show
   * every device there is and disconnect them, and a panel that said *no
   * device is paired* over a file holding three would be the one lie this
   * panel exists to prevent. It is a file read on a person's own act, not on
   * a beat.
   */
  async reread(): Promise<void> {
    const read = await readDevices(this.wire.opts.home)
    this.devices = read.devices
    if (read.skipped > 0) {
      this.problem = `${read.skipped} line(s) of the paired-device list could not be read`
    }
    this.wire.draw()
  }

  /**
   * The window's own approve/deny keys, when a device is waiting.
   *
   * Letting a device in is the same act in the same vocabulary as approving a
   * tool call, so it is the same pair of keys rather than a second pair to
   * learn — and it takes precedence while a device is asking, because that
   * question has a sixty-second deadline in front of you and an approval does
   * not. With nothing asking, the keys go where they always went.
   */
  async decide(allow: boolean): Promise<void> {
    const asking = this.asking
    if (asking === null) {
      await this.deps.decided(allow)
      return
    }
    this.asking = null
    asking.answer(
      allow
        ? // **Names and counts, and nothing else**, because that is what a
          // keypress with one question on it can honestly grant. Widening what
          // one device may read is its own act with its own control, and
          // granting it from a yes/no would be a yes to a question nobody was
          // asked.
          { let: true, projects: null, granted: [] }
        : { let: false, why: 'refused' },
    )
    await this.reread()
    this.wire.draw()
  }

  panel(): Frame['panel'] {
    if (codeShownOn(this.wire.state.panel) === null) return {}
    const surface = surfaceOf(this.config().surfaces.web)
    keepCode(this.tickets, surface, (this.server?.bound.length ?? 0) > 0, this.wire.now())
    return { away: this.view() }
  }

  /** The strip's chip (`Frame.remote`): what is listening, and how many devices are reading. */
  facts(): Partial<Frame> {
    const on = this.server !== null && this.server.bound.length > 0
    this.readers = on ? this.streams.listening().length : 0
    return { remote: { on, devices: this.readers } }
  }

  inputs(): PanelInputs {
    return {
      devices: this.devices.filter((one) => one.revoked === null).length,
      bindings: this.config().surfaces.window.keys,
    }
  }

  /**
   * The one way the panel is opened: a command somebody types.
   *
   * A command rather than a fifth button in the footer, which is four controls
   * every window has: this is the one page whose whole subject is off by
   * default, and a grey button for a feature nobody turned on costs every
   * window a column to say nothing. `/` lists it and `ctrl+k` finds it, which
   * is how the window already offers a thing you ask for rather than press.
   */
  actions(): Actions {
    return {
      '/away': async () => {
        this.wire.put({ ...this.wire.state, panel: awayPanel() })
        if (this.server !== null) this.mint()
        this.wire.draw()
        // Awaited, so the first frame of the panel already has the devices on
        // it: a list that arrives one frame later is a list that reads, for a
        // moment, as nobody being paired.
        await this.reread()
      },
    }
  }

  submits(): Submits {
    return {
      away: (_panel, choice) => this.carry(choice ?? ''),
    }
  }

  /** What the panel's own controls do, there or on the Away page of Settings. It stays open. */
  async carry(control: string): Promise<void> {
    this.problem = null
    try {
      if (control === AWAY_CONTROLS.code) this.mint()
      else if (control === AWAY_CONTROLS.allow) await this.decide(true)
      else if (control === AWAY_CONTROLS.deny) await this.decide(false)
      else if (control === AWAY_CONTROLS.all) await revokeEvery(this.sessions(), this.tickets)
      else if (isLink(control)) await carryLink(this.wire, control, this.tickets, this.deps)
      else if (control.startsWith(AWAY_CONTROLS.revoke)) {
        await revokeOne(this.sessions(), control.slice(AWAY_CONTROLS.revoke.length))
      } else await widen(this.widening(), control)
    } catch (err) {
      // Said on the panel where the button was pressed, and never swallowed:
      // pressing Disconnect everything and watching nothing happen is the
      // failure this catch exists to make visible.
      this.problem = err instanceof Error ? err.message : String(err)
    }
    this.wire.draw()
  }

  /**
   * What letting one device act, talk or see needs of this subject. **A
   * keypress at this machine** is the only door, and `web-grants.ts` has why.
   */
  private widening() {
    return {
      home: this.wire.opts.home,
      config: () => this.config(),
      now: () => this.wire.now(),
      devices: () => this.devices,
      log: (told: Told) => this.log(told),
      news: (said: string) => this.deps.news(said),
      reread: () => this.reread(),
    }
  }

  /** What ending a session needs of this subject, in one place for all three. */
  private sessions(): Sessions {
    return {
      home: this.wire.opts.home,
      now: () => this.wire.now(),
      listening: () => this.streams.listening(),
      keep: (devices) => {
        this.devices = devices
      },
      letGo: (device, why) => {
        this.forget(device)
        void this.log({ type: 'web_revoked', detail: { device, why } })
      },
      news: (said) => this.deps.news(said),
      reread: () => this.reread(),
    }
  }

  /**
   * A device that is no longer one: its streams closed, and nothing of it kept.
   *
   * All three together, because two out of three is a projection and a
   * revision held for a device that cannot ask again — small, and the kind of
   * leak that is only ever found by reading this function.
   */
  private forget(id: string): void {
    this.streams.revoke(id, 'signed out')
    this.projectors.delete(id)
    this.caughtUp.delete(id)
    this.lanes.forget(id)
  }

  /** A fresh ticket for the address a phone would reach this on. */
  private mint(): void {
    if (this.server === null) return
    mintPairing(this.tickets, surfaceOf(this.config().surfaces.web), this.wire.now())
  }

  /** What the panel draws, out of what this subject holds at this moment. */
  private view(): AwayView {
    const now = this.wire.now()
    const ticket = this.tickets.outstanding(now)[0] ?? null
    return awayView({
      surface: surfaceOf(this.config().surfaces.web),
      bound: this.server?.bound ?? [],
      listening: this.server !== null && this.server.bound.length > 0,
      ticket,
      asking: this.asking,
      devices: this.devices,
      live: new Set(this.streams.listening()),
      streams: this.streams.count,
      problem: this.problem,
      now,
    })
  }

  /**
   * Ask the person at the machine.
   *
   * The panel is opened rather than a line being printed somewhere, because
   * this is a question with a deadline and an answer that cannot be given
   * later. The promise is resolved by `decide`, or by the server's own
   * sixty-second deadline — which is an *answer* (nobody was there) and not a
   * failure, and which is why nothing here has a timer of its own.
   */
  private confirm(ask: PairingAsk): Promise<Confirmed> {
    return new Promise<Confirmed>((answer) => {
      this.asking = { ask, at: this.wire.now(), answer }
      this.wire.put({ ...this.wire.state, panel: awayPanel() })
      this.deps.news(`a device wants to pair: ${ask.label || 'unnamed'} from ${ask.from}`)
      this.wire.draw()
    })
  }

  /**
   * The reading for one device, caught up on demand.
   *
   * A device with a stream open is beaten by `beat`; one that only ever asks
   * `/api/snapshot` is not, so a request catches its projector up if the beat
   * has moved since it last did. **A request is not idle**, which is why doing
   * it here costs nothing in the case the budget was about.
   */
  private readingFor(reach: Reach): WebReading {
    const held = this.projectorFor(reach)
    return {
      snapshot: () => {
        this.catchUp(reach, held)
        return held.snapshot()
      },
      get rev() {
        return held.rev
      },
      notes: (scope, after) => {
        this.catchUp(reach, held)
        return held.notes(scope, after)
      },
      agent: (task) => {
        // **This request's reach, not the projector's.** The device list is
        // read at every request and a projector catches up on a beat, so a
        // grant taken back a second ago is already gone here — and the
        // collections are the ones this beat built, memoised, never a look.
        const answer = agentOf(reach, this.collections().tasks, task, this.agentIn(reach, task))
        // **Asking is looking**, and only a device that may read the screen,
        // about a task it may read at all, makes the window read one: an
        // ungranted phone with the page open costs the activity fold and no
        // lane, and a crafted name for a task out of reach costs nothing.
        if (answer.here && has(reach, 'lanes')) {
          this.lanes.watch(reach.device, task, this.wire.now())
        }
        return answer
      },
      // **This request's reach**, like an agent's, and the rows the window already lists.
      settings: () => settingsFor(this.deps.settings.rows(), reach, this.known()),
    }
  }

  /**
   * What the window holds of one agent: its activity out of the journal it
   * already has, and the lane as last read on a beat. Never a read now.
   */
  private agentIn(reach: Reach, task: string): AgentIn {
    const keys = () => this.known()
    return {
      activity: activityIn(this.wire.live?.events ?? [], task, AGENT.activity),
      lane: this.lanes.heldFor(task) ?? { kind: 'none', why: 'not read yet' },
      // Only for a device that will be shown a screen: asking every extension
      // for its keys is not free, and an ungranted answer has no screen.
      known: has(reach, 'lanes') ? this.lanes.keys(keys) : [],
    }
  }

  /** Every key Tade knows of: the config's, their variables, the environment's credentials. */
  private known(): string[] {
    const web = this.config().surfaces.web as unknown as Record<string, unknown>
    return knownKeys(this.wire.opts.extensions?.secrets() ?? [], web, process.env)
  }

  private catchUp(reach: Reach, held: Projector): void {
    if (this.caughtUp.get(reach.device) === this.beatAt) return
    this.caughtUp.set(reach.device, this.beatAt)
    const delta = held.beat(this.inputFor(reach), this.wire.now())
    if (delta !== null) this.streams.push(reach.device, delta, this.wire.now())
  }

  private projectorFor(reach: Reach): Projector {
    const held = this.projectors.get(reach.device)
    if (held !== undefined) return held
    const made = projector(this.inputFor(reach), this.wire.now())
    this.projectors.set(reach.device, made)
    return made
  }

  /**
   * What the projection last said about one task, as the facts a verb checks.
   *
   * Out of the collections the beat already built and **not** a fresh look:
   * the row the device tapped was built from these, so this is the comparison
   * being exact rather than approximate. What it is not is a lock — the
   * collections move on a beat, and what makes each act atomic at the moment
   * of the write is the door it goes through (`web-acting.ts` has the table).
   */
  private factsOn(task: string): TaskFacts | null {
    const row = this.collections().tasks.find((one) => one.id === task)
    return row === undefined ? null : factsOf(row)
  }

  /** The collections, with this device's reach and the server's own lifetime. */
  private inputFor(reach: Reach): SnapshotInput {
    const parts = this.collections()
    return {
      ...parts,
      // **Raised here and nowhere else**, because whether this device may send
      // a message is a fact about *this* device and the collections are built
      // once for everybody. `mine` arrives `false` from `talkIn`, so a wiring
      // change that forgot this line leaves every phone reading the
      // conversation and unable to send one — a capability that stopped
      // working rather than one that was handed out.
      talk: parts.talk === null ? null : { ...parts.talk, mine: this.mayAsk(reach.device) },
      reach,
      lifetime: {
        // The **server's** epoch, so a snapshot's freshness and a delta's `id`
        // are one string. Two sources for one value would make every
        // reconnection look like a restart, and nothing would go red because
        // resnapshotting is correct.
        epoch: this.server?.epoch ?? '',
        rev: this.projectors.get(reach.device)?.rev ?? 0,
        openedAt: this.wire.openedAt,
      },
    }
  }

  /**
   * Whether one device may send a message: granted `ask`, and still paired.
   *
   * A **drawing hint** and not permission — `admitAsk` re-asks the scope, the
   * setting and the origin at the turn, and `webAsking` builds the arm from
   * the device record again. What it is for is the rule `TaskRow.can` already
   * follows: a control nothing could carry out is a control nobody can
   * explain, so the page leaves the composer out rather than drawing one that
   * answers `403`.
   */
  private mayAsk(device: string): boolean {
    return this.paired(device)?.scopes.includes('ask') === true
  }

  /** The conversation as the projection takes it, or null where talking is off. */
  private talkNow(): ReturnType<typeof talkFor> {
    return talkFor(this.wire.state.transcript, this.deps.talk, this.talking())
  }

  private talking(): boolean {
    return surfaceOf(this.config().surfaces.web).talking
  }

  /** The conversation as it stands: the one fact a message assumes, and whose. */
  private conversation(): { busy: boolean; whose: string } {
    return { busy: this.deps.talk.busy(), whose: this.deps.talk.whose() }
  }

  /**
   * What the `ToolHost` asks at every call: the arm, narrowed to what that
   * device is granted now, and this device's own projection.
   *
   * Built here rather than in `app.ts` because every one of its three answers
   * is this subject's: the lease is the conversation's and the device list is
   * this one's, and a window that handed them over separately would be two
   * places deciding what a turn from away may reach.
   */
  arming(): Arming {
    const snapshot = (one: Device) => this.readingFor(reachOf(one)).snapshot()
    return armingFor({
      arm: () => this.deps.talk.arm(),
      paired: (device) => this.paired(device) ?? null,
      seen: (arm) => seenFrom(arm, (id) => this.paired(id), snapshot),
      log: (event) => this.wire.opts.client.log.append(event),
      note: (said) => this.deps.news(said),
    })
  }

  /** One device as the list has it **now**, or undefined for one that is gone. */
  private paired(device: string): Device | undefined {
    return this.devices.find((one) => one.id === device && one.revoked === null)
  }

  private config(): Config {
    return this.wire.opts.config
  }
}
