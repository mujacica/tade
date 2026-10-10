import {
  type AttentionSettings,
  attentionFor,
  type Config,
  findSecret,
  IN_CONFIG,
} from '@tade/core'
import type { From, Reach } from '@tade/web'
import {
  appendPush,
  type Change,
  changesBetween,
  changesFor,
  type Device,
  endpointAllowed,
  type Forgetting,
  generateVapid,
  has,
  type Notice,
  NotThere,
  noticeable,
  noticeFor,
  type Outcome,
  type Push,
  type PushCall,
  type Pusher,
  type PushTo,
  pusher,
  reachOf,
  readPushes,
  type Signing,
  sendable,
  signingFrom,
  type TaskIn,
  type TaskNow,
  type TaskWas,
  type WebPushing,
  wasOf,
} from '@tade/web'

// The window's half of notifications: the signing key, the subscriptions, and
// the one thing on the beat that decides whether a phone buzzes.
//
// **Its own file because `web.ts` is the listener's lifetime** and this is a
// different subject — and because that file is at the size a file is allowed
// to be. What is here is everything only the process holding `tade.lock` can
// do: read the key out of the config, generate one, append to
// `web-pushes.jsonl`, and compare one beat's tasks against the last one's.
// Every decision is pure and is in `@tade/web` (`noticed.ts`, `endpoint.ts`,
// `pushes.ts`); every byte that leaves the machine goes through `Pusher`.
//
// ## Nothing happens while nothing is subscribed
//
// `beat` returns on its first line with notifications off, and on its second
// with nothing subscribed — so the ordinary case, which is every machine that
// never turned this on, costs one boolean and one array length every two
// seconds. The folds that build the projection are not reached and nor is the
// clock.
//
// ## Nothing is caught up, and that is the design
//
// The transitions are between **this beat and the last one**, held in memory,
// which means a window that has just opened sends nothing at all: there is no
// previous beat to differ from. `PUSH_IS_WHILE_OPEN` is the sentence and this
// is where it is true. A laptop that was shut overnight does not wake up and
// send six notifications about last night — what happened is on the page when
// the phone next asks, and the phone asking is free.
//
// ## What is bounded, and why each bound is where it is
//
// - **One notification per beat per device.** `noticeFor` coalesces, so four
//   things at once is one buzz.
// - **The keys already sent** are a `Set` per device, trimmed to `KEPT_KEYS`
//   oldest-first. Unbounded it would be a task id per transition for as long
//   as the window is open; trimmed, the worst it does is send one notification
//   twice after a thousand transitions, which is the safe direction.
// - **The hour's sends** are a list of moments per device, filtered on every
//   read, so the budget cannot be a leak either.
// - **Retries are not retried.** A `later` is dropped and its key is *not*
//   marked, so the next transition on that task notifies — which is a retry
//   paced by what happens rather than by a timer, and is the only kind of
//   retry a window with no scheduler can honestly offer. `TRIES` bounds how
//   many times one device's send may fail before it is left alone until it
//   subscribes again, so a push service that is down does not get a request
//   every beat for an hour.
// - **A `410` is acted on once**: the row is written `gone at the push
//   service` and the fold stops handing it over, so a dead endpoint is not
//   posted to on the next beat.

/** How many sent keys are remembered per device. */
const KEPT_KEYS = 200

/**
 * How many failures in a row one device gets before it is left alone.
 *
 * Small on purpose. Each failure is a POST to somebody else's service, and the
 * thing that clears the count is a send that worked — so a service having a
 * bad ten minutes costs three requests, not one every two seconds. Left alone
 * means *until the phone subscribes again*, which is what a page does when
 * somebody opens it.
 */
export const TRIES = 3

/** What the push half needs of the rest of the window. Accessors, every one. */
export interface Pushes {
  /**
   * Where Tade's home is.
   *
   * An accessor like everything else here, and not because it moves: nothing
   * in this object is read before something asks it to, which is what lets the
   * away subject build this half in its constructor and cost nothing.
   */
  home: () => string
  /** The window's own config, read **at the beat**: a setting turned off counts. */
  config: () => Config
  /** The limits, out of the same settings the earbud reads (`attentionFor`). */
  attention: () => AttentionSettings
  /** The tasks as the projection has them this beat. */
  tasks: () => readonly TaskNow[]
  /** The paired devices as they are **now**, so a phone signed out counts. */
  devices: () => readonly { id: string; revoked: string | null }[]
  /**
   * What this device was granted, or null for one that is no longer paired.
   *
   * One accessor and two questions, both out of the same grant: which
   * projects it may be told about (`sees`) and whether a notification may name
   * the work (`has(reach, 'titles')`). Two accessors would be two readings of
   * one record, and the day they disagree is the day a phone is told about a
   * project it cannot see.
   */
  reach: (device: string) => Reach | null
  /** When somebody last typed in the window, or null where nothing says. */
  lastInputAt: () => number | null
  /** Write one setting, through the one door that writes one. */
  writeKey: (key: string, value: string, was: string) => Promise<void>
  /** One line for the journal. Never throws, never blocks a beat. */
  tell: (told: {
    type: 'web_subscribed' | 'web_pushed' | 'warning'
    detail: Record<string, string | number | boolean>
  }) => void
  now: () => number
  /** The local hour, so the same inputs give the same answer. */
  localHour?: () => number
  /** What sends one. The real one unless a test hands over a scripted one. */
  pusher?: (signing: Signing) => Pusher
}

/** What one device's notifications have cost and come to so far. */
interface Standing {
  sentAt: number[]
  keys: string[]
  failures: number
}

/**
 * The window's notifications: the `WebPushing` half, and the beat.
 *
 * One object and not two, because the two halves share the one thing worth
 * holding: the subscriptions, read once and kept, so a beat does not read a
 * file and a subscribe does not make the next beat read one.
 */
export class WebPush {
  private readonly deps: Pushes
  private pushes: readonly Push[] = []
  private signing: Signing | null = null
  /** Whether a key has been looked for yet, so a missing one is asked once. */
  private looked = false
  /** Whether a key is being generated, so two beats do not generate two. */
  private generating: Promise<void> | null = null
  private was: Map<string, TaskWas> | null = null
  private readonly standing = new Map<string, Standing>()
  private sender: Pusher | null = null
  private sendingTo = new Set<string>()
  /**
   * Devices whose row is being written off, so two beats write one line.
   *
   * `forgetOne` appends and then re-reads, and a beat arriving inside that
   * would see the same orphan again. Two identical `forgot` lines are harmless
   * — the fold reads the later one and gets the same answer — but a file that
   * grows a line every two seconds for as long as a signed-out phone's row
   * sits there is not.
   */
  private readonly forgetting = new Set<string>()

  constructor(deps: Pushes) {
    this.deps = deps
  }

  /** Read what is subscribed. Called once, when the listener comes up. */
  async open(): Promise<void> {
    const read = await readPushes(this.deps.home())
    this.pushes = read.pushes
    if (read.skipped > 0) {
      this.deps.tell({
        type: 'warning',
        detail: {
          warning: `${read.skipped} line(s) of the notification list could not be read`,
        },
      })
    }
  }

  /**
   * The VAPID public key, or empty where there is none yet.
   *
   * **Read every time rather than kept, and the reason is the revocation
   * lever**: clearing the key in Settings mints a new one, so a page that
   * asked yesterday has to be able to be told about today's. The read is one
   * `findSecret` over an object the window already holds.
   */
  key(): string {
    // **The setting first**, so turning notifications off stops the page being
    // offered a key within a beat. The route table was built when the listener
    // came up and cannot be unbuilt, so without this a phone would go on being
    // shown a control whose only possible outcome is a refusal — and a control
    // nothing could carry out is a control nobody can explain.
    if (!this.on()) return ''
    const signing = this.signingNow()
    return signing === null ? '' : signing.publicKey
  }

  /** The half the listener is handed, where a person turned notifications on. */
  half(): WebPushing {
    return {
      // Read at the call, never cached: a person who turned notifications off
      // a second ago meant it.
      unlocked: () => this.on(),
      subscribe: (call, from) => this.subscribe(call, from),
      forget: (from) => this.forget(from),
    }
  }

  /**
   * One beat: what changed, whether it is worth a notification, and the sends.
   *
   * **Nothing at all while nothing is subscribed**, which is the ordinary
   * case: two reads and a return. Nothing here awaits — the sends are started
   * and the beat goes on, because the window draws on this thread and a push
   * service is somebody else's latency.
   */
  beat(): void {
    if (!this.on()) {
      // Turned off: the last beat's facts go too, so turning it back on starts
      // from *now* rather than notifying about an hour nobody was told about.
      this.was = null
      return
    }
    const live = sendable([...this.pushes], this.deps.devices())
    this.forgetOrphans(live.orphaned)
    if (live.pushes.length === 0) {
      this.was = null
      return
    }
    // A key is needed before anything can be sent, and generating one is a
    // config write: started once, awaited by nobody, and the beat that follows
    // it is the one that sends.
    if (this.signingNow() === null) {
      this.mint()
      return
    }
    const tasks = this.deps.tasks()
    const before = this.was
    this.was = new Map(tasks.map((task) => [task.id, wasOf(task)]))
    // The first beat has nothing to differ from. Silence, deliberately.
    if (before === null) return
    const changes = changesBetween(before, tasks)
    if (changes.length === 0) return
    for (const push of live.pushes) void this.tellOne(push, changes)
  }

  /**
   * Everything one device is told about, or nothing with a reason.
   *
   * The reason is kept out of the journal where it is one of the four ordinary
   * ones — at the keyboard, quiet hours, the budget, already sent — because a
   * line per beat per device for *nothing happened* is a journal of the clock.
   * What is written down is a send, and a failure.
   */
  private async tellOne(push: Push, changes: readonly Change[]): Promise<void> {
    const device = push.device
    // **One send at a time per device.** A beat that arrives while the last
    // one is still in flight would otherwise send the same notification twice
    // — the keys are not marked until the answer comes back.
    if (this.sendingTo.has(device)) return
    const standing = this.standingOf(device)
    if (standing.failures >= TRIES) return
    const reach = this.deps.reach(device)
    // A device whose grant could not be read is a device that is no longer
    // paired, and `sendable` will say so on the next beat. Nothing is sent to
    // one in the meantime.
    if (reach === null) return
    // **Narrowed to what this device reads, before the budget.** A count is
    // still a fact about work, so a phone granted one project of five must not
    // be told that something in the other four wants you — and doing it before
    // the budget means one device's silence does not spend another's.
    const mine = changesFor(changes, reach)
    if (mine.length === 0) return
    const now = this.deps.now()
    const decided = noticeFor(mine, {
      now,
      settings: this.deps.attention(),
      sentInLastHour: this.inLastHour(standing, now),
      lastInputAt: this.deps.lastInputAt(),
      localHour: this.deps.localHour?.() ?? new Date(now).getHours(),
      // **Both halves, and the narrower one is the device's.** The setting is
      // the ceiling and the grant is the floor: a phone that may not read what
      // work is called never gets a name in a notification, whatever the
      // setting says.
      details: this.deps.config().surfaces.web.push_details && has(reach, 'titles'),
      already: new Set(standing.keys),
    })
    if (!decided.send) return
    this.sendingTo.add(device)
    try {
      await this.send(push, decided.notice, decided.keys, standing)
    } finally {
      this.sendingTo.delete(device)
    }
  }

  /** One notification, and what its answer means for the subscription. */
  private async send(
    push: Push,
    notice: Notice,
    keys: readonly string[],
    standing: Standing,
  ): Promise<void> {
    const to: PushTo = { endpoint: push.endpoint, p256dh: push.p256dh, auth: push.auth }
    let answer: Awaited<ReturnType<Pusher['send']>>
    try {
      answer = await this.senderNow().send(to, notice)
    } catch (error) {
      // A sender that threw is a failure like any other and never a reason a
      // beat throws: the window draws on this thread.
      standing.failures++
      this.deps.tell({
        type: 'warning',
        detail: {
          warning: `a notification could not be sent: ${String(error).slice(0, 160)}`,
          device: push.device,
        },
      })
      return
    }
    if (answer.kind === 'sent') {
      standing.failures = 0
      standing.sentAt.push(this.deps.now())
      // **Marked only once it is sent.** Marking before would make a service
      // that was down the thing that silenced a transition for ever.
      standing.keys.push(...keys)
      if (standing.keys.length > KEPT_KEYS) {
        standing.keys = standing.keys.slice(standing.keys.length - KEPT_KEYS)
      }
      this.deps.tell({
        type: 'web_pushed',
        detail: {
          device: push.device,
          // What it was about, as Tade's own words and a count. Never the
          // body, never a task.
          about: keys.map((key) => key.split('\n')[1] ?? '').join(' '),
          changes: keys.length,
          status: answer.status,
        },
      })
      return
    }
    if (answer.kind === 'gone') {
      await this.forgetOne(push.device, 'gone at the push service')
      this.deps.tell({
        type: 'web_pushed',
        detail: { device: push.device, status: answer.status, why: answer.why },
      })
      return
    }
    standing.failures++
    this.deps.tell({
      type: answer.kind === 'refused' ? 'warning' : 'web_pushed',
      detail:
        answer.kind === 'refused'
          ? { warning: `a notification was refused: ${answer.why}`, device: push.device }
          : { device: push.device, status: answer.status, why: answer.why },
    })
  }

  /** What this device may be told now: a row written under its own id. */
  private async subscribe(call: PushCall, from: From): Promise<Outcome> {
    const device = deviceOf(from)
    if (!this.paired(device)) throw new NotThere('that device is no longer paired')
    const checked = endpointAllowed(call.endpoint)
    // Checked here as well as at the parse and at the send, because this is
    // the moment the row is written and the setting could have moved.
    if (!checked.ok) throw new NotThere(`that endpoint ${checked.why}`)
    await appendPush(this.deps.home(), {
      kind: 'subscribed',
      device,
      at: new Date(this.deps.now()).toISOString(),
      endpoint: call.endpoint,
      p256dh: call.p256dh,
      auth: call.auth,
    })
    await this.reread()
    // A fresh subscription clears whatever the last one's failures were: a
    // phone that asked again is a phone whose endpoint may well be new.
    this.standing.delete(device)
    return { did: true, rev: '', said: `will be told through ${checked.host}` }
  }

  /** This device's own subscription, forgotten. There is no other it could name. */
  private async forget(from: From): Promise<Outcome> {
    const device = deviceOf(from)
    const had = this.pushes.some((one) => one.device === device && one.forgotten === null)
    if (!had) return { did: false, rev: '', said: 'was not being told' }
    await this.forgetOne(device, 'taken back on the device')
    return { did: true, rev: '', said: 'will not be told' }
  }

  /** One row written `forgot`, and the kept list brought up to date. */
  private async forgetOne(device: string, why: Forgetting): Promise<void> {
    await appendPush(this.deps.home(), {
      kind: 'forgot',
      device,
      at: new Date(this.deps.now()).toISOString(),
      why,
    })
    this.standing.delete(device)
    await this.reread()
    this.deps.tell({ type: 'web_subscribed', detail: { device, tool: 'forget', state: why } })
  }

  /**
   * A subscription whose device is gone, written down rather than left.
   *
   * The one case where the two files disagree, and it is answered rather than
   * worked around at every read: signing a phone out already stops its
   * notifications (`sendable` refuses the row), and this is the row being told
   * so, so that the next reader does not have to work out what it means.
   */
  private forgetOrphans(devices: readonly string[]): void {
    for (const device of devices) {
      if (this.forgetting.has(device)) continue
      this.forgetting.add(device)
      void this.forgetOne(device, 'signed out')
        .catch(() => {
          // A row that could not be written is a row that stays and is refused
          // again next beat: tidy, and never a beat that threw.
        })
        .finally(() => this.forgetting.delete(device))
    }
  }

  /** The subscriptions again, after one was written. */
  private async reread(): Promise<void> {
    const read = await readPushes(this.deps.home())
    this.pushes = read.pushes
  }

  /** Whether notifications are on, out of the config the window holds now. */
  private on(): boolean {
    const web = this.deps.config().surfaces.web
    // The same three keys `surfaceOf` reads, and in the same order: a
    // notification is delivered to a service worker, and there is no worker
    // without the shell.
    return web.enabled && web.install && web.push
  }

  private paired(device: string): boolean {
    return this.deps.devices().some((one) => one.id === device && one.revoked === null)
  }

  /**
   * The key, out of the environment first and the config under it.
   *
   * `findSecret` and not a read of the field, which is the one rule every key
   * in Tade goes through: the environment always wins, and no surface may
   * disagree with another about which of the two is live. A key that is not a
   * valid scalar for P-256 is **not** a key — somebody pasted something — and
   * it is said once rather than throwing on every beat.
   */
  private signingNow(): Signing | null {
    const found = findSecret({
      settings: this.deps.config().surfaces.web as unknown as Record<string, unknown>,
      key: 'push_key',
      env: process.env,
      variables: ['TADE_PUSH_KEY'],
    })
    if (found === null) {
      this.signing = null
      return null
    }
    if (this.signing?.privateKey === found.value) return this.signing
    try {
      this.signing = signingFrom(found.value)
      // The sender holds the key, so a key that changed is a new sender: a
      // kept one would go on signing with the key somebody just rotated away.
      this.sender = null
    } catch {
      this.signing = null
      if (!this.looked) {
        this.looked = true
        this.deps.tell({
          type: 'warning',
          detail: {
            warning: `the notification signing key in ${found.from} is not a usable key — clear surfaces.web.push_key and a new one will be generated`,
          },
        })
      }
    }
    return this.signing
  }

  /**
   * Generate a key, once, and write it where every other key lives.
   *
   * Through `writeKey`, which is the one door a setting is written by: written,
   * read back, handed to everywhere a config is held, and recorded as
   * `config_changed` with a count of characters rather than the key itself.
   *
   * Started and not awaited, with a guard so two beats do not mint two keys —
   * which would be the worse failure, because the second would make every
   * subscription the first signed unusable.
   */
  private mint(): void {
    if (this.generating !== null) return
    // A key that is set and unreadable is not a key to replace behind
    // somebody's back: they pasted something, they have been told, and
    // clearing it is theirs.
    if (
      findSecret({
        settings: this.deps.config().surfaces.web as unknown as Record<string, unknown>,
        key: 'push_key',
        env: process.env,
        variables: ['TADE_PUSH_KEY'],
      }) !== null
    ) {
      return
    }
    this.generating = (async () => {
      try {
        const made = generateVapid()
        await this.deps.writeKey('surfaces.web.push_key', made.privateKey, '')
        this.deps.tell({
          type: 'warning',
          detail: {
            warning: `a notification signing key was generated and written to ${IN_CONFIG}; clearing it mints a new one and every device has to allow notifications again`,
          },
        })
      } catch (error) {
        this.deps.tell({
          type: 'warning',
          detail: {
            warning: `a notification signing key could not be written: ${String(error).slice(0, 160)}`,
          },
        })
      } finally {
        this.generating = null
      }
    })()
  }

  private senderNow(): Pusher {
    const signing = this.signingNow()
    if (signing === null) throw new Error('there is no notification signing key')
    this.sender ??= (this.deps.pusher ?? ((one) => pusher({ signing: one })))(signing)
    return this.sender
  }

  private standingOf(device: string): Standing {
    const held = this.standing.get(device)
    if (held !== undefined) return held
    const made: Standing = { sentAt: [], keys: [], failures: 0 }
    this.standing.set(device, made)
    return made
  }

  /** How many went out in the last hour, filtered as it is read. */
  private inLastHour(standing: Standing, now: number): number {
    standing.sentAt = standing.sentAt.filter((at) => now - at < 3_600_000)
    return standing.sentAt.length
  }
}

/**
 * The device one call came from.
 *
 * A turn at the keyboard has no device and cannot reach these — there is no
 * control at the machine that subscribes a phone — so `you` is an empty id,
 * which `paired` then refuses. Said rather than asserted, because a throw here
 * would be a request answered `500`.
 */
function deviceOf(from: From): string {
  return from.how === 'remote' ? from.device : ''
}

/** What `pushFor` needs of the window beyond what `Wiring` already answers. */
export interface Pushed {
  /**
   * The projected tasks this beat, out of the collections the window already
   * built.
   *
   * Projected rows rather than the five facts a transition is made of, so the
   * seam that narrows one (`noticeable`) is in `@tade/web` beside the decision
   * it feeds — and nothing in the window has to remember which five.
   */
  tasks: () => readonly TaskIn[]
  /** The paired devices as they are now, so a phone signed out counts. */
  devices: () => readonly Device[]
  /** One line for the journal, through the window's own writer. */
  tell: (told: Parameters<Pushes['tell']>[0]) => void
}

/**
 * The push half, with everything it reads of the window named once.
 *
 * Here rather than in `web.ts`'s constructor for the reason `web-beat.ts` and
 * `web-halves.ts` are their own files: that one is the listener's lifetime and
 * the pairing panel, and *which of the window's values a notification is made
 * of* is a different subject — which reads as a list of accessors here instead
 * of against a nine-hundred-line class.
 *
 * Three things are read straight off `Wiring`, because they are the window's
 * and not this subject's: where Tade's home is, the config as it stands
 * **now**, and when somebody last typed. The rest is `Pushed`.
 */
export function pushFor(
  wire: {
    opts: { home: string; config: Config }
    state: { lastInputAt: number | null }
    now: () => number
  },
  deps: { writeKey: Pushes['writeKey'] },
  away: Pushed,
): WebPush {
  const config = (): Config => wire.opts.config
  return new WebPush({
    home: () => wire.opts.home,
    config,
    // The **same** two personal keys the earbud reads, through the one
    // overlay: quiet hours and an hourly budget are facts about the person,
    // and a second reading of them with its own fallbacks is the drift
    // `attention.ts` is kept in one piece to prevent.
    attention: () => attentionFor('push', config().surfaces.voice.attention),
    tasks: () => away.tasks().map(noticeable),
    devices: away.devices,
    // **Read off the device list at the moment of the send**, so a grant
    // narrowed a second ago counts: what a notification may say and which
    // projects it may be about are both this one answer.
    reach: (device) => {
      const held = away.devices().find((one) => one.id === device && one.revoked === null)
      return held === undefined ? null : reachOf(held)
    },
    lastInputAt: () => wire.state.lastInputAt,
    writeKey: deps.writeKey,
    tell: away.tell,
    now: () => wire.now(),
  })
}
