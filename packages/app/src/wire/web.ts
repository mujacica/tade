import { networkInterfaces, uptime } from 'node:os'
import {
  type Config,
  DEVICES_SEEN_BY_AGENTS,
  LAN_IS_PLAINTEXT,
  overridesFrom,
  type PlanStanding,
  planStandings,
  producedIn,
  routesOf,
  titlesOf,
  type Workspace,
  writtenOrder,
} from '@tade/core'
import {
  appendDevice,
  blocksFor,
  type Confirmed,
  codeFor,
  type Device,
  type PairingAsk,
  type Projector,
  projector,
  type Reach,
  reachOf,
  readDevices,
  readsOf,
  revokeAll,
  type SnapshotInput,
  Streams,
  surfaceOf,
  Tickets,
  type Told,
  type WebReading,
  type WebServer,
  webServer,
} from '@tade/web'
import { awayCollections, nothingKnown, ranOn, type TaskExtra } from '../away.ts'
import type { Frame } from '../frame.ts'
import { AWAY_CONTROLS, awayPanel } from '../panels/away/state.ts'
import type { AwayDevice, AwayView } from '../panels/away/view.ts'
import type { PanelInputs } from '../panels.ts'
import type { Actions, Subject, Submits, Wiring } from './context.ts'

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
  private held: Omit<SnapshotInput, 'reach' | 'lifetime'> | null = null

  constructor(wire: Wiring, deps: AwayDeps) {
    this.wire = wire
    this.deps = deps
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
  private collections(): Omit<SnapshotInput, 'reach' | 'lifetime'> {
    const held = this.held
    if (held !== null) return held
    const live = this.wire.live
    const world = live?.world ?? null
    const made =
      live === null || world === null ? empty() : awayCollections(this.partsOf(live, world))
    this.held = made
    return made
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
      },
      world,
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
  private async revoke(id: string): Promise<void> {
    await appendDevice(this.wire.opts.home, {
      kind: 'revoked',
      device: id,
      at: new Date(this.wire.now()).toISOString(),
      why: 'revoked at the machine',
    })
    this.forget(id)
    await this.log({ type: 'web_revoked', detail: { device: id, why: 'revoked at the machine' } })
    await this.reread()
  }

  /**
   * Every device, disconnected. **It needs no network**: what a phone holds is
   * checked here on every request, so one that is off, lost or on another
   * continent is disconnected by this.
   */
  private async revokeEverything(): Promise<void> {
    const gone = await revokeAll(this.wire.opts.home, new Date(this.wire.now()))
    for (const id of gone) {
      this.forget(id)
      await this.log({
        type: 'web_revoked',
        detail: { device: id, why: 'everything disconnected' },
      })
    }
    this.tickets.clear()
    this.deps.news(
      gone.length === 0 ? 'no device was paired' : `${gone.length} device(s) disconnected`,
    )
    await this.reread()
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
    const server = this.server
    if (server === null) return
    const base = this.pairingUrl()
    if (base === null) return
    this.tickets.clear()
    this.tickets.mint(base, this.wire.now())
  }

  /**
   * Where a phone should go, as a URL with no ticket on it yet.
   *
   * On a `lan` bind it is a reachable address — `routesOf`'s rule, so never a
   * link-local and never loopback, because a code for one of those scans
   * perfectly and goes nowhere. On a loopback bind it is `localhost`, which is
   * also what `tailscale serve` connects to.
   */
  private pairingUrl(): string | null {
    const surface = surfaceOf(this.config().surfaces.web)
    // A trusted host first, when somebody named one: that is the `https`
    // origin a proxy terminates for, and it is the only one worth printing
    // when it exists, because it is the one that keeps working off this wifi.
    const trusted = surface.trustedHosts[0]
    if (trusted !== undefined) return `https://${trusted}/pair`
    if (surface.bind === 'loopback') return `http://localhost:${surface.port}/pair`
    const address = routesOf(networkInterfaces())[0]
    if (address === undefined) return null
    const host = address.includes(':') ? `[${address}]` : address
    return `http://${host}:${surface.port}/pair`
  }

  /** What the panel draws. Facts every frame, never remembered. */
  private view(): AwayView {
    const surface = surfaceOf(this.config().surfaces.web)
    const now = this.wire.now()
    const ticket = this.tickets.outstanding(now)[0] ?? null
    const code = ticket === null ? null : codeFor(ticket.url)
    return {
      // What is *listening*, never what the config says: a bind that failed is
      // a config that says yes and a machine that says no.
      listening: this.server !== null && this.server.bound.length > 0,
      bind: surface.bind,
      bound: this.server?.bound ?? [],
      reachable: surface.bind === 'lan' ? routesOf(networkInterfaces()) : ['localhost'],
      ticket:
        ticket === null
          ? null
          : {
              url: ticket.url,
              secondsLeft: Math.max(0, Math.ceil((ticket.at + 90_000 - now) / 1000)),
            },
      code: code === null ? [] : blocksFor(code),
      asking:
        this.asking === null
          ? null
          : {
              label: this.asking.ask.label,
              from: this.asking.ask.from,
              host: this.asking.ask.host,
              secondsLeft: Math.max(0, Math.ceil((this.asking.at + 60_000 - now) / 1000)),
            },
      devices: this.deviceViews(),
      streams: this.streams.count,
      lan: LAN_IS_PLAINTEXT,
      agents: `${DEVICES_SEEN_BY_AGENTS[0]?.toUpperCase() ?? ''}${DEVICES_SEEN_BY_AGENTS.slice(1)}, which is why this list shows every device there is.`,
      problem: this.problem,
    }
  }

  private deviceViews(): AwayDevice[] {
    const live = new Set(this.streams.listening())
    return this.devices
      .filter((one) => one.revoked === null)
      .map((one) => ({
        id: one.id,
        label: one.label,
        pairedAt: one.pairedAt,
        reads: readsOf(reachOf(one)),
        live: live.has(one.id),
      }))
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

  /** The collections, with this device's reach and the server's own lifetime. */
  private inputFor(reach: Reach): SnapshotInput {
    const parts = this.collections()
    return {
      ...parts,
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
      await this.wire.opts.client.log.append({ type: told.type, detail: told.detail })
    } catch (err) {
      this.deps.news(
        `the away view could not write ${told.type} down: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

/** What the window hands the away view on a beat. */
export type AwayBeat = Parameters<typeof awayCollections>[0]

/** When the machine came up, or null where nothing could say. */
function upSinceOf(): number | null {
  try {
    const seconds = uptime()
    return Number.isFinite(seconds) && seconds > 0 ? Date.now() - seconds * 1000 : null
  } catch {
    // `unknown`, and never nought: a page drawing "up for 0s" because nothing
    // answered is the one lie that would make the whole panel worthless.
    return null
  }
}

/** Nothing projected yet: an away view that has had no beat still answers. */
function empty(): Omit<SnapshotInput, 'reach' | 'lifetime'> {
  return {
    projects: [],
    tasks: [],
    queue: [],
    findings: [],
    notes: [],
    plans: [],
    warnings: [],
    machineUpSince: null,
  }
}

/**
 * The beat's own parts, built out of what `Live` holds.
 *
 * Here rather than in `app.ts` so the window's wiring stays wiring, and out of
 * held values only: `seenActions` is the last look and never a look,
 * `spendToday` is a kept fold, and `overridesFrom`/`orderFrom`/`ranOn` are
 * folds over the journal the window already has. **No `git`, no `ps`, no
 * `collectStatus`** — a page refresh starts no work at all.
 */
export function beatParts(live: Beatable, world: Workspace): AwayBeat {
  const spend = live.spendToday()
  const overrides = overridesFrom(live.events)
  const ran = ranOn(live.events)
  // Folds over the journal the window already holds, each pure: whether an
  // agent is waiting on a question, and whether a task's document is actually
  // there. `producedIn` says `missing` rather than `written`, which is the
  // right way round — a task that names a document and has none is the case
  // worth being able to see.
  const waiting = new Set(live.tasks.filter((one) => one.waiting === true).map((one) => one.task))
  const written = new Set(
    producedIn(live.events)
      .filter((one) => !one.missing)
      .map((one) => one.task),
  )
  const extras = new Map<string, TaskExtra>()
  const pending = new Map<string, number>()
  for (const approval of live.pending) {
    pending.set(approval.task, (pending.get(approval.task) ?? 0) + 1)
  }
  for (const project of world.projects) {
    for (const task of project.tasks) {
      const approval = live.pending.find((one) => one.task === task.id) ?? null
      extras.set(task.id, {
        ...nothingKnown(),
        work: live.seenActions(task.id),
        overridden: overrides.some((one) => one.task === task.id),
        spend: spend.byTask[task.id] ?? null,
        ran: ran.get(task.id) ?? nothingKnown().ran,
        question: waiting.has(task.id),
        approval:
          approval === null
            ? null
            : // The tool's **name** and nothing else. The harness's one-line
              // summary of the call is the command with its paths in it, and
              // answering an approval from away is a later slice's — which
              // gets to decide what a person is shown before they say yes.
              { id: approval.requestId, tool: approval.tool, sinceAt: approval.at },
        produced: written.has(task.id),
      })
    }
  }
  return {
    world,
    titles: live.titles,
    extras,
    pending,
    queued: live.queued,
    queueFacts: live.queueFacts(),
    order: writtenOrder(live.events),
    notes: live.notes(null),
    plans: live.plans,
    machineUpSince: live.machineUpSince,
  }
}

/**
 * What `Away` reads of `Live`: held values, every one of them.
 *
 * Named rather than taking `Live` itself, so the one place that decides what
 * leaves the machine can be read against a list of nine accessors instead of
 * against a thousand-line class — and so a tenth cannot arrive by accident.
 */
export interface Held {
  events: readonly import('@tade/core').TadeEvent[]
  pending: readonly { requestId: string; task: string; tool: string; at: number }[]
  world: Workspace | null
  seenActions(task: string): import('../frame.ts').ActionsView | null
  spendToday(): { byTask: Record<string, import('@tade/core').Spend> }
  queued: readonly import('@tade/core').Queued[]
  queueFacts(): import('@tade/core').QueueFacts
  notes(project: string | null): readonly import('../frame.ts').NoteShown[]
  tasks: readonly { task: string; waiting?: boolean }[]
}

/** What `beatParts` needs, so it can be tested without a window. */
export interface Beatable {
  events: readonly import('@tade/core').TadeEvent[]
  pending: readonly { requestId: string; task: string; tool: string; at: number }[]
  seenActions(task: string): import('../frame.ts').ActionsView | null
  spendToday(): { byTask: Record<string, import('@tade/core').Spend> }
  queued: readonly import('@tade/core').Queued[]
  queueFacts(): import('@tade/core').QueueFacts
  notes(project: string | null): readonly import('../frame.ts').NoteShown[]
  plans: readonly PlanStanding[]
  titles: Readonly<Record<string, string>>
  /** The task snapshots the window already drew, for `waiting`. */
  tasks: readonly { task: string; waiting?: boolean }[]
  machineUpSince: number | null
}
