import { homedir } from 'node:os'
import { HARNESS_CHOICES, type LaneId, orchestratorAccount, ownSignInName } from '@tade/core'
import {
  cleanScreen,
  inTime,
  type SignInKey,
  type SignInStanding,
  signInLink,
  type WebSigningIn,
} from '@tade/web'
import { notify, type Wiring, why } from './context.ts'

// The orchestrator's own sign-in, driven from the person's own phone
// (`@tade/web`'s `signing-in.ts`): `/login` typed on the away view's line,
// carried out rather than pointed back at the machine.
//
// **The harness's own sign-in, for a machine nobody is at.** What `/login` at
// the machine runs in a terminal over the window (`Machine.logIn`), asked for
// with `{ browser: false }`: every harness then prints a link to open on any
// device and takes back what that page gives (Codex's device code needs
// nothing back). It runs in a lane of its own (`LANE`), the driver's like any
// other — never a tab, since its task is nobody's, and forgotten once it has
// ended (`forgettable`) — at a width a sign-in link fits on one row of.
//
// **The phone's hands on it are a line and a few keys**, written to the lane
// as somebody at it would type them: the code, then enter; the arrows, enter,
// escape and tab for a sign-in that asks which provider. Nothing typed is
// written down; the journal says only that a device started one and how it
// ended (`web_did`).
//
// **Its screen is read on the window's beat, and only while somebody looks**
// (`LOOK_MS` after the phone last asked), one read in flight with a deadline,
// and cleaned as an agent's is before it is held (`cleanScreen`). Whether it
// ended is asked every beat while it runs, looked at or not, so a sign-in
// finished and the phone put away still starts the orchestrator again on it.

/**
 * The lane it runs in: one at a time, beside the orchestrator's own task
 * (`ORCHESTRATOR_TASK`, `tade/orchestrator`), under one with no task file.
 */
const TASK = 'tade/orchestrator-sign-in'
export const LANE = `${TASK}/shell` as LaneId

/** Wide enough that a sign-in link is one row; the screen sent is cut to the budget anyway. */
export const COLS = 512
const ROWS = 40

/** How long one look keeps its screen being read, without another. */
export const LOOK_MS = 6_000

/** How long one read may take before the last one known is kept instead. */
const READ_MS = 1_500

/** What each key the phone may press is, as a terminal sends it. */
const KEY_BYTES: Readonly<Record<SignInKey, string>> = {
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  escape: '\x1b',
  tab: '\t',
}

/** Said where it is ended from the phone. */
export const CANCELLED = 'Cancelled: the orchestrator is as it was.'

/** What the window gives it. */
export interface SigningDeps {
  /** Start the orchestrator again on its sign-in now, once any turn is over; absent, there is none. */
  restart?: () => void
  /** The keys a screen is scrubbed of (`knownHere`). */
  known: () => string[]
}

const LATE = Symbol('late')

export class OrchestratorSignIn implements WebSigningIn {
  private readonly wire: Wiring
  private readonly deps: SigningDeps
  private state: 'idle' | 'starting' | 'running' | 'ended' = 'idle'
  private who: string | null = null
  private how: string | null = null
  private rows: string[] = []
  private link: string | null = null
  private said: string | null = null
  private by = ''
  /** Until when somebody's look keeps its screen being read. */
  private until = 0
  private reading = false
  /** Ended from the phone: its end is not a sign-in that failed. */
  private cancelled = false
  /** A read of its screen failed this sign-in, and was said. */
  private troubled = false

  constructor(wire: Wiring, deps: SigningDeps) {
    this.wire = wire
    this.deps = deps
  }

  look(_device: string): SignInStanding {
    this.until = this.wire.now() + LOOK_MS
    return this.standing()
  }

  start(device: string): SignInStanding {
    this.until = this.wire.now() + LOOK_MS
    if (this.state === 'starting' || this.state === 'running') return this.standing()
    const config = this.wire.opts.config
    const harness = config.orchestrator.harness
    const account = orchestratorAccount(config)
    const title = HARNESS_CHOICES.find((one) => one.id === harness)?.title ?? harness
    this.who = account ?? ownSignInName(config, harness) ?? `${title}'s own sign-in`
    this.rows = []
    this.link = null
    this.said = null
    this.cancelled = false
    this.troubled = false
    this.by = device
    try {
      const signing = this.wire.opts.client.signInFor(harness, account, { browser: false })
      this.how = signing.how
      this.state = 'starting'
      void this.open(signing.launch, device)
    } catch (err) {
      this.how = null
      this.state = 'ended'
      this.said = `The orchestrator cannot be signed in here: ${why(err)}`
    }
    return this.standing()
  }

  type(_device: string, text: string): SignInStanding {
    this.until = this.wire.now() + LOOK_MS
    if (this.state !== 'running') return this.standing()
    // The line, then enter on its own, as fingers would: a prompt that reads
    // a burst as a paste still takes the enter as the end of it.
    void this.write(text)
      .then(() => this.write(KEY_BYTES.enter))
      .catch((err: unknown) => this.lost(err))
    return this.standing()
  }

  key(_device: string, key: SignInKey): SignInStanding {
    this.until = this.wire.now() + LOOK_MS
    if (this.state !== 'running') return this.standing()
    void this.write(KEY_BYTES[key]).catch((err: unknown) => this.lost(err))
    return this.standing()
  }

  cancel(device: string): SignInStanding {
    if (this.state !== 'starting' && this.state !== 'running') return this.standing()
    this.cancelled = true
    this.state = 'ended'
    this.said = CANCELLED
    void this.wire.opts.client
      .closeLane(LANE)
      .catch((err: unknown) => this.wire.note(new Error(`Ending a sign-in from away: ${why(err)}`)))
    this.record(device, 'cancelled')
    return this.standing()
  }

  /**
   * One beat: whether it ended, and — while somebody looks — its screen read.
   * Nothing is awaited: the window draws on this thread.
   */
  beat(now: number): void {
    if (this.state !== 'running') return
    const lane = this.wire.opts.client.lane(LANE)
    if (lane === null || !lane.alive) {
      this.ended(lane?.exitCode ?? null)
      return
    }
    if (now > this.until || this.reading) return
    this.reading = true
    void inTime<string | typeof LATE>(
      this.wire.opts.client.capture(LANE, ROWS, false),
      READ_MS,
      LATE,
    )
      .then((text) => {
        if (text === LATE || this.state !== 'running') return
        this.rows = cleanScreen(text, this.deps.known()).lines
        this.link = signInLink(text, COLS) ?? this.link
      })
      // Late or failed is not gone: the last screen read stays, and a read
      // that failed is said once a sign-in, never once a beat.
      .catch((err: unknown) => {
        if (this.troubled) return
        this.troubled = true
        this.wire.note(new Error(`Reading a sign-in from away: ${why(err)}`))
      })
      .finally(() => {
        this.reading = false
      })
  }

  private standing(): SignInStanding {
    return {
      state: this.state === 'starting' ? 'running' : this.state,
      who: this.who,
      how: this.how,
      rows: this.rows,
      link: this.link,
      said: this.said,
    }
  }

  private async open(
    launch: { command: string; args: string[]; env: Record<string, string> },
    device: string,
  ): Promise<void> {
    const client = this.wire.opts.client
    try {
      // One sign-in at a time: an earlier one left running is ended first.
      if (client.lane(LANE)?.alive) await client.closeLane(LANE)
      await client.spawn({
        id: LANE,
        task: TASK,
        kind: 'shell',
        cwd: homedir(),
        command: launch.command,
        args: launch.args,
        env: launch.env,
        cols: COLS,
        rows: ROWS,
        title: 'orchestrator sign-in',
      })
    } catch (err) {
      this.state = 'ended'
      this.said = `The orchestrator's sign-in could not start here: ${why(err)}`
      return
    }
    // Cancelled while it was starting: what started is ended too.
    if (this.cancelled) {
      await client
        .closeLane(LANE)
        .catch((err: unknown) =>
          this.wire.note(new Error(`Ending a sign-in cancelled from away: ${why(err)}`)),
        )
      return
    }
    this.state = 'running'
    this.record(device, 'started')
  }

  private write(bytes: string): Promise<void> {
    return this.wire.opts.client.write(LANE, bytes)
  }

  /** A write that could not reach it: it is gone, which the next beat says. */
  private lost(err: unknown): void {
    this.wire.note(new Error(`Typing into a sign-in from away: ${why(err)}`))
  }

  private ended(code: number | null): void {
    this.state = 'ended'
    if (this.cancelled) return
    if (code !== 0) {
      this.said = `${this.who}'s sign-in ended before it finished: the orchestrator is as it was.`
      this.record(this.by, 'failed')
      return
    }
    this.record(this.by, 'done')
    if (this.deps.restart === undefined || this.wire.opts.restartThinker === undefined) {
      this.said = `Signed in as ${this.who}: the orchestrator runs on it the next time Tade starts.`
      return
    }
    this.said = `Signed in as ${this.who}: the orchestrator starts again on it once any turn it is in is over.`
    notify(this.wire, `the orchestrator was signed in from away as ${this.who}`)
    this.deps.restart()
  }

  /** Written down as the device's: that it did, never what it typed. */
  private record(device: string, state: string): void {
    void this.wire.opts.client.log
      .append({ type: 'web_did', detail: { device, verb: 'orchestrator sign-in', state } })
      .catch((err: unknown) => this.wire.note(new Error(`A sign-in from away: ${why(err)}`)))
  }
}
