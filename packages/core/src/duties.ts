import { z } from 'zod'
import type { LeaseOp } from './conversation-share.ts'
import { MACHINE_ID } from './feeds.ts'

// What exactly one of the person's machines does when one repository is a
// project on several: a duty, and the rule that says whose it is.
//
// One repository open on the Mac and on the VPS doubles everything that looks
// at what the two share: a review watch finds one red build from both and
// makes two findings, two batches run the full checks at one commit, and a
// branch parted between the two is a merge proposed on each. Each is a
// **duty** (`dutyOf`): a repository's watch, a batch at one commit, the merge
// of one parting. A machine that has the duty does it; every other one says
// whose it is and does not.
//
// **Whose a duty is, is the hub's word** (`DutyBoard`), kept in memory where
// the turn lease is (`Lease`, which the orchestrator's `TurnLease` is too):
// every machine that has the project claims the duty with its rank on every
// beat, the hub grants it to one, and a machine that wants it says so again
// until it is given. A claim is renewed every `RENEW_MS` and lapses after
// `LEASE_MS` unheard, so a machine that went to sleep or lost its network
// gives up its duties by itself within `LEASE_MS`; one that said goodbye
// gives them up at once (`gone`).
//
// **The rank every machine computes the same way** (`compareRank`): the
// project's own setting first (`projects.<name>.watches: here` before
// unsaid before a remote named), then the machine it was opened on first,
// then the hub, then the machine id. A better-ranked machine coming back does
// not take a duty from under a look: the holder is told to `yield`, lets go
// after whatever it is doing, and only then is the duty granted — with what
// the holder had found and where it had got to (`handed`), so the look that
// follows neither repeats nor skips anything.
//
// **A machine that cannot ask the hub** keeps a duty only until the grant it
// last had runs out (`grantedUntil`, counted from when it asked, so no two
// clocks are compared), and then stands in (`standsIn`) only where the hub
// said goodbye, or has been silent for `STAND_IN_MS`, and it is the best of
// the machines the hub last ranked that it does not know to be down. A hub
// that has just started grants nothing for `GRACE_MS` but to a machine that
// says it is already doing it, so one that stood in while the hub was away is
// never doubled by the hub's own watches coming up. Two machines that can
// each reach the world but not each other cannot both know the other is
// silent: past `STAND_IN_MS` both look, and that is said, never hidden.
//
// Pure apart from the board's memory: facts and `now` in, answers out.

/** How long a lease or a claim lasts unheard: a holder renews every `RENEW_MS`. */
export const LEASE_MS = 90_000
export const RENEW_MS = 20_000
/** How soon a machine asks again while one of its duties is being handed over. */
export const HANDING_MS = 3_000
/** How long a hub that has just started grants a duty only to a machine already doing it. */
export const GRACE_MS = LEASE_MS
/** How long a hub that went with no goodbye is waited for before a machine does its duties without it. */
export const STAND_IN_MS = 10 * 60_000
/** How long a duty done for good — a batch at one commit, a merge proposed — is remembered as done. */
export const DONE_MS = 12 * 3_600_000
/**
 * How long a batch claimed by a machine other than the hub waits for the hub
 * to claim it too — to have the commit — before it is granted where it was
 * asked: the hub runs the full checks wherever it can, and a commit only
 * another machine has is still checked, a little later. Never waited where
 * the machine claiming it says `batches: here`, or where the hub's own
 * setting names another machine (`DutyBoard`'s `hubBatches`).
 */
export const BATCH_WAIT_MS = 10 * 60_000
/** How many of its newest keys a claim carries; one look acts on far fewer. */
export const FOUND_SENT = 20
/** How many keys the hub keeps for one duty, newest first. */
export const FOUND_KEPT = 200
/** How many duties one request claims, and how many the hub keeps. */
export const DUTIES_ASKED = 128
export const DUTIES_KEPT = 1_024

/** A machine, by its id and what it calls itself. */
export interface MachineNamed {
  id: string
  name: string
}

/** What a lease answer says: granted, or whose it is and since when. */
export interface LeaseAnswer {
  granted: boolean
  /** Who holds it, where somebody else does, and since when. */
  holder?: { name: string; since: number }
}

/**
 * One lease, in memory: held by one machine under one key, until it runs out
 * unrenewed. The orchestrator's turn is one (`TurnLease`); a hub that
 * restarts begins with nobody holding it.
 */
export class Lease {
  private held: { id: string; name: string; key: string; since: number; until: number } | null =
    null
  private readonly ms: number

  constructor(ms: number = LEASE_MS) {
    this.ms = ms
  }

  /** Who holds it now, if anybody: one that ran out holds nothing. */
  holder(now: number): { id: string; name: string; since: number } | null {
    if (this.held && this.held.until <= now) this.held = null
    return this.held
  }

  ask(op: LeaseOp, who: MachineNamed, key: string, now: number): LeaseAnswer {
    const held = this.holder(now)
    const mine = held !== null && held.id === who.id && this.held?.key === key
    const busy = (): LeaseAnswer =>
      held ? { granted: false, holder: { name: held.name, since: held.since } } : { granted: true }
    if (op === 'release') {
      if (mine) this.held = null
      return { granted: true }
    }
    if (op === 'look') return mine ? { granted: true } : busy()
    if (held && !mine) return busy()
    const since = mine ? held.since : now
    this.held = { id: who.id, name: who.name, key, since, until: now + this.ms }
    return { granted: true }
  }
}

// ── Duties ───────────────────────────────────────────────────────────────────

/** What a duty is about: a repository's watch, a batch at one commit, the merge of one parting. */
export const DUTY_KINDS = ['watch', 'batch', 'merge'] as const
export type DutyKind = (typeof DUTY_KINDS)[number]

/**
 * A duty's name, the same on every machine: its kind, the repository as
 * `repositoryNamed` reads it out of `origin` (host, owner and name — never
 * what a project is called, which differs between machines), and what of it.
 */
export function dutyOf(kind: DutyKind, repository: string, what: string): string {
  return `${kind} ${repository} ${what}`
}

/** The merge of one parting: named by the two heads, in order, so both sides name it alike. */
export function mergeDuty(repository: string, branch: string, a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a]
  return dutyOf('merge', repository, `${branch} ${first}..${second}`)
}

/** What a duty's name looks like: three words at most 300 characters, nothing a line could break on. */
export const DUTY_NAME = /^(watch|batch|merge) [^\s]{1,200} [^\n\r]{1,200}$/

/** What a project's `watches` setting says, as a rank reads it. */
export const WATCHES_SAID = ['here', 'unsaid', 'elsewhere'] as const
export type WatchesSaid = (typeof WATCHES_SAID)[number]

/** What a machine claims a duty with: how it ranks for it. */
export interface Rank {
  /** `projects.<name>.watches` there: `here`, nothing, or another machine. */
  said: WatchesSaid
  /** When the project was first opened there (ms, that machine's clock); null where it cannot say. */
  opened: number | null
}

/**
 * What a machine claims a batch at one commit with: `projects.<name>.batches`
 * there, and nothing else — `watches` says where a repository is watched from,
 * not where its suites run, and when it was opened is no reason to run them.
 * Unsaid on every machine, the tie-break decides: the hub, the machine that
 * never closes and is built to run the full checks, before any other. Only a
 * machine whose HEAD is that commit claims it, so it is never granted to one
 * without it.
 */
export function batchRank(said: WatchesSaid): Rank {
  return { said, opened: null }
}

/** `watches` as a rank reads it: `here`, unsaid, or a remote by name. */
export function watchesSaid(setting: string | undefined, here: string): WatchesSaid {
  if (setting === undefined || setting === '') return 'unsaid'
  return setting === here ? 'here' : 'elsewhere'
}

/**
 * The order every machine puts claimants in, best first: the setting, then
 * the machine the project was opened on first, then the hub, then the id —
 * which no two machines share, so the order is total.
 */
export function compareRank(
  a: { id: string; rank: Rank },
  b: { id: string; rank: Rank },
  hub: string | null,
): number {
  const said = WATCHES_SAID.indexOf(a.rank.said) - WATCHES_SAID.indexOf(b.rank.said)
  if (said !== 0) return said
  const ao = a.rank.opened ?? Number.POSITIVE_INFINITY
  const bo = b.rank.opened ?? Number.POSITIVE_INFINITY
  if (ao !== bo) return ao < bo ? -1 : 1
  if (hub !== null && (a.id === hub) !== (b.id === hub)) return a.id === hub ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** One duty as one machine claims it, on every beat while it wants it. */
export interface DutyClaim {
  duty: string
  rank: Rank
  /** It is doing it now: granted and begun, or standing in while the hub could not be asked. */
  doing: boolean
  /** Where its last look got to, and a digest of what it looks at: for whoever does it next. */
  since?: string | null
  input?: string
  /** Its newest keys found with it, at most `FOUND_SENT`. */
  found?: readonly string[]
  /** Done for good: a batch at its commit has run, a merge has been proposed. */
  done?: boolean
}

/** What one machine is answered about one duty it claims. */
export interface DutyAnswer {
  duty: string
  /** It is the asker's to do now. */
  yours: boolean
  /** Whose it is, where somebody's. */
  holder: { id: string; name: string } | null
  /** The asker holds it and a machine ranked before it wants it: let go after what is under way. */
  yield?: true
  /** It was done for good already, by whom, and how long ago. */
  done?: { name: string; agoMs: number }
  /**
   * Given with a grant not yet begun: what the machine that had it before had
   * found, where it had got to, and how long ago it was last heard.
   */
  handed?: { from: string; found: string[]; since: string | null; input: string; agoMs: number }
  /** Every machine claiming it, best first: what a machine that loses the hub decides by. */
  ranked: MachineNamed[]
}

interface Claimed {
  name: string
  rank: Rank
  doing: boolean
  at: number
}

interface Board {
  claims: Map<string, Claimed>
  holder: { id: string; name: string } | null
  /** Where whoever had it last got to, and when it was last heard. */
  last: { id: string; name: string; since: string | null; input: string; at: number } | null
  found: string[]
  done: { name: string; at: number } | null
  touched: number
  /** When it was first claimed. */
  first: number
}

/**
 * The hub's word on whose each duty is, in memory beside the turn lease: a
 * hub that restarts starts with nobody holding anything, and `GRACE_MS` of
 * granting only to whoever says it is already doing a duty.
 */
export class DutyBoard {
  private readonly duties = new Map<string, Board>()
  private readonly me: MachineNamed
  private readonly born: number
  private readonly heardAll: () => boolean
  private readonly hubBatches: (duty: string) => boolean

  /**
   * `heardAll` says every machine that links here and did not say goodbye has
   * claimed since this board began: the grace is over then, since nobody can
   * be standing in unheard. `hubBatches` says the hub would run a batch itself
   * once it has the commit — false where its `projects.<name>.batches` names
   * another machine, so that one is not kept waiting for a hub that gives way.
   */
  constructor(
    me: MachineNamed,
    now: number,
    heardAll: () => boolean = () => false,
    hubBatches: (duty: string) => boolean = () => true,
  ) {
    this.me = me
    this.born = now
    this.heardAll = heardAll
    this.hubBatches = hubBatches
  }

  /**
   * One machine's claims, and what it lets go: answered for each claim. A
   * duty it no longer claims and did not let go lapses after `LEASE_MS`.
   */
  ask(
    from: MachineNamed,
    claims: readonly DutyClaim[],
    letGo: readonly string[],
    now: number,
  ): DutyAnswer[] {
    for (const duty of letGo) {
      const board = this.duties.get(duty)
      if (!board) continue
      board.claims.delete(from.id)
      if (board.holder?.id === from.id) board.holder = null
    }
    const answers: DutyAnswer[] = []
    for (const claim of claims.slice(0, DUTIES_ASKED)) {
      const board = this.boardOf(claim.duty, now)
      board.touched = now
      board.found = keptKeys(claim.found ?? [], board.found)
      if (claim.done) {
        board.done = { name: from.name, at: now }
        if (board.holder?.id === from.id) board.holder = null
        board.claims.delete(from.id)
      } else {
        board.claims.set(from.id, {
          name: from.name,
          rank: claim.rank,
          doing: claim.doing,
          at: now,
        })
      }
      // Where it got to is the word of whoever is actually doing it, never of
      // a machine just granted it and not yet begun, which would hand on nothing.
      if (claim.doing && (board.holder === null || board.holder.id === from.id)) {
        board.last = {
          id: from.id,
          name: from.name,
          since: claim.since ?? board.last?.since ?? null,
          input: claim.input ?? board.last?.input ?? '',
          at: now,
        }
      }
      answers.push(this.answer(claim.duty, board, from, claim, now))
    }
    this.forget(now)
    return answers
  }

  /** A machine said goodbye: whatever it held is given up now, not when its lease runs out. */
  gone(id: string): void {
    for (const board of this.duties.values()) {
      board.claims.delete(id)
      if (board.holder?.id === id) board.holder = null
    }
  }

  /** Whose a duty is now, as the hub would answer: what this machine's own surfaces draw. */
  holderOf(duty: string, now: number): MachineNamed | null {
    const board = this.duties.get(duty)
    if (!board) return null
    this.lapse(board, now)
    return board.holder
  }

  private boardOf(duty: string, now: number): Board {
    const had = this.duties.get(duty)
    if (had) return had
    const made: Board = {
      claims: new Map(),
      holder: null,
      last: null,
      found: [],
      done: null,
      touched: now,
      first: now,
    }
    this.duties.set(duty, made)
    return made
  }

  /** Claims unheard for `LEASE_MS` lapse, and a holder among them gives the duty up. */
  private lapse(board: Board, now: number): void {
    for (const [id, one] of board.claims) {
      if (now - one.at >= LEASE_MS) board.claims.delete(id)
    }
    if (board.holder && !board.claims.has(board.holder.id)) board.holder = null
    if (board.done && now - board.done.at >= DONE_MS) board.done = null
  }

  private ranked(board: Board): (MachineNamed & { rank: Rank; doing: boolean })[] {
    return [...board.claims.entries()]
      .map(([id, one]) => ({ id, name: one.name, rank: one.rank, doing: one.doing }))
      .sort((a, b) => compareRank(a, b, this.me.id))
  }

  private answer(
    duty: string,
    board: Board,
    from: MachineNamed,
    claim: DutyClaim,
    now: number,
  ): DutyAnswer {
    this.lapse(board, now)
    const ranked = this.ranked(board)
    const names = ranked.map(({ id, name }) => ({ id, name }))
    if (board.done) {
      return {
        duty,
        yours: false,
        holder: null,
        done: { name: board.done.name, agoMs: now - board.done.at },
        ranked: names,
      }
    }
    if (board.holder === null) {
      // Already being done somewhere — a machine that stood in while this hub
      // was away — is the holder first, whatever the rank, and yields after.
      const doing = ranked.find((one) => one.doing)
      const best = ranked[0]
      const grace = now - this.born < GRACE_MS && !this.heardAll()
      // A batch waits a while for the hub, which has not got the commit yet —
      // unless the best claimant was named to run it, or the hub gives way.
      const waits =
        duty.startsWith('batch ') &&
        best !== undefined &&
        best.id !== this.me.id &&
        best.rank.said !== 'here' &&
        this.hubBatches(duty) &&
        now - board.first < BATCH_WAIT_MS
      const next = doing ?? (grace || waits ? undefined : best)
      if (next) board.holder = { id: next.id, name: next.name }
    }
    const holder = board.holder
    const yours = holder?.id === from.id
    const best = ranked[0]
    const out: DutyAnswer = { duty, yours, holder, ranked: names }
    if (yours && best !== undefined && best.id !== from.id) out.yield = true
    if (yours && !claim.doing && board.last !== null && board.last.id !== from.id) {
      out.handed = {
        from: board.last.name,
        found: [...board.found],
        since: board.last.since,
        input: board.last.input,
        agoMs: now - board.last.at,
      }
    } else if (yours && !claim.doing && board.found.length > 0) {
      out.handed = {
        from: board.last?.name ?? from.name,
        found: [...board.found],
        since: null,
        input: '',
        agoMs: 0,
      }
    }
    return out
  }

  /** Past `DUTIES_KEPT`, the duties untouched longest that nobody holds or claims are forgotten. */
  private forget(now: number): void {
    if (this.duties.size <= DUTIES_KEPT) return
    const idle = [...this.duties.entries()]
      .filter(([, board]) => {
        this.lapse(board, now)
        return board.holder === null && board.claims.size === 0
      })
      .sort(([, a], [, b]) => a.touched - b.touched)
    for (const [duty] of idle.slice(0, this.duties.size - DUTIES_KEPT)) this.duties.delete(duty)
  }
}

/** Newest first, each once, at most `FOUND_KEPT`. */
function keptKeys(fresh: readonly string[], had: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const key of [...fresh, ...had]) {
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    out.push(key)
    if (out.length >= FOUND_KEPT) break
  }
  return out
}

// ── A machine that cannot ask the hub ────────────────────────────────────────

/**
 * Until when a grant holds on the machine that asked for it: from the moment
 * it *asked*, which is before the hub granted it, so the asker always lets go
 * before the hub hands the duty to anybody else — whatever either clock says.
 */
export function grantedUntil(askedAt: number): number {
  return askedAt + LEASE_MS - RENEW_MS
}

/** How the hub stands, as this machine's link to it last said. */
export interface HubSeen {
  name: string
  id: string | null
  /** `up` while its link is live; `closed` where it said goodbye; otherwise silent. */
  state: 'up' | 'closed' | 'silent'
  /** Since when it has been what it is now. */
  since: number
}

/**
 * Whether this machine does a duty while it cannot ask the hub: only where
 * the hub said goodbye or has been silent past `STAND_IN_MS`, and this
 * machine is the best of the machines the hub last ranked for it that it does
 * not know to be down — the hub itself left out, since it is the one away.
 * One the hub never ranked is this machine's alone as far as it can know.
 */
export function standsIn(facts: {
  me: string
  hub: HubSeen
  /** The hub's last ranking of it, best first; empty where it was never answered. */
  ranked: readonly MachineNamed[]
  /** Machines this one knows to be down, by id. */
  down: ReadonlySet<string>
  now: number
}): { stands: boolean; why: string } {
  const { hub } = facts
  if (hub.state === 'up') return { stands: false, why: `${hub.name} decides it` }
  const waited = facts.now - hub.since
  if (hub.state === 'silent' && waited < STAND_IN_MS) {
    const left = Math.ceil((STAND_IN_MS - waited) / 60_000)
    return {
      stands: false,
      why: `${hub.name}, which decides whose it is, has been silent with no goodbye — asleep, or off the network — so nothing is done here for ${left} more ${left === 1 ? 'minute' : 'minutes'} in case it is still being done there`,
    }
  }
  const first = facts.ranked.find(
    (one) => one.id !== hub.id && one.id !== facts.me && !facts.down.has(one.id),
  )
  const mine = facts.ranked.findIndex((one) => one.id === facts.me)
  const before = first !== undefined && (mine < 0 || facts.ranked.indexOf(first) < mine)
  const gone =
    hub.state === 'closed'
      ? `${hub.name} said goodbye`
      : `${hub.name} has been silent for ${Math.round(waited / 60_000)} minutes`
  if (before && first !== undefined) {
    return { stands: false, why: `${gone}, and ${first.name} is ranked before this machine` }
  }
  return {
    stands: true,
    why:
      hub.state === 'closed'
        ? `${gone}, so this machine does it until it is back`
        : `${gone}, so this machine does it — if it is only cut off from here and still does it, both do until they can see each other`,
  }
}

// ── What travels ─────────────────────────────────────────────────────────────

const Key = z.string().min(1).max(200)
const RankBody = z.strictObject({
  said: z.enum(WATCHES_SAID),
  opened: z.number().nullable(),
})

/** One request of `POST /api/duties`, as the hub's door reads it before anything else does. */
export const DutiesBody = z.strictObject({
  from: z.strictObject({ id: z.string().regex(MACHINE_ID), name: z.string().min(1).max(120) }),
  claims: z
    .array(
      z.strictObject({
        duty: z.string().regex(DUTY_NAME),
        rank: RankBody,
        doing: z.boolean(),
        since: z.string().max(2_000).nullable().optional(),
        input: z.string().max(80).optional(),
        found: z.array(Key).max(FOUND_SENT).optional(),
        done: z.boolean().optional(),
      }),
    )
    .max(DUTIES_ASKED),
  letGo: z.array(z.string().regex(DUTY_NAME)).max(DUTIES_ASKED),
})
export type DutiesAsk = z.infer<typeof DutiesBody>

const Named = z.object({ id: z.string().max(80), name: z.string().min(1).max(120) })

/** The hub's answer, read for its shape on the asking machine: another machine wrote it. */
export const DutiesReply = z.object({
  hub: Named,
  answers: z
    .array(
      z.object({
        duty: z.string().max(420),
        yours: z.boolean(),
        holder: Named.nullable(),
        yield: z.literal(true).optional(),
        done: z.object({ name: z.string().max(120), agoMs: z.number() }).optional(),
        handed: z
          .object({
            from: z.string().max(120),
            found: z.array(Key).max(FOUND_KEPT),
            since: z.string().max(2_000).nullable(),
            input: z.string().max(80),
            agoMs: z.number(),
          })
          .optional(),
        ranked: z.array(Named).max(64),
      }),
    )
    .max(DUTIES_ASKED),
})
export type DutiesAnswer = z.infer<typeof DutiesReply>
