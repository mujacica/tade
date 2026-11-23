import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { type ConversationAsk, type LeaseOp, SHARE_LINE } from '@tade/core'
import { appendixFor, type ConversationFormat, mergeConversations } from './conversation.ts'
import {
  appendLines,
  CONVERSATION_CHAIN_START,
  ConversationRecord,
  writeLines,
} from './conversation-file.ts'
import { ifMissing } from './sessions.ts'

// One orchestrator conversation on every machine: each machine's half of it.
//
// **What is kept.** This machine's own record, which is the harness's and is
// only ever appended to (`ConversationReplica.take`), and a copy of each other
// machine's conversation entries, canonical and in its order, under
// `<home>/machines/<id>/conversation.jsonl` beside the copy of its journal —
// written only by whoever holds this home, as feeds are. A copy is that
// machine's record as it last said it, so it only ever grows too; one that
// stops agreeing with the chain it was sent under is taken again whole.
//
// **The exchange** (`exchange`, the near half; `answer`, the far half): the
// machine that dials first says who it is and learns what the far side holds
// of it, then gives its entries after that and asks for the far side's after
// what it holds, each count with the chain over the lines up to it. A line too
// long for one request goes in pieces. It runs until neither side has
// anything the other lacks.
//
// **Settling** (`settle`) is what makes the copies part of this machine's own
// record, and only at a turn boundary: a copy that holds everything this
// record does and more is *adopted* — its extra entries appended in its order,
// no marker — and a copy and a record that each hold entries the other lacks
// are a fork, *merged* (`mergeConversations`), which only ever happens with
// the turn lease held, so two machines never merge one fork twice. A line of a
// shape nobody knows stops it, said in words, and both stay as they are.
//
// **The turn lease** (`TurnLease`) is the hub's: one turn at a time across
// the fleet while machines can reach it. It runs out by itself (`LEASE_MS`)
// unless renewed, so a machine that went away mid-turn holds nobody up long.

/** How long a lease lasts unless it is renewed: a turn renews it every `RENEW_MS`. */
export const LEASE_MS = 90_000
export const RENEW_MS = 20_000

/** How much one request gives, and how much one answer carries. */
const GIVE_BYTES = 48 * 1024
const ANSWER_BYTES = 512 * 1024

/** A machine, by its id and what it calls itself. */
export interface MachineNamed {
  id: string
  name: string
}

export interface LeaseAnswer {
  granted: boolean
  /** Who holds it, where somebody else does, and since when. */
  holder?: { name: string; since: number }
}

/** The far side's answer to one request of the exchange. */
export interface ConversationAnswer {
  machine: MachineNamed
  harness: string
  /** What it holds of the asker's entries now, after taking what was given. */
  held: { after: number; h: string; piece?: number }
  /** Its own entries from `after`, as many as fit, or a piece of the next where one did not. */
  after: number
  lines: string[]
  piece?: { text: string; from: number; done: boolean }
  /** It has more after these. */
  more: boolean
  /** How many entries it holds in all. */
  entries: number
  lease?: LeaseAnswer
  /** Why nothing was taken or given: a harness that is not the asker's, a line it does not know. */
  refused?: string
}

/** The hub's lease on whose turn it is. In memory: a hub that restarts begins with nobody's turn. */
export class TurnLease {
  private held: { id: string; name: string; key: string; since: number; until: number } | null =
    null

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
    this.held = { id: who.id, name: who.name, key, since, until: now + LEASE_MS }
    return { granted: true }
  }
}

/** What settling one copy into this record came to. */
export type Settled =
  | { from: string; took: 0; refused?: string }
  | { from: string; took: number; merged: null | { trunk: string; other: string } }

export interface SharedConversationOptions {
  home: string
  me: MachineNamed
  /** Which harness this machine's orchestrator runs on. */
  harness: string
  format: ConversationFormat
  /** This machine's own record of the conversation. */
  record: string
  /** Canonical lines appended to this machine's own record, for this machine (`ConversationReplica.take`). */
  take: (lines: readonly string[], leaf: string | null) => Promise<void>
}

interface Copy {
  name: string
  record: ConversationRecord
  /** A line given in pieces, held until its last. */
  piece: string
}

/** Where a home keeps its copy of another machine's conversation. */
export function conversationCopyPath(home: string, machine: string): string {
  return join(home, 'machines', machine, 'conversation.jsonl')
}

/** Said where two machines run their orchestrator on different harnesses. */
export function sameHarness(there: string, theirs: string, here: string, ours: string): string {
  return `every machine has to run the orchestrator on the same harness for it to be one conversation: ${there} runs ${theirs} and ${here} runs ${ours}, so each keeps its own until one of them is changed (orchestrator.harness)`
}

export class SharedConversation {
  readonly me: MachineNamed
  readonly harness: string
  readonly own: ConversationRecord
  private readonly opts: SharedConversationOptions
  private readonly copies = new Map<string, Copy>()
  /** What each far machine holds of this one's, as it last said. */
  private readonly hold = new Map<string, { after: number; h: string; piece: number }>()

  constructor(opts: SharedConversationOptions) {
    this.opts = opts
    this.me = opts.me
    this.harness = opts.harness
    this.own = new ConversationRecord(opts.record, opts.format)
  }

  /** The copy of one machine's, looked at now. */
  private async copyOf(machine: MachineNamed): Promise<Copy> {
    let copy = this.copies.get(machine.id)
    if (!copy) {
      const record = new ConversationRecord(
        conversationCopyPath(this.opts.home, machine.id),
        this.opts.format,
      )
      copy = { name: machine.name, record, piece: '' }
      this.copies.set(machine.id, copy)
    }
    if (copy.name !== machine.name || !copy.record.entries) await writeName(this.opts.home, machine)
    copy.name = machine.name
    await copy.record.look()
    return copy
  }

  /** The machines whose copies a home already keeps, taken up: what a hub settles after it restarts. */
  async known(machines: readonly MachineNamed[]): Promise<void> {
    for (const machine of machines) if (machine.id !== this.me.id) await this.copyOf(machine)
  }

  // ── The far half ──────────────────────────────────────────────────────────

  /** Take what one request gives, and answer with what the asker lacks. The lease is the caller's. */
  async answer(ask: ConversationAsk): Promise<ConversationAnswer> {
    await this.own.look()
    const nothing = { after: 0, lines: [], more: false, entries: this.own.entries }
    if (ask.harness !== this.harness) {
      return {
        machine: this.me,
        harness: this.harness,
        held: { after: 0, h: CONVERSATION_CHAIN_START },
        ...nothing,
        refused: sameHarness(ask.from.name, ask.harness, this.me.name, this.harness),
      }
    }
    if (ask.from.id === this.me.id) throw new Error('a machine asked itself for its conversation')
    const copy = await this.copyOf(ask.from)
    const refused = ask.give ? await this.taken(copy, ask.give) : undefined
    const out = ask.want ? await this.give(this.own, ask.want, ANSWER_BYTES) : nothing
    return {
      machine: this.me,
      harness: this.harness,
      held: holdOf(copy),
      ...out,
      entries: this.own.entries,
      ...(refused ? { refused } : {}),
    }
  }

  /**
   * Lines given, into the copy: appended where they follow it, the copy begun
   * again where they begin from nothing, and nothing done where they do neither
   * — the answer's `held` says where to give from instead.
   */
  private async taken(
    copy: Copy,
    give: NonNullable<ConversationAsk['give']>,
  ): Promise<string | undefined> {
    const record = copy.record
    const follows = give.after === record.entries && give.h === record.chainAt(record.entries)
    if (!follows) {
      if (give.after !== 0) return undefined
      await writeLines(record.path, [])
      await record.look()
      copy.piece = ''
    }
    const lines = [...give.lines]
    const piece = give.piece
    if (piece) {
      if (piece.from === copy.piece.length) copy.piece += piece.text
      else if (piece.from === 0) copy.piece = piece.text
      // Out of step: dropped, and `held.piece` asks for the line from its start.
      else copy.piece = ''
      if (piece.done && copy.piece.length >= piece.from + piece.text.length) {
        lines.push(copy.piece)
        copy.piece = ''
      }
    }
    for (const line of lines) {
      const read = this.opts.format.read(line)
      if (read.kind !== 'entry') {
        const what = read.kind === 'unknown' ? read.why : 'the harness’s own bookkeeping'
        return `a line from ${copy.name} is not an entry of the conversation Tade knows (${what}), so its copy here stays as it was`
      }
    }
    await appendLines(record.path, lines)
    await record.look()
    return undefined
  }

  /** A record's lines after `want`, as many as fit — from the start where `want` does not agree with it. */
  private async give(
    record: ConversationRecord,
    want: { after: number; h: string; piece?: number },
    bytes: number,
  ): Promise<{
    after: number
    lines: string[]
    piece?: { text: string; from: number; done: boolean }
    more: boolean
  }> {
    const agrees = want.after <= record.entries && record.chainAt(want.after) === want.h
    const after = agrees ? want.after : 0
    const fits: string[] = []
    let used = 0
    for (const line of await record.canonical(after, bytes)) {
      if (line.length > SHARE_LINE || (fits.length > 0 && used + line.length > bytes)) break
      fits.push(line)
      used += line.length
    }
    const next = after + fits.length
    if (fits.length === 0 && next < record.entries) {
      // One line too long for a request: a piece of it, from where the far side has it.
      const [line = ''] = await record.canonical(next, 1)
      const from = agrees && want.piece !== undefined && want.piece <= line.length ? want.piece : 0
      const text = line.slice(from, from + SHARE_LINE)
      return {
        after: next,
        lines: [],
        piece: { text, from, done: from + text.length >= line.length },
        more: true,
      }
    }
    return { after, lines: fits, more: next < record.entries }
  }

  // ── The near half ─────────────────────────────────────────────────────────

  /**
   * One exchange with the machine at the other end of `send`, until neither
   * holds anything the other lacks. Throws what the link threw, and a line it
   * could not take; answers what the far side refused, which is said rather
   * than retried. A `take` the far side would not grant stops it at once.
   */
  async exchange(
    send: (ask: ConversationAsk) => Promise<ConversationAnswer>,
    lease?: { op: LeaseOp; key: string },
  ): Promise<{
    there: MachineNamed
    took: number
    refused?: string
    lease?: LeaseAnswer
  }> {
    // First who this is and, with it, the lease: what the far side holds of
    // this machine comes back with it, so nothing is given twice.
    const opened = await send({ from: this.me, harness: this.harness, ...(lease ? { lease } : {}) })
    const answered = { there: opened.machine, ...(opened.lease ? { lease: opened.lease } : {}) }
    if (opened.refused) return { ...answered, took: 0, refused: opened.refused }
    if (lease?.op === 'take' && opened.lease?.granted === false) return { ...answered, took: 0 }
    const copy = await this.copyOf(opened.machine)
    this.hold.set(opened.machine.id, { ...opened.held, piece: opened.held.piece ?? 0 })
    let took = 0
    for (let round = 0; round < 100_000; round++) {
      await this.own.look()
      const give = await this.giving(opened.machine.id)
      const answer = await send({
        from: this.me,
        harness: this.harness,
        give,
        want: holdOf(copy),
      })
      if (answer.refused) return { ...answered, took, refused: answer.refused }
      this.hold.set(opened.machine.id, { ...answer.held, piece: answer.held.piece ?? 0 })
      const before = copy.record.entries
      const refused = await this.taken(copy, {
        after: answer.after,
        h:
          answer.after === 0 ? CONVERSATION_CHAIN_START : (copy.record.chainAt(answer.after) ?? ''),
        lines: answer.lines,
        ...(answer.piece ? { piece: answer.piece } : {}),
      })
      if (refused) throw new Error(refused)
      took += Math.max(0, copy.record.entries - before)
      const theyHold =
        answer.held.after === this.own.entries &&
        answer.held.h === this.own.chainAt(this.own.entries) &&
        !answer.held.piece
      if (theyHold && !answer.more && !answer.piece) return { ...answered, took }
    }
    throw new Error('the conversation exchange did not settle')
  }

  /** What to give: this record's lines after what the far side holds, or from the start where that does not agree. */
  private async giving(machine: string): Promise<NonNullable<ConversationAsk['give']>> {
    const hold = this.hold.get(machine) ?? { after: 0, h: CONVERSATION_CHAIN_START, piece: 0 }
    const out = await this.give(this.own, hold, GIVE_BYTES)
    return {
      after: out.after,
      h: this.own.chainAt(out.after) ?? CONVERSATION_CHAIN_START,
      lines: out.lines,
      ...(out.piece ? { piece: out.piece } : {}),
    }
  }

  // ── Settling ──────────────────────────────────────────────────────────────

  /**
   * Make every copy part of this machine's own record: adopt one that holds
   * all of it and more, and merge one that forked from it — the second only
   * where `merging` says the caller holds the lease. Appends through `take`;
   * the harness reading it again is the caller's, between turns.
   */
  async settle(merging: boolean): Promise<Settled[]> {
    const out: Settled[] = []
    for (const copy of this.copies.values()) {
      await this.own.look()
      await copy.record.look()
      out.push(await this.settleOne(copy, merging))
    }
    return out
  }

  private async settleOne(copy: Copy, merging: boolean): Promise<Settled> {
    const strange = this.own.unknown ?? copy.record.unknown
    if (strange) {
      return {
        from: copy.name,
        took: 0,
        refused: `a line of a shape Tade does not know is in the conversation (${strange}), so what ${copy.name} said is not taken in: it does not guess at it`,
      }
    }
    const own = this.own.ids
    const theirs = copy.record.ids
    let onlyTheirs = 0
    for (const id of theirs) if (!own.has(id)) onlyTheirs++
    if (onlyTheirs === 0) return { from: copy.name, took: 0 }
    let onlyOwn = 0
    for (const id of own) if (!theirs.has(id)) onlyOwn++
    if (onlyOwn === 0) {
      const lines = await copy.record.only((id) => !own.has(id))
      await this.opts.take(lines, lastOnPath(this.opts.format, lines))
      return { from: copy.name, took: lines.length, merged: null }
    }
    if (!merging) return { from: copy.name, took: 0 }
    const local = await this.own.all()
    const merged = mergeConversations(
      this.opts.format,
      { name: this.me.name, lines: local },
      { name: copy.name, lines: await copy.record.all() },
    )
    if (!merged.ok) return { from: copy.name, took: 0, refused: merged.why }
    const appendix = appendixFor(this.opts.format, local, merged.lines)
    await this.opts.take(appendix, merged.fork?.leaf ?? lastOnPath(this.opts.format, appendix))
    return {
      from: copy.name,
      took: appendix.length,
      merged: merged.fork ? { trunk: merged.fork.trunk, other: merged.fork.other } : null,
    }
  }
}

/** Where a copy stands, as a cursor the far side gives from. */
function holdOf(copy: Copy): { after: number; h: string; piece?: number } {
  const after = copy.record.entries
  return {
    after,
    h: copy.record.chainAt(after) ?? CONVERSATION_CHAIN_START,
    ...(copy.piece ? { piece: copy.piece.length } : {}),
  }
}

/** The last entry of these on the main path: where the harness comes back to. */
function lastOnPath(format: ConversationFormat, lines: readonly string[]): string | null {
  for (let n = lines.length - 1; n >= 0; n--) {
    const read = format.read(lines[n] as string)
    if (read.kind === 'entry' && !read.side) return read.id
  }
  return null
}

/** What a machine calls itself, beside its copy, so a hub that restarts names it. */
async function writeName(home: string, machine: MachineNamed): Promise<void> {
  const path = join(home, 'machines', machine.id, 'conversation.name')
  if ((await readFile(path, 'utf8').catch(ifMissing(null))) === machine.name) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, machine.name, { mode: 0o600 })
}
