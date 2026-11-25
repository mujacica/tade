import { constants } from 'node:fs'
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  BESIDE_ASKED,
  BESIDE_NAME,
  type ConversationAsk,
  ConversationReply,
  feedDir,
  Lease,
  type LeaseAnswer,
  type LeaseOp,
  MACHINE_ID,
  type MachineNamed,
  PeerRoom,
  SHARE_ANSWER,
  SHARE_LINE,
} from '@tade/core'

export type { LeaseAnswer, MachineNamed } from '@tade/core'
export { LEASE_MS, RENEW_MS } from '@tade/core'

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
// **The files beside a record travel with it** (`ConversationFormat.besideOf`,
// Claude Code's large tool results): an entry names one by its name there,
// and the model reads it when it needs more than the entry holds, so a copy
// without it is a conversation that points at nothing. Each side says, every
// request, which of the files the other's entries name it lacks — from the
// bytes it holds of one, in `<copy>/<name>.part` until the last piece — and
// the other gives a piece of the first it has, or says it has it nowhere,
// once. A file is written once and never changes, so a name is all that is
// compared. Files ride in a request only where it gives no entries, since a
// request is the hub's 64 KB, and an exchange goes on while they move; whether
// it is `complete` is still the entries', which is what a merge waits for.
// Settling puts what came beside this machine's own record, where the entries
// taken in name it.
//
// **The turn lease** (`TurnLease`) is the hub's: one turn at a time across
// the fleet while machines can reach it. It runs out by itself (`LEASE_MS`)
// unless renewed, so a machine that went away mid-turn holds nobody up long.

/** How much one request gives, and how much one answer carries. */
const GIVE_BYTES = 48 * 1024
const ANSWER_BYTES = SHARE_ANSWER

/** How much of a file one request gives — `SHARE_LINE` in base64 — and one answer carries. */
const GIVE_FILE = (SHARE_LINE / 4) * 3
const ANSWER_FILE = (ANSWER_BYTES / 4) * 3

/**
 * The longest line of another machine's conversation held while its pieces
 * arrive: a large tool result travels beside the entries as a file, so a line
 * this long is no entry anybody wrote — and held in memory, it is the window's.
 */
const PIECE_MOST = 16 * 1024 * 1024

/** A piece of a file beside a record, in base64. */
export interface BesidePiece {
  name: string
  from: number
  data: string
  done: boolean
}

/** What one side of the exchange says of the files beside the records. */
export interface BesideSaid {
  /** What it lacks of the other's, each from the bytes it holds of it. */
  lacks: { name: string; from: number }[]
  /** A piece of one the other lacks. */
  piece?: BesidePiece
  /** The ones the other lacks that it has nowhere. */
  gone: string[]
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
  /** The files beside the records, where the harness keeps any. */
  files?: BesideSaid
}

/**
 * The hub's lease on whose turn it is: core's `Lease`, the one every duty a
 * hub keeps is held under too (`DutyBoard`). In memory: a hub that restarts
 * begins with nobody's turn.
 */
export class TurnLease extends Lease {}

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
  /** A file beside a record that could not be read or put in place: said, and the rest carries on. */
  warn?: (text: string) => void
  /**
   * How much more of what other machines give fits on this disk (`PeerRoom`,
   * `@tade/core`'s `peer-disk.ts`), shared with the copies of their journals.
   * One of its own under `home` where none is handed over.
   */
  room?: PeerRoom
}

interface Copy {
  name: string
  record: ConversationRecord
  /** A line given in pieces, held until its last. */
  piece: string
  /** Where the files its entries name are kept (`conversationFilesPath`). */
  dir: string
  /** The ones known to be there whole. */
  have: Set<string>
  /** The ones its machine said it has nowhere: not asked for again. */
  gone: Set<string>
}

/**
 * Where a home keeps its copy of another machine's conversation: beside the
 * copy of its journal (`feedDir`), which refuses anything but a machine id, so
 * no caller can make a path out of an id nothing checked.
 */
export function conversationCopyPath(home: string, machine: string): string {
  return join(feedDir(home, machine), 'conversation.jsonl')
}

/** Where a home keeps the files beside another machine's record its entries name, by their names there. */
export function conversationFilesPath(home: string, machine: string): string {
  return join(feedDir(home, machine), 'conversation')
}

/**
 * The machines whose conversation a home keeps a copy of, with what each
 * calls itself: what a hub takes up again after it restarts, before anybody
 * has asked it anything.
 */
export async function conversationCopies(home: string): Promise<MachineNamed[]> {
  const out: MachineNamed[] = []
  const entries = await readdir(join(home, 'machines'), { withFileTypes: true }).catch(
    ifMissing([]),
  )
  for (const entry of entries) {
    // The folders a remote's name keeps (`machineDir`) are not copies of anybody's.
    if (!entry.isDirectory() || !MACHINE_ID.test(entry.name)) continue
    const name = await readFile(join(feedDir(home, entry.name), 'conversation.name'), 'utf8').catch(
      ifMissing(null),
    )
    if (name !== null && name.trim() !== '') out.push({ id: entry.name, name: name.trim() })
  }
  return out
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
  /** Where this record keeps the files its entries name; null where the harness keeps none. */
  private readonly beside: string | null
  /** What each far machine lacks of the files this one's entries name, as it last said. */
  private readonly lacking = new Map<string, { name: string; from: number }[]>()
  /** The files already beside this record, so settling does not look again. */
  private readonly placed = new Set<string>()
  /** The files known to be here somewhere, so none is asked for again. */
  private readonly held = new Set<string>()
  /** What was said about a file, once each. */
  private readonly warned = new Set<string>()
  /** How much more of what other machines give fits here. */
  private readonly room: PeerRoom
  /**
   * The end of what changes the copies, so each change starts after the last
   * has finished (`serially`). Requests from one machine overlap — a turn's
   * exchange starts while the beat's is still going, or a request the link
   * gave up on is still being answered when the next arrives — and two that
   * give the same piece each wrote the `.part` and renamed it, the second
   * from nothing (TADE-G), as two giving the same lines appended them twice.
   */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(opts: SharedConversationOptions) {
    this.opts = opts
    this.room = opts.room ?? new PeerRoom(opts.home)
    this.me = opts.me
    this.harness = opts.harness
    this.own = new ConversationRecord(opts.record, opts.format)
    this.beside = opts.format.besideOf?.(opts.record) ?? null
  }

  /**
   * `change` once every change to the copies before it has finished, however
   * that one ended: its failure is its caller's, from `run`, and the next
   * change waits only for it to settle.
   */
  private serially<T>(change: () => Promise<T>): Promise<T> {
    const run = this.tail.then(change)
    this.tail = Promise.allSettled([run])
    return run
  }

  /** The copy of one machine's, looked at now. */
  private async copyOf(machine: MachineNamed): Promise<Copy> {
    let copy = this.copies.get(machine.id)
    if (!copy) {
      const record = new ConversationRecord(
        conversationCopyPath(this.opts.home, machine.id),
        this.opts.format,
      )
      copy = {
        name: machine.name,
        record,
        piece: '',
        dir: conversationFilesPath(this.opts.home, machine.id),
        have: new Set(),
        gone: new Set(),
      }
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
  answer(ask: ConversationAsk): Promise<ConversationAnswer> {
    return this.serially(() => this.answerNow(ask))
  }

  private async answerNow(ask: ConversationAsk): Promise<ConversationAnswer> {
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
    if (ask.files?.give) await this.takeFile(copy, ask.files.give)
    for (const name of ask.files?.gone ?? []) copy.gone.add(name)
    const files = await this.filesFor(
      ask.from.id,
      ask.files?.want ?? [],
      out.lines.length === 0 && !('piece' in out) ? ANSWER_FILE : 0,
    )
    return {
      machine: this.me,
      harness: this.harness,
      held: holdOf(copy),
      ...out,
      entries: this.own.entries,
      ...(refused ? { refused } : {}),
      ...(this.beside ? { files: { lacks: await this.wanting(copy), ...files } } : {}),
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
      if (copy.piece.length > PIECE_MOST) {
        copy.piece = ''
        return `a line from ${copy.name} ran past ${PIECE_MOST / 1024 ** 2} MB in pieces, which no entry is, so its copy here stays as it was`
      }
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
    const bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0)
    if (bytes > 0 && !(await this.room.fits(bytes, Date.now()))) {
      return `${copy.name}’s conversation was not taken: ${this.room.says()}`
    }
    await appendLines(record.path, lines)
    this.room.spent(bytes)
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
   *
   * `send` answers whatever the far side's door sent back, unread: every
   * answer is checked here (`ConversationReply`) before anything is taken
   * from it, and one that is not an answer, says it is this machine, or
   * changes machine partway throws — so no caller can trust one by a cast.
   */
  async exchange(
    send: (ask: ConversationAsk) => Promise<unknown>,
    lease?: { op: LeaseOp; key: string },
    rounds = Number.POSITIVE_INFINITY,
  ): Promise<{
    there: MachineNamed
    took: number
    /** Neither side lacks anything the other holds: false where `rounds` ran out first. */
    complete: boolean
    refused?: string
    lease?: LeaseAnswer
  }> {
    // First who this is and, with it, the lease: what the far side holds of
    // this machine comes back with it, so nothing is given twice.
    const opened = this.answerOf(
      await send({ from: this.me, harness: this.harness, ...(lease ? { lease } : {}) }),
      null,
    )
    const answered = { there: opened.machine, ...(opened.lease ? { lease: opened.lease } : {}) }
    if (opened.refused) return { ...answered, took: 0, complete: false, refused: opened.refused }
    if (lease?.op === 'take' && opened.lease?.granted === false) {
      return { ...answered, took: 0, complete: false }
    }
    const there = opened.machine.id
    const copy = await this.copyOf(opened.machine)
    this.hold.set(there, { ...opened.held, piece: opened.held.piece ?? 0 })
    this.lacking.set(there, this.saidOf(opened, copy.name).lacks)
    // Only a far side that said what it lacks reads files: an older one's door refuses the field.
    const speaks = this.beside !== null && opened.files !== undefined
    let took = 0
    let whole = false
    for (let round = 0; round < rounds; round++) {
      await this.own.look()
      const give = await this.giving(there)
      const files = speaks
        ? await this.filesFor(
            there,
            this.lacking.get(there) ?? [],
            give.lines.length === 0 && !give.piece ? GIVE_FILE : 0,
          )
        : null
      const wants = files ? await this.wanting(copy) : []
      const reply = await send({
        from: this.me,
        harness: this.harness,
        give,
        want: holdOf(copy),
        ...(files
          ? {
              files: {
                want: wants,
                ...(files.piece ? { give: files.piece } : {}),
                gone: files.gone,
              },
            }
          : {}),
      })
      const answer = this.answerOf(reply, opened.machine)
      if (answer.refused) return { ...answered, took, complete: false, refused: answer.refused }
      this.hold.set(there, { ...answer.held, piece: answer.held.piece ?? 0 })
      const said = this.saidOf(answer, copy.name)
      this.lacking.set(there, said.lacks)
      const { refused, grew } = await this.serially(async () => {
        if (said.piece) await this.takeFile(copy, said.piece)
        for (const name of said.gone) copy.gone.add(name)
        const before = copy.record.entries
        const refused = await this.taken(copy, {
          after: answer.after,
          h:
            answer.after === 0
              ? CONVERSATION_CHAIN_START
              : (copy.record.chainAt(answer.after) ?? ''),
          lines: answer.lines,
          ...(answer.piece ? { piece: answer.piece } : {}),
        })
        return { refused, grew: copy.record.entries - before }
      })
      if (refused) throw new Error(refused)
      took += Math.max(0, grew)
      const theyHold =
        answer.held.after === this.own.entries &&
        answer.held.h === this.own.chainAt(this.own.entries) &&
        !answer.held.piece
      whole = theyHold && !answer.more && !answer.piece
      // Files go on moving after the entries are whole, until a round moves
      // none, this side owes the far one nothing it said it lacks, and wants
      // nothing it has not asked for — the entries just taken may name some.
      const moved =
        files !== null &&
        (files.piece !== undefined ||
          files.gone.length > 0 ||
          said.piece !== undefined ||
          said.gone.length > 0)
      if (whole && !moved && !(speaks && (await this.unsettled(there, said.lacks, copy, wants)))) {
        return { ...answered, took, complete: true }
      }
    }
    return { ...answered, took, complete: whole }
  }

  /**
   * One answer of the far side's, checked for its shape before anything reads
   * it: from a machine that is not this one, and — after the first — from the
   * one that answered first. Throws, in words, what it is not.
   */
  private answerOf(raw: unknown, first: MachineNamed | null): ConversationAnswer {
    const parsed = ConversationReply.safeParse(raw)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      const where = issue?.path.length ? ` (${issue.path.join('.')})` : ''
      throw new Error(
        `an answer that is not one of the conversation's exchange came back${where}, so nothing of it is taken`,
      )
    }
    const answer = parsed.data
    if (answer.machine.id === this.me.id) {
      throw new Error(
        `an answer came back as from this machine (${this.me.name}), so nothing of it is taken`,
      )
    }
    if (first && answer.machine.id !== first.id) {
      throw new Error(
        `an answer came back from ${answer.machine.name} partway through an exchange with ${first.name}, so nothing of it is taken`,
      )
    }
    return answer
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

  // ── The files beside the records ──────────────────────────────────────────

  /** What a far side said of the files, with nothing it sent that is not a name beside a record. */
  private saidOf(answer: ConversationAnswer, from: string): BesideSaid {
    const files = answer.files
    if (!this.beside || !files) return { lacks: [], gone: [] }
    const named = (name: unknown): name is string =>
      typeof name === 'string' && BESIDE_NAME.test(name)
    const piece = files.piece
    if (piece && !(named(piece.name) && typeof piece.data === 'string')) {
      throw new Error(`${from} sent a file that is not one kept beside the conversation`)
    }
    return {
      lacks: (Array.isArray(files.lacks) ? files.lacks : [])
        .filter((one) => named(one?.name) && Number.isInteger(one.from) && one.from >= 0)
        .slice(0, BESIDE_ASKED),
      ...(piece ? { piece } : {}),
      gone: (Array.isArray(files.gone) ? files.gone : []).filter(named),
    }
  }

  /**
   * What this side lacks of the files a copy's entries name, each from the
   * bytes it holds — never one it has anywhere, its own given back included.
   */
  private async wanting(copy: Copy): Promise<{ name: string; from: number }[]> {
    const out: { name: string; from: number }[] = []
    for (const name of copy.record.beside.keys()) {
      if (out.length >= BESIDE_ASKED) break
      if (copy.have.has(name) || copy.gone.has(name) || this.held.has(name)) continue
      if (!BESIDE_NAME.test(name)) continue
      const path = join(copy.dir, name)
      if ((await sizeOf(path)) !== null) {
        copy.have.add(name)
        continue
      }
      if ((await this.found(name)) !== null) {
        this.held.add(name)
        continue
      }
      out.push({ name, from: (await sizeOf(`${path}.part`)) ?? 0 })
    }
    return out
  }

  /**
   * For what a far machine lacks: a piece of the first it lacks that this one
   * has, in at most `bytes`, and the ones it has nowhere — leaving out one a
   * copy here is still waiting for, which may yet come.
   */
  private async filesFor(
    machine: string,
    lacks: readonly { name: string; from: number }[],
    bytes: number,
  ): Promise<{ piece?: BesidePiece; gone: string[] }> {
    if (!this.beside) return { gone: [] }
    const gone: string[] = []
    let piece: BesidePiece | undefined
    for (const { name, from } of lacks) {
      const path = await this.found(name)
      if (path === null) {
        if (!this.coming(name, machine)) gone.push(name)
        continue
      }
      if (piece || bytes === 0) continue
      piece = (await this.pieceOf(path, name, from, bytes)) ?? undefined
      if (!piece) gone.push(name)
    }
    return { ...(piece ? { piece } : {}), gone }
  }

  /**
   * Whether another round would move a file: the far machine lacks one this
   * one would give or say it has nowhere, or this one wants one it did not
   * ask for in the round just made.
   */
  private async unsettled(
    machine: string,
    lacks: readonly { name: string; from: number }[],
    copy: Copy,
    asked: readonly { name: string }[],
  ): Promise<boolean> {
    for (const { name } of lacks) {
      if ((await this.found(name)) !== null || !this.coming(name, machine)) return true
    }
    const before = new Set(asked.map((one) => one.name))
    return (await this.wanting(copy)).some((one) => !before.has(one.name))
  }

  /** Where a file is here: where this record's entries say, beside this record, or in a copy. */
  private async found(name: string): Promise<string | null> {
    const places = [
      this.own.beside.get(name),
      this.beside ? join(this.beside, name) : null,
      ...[...this.copies.values()].map((copy) => join(copy.dir, name)),
    ]
    for (const path of places) if (path && (await sizeOf(path)) !== null) return path
    return null
  }

  /** Whether a copy here other than `except`'s names a file it does not have yet. */
  private coming(name: string, except: string): boolean {
    for (const [id, copy] of this.copies) {
      if (id === except || copy.gone.has(name) || copy.have.has(name)) continue
      if (copy.record.beside.has(name)) return true
    }
    return false
  }

  /** A piece of a file from `from` — from its start where it is shorter — or null, said, where it cannot be read. */
  private async pieceOf(
    path: string,
    name: string,
    from: number,
    bytes: number,
  ): Promise<BesidePiece | null> {
    try {
      const handle = await open(path, 'r')
      try {
        const { size } = await handle.stat()
        const at = from <= size ? from : 0
        const buffer = Buffer.alloc(Math.min(bytes, size - at))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, at)
        return {
          name,
          from: at,
          data: buffer.subarray(0, bytesRead).toString('base64'),
          done: at + bytesRead >= size,
        }
      } finally {
        await handle.close()
      }
    } catch (err) {
      this.warnOnce(
        name,
        `${name} beside the conversation could not be read to send: ${String(err)}`,
      )
      return null
    }
  }

  /** A piece of a file into a copy's folder: appended where it follows, begun again from its start, else dropped. */
  private async takeFile(copy: Copy, piece: BesidePiece): Promise<void> {
    const path = join(copy.dir, piece.name)
    const part = `${path}.part`
    if (piece.from !== 0 && piece.from !== ((await sizeOf(part)) ?? 0)) return
    const data = Buffer.from(piece.data, 'base64')
    // A file whose last piece never comes grows a `.part` for ever: all of it
    // is counted against the room every machine's gifts share here.
    if (!(await this.room.fits(data.length, Date.now()))) {
      this.warnOnce(
        `room ${piece.name}`,
        `${piece.name} from ${copy.name} was not taken: ${this.room.says()}`,
      )
      // Not asked for again while this window runs, or the exchange asks for
      // it every round for ever; the next one to open asks once more.
      copy.gone.add(piece.name)
      await rm(part, { force: true })
      return
    }
    await mkdir(dirname(part), { recursive: true })
    if (piece.from === 0) await writeFile(part, data, { mode: 0o600 })
    else await appendFile(part, data, { mode: 0o600 })
    this.room.spent(data.length)
    if (!piece.done) return
    await rename(part, path)
    copy.have.add(piece.name)
  }

  /** A copy's files beside this record, where the entries taken in from it name them. Never throws. */
  private async place(copy: Copy): Promise<void> {
    if (!this.beside) return
    for (const name of copy.have) {
      if (this.placed.has(name)) continue
      const to = join(this.beside, name)
      try {
        if ((await sizeOf(to)) === null) {
          await mkdir(dirname(to), { recursive: true })
          // A clone where the disk can make one, so the two cost the space once.
          await copyFile(join(copy.dir, name), to, constants.COPYFILE_FICLONE)
        }
        this.placed.add(name)
      } catch (err) {
        this.warnOnce(
          name,
          `${name} from ${copy.name} could not be put beside the conversation: ${String(err)}`,
        )
      }
    }
  }

  private warnOnce(name: string, text: string): void {
    if (this.warned.has(name)) return
    this.warned.add(name)
    this.opts.warn?.(text)
  }

  // ── Settling ──────────────────────────────────────────────────────────────

  /**
   * Make every copy part of this machine's own record: adopt one that holds
   * all of it and more, and merge one that forked from it — the second only
   * where `merging` says the caller holds the lease. Appends through `take`;
   * the harness reading it again is the caller's, between turns.
   */
  settle(merging: boolean): Promise<Settled[]> {
    return this.serially(() => this.settleNow(merging))
  }

  private async settleNow(merging: boolean): Promise<Settled[]> {
    const out: Settled[] = []
    for (const copy of this.copies.values()) {
      await this.own.look()
      await copy.record.look()
      out.push(await this.settleOne(copy, merging))
      await this.place(copy)
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

/** A file's size, or null where there is none. */
async function sizeOf(path: string): Promise<number | null> {
  const found = await stat(path).catch(ifMissing(null))
  return found?.isFile() ? found.size : null
}

/** What a machine calls itself, beside its copy, so a hub that restarts names it. */
async function writeName(home: string, machine: MachineNamed): Promise<void> {
  const path = join(feedDir(home, machine.id), 'conversation.name')
  if ((await readFile(path, 'utf8').catch(ifMissing(null))) === machine.name) return
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, machine.name, { mode: 0o600 })
}
