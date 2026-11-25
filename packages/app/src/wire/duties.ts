import { stat } from 'node:fs/promises'
import {
  BATCH_RANK,
  BATCH_WAIT_MS,
  type DutiesAnswer,
  DutiesReply,
  DutyBoard,
  type DutyClaim,
  dutyOf,
  FOUND_SENT,
  grantedUntil,
  HANDING_MS,
  type HubSeen,
  hubOf,
  LEASE_MS,
  type MachineNamed,
  type MachineSeen,
  machineLabel,
  mergeDuty,
  projectDir,
  type Rank,
  RENEW_MS,
  standsIn,
  WATCHES_HERE,
  type Watched,
  type WatchWhere,
  watchesSaid,
} from '@tade/core'
import { repositoryAt } from '@tade/status'
import type { WebDuties } from '@tade/web'
import { type Wiring, why } from './context.ts'
import type { ConversationReach } from './conversation.ts'
import { seenName } from './machines-seen.ts'
import { inputDigest } from './watch-seen.ts'

// Whose each duty is, from the window and the heart (`@tade/core`'s
// `duties.ts` has the rule and its argument): one repository's watches, a
// batch of the full checks at one commit and the merge of one parting each
// done by exactly one of the person's machines.
//
// **The far half is the heart's**, so a `tade serve` hub with no screen keeps
// the board and answers it (`/api/duties`, `@tade/web`'s `duties.ts`). **The
// near half is the window's**, because only a window dials: the hub its config
// names (`hubOf`), over the link it already holds. A machine that links to
// nobody keeps the board itself and is its only claimant until somebody links
// to it. One with several remotes and no hub named has nobody to ask, and the
// older rule (`watchWhere`) answers for its watches, as before.
//
// **On the beat** it claims everything it wants every `RENEW_MS`, every
// `HANDING_MS` while one of its duties is being handed over or not yet
// answered — and at once after a look found something, so what it found is at
// the hub before anything could take the duty over. A grant holds here until
// `grantedUntil`, counted from the ask; past it, with the hub not answering,
// what it does is `standsIn`'s answer. Nothing that draws waits on any of it.

/** The hub's door for it (`@tade/web`'s `duties.ts`). */
const DOOR = '/api/duties'

/** How often which repository each project is, and when it was opened here, is read again. */
const NAMED_EVERY_MS = 5 * 60_000

/** What a machine that had a duty before had found, and where it got to: for the look that takes over. */
export interface Hand {
  from: string
  found: string[]
  since: string | null
  input: string
  agoMs: number
}

/** Whose one duty is, as this machine has it to act on. */
export interface DutyVerdict {
  duty: string
  mine: boolean
  /** Whose it is where not this machine's: a machine's name, as this machine says it. */
  on: string | null
  said: string
  /** Given with a grant not yet begun. */
  hand?: Hand
  /** The hub has not answered for it yet. */
  pending?: true
}

interface Held {
  claim: DutyClaim
  wantedAt: number
  heard: boolean
  yours: boolean
  until: number
  holder: MachineNamed | null
  ranked: MachineNamed[]
  yielding: boolean
  hand: Hand | null
  done: string | null
  /** Doing it without the hub's word. */
  standing: boolean
}

export interface FleetDutiesDeps {
  /** Every machine as this one has seen it (`machines-seen.ts`). */
  seen(): readonly MachineSeen[]
  /** Said in the strip, once for each new thing. */
  say(text: string): void
}

export class FleetDuties {
  private readonly wire: Wiring
  private readonly deps: FleetDutiesDeps
  private board: DutyBoard | null = null
  private reach: ConversationReach | null = null
  private readonly held = new Map<string, Held>()
  private readonly letting = new Set<string>()
  /** Which repository each project is and when it was opened here, by project; undefined until read. */
  private readonly named = new Map<string, { repository: string | null; opened: number | null }>()
  private namedAt = Number.NEGATIVE_INFINITY
  private naming: Promise<void> | null = null
  /** What is woken when a duty becomes this machine's, and whether something is mid-way through it. */
  private readonly wakes = new Map<string, () => void>()
  private readonly busy = new Map<string, () => boolean>()
  private readonly afterNames = new Set<() => void>()
  /** Claimants of the board here, by the name they call themselves, for a goodbye heard. */
  private readonly claimants = new Map<string, string>()
  private readonly goodbyes = new Map<string, number>()
  private asking = false
  private askedAt = Number.NEGATIVE_INFINITY
  private answeredAt = Number.NEGATIVE_INFINITY
  private soon = false
  /** A hub too old to know the door, so the older rule answers. */
  private tooOld: string | null = null
  private lastSaid = ''
  /** When this window saw the hub's link go, while it has not come back. */
  private downAt: number | null = null
  /** The hub, as it last answered for itself. */
  private hubIs: MachineNamed | null = null

  constructor(wire: Wiring, deps: FleetDutiesDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** Which repository each project is, read now: before the first watch is due. Never throws. */
  begin(): Promise<void> {
    // The board's grace counts from the moment this machine started, not from its first claim.
    this.boardHere()
    return this.readNames()
  }

  /** How the window reaches the hub. Never set under `tade serve`, which dials nobody. */
  withReach(reach: ConversationReach): void {
    this.reach = reach
  }

  private me(): MachineNamed {
    return { id: this.wire.opts.client.machine.id, name: machineLabel() }
  }

  /** Whether another machine of the person's has ever linked here, or claims a duty here now. */
  private peers(): boolean {
    return this.claimants.size > 0 || this.deps.seen().some((one) => one.way === 'from')
  }

  /** Every machine that links here and did not say goodbye has claimed since this window began. */
  private heardAll(): boolean {
    const there = new Map<string, MachineSeen>()
    for (const one of this.deps.seen()) if (one.way === 'from') there.set(one.machine, one)
    return [...there.values()].every(
      (one) => one.state === 'closed' || this.claimants.has(seenName(one.machine)),
    )
  }

  /** The board this machine keeps as the hub, made on first use. */
  private boardHere(): DutyBoard {
    this.board ??= new DutyBoard(this.me(), this.wire.now(), () => this.heardAll())
    return this.board
  }

  /** The hub's name here, where another machine is the hub. */
  private hubName(): string | null {
    return hubOf(this.wire.opts.config).hub?.name ?? null
  }

  /**
   * How this machine decides: by asking the hub, by keeping the board itself,
   * or not at all (several remotes and no hub named, or a hub too old to say).
   */
  private mode(): 'asks' | 'keeps' | null {
    const config = this.wire.opts.config
    if (this.hubName() !== null) return this.reach !== null && this.tooOld === null ? 'asks' : null
    if (config.machine.hub !== WATCHES_HERE && Object.keys(config.remotes).length > 0) return null
    // A machine nothing else has ever linked to has nobody to share a duty with.
    return this.peers() ? 'keeps' : null
  }

  /** The door: one machine's claims, answered by the board this machine keeps. */
  door(): WebDuties {
    return async (ask) => {
      this.claimants.set(seenName(ask.from.name), ask.from.id)
      const answers = this.boardHere().ask(ask.from, ask.claims, ask.letGo, this.wire.now())
      // A claimant's ask can hand a duty to or from this machine: looked at now.
      this.soon = true
      return { hub: this.me(), answers } satisfies DutiesAnswer
    }
  }

  /** Every duty this machine claims, and whose each is as it last heard. */
  standing(): { duty: string; mine: boolean; holder: string | null }[] {
    const now = this.wire.now()
    const mode = this.mode()
    return [...this.held.entries()].map(([duty, held]) => ({
      duty,
      mine: this.verdict(duty, held, mode, now).mine,
      holder: held.holder ? this.nameOf(held.holder) : null,
    }))
  }

  // ── What each kind of duty asks ────────────────────────────────────────────

  /**
   * Whose a watch on a project's repository is — null where the older rule
   * answers (nothing to ask, or no repository named). `on` false is a watch
   * that is off here: whose it is is said, and nothing is claimed.
   */
  watch(
    one: { id: string; project: string; watch: string; input: Readonly<Record<string, unknown>> },
    watched: Watched,
    on: boolean,
    hooks: { wake: () => void; looking: () => boolean },
  ): (WatchWhere & { duty: string; hand?: Hand }) | null {
    const named = this.repositoryOf(one.project)
    if (named === null) return null
    if (named === undefined) {
      // A machine that asks the hub has the older rule's evidence meanwhile; the
      // hub itself waits the moment git takes, and looks again once it is read.
      if (this.mode() === 'asks') return null
      this.afterNames.add(hooks.wake)
      return {
        duty: '',
        here: false,
        on: machineLabel(),
        said: `which repository ${one.project} is is being read, and its watches look once it is`,
      }
    }
    const duty = dutyOf('watch', named, one.watch)
    if (!on) {
      const held = this.held.get(duty)
      return held?.holder && !held.yours
        ? { duty, here: false, on: this.nameOf(held.holder), said: this.notMine(held) }
        : { duty, here: true }
    }
    this.wakes.set(duty, hooks.wake)
    this.busy.set(duty, hooks.looking)
    const found = [...new Set(watched.findings.map((finding) => finding.key))].slice(0, FOUND_SENT)
    const verdict = this.want(duty, one.project, {
      since: watched.since,
      input: inputDigest(one.input),
      found,
    })
    // Until the hub has answered, the older rule's evidence answers: a machine
    // whose projection says it looks with it keeps this one off.
    if (verdict.pending) return null
    if (verdict.mine) return { duty, here: true, ...(verdict.hand ? { hand: verdict.hand } : {}) }
    return { duty, here: false, on: verdict.on ?? machineLabel(), said: verdict.said }
  }

  /** Whose the batch at one commit is; null where nothing is asked. */
  batch(project: string, head: string): DutyVerdict | null {
    const named = this.repositoryOf(project)
    if (!named) return null
    // Ranked alike on every machine, so the hub runs it wherever it has the commit.
    return this.want(dutyOf('batch', named, head), project, {}, BATCH_RANK)
  }

  /** Whose proposing the merge of one parting is; null where nothing is asked. */
  merge(project: string, branch: string, head: string, target: string): DutyVerdict | null {
    const named = this.repositoryOf(project)
    if (!named) return null
    return this.want(mergeDuty(named, branch, head, target), project, {})
  }

  /** It has begun: what the hub handed over is written, and it is doing it. */
  began(duty: string): void {
    const held = this.held.get(duty)
    if (!held) return
    held.claim = { ...held.claim, doing: true }
    held.hand = null
    this.soon = true
  }

  /** A look ended: what it found goes to the hub now, and a hand-over waiting for it goes ahead. */
  ended(duty: string, found: readonly string[]): void {
    const held = this.held.get(duty)
    if (!held) return
    const keys = [...new Set([...found, ...(held.claim.found ?? [])])].slice(0, FOUND_SENT)
    held.claim = { ...held.claim, found: keys }
    this.soon = true
  }

  /** Not wanted any more, and not done: given up now, for whoever is next. */
  letGo(duty: string): void {
    if (!this.held.delete(duty)) return
    this.letting.add(duty)
    this.soon = true
    if (this.mode() === 'keeps') this.askHere(this.wire.now())
  }

  /** Done for good: told to the hub, and nobody asks again for it. */
  done(duty: string): void {
    const held = this.held.get(duty)
    if (!held) return
    held.claim = { ...held.claim, done: true, doing: false }
    this.soon = true
    if (this.mode() === 'keeps') this.askHere(this.wire.now())
  }

  // ── The beat ───────────────────────────────────────────────────────────────

  /** On the window's beat: claims renewed, goodbyes heard, hand-overs let go of. Never throws. */
  beat(): void {
    const now = this.wire.now()
    if (now - this.namedAt >= NAMED_EVERY_MS) {
      // A hub found too old is asked again: it may have been updated since.
      this.tooOld = null
      void this.readNames()
    }
    for (const [duty, held] of this.held) {
      if (now - held.wantedAt < LEASE_MS) continue
      this.held.delete(duty)
      this.letting.add(duty)
    }
    this.hearGoodbyes()
    const mode = this.mode()
    if (mode === 'keeps') {
      this.askHere(now)
      return
    }
    if (mode !== 'asks' || this.asking) return
    const handing = [...this.held.values()].some(
      (one) => !one.heard || one.yielding || (!one.yours && one.ranked[0]?.id === this.me().id),
    )
    if (!this.soon && now - this.askedAt < (handing ? HANDING_MS : RENEW_MS)) return
    this.asking = true
    this.soon = false
    this.askedAt = now
    void this.exchange(now)
      .catch((err: unknown) => this.sayOnce(`whose each duty is could not be asked: ${why(err)}`))
      .finally(() => {
        this.asking = false
      })
  }

  /** The board here asked for everything this machine claims, as any other machine's ask is. */
  private askHere(now: number): void {
    const claims = [...this.held.values()].map((one) => one.claim)
    const letGo = [...this.letting, ...this.yieldable()]
    this.letting.clear()
    const answers = this.boardHere().ask(this.me(), claims, letGo, now)
    for (const claim of claims) if (claim.done) this.held.delete(claim.duty)
    this.take(answers, Number.POSITIVE_INFINITY)
  }

  private async exchange(askedAt: number): Promise<void> {
    const name = this.hubName()
    const reach = name === null ? null : this.reach?.(name)
    if (name === null || !reach?.live) return
    const claims = [...this.held.values()].map((one) => one.claim)
    const letGo = [...this.letting, ...this.yieldable()]
    const answer = await reach.link.request(name, DOOR, { from: this.me(), claims, letGo })
    if (answer.status === 404) {
      this.tooOld = `${name}'s Tade does not answer whose each duty is: update it there`
      this.sayOnce(`${this.tooOld}; until then each watch is placed by the older rule`)
      return
    }
    if (answer.status !== 200) throw new Error(`${name} answered ${answer.status}`)
    const read = DutiesReply.safeParse(answer.body)
    if (!read.success) throw new Error(`what ${name} answered is not an answer about duties`)
    for (const duty of letGo) this.letting.delete(duty)
    for (const claim of claims) if (claim.done) this.held.delete(claim.duty)
    this.answeredAt = this.wire.now()
    this.hubIs = read.data.hub
    this.lastSaid = ''
    this.take(read.data.answers, grantedUntil(askedAt))
  }

  /** The duties held here that a better-ranked machine wants and nothing is mid-way through. */
  private yieldable(): string[] {
    const out: string[] = []
    for (const [duty, held] of this.held) {
      if (!held.yours || !held.yielding) continue
      // Only a watch is handed back between looks; a batch or a merge, once
      // granted, is done to the end where it began, never begun twice.
      const busy = this.busy.get(duty)
      if (busy === undefined || busy()) continue
      held.yours = false
      held.yielding = false
      held.claim = { ...held.claim, doing: false }
      out.push(duty)
    }
    return out
  }

  private take(answers: DutiesAnswer['answers'], until: number): void {
    for (const answer of answers) {
      const held = this.held.get(answer.duty)
      if (!held) continue
      const was = held.yours
      held.heard = true
      held.yours = answer.yours
      held.holder = answer.holder
      held.ranked = answer.ranked
      held.yielding = answer.yield === true
      held.until = answer.yours ? until : 0
      held.done = answer.done?.name ?? null
      held.standing = false
      if (answer.handed && !held.claim.doing) held.hand = answer.handed
      if (!answer.yours) {
        held.hand = null
        held.claim = { ...held.claim, doing: false }
      }
      if (!was && answer.yours) this.wakes.get(answer.duty)?.()
    }
  }

  /** A machine that links here said goodbye: what it held is given up now. */
  private hearGoodbyes(): void {
    if (this.board === null) return
    for (const one of this.deps.seen()) {
      if (one.way !== 'from' || one.state !== 'closed') continue
      if (this.goodbyes.get(one.machine) === one.at) continue
      this.goodbyes.set(one.machine, one.at)
      const id = this.claimants.get(seenName(one.machine))
      if (id !== undefined) this.board.gone(id)
    }
  }

  // ── Deciding ───────────────────────────────────────────────────────────────

  private want(
    duty: string,
    project: string,
    parts: Pick<DutyClaim, 'since' | 'input' | 'found'>,
    rank: Rank = this.rankOf(project),
  ): DutyVerdict {
    const now = this.wire.now()
    const had = this.held.get(duty)
    const claim: DutyClaim = {
      ...had?.claim,
      ...parts,
      duty,
      rank,
      doing: had?.claim.doing ?? false,
    }
    const held: Held = had ?? {
      claim,
      wantedAt: now,
      heard: false,
      yours: false,
      until: 0,
      holder: null,
      ranked: [],
      yielding: false,
      hand: null,
      done: null,
      standing: false,
    }
    held.claim = claim
    held.wantedAt = now
    this.held.set(duty, held)
    this.letting.delete(duty)
    if (!had) this.soon = true
    const mode = this.mode()
    if (mode === 'keeps') this.askHere(now)
    return this.verdict(duty, held, mode, now)
  }

  private verdict(
    duty: string,
    held: Held,
    mode: 'asks' | 'keeps' | null,
    now: number,
  ): DutyVerdict {
    if (held.done !== null) {
      return { duty, mine: false, on: held.done, said: `it was done already, on ${held.done}` }
    }
    const answered = mode === 'keeps' || now - this.answeredAt < LEASE_MS - RENEW_MS
    if (held.heard && answered && (!held.yours || now < held.until)) {
      if (held.yours) return { duty, mine: true, on: null, said: '', ...this.handOf(held) }
      const on = held.holder ? this.nameOf(held.holder) : (this.hubName() ?? machineLabel())
      return { duty, mine: false, on, said: this.notMine(held) }
    }
    // A grant that ran out unrenewed is given up here first: the hub hands it on only after.
    if (held.yours) {
      held.yours = false
      held.claim = { ...held.claim, doing: false }
    }
    const hub = this.hubSeen(now)
    // Never answered yet — the link still coming up, or the hub away since
    // before this window opened — the older rule's evidence answers, unless
    // the hub said goodbye.
    if (!held.heard && hub.state !== 'closed') {
      return {
        duty,
        mine: false,
        on: hub.name,
        said: `${hub.name} is being asked whose it is`,
        pending: true,
      }
    }
    const stood = standsIn({
      me: this.me().id,
      hub,
      ranked: held.ranked,
      down: new Set(),
      now,
    })
    if (stood.stands && !held.standing) held.claim = { ...held.claim, doing: true }
    held.standing = stood.stands
    if (stood.stands) return { duty, mine: true, on: null, said: stood.why }
    const first = held.ranked.find((one) => one.id !== this.me().id)
    return { duty, mine: false, on: first ? this.nameOf(first) : hub.name, said: stood.why }
  }

  private handOf(held: Held): { hand?: Hand } {
    return held.hand !== null && !held.claim.doing ? { hand: held.hand } : {}
  }

  /** Why a duty is another machine's, in a sentence. */
  private notMine(held: Held): string {
    const holder = held.holder
    if (holder === null && held.claim.duty.startsWith('batch ')) {
      return `${this.hubName() ?? 'the hub'} runs the full checks wherever it has the commit, so this machine runs them only if it has not got it within ${BATCH_WAIT_MS / 60_000} minutes`
    }
    if (holder === null) {
      return `nobody has it yet: ${this.hubName() ?? 'this machine'} grants it once it has heard from every machine that may be doing it`
    }
    const name = this.nameOf(holder)
    const mine = held.ranked.findIndex((one) => one.id === this.me().id)
    const theirs = held.ranked.findIndex((one) => one.id === holder.id)
    if (mine >= 0 && mine < theirs) {
      return `${name} has it and hands it here after what it is doing, since this machine is ranked before it`
    }
    return `${name} has it: one machine per repository, ranked alike on every one — projects.<name>.watches first, then the machine the project was opened on first, then the hub`
  }

  /** A machine as this one names it: the hub by its name here, any other as it calls itself. */
  private nameOf(one: MachineNamed): string {
    if (one.id === this.me().id) return machineLabel()
    const hub = this.hubName()
    if (hub !== null && this.hubIs?.id === one.id) return hub
    return one.name
  }

  /** How the hub stands, as this machine's link to it says: up, said goodbye, or silent since when. */
  private hubSeen(now: number): HubSeen {
    const name = this.hubName() ?? machineLabel()
    const id = this.hubIs?.id ?? null
    if (this.reach?.(name)?.live === true) {
      this.downAt = null
      return { name, id, state: 'up', since: now }
    }
    this.downAt ??= now
    const seen = this.deps.seen().find((one) => one.way === 'to' && one.machine === name)
    if (seen?.state === 'closed') return { name, id, state: 'closed', since: seen.at }
    // Silent since its line said so, or since this window saw its link go —
    // never since the window opened, which would make a blip a long silence.
    const said = seen && seen.state !== 'up' ? (seen.since ?? seen.at) : null
    return { name, id, state: 'silent', since: said ?? this.downAt }
  }

  private rankOf(project: string): Rank {
    const config = this.wire.opts.config
    return {
      said: watchesSaid(config.projects[project]?.watches, WATCHES_HERE),
      opened: this.named.get(project)?.opened ?? null,
    }
  }

  /** Which repository a project is: undefined until read, null where its checkout names none. */
  private repositoryOf(project: string): string | null | undefined {
    if (this.mode() === null) return null
    const named = this.named.get(project)
    if (named === undefined) {
      void this.readNames()
      return undefined
    }
    return named.repository
  }

  /** Every project's repository and the moment it was first opened here: git and a stat, never waited on. */
  private readNames(): Promise<void> {
    this.naming ??= (async () => {
      this.namedAt = this.wire.now()
      const home = this.wire.opts.home
      for (const [name, project] of Object.entries(this.wire.opts.config.projects)) {
        const repository = await repositoryAt(project.root).catch((err: unknown) => {
          this.sayOnce(`which repository ${name} is could not be read: ${why(err)}`)
          return null
        })
        const born = await stat(projectDir(home, name)).then(
          (one) => (one.birthtimeMs > 0 ? one.birthtimeMs : null),
          // A project with no folder in this home yet has nothing to say when it was opened.
          (err: NodeJS.ErrnoException) => (err.code === 'ENOENT' ? null : Promise.reject(err)),
        )
        this.named.set(name, { repository, opened: born })
      }
      const woken = [...this.afterNames]
      this.afterNames.clear()
      for (const wake of woken) wake()
    })()
      .catch((err: unknown) => this.sayOnce(`the projects could not be read: ${why(err)}`))
      .finally(() => {
        this.naming = null
      })
    return this.naming
  }

  private sayOnce(text: string): void {
    if (this.lastSaid === text) return
    this.lastSaid = text
    this.deps.say(text)
  }
}
