import {
  type Arm,
  type Arming,
  type Config,
  type InboxRow,
  planStandings,
  startOfToday,
  titlesOf,
  type Workspace,
} from '@tade/core'
import {
  type Confirmed,
  type Device,
  factsOf,
  type PairingAsk,
  type Projector,
  projector,
  type Reach,
  reachOf,
  readDevices,
  type SnapshotInput,
  Streams,
  surfaceOf,
  type TaskFacts,
  Tickets,
  type Told,
  type WebReading,
  type WebServer,
  webServer,
} from '@tade/web'
import { awayCollections } from '../away.ts'
import type { Frame } from '../frame.ts'
import { AWAY_CONTROLS, awayPanel } from '../panels/away/state.ts'
import type { AwayView } from '../panels/away/view.ts'
import type { PanelInputs } from '../panels.ts'

import type { Actions, Subject, Submits, Wiring } from './context.ts'
import { letOneAct, letOneTalk, webActing } from './web-acting.ts'
import { armingFor, type Talking, webAsking } from './web-asking.ts'
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
import { halvesFor } from './web-halves.ts'
import { awayView, mintPairing } from './web-panel.ts'
import { pushFor, type WebPush } from './web-push.ts'
import { letGoOfRevoked, revokeEvery, revokeOne, type Sessions } from './web-sessions.ts'

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
  /** The one door a setting is written by: the generated notification key. */
  writeKey(key: string, value: string, was: string): Promise<void>
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

  constructor(wire: Wiring, deps: AwayDeps) {
    this.wire = wire
    this.deps = deps
    // Out of the collections the beat already built: no look at the world.
    this.push = pushFor(wire, deps, {
      tasks: () => this.collections().tasks,
      devices: () => this.devices,
      tell: (told) => void this.log(told),
    })
  }

  /**
   * Start listening, if a person turned it on.
   *
   * Called once, from `begin`. A `web_enabled` line goes in the journal with
   * what it came up as and what it actually bound — the second half being
   * what a config cannot say, and the half somebody reading the journal a
   * month later needs in order to know whether anything was reachable at all.
   */
  async open(): Promise<void> {
    const surface = surfaceOf(this.config().surfaces.web)
    if (!surface.enabled) return
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
      detail: {
        enabled: true,
        bind: surface.bind,
        port: surface.port,
        bound: bound.join(' '),
      },
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

  /** Close every stream, then the listener. Safe twice, and safe before `open`. */
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.projectors.clear()
    this.caughtUp.clear()
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
    // And the one thing `streams.beat` cannot know: a device revoked somewhere
    // other than this window — `tade web revoke`, `tade web off`. Fired and
    // not awaited, because the beat is synchronous and the window draws on
    // this thread; `web-sessions.ts` has the whole argument.
    void letGoOfRevoked(this.sessions())
    // And the notifications: nothing awaited — somebody else's latency.
    this.push.beat()
    if (this.asking !== null) this.wire.draw()
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
   * fold; `overridesFrom`, `writtenOrder`, `producedIn` and `ranOn` are folds
   * over the journal the window already has; `planUsage` is what each harness
   * already said. **No `git`, no `ps`, no `collectStatus`** — a page refresh
   * starts no work at all, which is the promise a test asserts as a count of
   * calls (`test/away.test.ts`).
   */
  private partsOf(live: Held, world: Workspace): AwayBeat {
    return beatParts(
      {
        events: live.events,
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

  facts(): Partial<Frame> {
    return {}
  }

  panel(): Frame['panel'] {
    if (this.wire.state.panel?.kind !== 'away') return {}
    return { away: this.view() }
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

  /** What the panel's own controls do. The panel stays open while they happen. */
  private async carry(control: string): Promise<void> {
    this.problem = null
    try {
      if (control === AWAY_CONTROLS.code) this.mint()
      else if (control === AWAY_CONTROLS.allow) await this.decide(true)
      else if (control === AWAY_CONTROLS.deny) await this.decide(false)
      else if (control === AWAY_CONTROLS.all) await this.revokeEverything()
      else if (control.startsWith(AWAY_CONTROLS.revoke)) {
        await this.revoke(control.slice(AWAY_CONTROLS.revoke.length))
      } else if (control.startsWith(AWAY_CONTROLS.talk)) {
        // Checked **before** `act`, because `away-talk:` and `away-act:` are
        // different prefixes and the order of these branches is the order a
        // reader checks them in; a prefix that is a prefix of another would be
        // a control that silently did the other thing.
        await this.letItTalk(control.slice(AWAY_CONTROLS.talk.length))
      } else if (control.startsWith(AWAY_CONTROLS.act)) {
        await this.letItAct(control.slice(AWAY_CONTROLS.act.length))
      }
    } catch (err) {
      // Said on the panel where the button was pressed, and never swallowed:
      // pressing Disconnect everything and watching nothing happen is the
      // failure this catch exists to make visible.
      this.problem = err instanceof Error ? err.message : String(err)
    }
    this.wire.draw()
  }

  /** One device, disconnected at the machine. Its streams close now. */
  private revoke(id: string): Promise<void> {
    return revokeOne(this.sessions(), id)
  }

  /**
   * Let one device act, or take it back. **A keypress at this machine.**
   *
   * The only door a scope widens through, and there is deliberately no other:
   * no route, no orchestrator tool and no config key, because the thing that
   * grants authority is never reachable from inside the authority it granted
   * (DESIGN.md §9.1). What it decides is in `web-acting.ts`; what is here is
   * the window's half — the file, the line, and the sentence in the strip.
   */
  private async letItAct(id: string): Promise<void> {
    const granted = await letOneAct(
      {
        home: this.wire.opts.home,
        acting: () => surfaceOf(this.config().surfaces.web).acting,
        now: () => this.wire.now(),
      },
      this.devices,
      id,
    )
    await this.log({
      // The same kind of line as a device being let in or disconnected, and
      // for the same reason: somebody who did not press the key is the one who
      // most needs to see that it happened.
      type: 'web_paired',
      detail: { device: id, scopes: granted.scopes.join(' '), granted: 'at the machine' },
    })
    this.deps.news(granted.said)
    await this.reread()
  }

  /**
   * Let one device talk to Tade, or take it back. **A keypress at this
   * machine**, and a second one from the act grant.
   *
   * The same door `letItAct` is and the same argument for there being no other
   * one: the thing that grants authority is never reachable from inside the
   * authority it granted. What it grants is `ask` and nothing else — a device
   * that may talk and may not act can be answered in words and cannot change
   * anything, because what a turn may *do* is read off the same `answer` and
   * `steer` scopes the act control writes.
   */
  private async letItTalk(id: string): Promise<void> {
    const granted = await letOneTalk(
      {
        home: this.wire.opts.home,
        talking: () => surfaceOf(this.config().surfaces.web).talking,
        now: () => this.wire.now(),
      },
      this.devices,
      id,
    )
    await this.log({
      type: 'web_paired',
      detail: { device: id, scopes: granted.scopes.join(' '), granted: 'at the machine' },
    })
    this.deps.news(granted.said)
    await this.reread()
  }

  /** Every device, and the outstanding code, gone. It needs no network. */
  private revokeEverything(): Promise<void> {
    return revokeEvery(this.sessions(), this.tickets)
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
      notes: (scope) => {
        this.catchUp(reach, held)
        return held.notes(scope)
      },
    }
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
   * What a remote turn's "where are we" is answered with: that device's own
   * projection, which `Arming.seen` has the argument for.
   *
   * A device that has gone **throws** rather than answering an empty tree:
   * *that device is no longer paired* is a true sentence a model can act on,
   * and nought projects would read as a machine with no work on it.
   */
  seen(arm: Arm): Promise<unknown> {
    if (arm.how !== 'remote') throw new Error('only a turn from away is answered this way')
    const device = this.paired(arm.device)
    if (device === undefined) throw new Error('that device is no longer paired')
    return Promise.resolve(this.readingFor(reachOf(device)).snapshot())
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
    return armingFor({
      arm: () => this.deps.talk.arm(),
      paired: (device) => this.paired(device) ?? null,
      seen: (arm) => this.seen(arm),
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

  /**
   * One line in the journal, and **said in the strip if it would not go in**.
   *
   * A journal that will not take a line is not a reason a request fails — a
   * phone must not get a `500` because a disk is full — but it may not be
   * swallowed either: `web_paired` and `web_did` are the audit, and "every act
   * one takes is in the journal under its id" is half of what stands against a
   * device somebody else let in. A line that silently did not land would make
   * that sentence quietly untrue, so the failure goes where a person reading
   * the window will see it.
   */
  private async log(told: Told): Promise<void> {
    try {
      await this.wire.opts.client.log.append({
        type: told.type,
        ...(told.task === undefined ? {} : { task: told.task }),
        detail: told.detail,
      })
    } catch (err) {
      this.deps.news(
        `the away view could not write ${told.type} down: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}
