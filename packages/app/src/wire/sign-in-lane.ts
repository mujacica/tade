import { homedir } from 'node:os'
import type { LaneId } from '@tade/core'
import { cleanScreen, inTime, type SignInKey, type SignInStanding, signInLink } from '@tade/web'
import { type Wiring, why } from './context.ts'

// A harness's own sign-in for a machine nobody is at, run in a lane of the
// window's and driven from the person's own phone: the orchestrator's
// (`web-sign-in.ts`, `/login` on the away view's line) and any account's
// (`accounts-here.ts`, Settings › Accounts on the phone, on any machine's tab).
//
// **The harness's own sign-in, asked for with `{ browser: false }`**: every
// harness then prints a link to open on any device and takes back what that
// page gives (Codex's device code needs nothing back). It runs in a lane of its
// own, the driver's like any other — never a tab, since its task is nobody's,
// and forgotten once it has ended (`forgettable`) — at a width a sign-in link
// fits on one row of.
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
// finished and the phone put away still does what its ending does.

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

/** One lane's sign-ins: where it runs and how it is written down. */
export interface LaneOf {
  /** Its task, under which its lane is `<task>/shell`: nobody's, with no task file. */
  task: string
  /** The lane's title. */
  title: string
  /** What the journal calls it (`web_did`'s `verb`). */
  verb: string
  /** Said where it is ended from the phone. */
  cancelled: string
  /** The keys a screen is scrubbed of (`knownHere`). */
  known: () => string[]
}

/** One sign-in to run: who it is, the harness's own words and command, and what its end says. */
export interface SignInWhat {
  /** What it is, as one running is told apart from another: a second start of it is the one running. */
  key: string
  who: string
  how: string
  launch: { command: string; args: string[]; env: Record<string, string> }
  /** Said where its harness could not even start in a lane. */
  couldNotStart: (why: string) => string
  /** Said where it ended before it finished. */
  failed: string
  /** What ending signed in does, and what is then said. */
  done: () => string
}

const LATE = Symbol('late')

export class SignInLane {
  readonly lane: LaneId
  private readonly wire: Wiring
  private readonly of: LaneOf
  private state: 'idle' | 'starting' | 'running' | 'ended' = 'idle'
  private what: SignInWhat | null = null
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

  constructor(wire: Wiring, of: LaneOf) {
    this.wire = wire
    this.of = of
    this.lane = `${of.task}/shell` as LaneId
  }

  /** What the one running or last run is (`SignInWhat.key`); null before one. */
  about(): string | null {
    return this.what?.key ?? null
  }

  look(): SignInStanding {
    this.until = this.wire.now() + LOOK_MS
    return this.standing()
  }

  /**
   * Start a sign-in, written down as this device's. The same one running
   * already is answered as it is; another one running is ended first, since
   * one lane holds one at a time. `what` throws where nothing can be signed
   * in, and `cannot` says that.
   */
  start(device: string, what: () => SignInWhat, cannot: (why: string) => string): SignInStanding {
    this.until = this.wire.now() + LOOK_MS
    let next: SignInWhat
    try {
      next = what()
    } catch (err) {
      // Said to whoever asked, and nothing else changes: one running goes on.
      const said = cannot(why(err))
      if (this.running())
        return { state: 'ended', who: null, how: null, rows: [], link: null, said }
      this.what = null
      this.who = null
      this.how = null
      this.rows = []
      this.link = null
      this.state = 'ended'
      this.said = said
      return this.standing()
    }
    if (this.running() && this.what?.key === next.key) return this.standing()
    this.what = next
    this.who = next.who
    this.how = next.how
    this.rows = []
    this.link = null
    this.said = null
    this.cancelled = false
    this.troubled = false
    this.by = device
    this.state = 'starting'
    void this.open(next, device)
    return this.standing()
  }

  type(text: string): SignInStanding {
    this.until = this.wire.now() + LOOK_MS
    if (this.state !== 'running') return this.standing()
    // The line, then enter on its own, as fingers would: a prompt that reads
    // a burst as a paste still takes the enter as the end of it.
    void this.write(text)
      .then(() => this.write(KEY_BYTES.enter))
      .catch((err: unknown) => this.lost(err))
    return this.standing()
  }

  key(key: SignInKey): SignInStanding {
    this.until = this.wire.now() + LOOK_MS
    if (this.state !== 'running') return this.standing()
    void this.write(KEY_BYTES[key]).catch((err: unknown) => this.lost(err))
    return this.standing()
  }

  cancel(device: string): SignInStanding {
    if (!this.running()) return this.standing()
    this.cancelled = true
    this.state = 'ended'
    this.said = this.of.cancelled
    void this.wire.opts.client
      .closeLane(this.lane)
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
    const lane = this.wire.opts.client.lane(this.lane)
    if (lane === null || !lane.alive) {
      this.ended(lane?.exitCode ?? null)
      return
    }
    if (now > this.until || this.reading) return
    this.reading = true
    void inTime<string | typeof LATE>(
      this.wire.opts.client.capture(this.lane, ROWS, false),
      READ_MS,
      LATE,
    )
      .then((text) => {
        if (text === LATE || this.state !== 'running') return
        this.rows = cleanScreen(text, this.of.known()).lines
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

  private running(): boolean {
    return this.state === 'starting' || this.state === 'running'
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

  private async open(what: SignInWhat, device: string): Promise<void> {
    const client = this.wire.opts.client
    try {
      // One sign-in at a time: an earlier one left running is ended first.
      if (client.lane(this.lane)?.alive) await client.closeLane(this.lane)
      await client.spawn({
        id: this.lane,
        task: this.of.task,
        kind: 'shell',
        cwd: homedir(),
        command: what.launch.command,
        args: what.launch.args,
        env: what.launch.env,
        cols: COLS,
        rows: ROWS,
        title: this.of.title,
      })
    } catch (err) {
      if (this.what !== what) return
      this.state = 'ended'
      this.said = what.couldNotStart(why(err))
      return
    }
    // Cancelled, or another started, while it was starting: what started is ended too.
    if (this.cancelled || this.what !== what) {
      if (this.what === what) {
        await client
          .closeLane(this.lane)
          .catch((err: unknown) =>
            this.wire.note(new Error(`Ending a sign-in cancelled from away: ${why(err)}`)),
          )
      }
      return
    }
    this.state = 'running'
    this.record(device, 'started')
  }

  private write(bytes: string): Promise<void> {
    return this.wire.opts.client.write(this.lane, bytes)
  }

  /** A write that could not reach it: it is gone, which the next beat says. */
  private lost(err: unknown): void {
    this.wire.note(new Error(`Typing into a sign-in from away: ${why(err)}`))
  }

  private ended(code: number | null): void {
    this.state = 'ended'
    if (this.cancelled || this.what === null) return
    if (code !== 0) {
      this.said = this.what.failed
      this.record(this.by, 'failed')
      return
    }
    this.record(this.by, 'done')
    this.said = this.what.done()
  }

  /** Written down as the device's: that it did, never what it typed. */
  private record(device: string, state: string): void {
    void this.wire.opts.client.log
      .append({ type: 'web_did', detail: { device, verb: this.of.verb, state } })
      .catch((err: unknown) => this.wire.note(new Error(`A sign-in from away: ${why(err)}`)))
  }
}
