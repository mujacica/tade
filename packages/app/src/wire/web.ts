import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import type { Arming, Config, SeenWord } from '@tade/core'
import type { ToolAnswer } from '@tade/harnesses-core'
import {
  AGENT,
  type AgentIn,
  type AnswerIn,
  agentOf,
  type Confirmed,
  type ConnectWhere,
  Copies,
  chatBefore,
  connectWhere,
  copyFrame,
  type Device,
  drawingDoor,
  factsOf,
  type Host,
  MOMENTS,
  nameDevice,
  type OrchestratorStanding,
  type PairingAsk,
  type Places,
  type Projector,
  projector,
  pusher,
  type Reach,
  reachOf,
  readDevices,
  type Snapshot,
  type SnapshotInput,
  Streams,
  settingsFor,
  sseFrame,
  surfaceOf,
  type TaskFacts,
  Tickets,
  type Told,
  TURNS,
  turnsAway,
  type WebAnswers,
  type WebEarlier,
  type WebReading,
  type WebServer,
  type WindowDoor,
  webServer,
  withoutCredentials,
} from '@tade/web'
import { lastUpdates } from '@tade/workbench/programs'
import { awayCollections, chatLines } from '../away.ts'
import { ACTIVITY_TYPES, activityIn, momentsOf } from '../away-activity.ts'
import type { Frame } from '../frame.ts'
import { approvalInFront } from '../model.ts'
import { ASKING_FIRST, AWAY_CONTROLS, awayPanel, BEHIND_THE_PANEL } from '../panels/away/state.ts'
import type { AwayView } from '../panels/away/view.ts'
import type { PanelInputs } from '../panels.ts'
import type { ActAnswer } from './acts.ts'
import { type Actions, notify, type Subject, type Submits, type Wiring, why } from './context.ts'
import { hooksFor } from './doorbell.ts'
import { drawing } from './drawing.ts'
import { evaluationsAnswer } from './evaluations.ts'
import { seenName } from './machines-seen.ts'
import { armingFor, seenFrom } from './web-asking.ts'
import { type AwayHeld, nothingYet, partsFrom, talkFor, upSinceOf } from './web-beat.ts'
import { carryingFor } from './web-carry.ts'
import { changesFrom } from './web-changes.ts'
import { CheckRecords } from './web-checks.ts'
import { connectingFor } from './web-connect.ts'
import type { AwayDeps } from './web-deps.ts'
import { diskFrom } from './web-disk.ts'
import { builtFrom, turnTo } from './web-follow.ts'
import { halvesFor } from './web-halves.ts'
import { knownHere, Lanes } from './web-lanes.ts'
import { carryConnect, carryLink, isConnect, isLink } from './web-link.ts'
import { ownedFor } from './web-owned.ts'
import { awayView, codeShownOn, keepCode, mintPairing, type PanelFacts } from './web-panel.ts'
import { Presences } from './web-presence.ts'
import { PublicHealth } from './web-public.ts'
import { pushFor, type WebPush } from './web-push.ts'
import { orchestratorRestartFrom, restartingFrom } from './web-restart.ts'
import { letGoOfRevoked, revokeEvery, revokeOne, type Sessions } from './web-sessions.ts'
import { sideFrom } from './web-side.ts'
import { OrchestratorSignIn } from './web-sign-in.ts'
import { heard, toldTo } from './web-told.ts'

/**
 * How many pages of the orchestrator's record one ask for earlier lines may
 * read (`earlierHalf`): enough for a page of them, and then the page asks again.
 */
const EARLIER_ROUNDS = 4

export type { AwayDeps }

/** How often a public listener that did not come up is tried again: a stat each time. */
const PUBLIC_AGAIN_MS = 15_000

// The window's end of the away view: the server's lifetime, the pairing panel,
// and the beat that moves the projection on.
//
// **The server lives in this process, behind the lock holder, and dies with it.** Four reasons, and
// the one that decides it: half the state only exists here. Pending approvals live in the
// supervisor, lane liveness is the driver's answer, and `Live` already computes the rest on a beat
// — a second process would either take `tade.lock` (refused) or write behind it (corrupt), and
// would double every `git` and `ps` call to give two answers to one question. The cost is stated
// rather than papered over: **the away view answers only while this window is open**, and a phone
// that taps the bookmark with Tade closed gets the browser's own connection error
// (`AWAY_IS_WHILE_OPEN`).
//
// **Nothing here is reachable by the orchestrator.** Every key it reads is in `reach.ts`'s `never`
// subtree, so a page an agent wrote cannot turn the listener on, move it to the network, change its
// port or add a trusted host. Pairing, granting and revoking are not settings at all: they are a
// keypress at this machine, which is the one authorisation nothing remote can obtain.
//
// **Idle costs nothing.** With `enabled: false` there is no server and `beat` returns on its first
// line. With it on and nobody connected, `beat` builds **no projection**: `streams.listening()` is
// empty, so there is nothing to project for. `test/away.test.ts` asserts that as a count of calls
// rather than as a sentence.

/** How often this machine's own projection is built while its listener is off and nothing beats it. */
const OWN_EVERY_MS = 1_000

/**
 * What this machine's own projection is built for when it is told another
 * machine of the person's: everything, as every device is sent — never a
 * device in the list, so no page's projector is it.
 */
const OWN: Reach = { device: 'every machine' }

export class Away implements Subject {
  private readonly wire: Wiring
  private readonly deps: AwayDeps
  private server: WebServer | null = null
  private readonly streams = new Streams({ tell: (told) => void this.log(told) })
  /** What every page of the person's own has been sent of each other machine (`copies.ts`). */
  private readonly copies = new Copies()
  /** The owner link each machine that links here last asked its outbox as, by its name: who a wake goes to. */
  private readonly outboxAsker = new Map<string, string>()
  /** The epoch this machine's own projection is told under while no listener has one (`own`). */
  private readonly offEpoch = randomUUID()
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
  /** The orchestrator's own sign-in, driven from the person's own phone. */
  private readonly signIn: OrchestratorSignIn
  /** What ran in each tree, read only while a beat is built for somebody (`web-checks.ts`). */
  private readonly records = new CheckRecords({ now: () => this.wire.now() })
  /** One line in the journal, said in the strip if it would not go in (`web-told.ts`). */
  private readonly log: (told: Told) => Promise<void>
  /** What the listener was last brought up for (`builtFrom`), null for down, and the turn doing it. */
  private wanted: string | null = null
  private turning: Promise<void> = Promise.resolve()
  /** The devices the strip's chip last drew: one more or fewer since is a frame owed. */
  private readers = 0
  /** The certificate and the version, while a public listener is up (`web-public.ts`). */
  private readonly health: PublicHealth
  /** The person at another of their screens, held and written once a stretch (`web-presence.ts`). */
  private readonly presences: Presences

  constructor(wire: Wiring, deps: AwayDeps) {
    this.wire = wire
    this.deps = deps
    this.log = toldTo(wire, (said) => deps.news(said))
    this.presences = new Presences(wire, (said) => deps.news(said))
    this.health = new PublicHealth({
      look: () => wire.opts.certificate ?? null,
      newer: async () => (await lastUpdates(wire.opts.home))?.tade.newer ?? null,
      news: (said) => deps.news(said),
      draw: () => wire.draw(),
      now: () => wire.now(),
    })
    // An act put in the outbox for a machine that links here wakes its link's
    // stream, so that machine collects it now rather than on its next beat.
    deps.acts?.wakes((name) => {
      const device = this.outboxAsker.get(name)
      if (device !== undefined) this.streams.wake(device)
    })
    this.signIn = new OrchestratorSignIn(wire, {
      ...(deps.restartOrchestrator && { restart: deps.restartOrchestrator }),
      known: () => this.lanes.keys(() => knownHere(this.wire, this.config())),
    })
    this.lanes = new Lanes({
      capture: (lane, lines) => wire.opts.client.capture(lane as never, lines, false),
      history: async (task, limit) => {
        const page = await wire.opts.client.agentHistory(task, { limit })
        return { turns: page.items, before: page.earlier }
      },
      // With the keys and places an ask is answered with (`agentIn`), so it finds them made.
      ready: (task, turns) =>
        turnsAway(
          turns,
          this.lanes.keys(() => knownHere(this.wire, this.config())),
          this.placesOf(task),
        ),
      trouble: (task, err) =>
        wire.note(
          new Error(
            `the away view could not read ${task}'s conversation: ${err instanceof Error ? err.message : String(err)}`,
          ),
        ),
      now: () => wire.now(),
    })
    // Out of the collections the beat already built: no look at the world.
    this.push = pushFor(
      wire,
      {
        writeKey: (...key) => deps.settings.writeKey(...key),
        // Asked for at the first send, never here: the push services', unless
        // a test handed in what it would have sent instead.
        pusher: (signing) => wire.opts.pusher?.(signing) ?? pusher({ signing }),
      },
      {
        tasks: () => this.collections().tasks,
        devices: () => this.devices,
        tell: (told) => void this.log(told),
        presentAt: () => this.presences.presentAt(),
      },
    )
  }

  /**
   * The window's state for a device with the full view open (`far-faces.ts`):
   * to that device's streams, and nothing while the listener is down.
   */
  window(device: string, message: unknown): void {
    if (this.server !== null) this.streams.window(device, message, this.wire.now())
  }

  /** Keep an agent's screen read for a device whose full view is in front of it (`web-lanes.ts`). */
  watchLane(device: string, task: string): void {
    this.lanes.watch(device, task, this.wire.now())
  }

  /** That agent's screen as last read for away, its keys and credentials taken out; null for none yet. */
  laneScreen(task: string): string | null {
    const held = this.lanes.heldFor(task)
    if (held?.kind !== 'read') return null
    // The rows below what the lane printed are the lane's height and nothing
    // else: a phone draws the foot of a screen in a shorter pane, so they go.
    return this.scrub(held.text.replace(/(?:[ \t]*\r?\n)+[ \t]*$/, ''))
  }

  /**
   * A screen's keys and credentials taken out, as the overview's text has them
   * taken out (`screen.ts`, kept by §10 T1): what a full view is sent of a lane.
   */
  scrub(text: string): string {
    return withoutCredentials(
      text,
      this.lanes.keys(() => knownHere(this.wire, this.config())),
    )
  }

  /** "Nobody is here", for a turn Tade starts, or null where somebody has been (`web-presence.ts`). */
  nobodyHere(): string | null {
    return this.presences.nobodyHere()
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
    // `stop` clears every code, so one outstanding is the frame's, for this listener, on screen.
    const shown = () => this.tickets.outstanding(this.wire.now()).length > 0
    const mint = () =>
      codeShownOn(this.wire.state.panel) === null || shown() ? undefined : this.mint()
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
      // What a browser that draws the window itself is served (`/draw`):
      // built the first time one asks, never as the listener opens.
      drawing: drawingDoor(drawing),
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
          known: () => knownHere(this.wire, this.config()),
          write: (path, value, by) => this.deps.settings.write(path, value, by),
        },
        now: () => this.wire.now(),
      }),
      answers: this.answers(),
      // An agent's changes and their diffs, read when a page opens them: the window's Show changes.
      changes: changesFrom({
        live: () => this.wire.live ?? null,
        known: () => this.lanes.keys(() => knownHere(this.wire, this.config())),
        note: (err) => this.wire.note(err),
      }),
      earlier: this.earlierHalf(),
      present: (device, at) => this.presences.seen(device, at),
      ...(this.deps.machines && {
        seen: (device, word, at, host, name) => this.seen(device, word, at, host, name),
      }),
      looking: (device, at) => this.push.looking(device, at),
      // The window itself, for a phone that draws its own copy (`far-faces.ts`).
      ...windowFor(this.deps.window?.()),
      since: this.presences.since(),
      carrying: carryingFor(this.wire, this.deps.settings),
      // The doorbells, answered only on a public listener and only for a source with a secret.
      ...(this.deps.doorbell && {
        hooks: hooksFor(this.wire, () => this.config(), this.deps.doorbell),
      }),
      ...(this.deps.side && { side: sideFrom(this.wire, this.deps.side) }),
      // What is on disk in a project the side drew, pressed there: confined to its tree.
      ...(this.deps.side && { disk: diskFrom(this.wire) }),
      ...ownedFor(
        this.wire,
        () => this.panelFacts(),
        this.deps.lifecycle,
        this.deps.inventory,
        this.deps.waiting,
        this.standing(),
      ),
      // Tade started again from the person's own phone: every machine, as the strip's reload.
      restarting: restartingFrom(this.wire, this.deps.reloadStops, this.deps.reloadAll),
      // Its orchestrator alone, on a sign-in made here from another machine's `/login`.
      orchestratorRestart: orchestratorRestartFrom(this.wire, this.deps.restartOrchestrator),
      // `/login` from the person's own phone: its sign-in, run here and typed into from there.
      orchestratorSignIn: this.signIn,
      // Settings › Accounts for every machine, and an account's sign-in from away.
      ...(this.deps.accounts && { accounts: this.deps.accounts }),
      ...(this.deps.feeds && { feeds: this.deps.feeds.web() }),
      ...(this.deps.projections && { projectionTold: this.deps.projections.web() }),
      ...(this.deps.conversation && { conversation: this.deps.conversation.web() }),
      ...(this.deps.duties && { duties: this.deps.duties.door() }),
      ...(this.deps.acts && {
        acts: {
          take: (act, _device, label) =>
            this.deps.acts?.take({ ...act, from: label }) as Promise<ActAnswer>,
          outbox: async (answers, device, label) => {
            this.outboxAsker.set(seenName(label), device)
            return { acts: this.deps.acts?.outboxFor(label, answers) ?? [] }
          },
        },
        // A press on another machine's row from this door's page: sent as this
        // window's own press is, and what that machine said — or why it was
        // not done — handed back as words the page shows.
        pressThere: {
          press: async (req) => {
            const acts = this.deps.acts
            if (!acts) return { ok: false, said: 'this window acts on no other machine' }
            try {
              return { ok: true, said: await acts.pressed(req) }
            } catch (err) {
              return { ok: false, said: why(err) }
            }
          },
        },
      }),
      // The guided pages that connect GitHub, Slack and Linear (`web-connect.ts`):
      // this machine's own door and an owner's, and the callbacks where each
      // sends a browser — Linear's tokens handed to the window's holder.
      connecting: connectingFor({
        config: () => this.config(),
        settings: this.deps.settings,
        heard: (source) => this.wire.live?.heardFrom(source) ?? { verified: null, refused: null },
        now: () => this.wire.now(),
        ...(this.deps.linear && { linear: this.deps.linear }),
      }),
      tickets: this.tickets,
      streams: this.streams,
      tell: heard(
        this.log,
        (said) => this.deps.news(said),
        () => this.reread(),
      ),
      now: () => this.wire.now(),
    })
    this.server = server
    const bound = await server.listen()
    this.health.up(server.public === null ? null : surface.publicName)
    await this.log({
      type: 'web_enabled',
      detail: {
        enabled: true,
        bind: surface.bind,
        port: surface.port,
        bound: bound.join(' '),
        public: server.public === null ? '' : (surface.publicName ?? ''),
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

  /** When the public listener was last tried again, and whether a try is under way. */
  private publicTried = 0
  private publicTrying = false

  /**
   * The public listener tried again, every `PUBLIC_AGAIN_MS`, while a public
   * name is set and it is not up: its directory is root's to make, and on a
   * box being set up it is made after the away view was turned on, which
   * otherwise needed a restart nobody was told about. A stat while it is not
   * there, nothing once it is up, and said in the news when it comes up.
   */
  private publicAgain(now: number): void {
    const server = this.server
    if (server === null || server.public !== null || server.publicTrouble === null) return
    if (this.publicTrying || now - this.publicTried < PUBLIC_AGAIN_MS) return
    this.publicTried = now
    this.publicTrying = true
    void server
      .listenPublicAgain()
      .then((up) => {
        if (!up || this.server !== server) return
        const name = surfaceOf(this.config().surfaces.web).publicName
        this.health.up(name)
        this.deps.news(`the away view now answers Caddy for ${name ?? 'the public name'}`)
      })
      .catch((err: unknown) => {
        this.deps.news(`the away view could not try Caddy's socket again: ${String(err)}`)
      })
      .finally(() => {
        this.publicTrying = false
      })
  }

  /** Close every stream, then the listener; no code or question at the door outlives it. Safe twice. */
  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.health.up(null)
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
  /**
   * Every open page, and every one opened after — on this listener or the next
   * this window starts — is told Tade's own code changed since it started
   * (`own-code.ts`), so a screen newer than the routes answering it says so.
   */
  restart(): void {
    this.streams.restartAll()
  }

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
    this.beatCopies(now)
    // Heartbeats, clients that stopped reading, sessions that ran out: all of
    // it on this beat and nowhere else, which is what "no unbounded timers"
    // means mechanically.
    this.streams.beat(now)
    // Agents' screens, for whoever is still looking: a comparison and a return
    // when nobody is (`web-lanes.ts`), and never a wait on the driver.
    this.lanes.beat(now)
    // A sign-in from away: whether it ended, and its screen while somebody looks.
    this.signIn.beat(now)
    // And the one thing `streams.beat` cannot know: a device revoked somewhere
    // other than this window — `tade web revoke`, `tade web off`. Fired and
    // not awaited, because the beat is synchronous and the window draws on
    // this thread; `web-sessions.ts` has the whole argument.
    void letGoOfRevoked(this.sessions())
    // And the notifications: nothing awaited — somebody else's latency.
    this.push.beat()
    // And the public listener's certificate and version, on clocks of their own.
    this.health.beat()
    this.publicAgain(now)
    if (this.asking !== null || this.streams.listening().length !== this.readers) this.wire.draw()
  }

  /**
   * This machine's own projection as an owner of it is sent: what it tells
   * every machine it links to (`projection-shared.ts`), so a page there draws
   * this machine's work. Built at most once a beat, by a projector of its own,
   * and only when asked — **whether or not this machine's own page is on**: the
   * phone may well reach every machine through another's door, and this one's
   * work is drawn there all the same. With the listener off there is no beat
   * here to build it on, so it is built at most once a second; its projector's
   * epoch is the cursor it is told under, and a listener starting or stopping
   * here is a new one, told whole.
   */
  own(): Snapshot | null {
    const held = this.projectorFor(OWN)
    const now = this.wire.now()
    const at = this.server === null ? now - (now % OWN_EVERY_MS) : this.beatAt
    if (this.caughtUp.get(OWN.device) !== at) {
      this.caughtUp.set(OWN.device, at)
      held.beat(this.inputFor(OWN), now)
    }
    return held.snapshot()
  }

  /**
   * The other machines' copies, moved on for every page of the person's own
   * that is open — and for nobody else. With none open, nothing is compared:
   * what was sent is let go, so the next page to open is sent each copy whole
   * on the beat after it does.
   */
  private beatCopies(now: number): void {
    const to = new Set(this.streams.listening().filter((device) => this.sentCopies(device)))
    if (to.size === 0) {
      this.copies.beat([])
      return
    }
    const frames = this.copies.beat(this.deps.copies?.() ?? [])
    this.streams.pushCopies(
      to,
      frames.map((frame) => sseFrame(copyFrame(frame))),
      now,
    )
  }

  /** Whether this device is sent the other machines' copies: a paired device, and not a link. */
  private sentCopies(device: string): boolean {
    const held = this.paired(device)
    return held !== undefined && !held.owner
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
      live === null || world === null
        ? nothingYet()
        : awayCollections(
            partsFrom(this.wire, live, world, {
              upSince: this.upSince,
              records: this.records,
              factory: this.deps.factory(),
            }),
          )
    // **The conversation goes over the top**, because it is the window's and
    // not the world's: `null` from `nothingYet` would say *talking is not
    // turned on* until `Live` has looked once — the first second of a window.
    this.held = { ...made, talk: this.talkNow() }
    return this.held
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

  /** The devices whose new name could not be written down, said once each. */
  private readonly unnamed = new Set<string>()

  /**
   * A machine that links here said it is up or closing (`/api/seen`), and
   * perhaps what it is called now: a name that is not the label it paired
   * with is written on its device (`nameDevice`) and its record moves to it
   * (`MachinesSeen.heard`'s `was`), so the host name it paired under before it
   * had a name of its own stops being what it is called here.
   */
  private seen(
    device: Pick<Device, 'id' | 'label'>,
    word: SeenWord,
    at: number,
    host: Host | null,
    name: string | null,
  ): void {
    const machines = this.deps.machines
    if (machines === undefined) return
    if (name === null || name === device.label) {
      machines.heard(device.label, word, at, host)
      return
    }
    machines.heard(name, word, at, host, device.label)
    nameDevice(this.wire.opts.home, device, name, new Date(at))
      .then(() => this.reread())
      .catch((err: unknown) => {
        if (this.unnamed.has(device.id)) return
        this.unnamed.add(device.id)
        this.deps.news(
          `that ${device.label} is called ${name} now could not be written down: ${String(err)}`,
        )
      })
  }

  /**
   * The window's own approve/deny keys, pressed with no panel open.
   *
   * Letting a device in is the same act in the same vocabulary as approving a
   * tool call, so it is the same pair of keys rather than a second pair to
   * learn — and it takes precedence while a device is asking, because that
   * question has a sixty-second deadline in front of you and an approval does
   * not. **But its card is on no screen while the panel is shut**, so the key
   * opens the panel on it and answers nothing: a yes to a device nobody can
   * see is a device in your control room, and the card in front was the
   * agent's. With nothing asking, the keys go where they always went.
   */
  async keyed(allow: boolean): Promise<void> {
    if (this.asking === null) {
      await this.deps.decided(allow)
      return
    }
    this.wire.put({ ...this.wire.state, panel: { ...awayPanel(), said: ASKING_FIRST } })
    this.wire.draw()
  }

  /**
   * A yes or a no from the panel, which answers only while the card is drawn
   * (`awayKey`). With nothing asking, the key is the window's own and asks the
   * window's own question — whether an agent's card is in front
   * (`approvalInFront`) — which says no while a panel covers the pane, so the
   * agent behind it is not answered and the panel says why.
   */
  async decide(allow: boolean): Promise<void> {
    const asking = this.asking
    if (asking === null) {
      const shown = this.wire.state.panel
      if (approvalInFront(this.wire.state)) await this.deps.decided(allow)
      else if (shown?.kind === 'away') {
        this.wire.put({ ...this.wire.state, panel: { ...shown, said: BEHIND_THE_PANEL } })
      } else notify(this.wire, BEHIND_THE_PANEL)
      return
    }
    this.asking = null
    // A yes is all of it: every paired device is the person's own.
    asking.answer(allow ? { let: true } : { let: false, why: 'refused' })
    await this.reread()
    this.wire.draw()
  }

  panel(): Frame['panel'] {
    // Settings › Intake says where the guided pages that connect a source
    // are, and only this subject knows whether its door is up to serve them.
    const shown = this.wire.state.panel
    if (shown?.kind === 'settings' && shown.category === 'intake' && shown.search === '') {
      return { connect: this.connectHere() }
    }
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
      asking: this.asking !== null,
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
    if (isConnect(control)) {
      // Pressed on Settings › Intake, which draws no `problem` of this
      // panel's: what went wrong is said in the conversation instead.
      try {
        await carryConnect(this.wire, control, this.connectHere(), this.deps)
      } catch (err) {
        notify(this.wire, err instanceof Error ? err.message : String(err))
      }
      this.wire.draw()
      return
    }
    this.problem = null
    try {
      if (control === AWAY_CONTROLS.code) this.mint()
      else if (control === AWAY_CONTROLS.allow) await this.decide(true)
      else if (control === AWAY_CONTROLS.deny) await this.decide(false)
      else if (control === AWAY_CONTROLS.all) await revokeEvery(this.sessions(), this.tickets)
      else if (isLink(control)) await carryLink(this.wire, control, this.tickets, this.deps)
      else if (control.startsWith(AWAY_CONTROLS.revoke)) {
        await revokeOne(this.sessions(), control.slice(AWAY_CONTROLS.revoke.length))
      }
    } catch (err) {
      // Said on the panel where the button was pressed, and never swallowed:
      // pressing Disconnect everything and watching nothing happen is the
      // failure this catch exists to make visible.
      this.problem = err instanceof Error ? err.message : String(err)
    }
    this.wire.draw()
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

  /**
   * Where the guided pages that connect a source answer now: this machine's
   * own door while it is up (`connectWhere`), and why not where it is not —
   * off, a `lan` bind, or a port another program held.
   */
  private connectHere(): ConnectWhere {
    const up = this.server !== null && this.server.bound.length > 0
    return connectWhere(surfaceOf(this.config().surfaces.web), up)
  }

  /** What the panel draws, out of what this subject holds at this moment. */
  private view(): AwayView {
    return awayView(this.panelFacts())
  }

  /** What this subject holds at this moment: what the panel and another machine read (`web-machine.ts`). */
  private panelFacts(): PanelFacts {
    const now = this.wire.now()
    const ticket = this.tickets.outstanding(now)[0] ?? null
    return {
      surface: surfaceOf(this.config().surfaces.web),
      bound: this.server?.bound ?? [],
      listening: this.server !== null && this.server.bound.length > 0,
      publicAt: this.server?.public ?? null,
      publicTrouble: this.server?.publicTrouble ?? null,
      health: this.health.lines(),
      ticket,
      asking: this.asking,
      devices: this.devices,
      live: new Set(this.streams.listening()),
      streams: this.streams.count,
      problem: this.problem,
      now,
    }
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
      copies: (held) => (this.sentCopies(reach.device) ? this.copies.opening(held) : []),
      notes: (scope, after) => {
        this.catchUp(reach, held)
        return held.notes(scope, after)
      },
      agent: (task, seen = null) => {
        // The collections are the ones this beat built, memoised, never a look.
        const answer = agentOf(this.collections().tasks, task, this.agentIn(task), AGENT, seen)
        // **Asking is looking**: a device asking about a task that is here
        // makes the window read its screen, and a crafted name for a task
        // that is not costs nothing.
        if (answer.here) {
          this.lanes.watch(reach.device, task, this.wire.now())
        }
        return answer
      },
      // **The conversation as it is now**, not as of the beat: what a look back
      // just read out of the record (`earlier`) is in it.
      chat: (before) => chatBefore(this.talkNow(), before),
      // What the window already holds.
      settings: () => settingsFor(this.deps.settings.rows(), knownHere(this.wire, this.config())),
      evaluations: () => evaluationsAnswer(this.wire),
    }
  }

  /**
   * One call's whole answer, read out of the record of the conversation it is
   * in when a page opens it (`@tade/web`'s `answered.ts`) — an agent's out of
   * its harness's, the orchestrator's out of its own. Never held: a page asks
   * once a press. A record that could not be read is said here, at the
   * machine, and to the page as `unread`, never as a call that answered nothing.
   */
  private answers(): WebAnswers {
    const read = async (what: string, asking: Promise<ToolAnswer | null>): Promise<AnswerIn> => {
      try {
        const found = await asking
        return found === null ? null : { result: found.result }
      } catch (err) {
        this.wire.note(
          new Error(
            `the away view could not read ${what}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        )
        return 'unread'
      }
    }
    return {
      agent: (task, call) =>
        read(`what ${task}'s call answered`, this.wire.opts.client.agentAnswer(task, call)),
      talk: (call) =>
        read(
          "what the orchestrator's call answered",
          this.wire.opts.callAnswer?.(call) ?? Promise.resolve(null),
        ),
      known: () => this.lanes.keys(() => knownHere(this.wire, this.config())),
    }
  }

  /**
   * A conversation read further back than a page holds (`@tade/web`'s
   * `earlier.ts`): Tade's through the window's own scrollback (`Earlier`), so
   * what is read is the window's as well, and an agent's out of its harness's
   * record, a page before the cursor its newest page gave. A record that could
   * not be read is said here, at the machine, and to the page as `unread`.
   */
  private earlierHalf(): WebEarlier {
    return {
      talk: async (before, want) => {
        const more = this.deps.earlier
        if (more === undefined) return true
        for (let round = 0; round < EARLIER_ROUNDS; round += 1) {
          const transcript = this.wire.state.transcript
          if (transcript.earlier === null) return true
          const held = chatLines(transcript).filter((line) => line.id < before).length
          if (held >= want) return true
          if (!(await more())) return false
        }
        return true
      },
      agent: async (task, before) => {
        try {
          const page = await this.wire.opts.client.agentHistory(task, {
            limit: TURNS.turns,
            before,
          })
          return { turns: page.items, before: page.earlier }
        } catch (err) {
          this.wire.note(
            new Error(
              `the away view could not read ${task}'s conversation further back: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
          return 'unread'
        }
      },
      // Out of the journal on a thread of its own (`Workbench.eventsBefore`):
      // a page scrolled past the newest stretch never holds up a beat.
      moments: async (task, before) => {
        try {
          const events = await this.wire.opts.client.eventsBefore({
            task,
            types: ACTIVITY_TYPES,
            before: Number(before),
            most: MOMENTS,
          })
          return momentsOf(events, MOMENTS)
        } catch (err) {
          this.wire.note(
            new Error(
              `the away view could not read what ${task} did further back: ${err instanceof Error ? err.message : String(err)}`,
            ),
          )
          return 'unread'
        }
      },
      known: () => this.lanes.keys(() => knownHere(this.wire, this.config())),
      places: (task) => this.placesOf(task),
    }
  }

  /**
   * Where a path in one agent's call briefs is shortened to: where its task
   * works (`.`), Tade's home and the home directory — the rule an approval's
   * command and Tade's own conversation already go by.
   */
  private placesOf(task: string): Places {
    const worked = this.wire.live?.world?.projects
      .flatMap((project) => project.tasks)
      .find((one) => one.id === task)?.worktree
    return { work: worked ?? null, tade: this.wire.opts.home, home: homedir() }
  }

  /**
   * What the window holds of one agent: its activity out of the journal it
   * already has, and the lane as last read on a beat. Never a read now.
   */
  private agentIn(task: string): AgentIn {
    const keys = () => knownHere(this.wire, this.config())
    return {
      ...activityIn(this.wire.live?.events ?? [], task, AGENT.activity),
      lane: this.lanes.heldFor(task) ?? { kind: 'none', why: 'not read yet' },
      conversation: this.lanes.talkFor(task),
      places: this.placesOf(task),
      known: this.lanes.keys(keys),
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
      // **Raised here and nowhere else**, because whether this device may send a message is a fact
      // about *this* device and the collections are built once for everybody. `mine` arrives
      // `false` from `talkIn`, so a wiring change that forgot this line leaves every phone reading
      // the conversation and unable to send one — a capability that stopped working rather than one
      // that was handed out.
      talk: parts.talk === null ? null : { ...parts.talk, mine: this.mayAsk(reach.device) },
      // The person's other machines as this one has seen them: a phone looking at the VPS is told
      // the Mac is closed.
      machines: this.deps.machines?.rows() ?? [],
      // And this machine's own figures: its processors, memory and disk, and Tade's share of them.
      host: this.deps.machines?.host() ?? null,
      // Whether its agents outlive this window, for another machine's page once this one goes quiet.
      detach: this.wire.opts.client.driver.capabilities.detach,
      reach,
      lifetime: {
        // The **server's** epoch, so a snapshot's freshness and a delta's `id`
        // are one string. Two sources for one value would make every
        // reconnection look like a restart, and nothing would go red because
        // resnapshotting is correct. With no server — this machine's own
        // projection, told another machine while its page is off — one of
        // this window's own, which no page here ever reads.
        epoch: this.server?.epoch ?? this.offEpoch,
        rev: this.projectors.get(reach.device)?.rev ?? 0,
        openedAt: this.wire.openedAt,
      },
    }
  }

  /**
   * Whether one device may send a message: still paired, and not paired in
   * the clear (`Device.clear`), which reads and never acts.
   *
   * A **drawing hint** and not permission — `admitAsk` re-asks the setting
   * and the origin at the turn, and `webAsking` builds the arm from the device
   * record again. What it is for is the rule `TaskRow.can` already follows: a
   * control nothing could carry out is a control nobody can explain, so the
   * page leaves the composer out rather than drawing one that answers `403`.
   */
  private mayAsk(device: string): boolean {
    const held = this.paired(device)
    return held !== undefined && !held.clear
  }

  /** The conversation as the projection takes it, or null where talking is off. */
  private talkNow(): ReturnType<typeof talkFor> {
    // The keys a call is cleaned of: the same ones a screen is, worked out at
    // most once a beat and only where some line is a tool's.
    return talkFor(
      this.wire.state.transcript,
      this.deps.talk,
      this.talking(),
      () => this.lanes.keys(() => knownHere(this.wire, this.config())),
      { tade: this.wire.opts.home, home: homedir() },
    )
  }

  private talking(): boolean {
    return surfaceOf(this.config().surfaces.web).talking
  }

  /** How the orchestrator here stands, where this window holds the one conversation. */
  private standing(): (() => OrchestratorStanding) | undefined {
    const conversation = this.deps.conversation
    return conversation && (() => conversation.standing())
  }

  /** The conversation as it stands: the one fact a message assumes, and whose. */
  private conversation(): { busy: boolean; whose: string } {
    return { busy: this.deps.talk.busy(), whose: this.deps.talk.whose() }
  }

  /**
   * What the `ToolHost` asks at every call: the arm, re-checked against the
   * device list now, and this device's own projection.
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

/** The window's door for the listener, where the face has one to share: absent, both routes are a `404`. */
function windowFor(door: WindowDoor | undefined): { window?: WindowDoor } {
  return door === undefined ? {} : { window: door }
}
