import { createReadStream } from 'node:fs'
import {
  appendFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  CHAIN_HASH,
  CHAIN_START,
  chainNext,
  type Epoch,
  type EventFilter,
  type FeedSummary,
  type FleetEvent,
  feedDir,
  isEpoch,
  laterEpoch,
  MACHINE_ID,
  matchesFilter,
  PeerRoom,
  printable,
  type SyncState,
  type SyncSummary,
  type TadeEvent,
  travels,
  typeNow,
} from '@tade/core'
import { type Answer, LinkError, SIGNED_OUT } from '@tade/remotes-core'
import { ifMissing } from './machine-file.ts'

// Every machine's journal on every machine of the person's (`@tade/core`'s
// `feeds.ts` holds the rules): this machine's own served from its
// `events.jsonl`, and a copy of each other machine's kept under
// `<home>/machines/<id>/`, each with the hash chain over its lines.
//
// **One exchange, both ways, asked by the machine that holds the link**, as
// notes are (`notes-shared.ts`): the window that dials gives what the far side
// lacks and takes what it lacks, over the far side's own door (`POST
// /api/feeds/share`). It opens with each side's summary — per feed, `(epoch,
// seq, h)` — and where those agree, which is nearly always, that one request
// is all of it. Otherwise rounds follow: lines after the other's cursor, as
// many as fit a request (`GIVE_BYTES`, the far side reads 64 KB) or an answer
// (`ANSWER_BYTES`), and a line too long for one request given in pieces.
//
// **Relaying is what the exchange does anyway.** Every copy held here is
// offered as well as this machine's own journal, so a laptop that dials the
// hub takes the other laptop's journal from the hub's copy, and lines are
// verified by the chain whoever handed them over. Only the origin is believed
// over a copy that disagrees: two relays that hold different histories of a
// third machine both keep their own and say so, and the origin's own word, the
// next time it is heard, settles which goes on.
//
// **Nothing is thrown away.** A copy that stops agreeing — a new epoch, or the
// same numbers with another history — is set aside whole beside the new one,
// `<id>.<epoch>.jsonl`, and said (`feed_forked`).

/** What one request may give, in bytes of lines: the far side reads no more than 64 KB of body. */
export const GIVE_BYTES = 48 * 1024

/** What one answer gives, in bytes of lines, before it leaves the rest for the next round. */
export const ANSWER_BYTES = 1024 * 1024

/** The longest line a feed may carry: a line longer than this stops that feed here, and is said. */
export const LINE_MOST = 4 * 1024 * 1024

/** The most rounds one exchange takes before it leaves the rest for the next. */
const ROUNDS_MOST = 64

/** How long a line given in pieces waits for its next piece before it is let go. */
const PIECE_WAITS_MS = 5 * 60_000

/** Who a machine is, as an exchange names it. */
export interface MachineNamed {
  id: string
  /** What it calls itself (`machineLabel`). */
  name: string
}

// ── One file of lines, and the chain over them ────────────────────────────────

/**
 * The start of a journal line as `EventLog` writes it, which is enough to know
 * its number and kind without parsing the rest — a journal of a quarter of a
 * million lines is read through once when a window opens, and on the thread
 * that draws.
 */
const LINE_HEAD = /^\{"seq":(\d+),"ts":"(?:[^"\\]|\\.)*","type":"([a-z_]+)"/

/** A line's number and kind, or null for a line that is not one. */
function headOf(line: string): { seq: number; type: string } | null {
  const found = LINE_HEAD.exec(line)
  if (found !== null) return { seq: Number(found[1]), type: found[2] ?? '' }
  try {
    const parsed = JSON.parse(line) as Partial<TadeEvent>
    if (typeof parsed.seq !== 'number' || !Number.isSafeInteger(parsed.seq)) return null
    if (typeof parsed.type !== 'string') return null
    return { seq: parsed.seq, type: parsed.type }
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  }
}

/** How much of a file one read takes, so a big journal is read in pieces and the window draws between. */
const READ_CHUNK = 1024 * 1024

/**
 * One file of journal lines, and the chain over the ones that travel: this
 * machine's own `events.jsonl`, whose other lines are passed over, or a copy,
 * every line of which travels. Each line held is a number, where it is in the
 * file, and the chain at it — never the line itself, which is read back from
 * the file when it is given.
 */
export class FeedFile {
  readonly path: string
  private readonly all: boolean
  private seqs: number[] = []
  private offs: number[] = []
  private lens: number[] = []
  private hashes: string[] = []
  private readTo = 0
  private h = CHAIN_START
  private reading: Promise<void> | null = null

  constructor(path: string, all: boolean) {
    this.path = path
    this.all = all
  }

  /** The highest number held, nought for none. */
  get seq(): number {
    return this.seqs.at(-1) ?? 0
  }

  /** How many lines are held. */
  get n(): number {
    return this.seqs.length
  }

  /** The chain at the last line held. */
  get chain(): string {
    return this.h
  }

  /** The chain at line `seq`, or null where no line held is that number. Nought is where every chain begins. */
  hAt(seq: number): string | null {
    if (seq === 0) return CHAIN_START
    const i = this.indexOf(seq)
    return i >= 0 && this.seqs[i] === seq ? (this.hashes[i] ?? null) : null
  }

  /** The first index whose number is at least `seq`. */
  private indexOf(seq: number): number {
    let lo = 0
    let hi = this.seqs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((this.seqs[mid] ?? 0) < seq) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /**
   * Read what was written since the last read: a `stat` where nothing was. A
   * file shorter than what was read was rewritten, and is read again from the
   * start. One read at a time; a second caller waits for the first.
   */
  catchUp(): Promise<void> {
    if (this.reading === null) {
      this.reading = this.read().finally(() => {
        this.reading = null
      })
    }
    return this.reading
  }

  private async read(): Promise<void> {
    const size = (await stat(this.path).catch(ifMissing(null)))?.size ?? 0
    if (size < this.readTo) this.reset()
    if (size === this.readTo) return
    const handle = await open(this.path, 'r').catch(ifMissing(null))
    if (handle === null) return
    try {
      let at = this.readTo
      let carry = Buffer.alloc(0)
      while (at < size) {
        const want = Math.min(READ_CHUNK, size - at)
        const chunk = Buffer.alloc(want)
        const { bytesRead } = await handle.read(chunk, 0, want, at)
        if (bytesRead === 0) break
        const buf =
          carry.length > 0
            ? Buffer.concat([carry, chunk.subarray(0, bytesRead)])
            : chunk.subarray(0, bytesRead)
        const base = at - carry.length
        let start = 0
        for (let nl = buf.indexOf(0x0a, start); nl >= 0; nl = buf.indexOf(0x0a, start)) {
          this.take(buf.toString('utf8', start, nl), base + start, nl - start)
          start = nl + 1
        }
        carry = Buffer.from(buf.subarray(start))
        at += bytesRead
        // A line still waiting for its newline is read again next time.
        this.readTo = at - carry.length
      }
    } finally {
      await handle.close()
    }
  }

  /** One whole line read from the file, held where it travels. */
  private take(line: string, off: number, len: number): void {
    if (line.trim() === '') return
    const head = headOf(line)
    if (head === null || head.seq <= this.seq) return
    if (!this.all && !travels(head.type)) return
    this.h = chainNext(this.h, line)
    this.seqs.push(head.seq)
    this.offs.push(off)
    this.lens.push(len)
    this.hashes.push(this.h)
  }

  private reset(): void {
    this.seqs = []
    this.offs = []
    this.lens = []
    this.hashes = []
    this.readTo = 0
    this.h = CHAIN_START
  }

  /**
   * The lines after `seq`, as many as fit `bytes` and always the first, read
   * back from the file exactly as they were written — and whether more follow.
   */
  async linesAfter(seq: number, bytes: number): Promise<{ lines: string[]; more: boolean }> {
    const from = this.indexOf(seq + 1)
    let to = from
    let used = 0
    while (to < this.seqs.length) {
      const len = this.lens[to] ?? 0
      if (to > from && used + len > bytes) break
      used += len
      to++
    }
    if (to === from) return { lines: [], more: false }
    const lines = await this.readLines(from, to)
    return { lines, more: to < this.seqs.length }
  }

  private async readLines(from: number, to: number): Promise<string[]> {
    const handle = await open(this.path, 'r')
    try {
      const out: string[] = []
      for (let i = from; i < to; i++) {
        const len = this.lens[i] ?? 0
        const buf = Buffer.alloc(len)
        await handle.read(buf, 0, len, this.offs[i] ?? 0)
        out.push(buf.toString('utf8'))
      }
      return out
    } finally {
      await handle.close()
    }
  }

  /** Lines verified elsewhere, appended to this copy: each with its number and its chain. */
  async append(lines: readonly { line: string; seq: number; h: string }[]): Promise<void> {
    if (lines.length === 0) return
    await this.catchUp()
    const text = `${lines.map((one) => one.line).join('\n')}\n`
    await appendFile(this.path, text, { mode: 0o600 })
    let off = this.readTo
    for (const one of lines) {
      const len = Buffer.byteLength(one.line)
      this.seqs.push(one.seq)
      this.offs.push(off)
      this.lens.push(len)
      this.hashes.push(one.h)
      this.h = one.h
      off += len + 1
    }
    this.readTo = off
  }
}

// ── A copy of another machine's journal ──────────────────────────────────────

/** What `feed.json` says of a copy. */
export interface CopyMeta {
  machine: string
  name: string
  epoch: Epoch
  /** Each copy set aside, oldest first: where it is kept, and why. */
  forks: { epoch: string; kept: string; why: 'chain' | 'epoch'; at: string }[]
}

interface Copy {
  meta: CopyMeta
  file: FeedFile
}

/** A copy set aside, for the line that says so. */
export interface Forked {
  machine: string
  name: string
  epoch: string
  /** Where the old copy is kept, or null where the copy here was kept and the other history refused. */
  kept: string | null
  why: 'chain' | 'epoch'
  /** Who handed the other history. */
  from: string
}

async function readMeta(dir: string): Promise<CopyMeta | null> {
  const parsed = jsonOf<Partial<CopyMeta>>(
    await readFile(join(dir, 'feed.json'), 'utf8').catch(ifMissing(null)),
  )
  if (parsed === null || typeof parsed.machine !== 'string' || !MACHINE_ID.test(parsed.machine)) {
    return null
  }
  if (typeof parsed.name !== 'string' || !isEpoch(parsed.epoch)) return null
  return {
    machine: parsed.machine,
    name: printable(parsed.name).slice(0, 60),
    epoch: parsed.epoch,
    forks: Array.isArray(parsed.forks) ? parsed.forks : [],
  }
}

/** A file's JSON, or null for none or for text that is not JSON — which a copy can be, edited by hand. */
function jsonOf<T>(text: string | null): T | null {
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  }
}

async function writeMeta(dir: string, meta: CopyMeta): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `feed.json.${process.pid}.writing`)
  await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`)
  await rename(tmp, join(dir, 'feed.json'))
}

// ── What travels ────────────────────────────────────────────────────────────

/**
 * Lines of one feed, given: after which number of which life, with the chain
 * there, and either whole lines or one piece of a line too long for a request.
 */
export interface Given {
  machine: string
  name: string
  epoch: Epoch
  after: number
  h: string
  lines: string[]
  /** A piece of the line after these, from character `from`: `done` is its last piece. */
  piece?: { text: string; from: number; done: boolean }
  /** On an answer: more lines follow these. */
  more?: boolean
}

/** Lines of one feed asked for: after which number of which life, with the chain there. */
export interface Want {
  machine: string
  epoch: Epoch
  after: number
  h: string
}

/** What one request asks. `have` opens an exchange or closes it. */
export interface FeedsAsk {
  from: MachineNamed
  have?: FeedSummary[]
  /** Beside `have`: the notes' sum and the kept settings, for the state hash. */
  sync?: Omit<SyncSummary, 'feeds'>
  /** The last request of an exchange: the far side writes down where the two stand. */
  close?: boolean
  /**
   * Beside `close`: what the asker calls the far side (`remotes.<name>` there),
   * kept with where the two stand — how a wait written there names it.
   */
  calls?: string
  give: Given[]
  want: Want[]
}

/** What became of one feed given. */
export interface Took {
  machine: string
  /** Lines taken. */
  lines: number
  /** Where the copy there stands now, where it took or held any. */
  seq?: number
  h?: string
  /** Not taken, and why: `from the start` asks for the feed again from line one. */
  refused?: string
  /** A piece of a line held there, waiting for the rest. */
  pieces?: number
}

/** What the far side answers each request. */
export interface FeedsAnswer {
  machine: MachineNamed
  have?: FeedSummary[]
  sync?: Omit<SyncSummary, 'feeds'>
  lines: Given[]
  took: Took[]
  /** Where the two stand, as the far side wrote it down, on a closing request. */
  state?: SyncState
}

/** What a new copy costs before its first line, as `PeerRoom` counts it: its folder's `feed.json`. */
const COPY_BYTES = 1024

/** A refusal that means: give it again from line one. */
const FROM_START = 'from the start'

// ── The store ──────────────────────────────────────────────────────────────

/** Every feed this home holds: its own journal's, and a copy of each other machine's. */
export class Feeds {
  readonly home: string
  readonly me: MachineNamed & { epoch: Epoch }
  readonly own: FeedFile
  private readonly copies = new Map<string, Copy>()
  /** Lines given in pieces, waiting for the rest, by who gave them and where. */
  private readonly pieces = new Map<string, { text: string; at: number }>()
  private queue: Promise<unknown> = Promise.resolve()
  /**
   * How much more of what other machines give fits on this disk, all of it
   * together (`@tade/core`'s `peer-disk.ts`): copies set aside by forks, and
   * machines nobody here has heard of, count as much as any.
   */
  private readonly room: PeerRoom

  private constructor(home: string, me: MachineNamed & { epoch: Epoch }, room: PeerRoom) {
    this.home = home
    this.me = me
    this.own = new FeedFile(join(home, 'events.jsonl'), false)
    this.room = room
  }

  /** Every feed under a home, read; this machine's own journal too, which may take a moment where it is big. */
  static async open(
    home: string,
    me: MachineNamed & { epoch: Epoch },
    opts: { room?: PeerRoom } = {},
  ): Promise<Feeds> {
    const feeds = new Feeds(home, me, opts.room ?? new PeerRoom(home))
    const entries = await readdir(join(home, 'machines'), { withFileTypes: true }).catch(
      ifMissing([]),
    )
    for (const entry of entries) {
      if (!entry.isDirectory() || !MACHINE_ID.test(entry.name) || entry.name === me.id) continue
      const dir = join(home, 'machines', entry.name)
      const meta = await readMeta(dir)
      if (meta === null || meta.machine !== entry.name) continue
      const file = new FeedFile(join(dir, 'events.jsonl'), true)
      await file.catchUp()
      feeds.copies.set(meta.machine, { meta, file })
    }
    await feeds.own.catchUp()
    return feeds
  }

  /** One thing at a time changes a copy, so two exchanges never append to one file at once. */
  private alone<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => {})
    return run
  }

  /** Each feed held, summarised: this machine's own read up to now. */
  async summaries(): Promise<FeedSummary[]> {
    await this.own.catchUp()
    const own: FeedSummary = {
      machine: this.me.id,
      name: this.me.name,
      epoch: this.me.epoch,
      seq: this.own.seq,
      n: this.own.n,
      h: this.own.chain,
    }
    return [
      own,
      ...[...this.copies.values()].map((one) => ({
        machine: one.meta.machine,
        name: one.meta.name,
        epoch: one.meta.epoch,
        seq: one.file.seq,
        n: one.file.n,
        h: one.file.chain,
      })),
    ]
  }

  /** The chain at one number of one feed held here, or null. */
  hAt(machine: string, seq: number): string | null {
    return this.feedOf(machine)?.file.hAt(seq) ?? null
  }

  /** The life of one feed held here, or null for one this home has none of. */
  epochOf(machine: string): Epoch | null {
    return this.feedOf(machine)?.epoch ?? null
  }

  /** The feed of one machine as held here, or null for one this home has none of. */
  private feedOf(machine: string): { file: FeedFile; epoch: Epoch; name: string } | null {
    if (machine === this.me.id) return { file: this.own, epoch: this.me.epoch, name: this.me.name }
    const copy = this.copies.get(machine)
    return copy === undefined
      ? null
      : { file: copy.file, epoch: copy.meta.epoch, name: copy.meta.name }
  }

  /**
   * What was asked for, given: the lines after the asker's cursor where the
   * chain there is this one's, and from the start where it is not — the
   * asker's own take then finds the fork. Null for a feed held nowhere here.
   */
  async give(want: Want, bytes: number): Promise<Given | null> {
    const feed = this.feedOf(want.machine)
    if (feed === null) return null
    await feed.file.catchUp()
    const same = want.epoch.id === feed.epoch.id
    const after = same && feed.file.hAt(want.after) === want.h ? want.after : 0
    const { lines, more } = await feed.file.linesAfter(after, bytes)
    return {
      machine: want.machine,
      name: feed.name,
      epoch: feed.epoch,
      after,
      h: after === 0 ? CHAIN_START : want.h,
      lines,
      ...(more ? { more } : {}),
    }
  }

  /**
   * Lines of another machine's journal, handed over by `giver`, taken into the
   * copy here where they go on from it: each checked to be a line of a kind
   * that travels, numbered after the last, and chained onto the copy. Two
   * histories of one machine are a fork, kept and said (`Forked`).
   */
  take(
    given: Given,
    giver: MachineNamed,
    now: number,
  ): Promise<{ took: Took; forked: Forked | null }> {
    return this.alone(() => this.takeNow(given, giver, now))
  }

  private async takeNow(
    given: Given,
    giver: MachineNamed,
    now: number,
  ): Promise<{ took: Took; forked: Forked | null }> {
    const no = (refused: string): { took: Took; forked: Forked | null } => ({
      took: { machine: given.machine, lines: 0, refused },
      forked: null,
    })
    if (given.machine === this.me.id) return no('this machine’s own journal is its own')
    if (!MACHINE_ID.test(given.machine) || !isEpoch(given.epoch) || !CHAIN_HASH.test(given.h)) {
      return no('not a feed')
    }
    const origin = giver.id === given.machine
    let copy = this.copies.get(given.machine)
    let forked: Forked | null = null
    if (copy !== undefined && laterEpoch(given.epoch, copy.meta.epoch) < 0) {
      return no(`an earlier life of ${copy.meta.name}’s journal than the one held here`)
    }
    if (copy === undefined || laterEpoch(given.epoch, copy.meta.epoch) > 0) {
      if (given.after !== 0) return no(FROM_START)
      // A new copy is a folder and its `feed.json` before any line: a machine
      // id made up per beat would be a folder per beat, so it asks for room too.
      if (!(await this.room.fits(COPY_BYTES, now))) return no(this.room.says())
      if (copy !== undefined) forked = await this.setAside(copy, 'epoch', giver, now)
      copy = await this.begin(given, copy?.meta.forks ?? [])
    } else if (copy.file.hAt(given.after) !== given.h && given.after <= copy.file.seq) {
      // The giver's history at its cursor is not this copy's.
      if (!origin) return this.refusedFork(copy, given, giver)
      if (given.after !== 0) return no(FROM_START)
      forked = await this.setAside(copy, 'chain', giver, now)
      copy = await this.begin(given, copy.meta.forks)
    } else if (given.after > copy.file.seq) {
      return no(FROM_START)
    }
    if (origin && given.name !== copy.meta.name && given.name.trim() !== '') {
      copy.meta = { ...copy.meta, name: printable(given.name).slice(0, 60) }
      await writeMeta(feedDir(this.home, given.machine), copy.meta)
    }
    const whole = [...given.lines]
    let pieces: number | undefined
    if (given.piece !== undefined) {
      const done = this.piece(given, giver, copy, now)
      if (typeof done === 'string') whole.push(done)
      else if (done === null) return no(FROM_START)
      else pieces = done
    }
    // Walk the lines from the giver's cursor: those this copy already holds
    // must chain to what it holds, and the rest go on from its end.
    let h = given.h
    let last = given.after
    const fresh: { line: string; seq: number; h: string }[] = []
    for (const line of whole) {
      const head = headOf(line)
      if (head === null || head.seq <= last || !travels(head.type) || line.length > LINE_MOST) {
        break
      }
      h = chainNext(h, line)
      last = head.seq
      if (head.seq <= copy.file.seq) {
        if (copy.file.hAt(head.seq) === h) continue
        if (!origin) return this.refusedFork(copy, given, giver)
        // The origin's own history differs from the copy's: the copy goes
        // aside, and what was given is taken into a new one from nothing.
        const fork = await this.setAside(copy, 'chain', giver, now)
        await this.begin(given, copy.meta.forks)
        const again = await this.takeNow(given, giver, now)
        return { took: again.took, forked: fork }
      }
      fresh.push({ line, seq: head.seq, h })
    }
    const bytes = fresh.reduce((sum, one) => sum + Buffer.byteLength(one.line) + 1, 0)
    if (bytes > 0 && !(await this.room.fits(bytes, now))) return no(this.room.says())
    await copy.file.append(fresh)
    this.room.spent(bytes)
    return {
      took: {
        machine: given.machine,
        lines: fresh.length,
        seq: copy.file.seq,
        h: copy.file.chain,
        ...(pieces === undefined ? {} : { pieces }),
      },
      forked,
    }
  }

  /**
   * One piece of a line too long for a request, held until its last: the whole
   * line where this was it, how much is held where it was not, and null where
   * the piece does not follow what is held — the giver starts the line again.
   */
  private piece(
    given: Given,
    giver: MachineNamed,
    copy: Copy,
    now: number,
  ): string | number | null {
    const piece = given.piece
    if (piece === undefined) return 0
    for (const [key, held] of this.pieces)
      if (now - held.at > PIECE_WAITS_MS) this.pieces.delete(key)
    // Where the line goes: after every whole line given with it, which the
    // giver sends none of beside a piece.
    if (given.lines.length > 0 || given.after !== copy.file.seq) return null
    const key = `${giver.id}\n${given.machine}\n${given.epoch.id}\n${given.after}`
    const held = this.pieces.get(key)?.text ?? ''
    if (piece.from !== held.length) {
      this.pieces.delete(key)
      return null
    }
    const text = held + piece.text
    if (text.length > LINE_MOST) {
      this.pieces.delete(key)
      return null
    }
    if (piece.done) {
      this.pieces.delete(key)
      return text
    }
    this.pieces.set(key, { text, at: now })
    return text.length
  }

  /** A relay's history of a machine that disagrees with the copy here: the copy kept, and the other said. */
  private refusedFork(
    copy: Copy,
    given: Given,
    giver: MachineNamed,
  ): { took: Took; forked: Forked } {
    return {
      took: {
        machine: given.machine,
        lines: 0,
        refused: `${giver.name} holds a different history of ${copy.meta.name}’s journal than this machine: both are kept until ${copy.meta.name} itself is heard`,
      },
      forked: {
        machine: copy.meta.machine,
        name: copy.meta.name,
        epoch: copy.meta.epoch.id,
        kept: null,
        why: 'chain',
        from: giver.name,
      },
    }
  }

  /** A new copy of one machine's journal, for the life `given` is of. */
  private async begin(given: Given, forks: CopyMeta['forks']): Promise<Copy> {
    this.room.spent(COPY_BYTES)
    const dir = feedDir(this.home, given.machine)
    await mkdir(dir, { recursive: true })
    const meta: CopyMeta = {
      machine: given.machine,
      name: printable(given.name).slice(0, 60) || given.machine.slice(0, 8),
      epoch: given.epoch,
      forks,
    }
    await writeFile(join(dir, 'events.jsonl'), '', { mode: 0o600 })
    await writeMeta(dir, meta)
    const copy = { meta, file: new FeedFile(join(dir, 'events.jsonl'), true) }
    this.copies.set(given.machine, copy)
    return copy
  }

  /** A copy set aside whole, beside where the next one begins: `<id>.<epoch>.jsonl`, numbered where that is taken. */
  private async setAside(
    copy: Copy,
    why: 'chain' | 'epoch',
    giver: MachineNamed,
    now: number,
  ): Promise<Forked> {
    const dir = feedDir(this.home, copy.meta.machine)
    let kept = join(dir, `${copy.meta.machine}.${copy.meta.epoch.id}.jsonl`)
    for (let n = 2; await stat(kept).then(() => true, ifMissing(false)); n++) {
      kept = join(dir, `${copy.meta.machine}.${copy.meta.epoch.id}.${n}.jsonl`)
    }
    await rename(copy.file.path, kept).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') throw err
    })
    copy.meta = {
      ...copy.meta,
      forks: [
        ...copy.meta.forks,
        { epoch: copy.meta.epoch.id, kept, why, at: new Date(now).toISOString() },
      ],
    }
    return {
      machine: copy.meta.machine,
      name: copy.meta.name,
      epoch: copy.meta.epoch.id,
      kept,
      why,
      from: giver.name,
    }
  }

  /** Where this machine and another last stood, kept beside that machine's copy for `tade machines`. */
  async keepSync(peer: MachineNamed, kept: KeptSync): Promise<void> {
    if (!MACHINE_ID.test(peer.id) || peer.id === this.me.id) return
    const dir = feedDir(this.home, peer.id)
    await mkdir(dir, { recursive: true })
    const was =
      kept.calls === undefined
        ? jsonOf<KeptSync>(await readFile(join(dir, 'sync.json'), 'utf8').catch(ifMissing(null)))
        : null
    const calls = typeof was?.calls === 'string' ? { calls: was.calls } : {}
    const tmp = join(dir, `sync.json.${process.pid}.writing`)
    await writeFile(tmp, `${JSON.stringify({ ...kept, ...calls }, null, 2)}\n`)
    await rename(tmp, join(dir, 'sync.json'))
  }
}

/** Where this machine and another stood, as `sync.json` keeps it. */
export interface KeptSync {
  id: string
  name: string
  /** Its name here (`remotes.<name>`), for a machine this one links to. */
  called?: string
  /**
   * What it calls this machine (`remotes.<name>` there), for a machine that
   * links to this one: how its waits name this one. Kept through an exchange
   * this machine dials, which does not say it.
   */
  calls?: string
  /**
   * What its link paired as, for a machine that links to this one: the name
   * its `machine_seen` lines carry, which need not be what it calls itself.
   */
  label?: string
  /** `to`: this machine dialled it. `from`: it dialled this one. */
  way: 'to' | 'from'
  state: SyncState
}

// ── The far half ────────────────────────────────────────────────────────────

/**
 * The far half, answered on the remote's own door: take what was given, then
 * answer what was asked for, and — opened or closed with a summary — this
 * side's own. `extras` is the notes' sum and the kept settings, asked only
 * where a summary is.
 */
export async function answerFeeds(
  feeds: Feeds,
  ask: FeedsAsk,
  opts: {
    extras: () => Promise<Omit<SyncSummary, 'feeds'>>
    now: number
    /** Written down here: a fork found, and where the two stand on a closing request. */
    forked?: (fork: Forked) => Promise<void>
    synced?: (
      peer: MachineNamed,
      here: SyncSummary,
      there: SyncSummary,
      calls: string | undefined,
    ) => Promise<SyncState | null>
  },
): Promise<FeedsAnswer> {
  const took: Took[] = []
  for (const given of ask.give) {
    const done = await feeds.take(given, ask.from, opts.now)
    took.push(done.took)
    if (done.forked !== null) await opts.forked?.(done.forked)
  }
  const lines: Given[] = []
  let bytes = 0
  for (const want of ask.want) {
    if (bytes >= ANSWER_BYTES) break
    const given = await feeds.give(want, ANSWER_BYTES - bytes)
    if (given === null) continue
    bytes += given.lines.reduce((sum, line) => sum + line.length, 0)
    lines.push(given)
  }
  const machine = { id: feeds.me.id, name: feeds.me.name }
  if (ask.have === undefined) return { machine, lines, took }
  const have = await feeds.summaries()
  const sync = await opts.extras()
  let state: SyncState | null = null
  if (ask.close === true && ask.sync !== undefined) {
    state =
      (await opts.synced?.(
        ask.from,
        { feeds: have, ...sync },
        { feeds: ask.have, ...ask.sync },
        ask.calls,
      )) ?? null
  }
  return { machine, have, sync, lines, took, ...(state === null ? {} : { state }) }
}

// ── The near half ───────────────────────────────────────────────────────────

/** What one exchange came to, from the side that asked. */
export interface FeedsShared {
  there: MachineNamed
  /** Lines taken here, and given there. */
  took: number
  gave: number
  forks: Forked[]
  /** Feeds the far side would not take, and why — a fork, a line too long. */
  refused: string[]
  /** Lines left for the next exchange. */
  left: number
  here: SyncSummary
  thereSummary: SyncSummary
}

/**
 * A remote that answered and would not share its journal — an older Tade, an
 * answer that is not one — as against one that could not be reached, which is
 * its link's to say.
 */
export class FeedsRefused extends LinkError {}

/** One feed being given: from where, on to the far side's cursor. */
interface Giving {
  machine: string
  after: number
  h: string
  /** Characters of the next line already given in pieces. */
  piece: number
}

/**
 * The near half, run by the window that holds the link: the summaries, the
 * rounds, then a closing summary each way, which is what the far side writes
 * down where the two stand from. `call` is one request to the far side's door;
 * it throws where the link could not make one.
 */
export async function shareFeeds(
  feeds: Feeds,
  call: (ask: FeedsAsk) => Promise<Answer>,
  opts: {
    name: string
    extras: () => Promise<Omit<SyncSummary, 'feeds'>>
    now?: () => number
  },
): Promise<FeedsShared> {
  const now = opts.now ?? Date.now
  const from = { id: feeds.me.id, name: feeds.me.name }
  const ask = async (body: FeedsAsk) => answerOf(await call(body), opts.name)
  const here = await feeds.summaries()
  const first = await ask({ from, have: here, sync: await opts.extras(), give: [], want: [] })
  if (first.have === undefined) {
    throw new FeedsRefused('failed', `${opts.name} did not say which journals it holds`)
  }
  const there = first.machine
  const out: FeedsShared = {
    there,
    took: 0,
    gave: 0,
    forks: [],
    refused: [],
    left: 0,
    here: { feeds: here, ...(await opts.extras()) },
    thereSummary: { feeds: first.have, ...(first.sync ?? { notes: '', settings: {}, pinned: [] }) },
  }
  const mine = new Map(here.map((one) => [one.machine, one]))
  const theirs = new Map(first.have.map((one) => [one.machine, one]))
  let giving: Giving[] = []
  let wanting: Want[] = []
  for (const id of new Set([...mine.keys(), ...theirs.keys()])) {
    const m = mine.get(id)
    const t = theirs.get(id)
    const fromZero = { machine: id, after: 0, h: CHAIN_START, piece: 0 }
    // The far side's own journal is never given to it, and this one's never taken.
    if (t !== undefined && id !== feeds.me.id) {
      if (m === undefined || laterEpoch(t.epoch, m.epoch) > 0) {
        wanting.push({ machine: id, epoch: t.epoch, after: 0, h: CHAIN_START })
      } else if (laterEpoch(t.epoch, m.epoch) === 0) {
        if (t.seq > m.seq) wanting.push({ machine: id, epoch: t.epoch, after: m.seq, h: m.h })
        else if (t.seq === m.seq && t.h !== m.h) {
          wanting.push({ machine: id, epoch: t.epoch, after: 0, h: CHAIN_START })
        }
      }
    }
    if (m !== undefined && id !== there.id) {
      if (t === undefined || laterEpoch(m.epoch, t.epoch) > 0) giving.push(fromZero)
      else if (
        laterEpoch(m.epoch, t.epoch) === 0 &&
        m.seq >= t.seq &&
        (m.seq > t.seq || m.h !== t.h)
      ) {
        const at = feeds.hAt(id, t.seq)
        giving.push(
          at === t.h && m.seq > t.seq ? { machine: id, after: t.seq, h: t.h, piece: 0 } : fromZero,
        )
      }
    }
  }
  for (let round = 0; round < ROUNDS_MOST && (giving.length > 0 || wanting.length > 0); round++) {
    const give = await givePage(feeds, giving)
    const answer = await ask({ from, give: give.map((one) => one.given), want: wanting })
    // What the far side took, and where each copy there stands now.
    const next: Giving[] = []
    for (const one of giving) {
      const sent = give.find((each) => each.given.machine === one.machine)
      if (sent === undefined) {
        next.push(one)
        continue
      }
      const took = answer.took.find((each) => each.machine === one.machine)
      out.gave += took?.lines ?? 0
      if (took?.refused === FROM_START) {
        if (one.after !== 0 || one.piece !== 0)
          next.push({ ...one, after: 0, h: CHAIN_START, piece: 0 })
        else
          out.refused.push(
            `${opts.name} would not take ${nameOf(here, one.machine)}’s journal from the start`,
          )
      } else if (took?.refused !== undefined) {
        out.refused.push(took.refused)
      } else if (took !== undefined) {
        const piece = sent.given.piece
        const advanced =
          piece !== undefined && !piece.done
            ? { ...one, piece: took.pieces ?? one.piece + piece.text.length }
            : { ...one, after: took.seq ?? one.after, h: took.h ?? one.h, piece: 0 }
        if (sent.more || (piece !== undefined && !piece.done)) next.push(advanced)
      }
    }
    giving = next
    // What came back for what was asked, taken here.
    const still: Want[] = []
    for (const want of wanting) {
      const given = answer.lines.find((each) => each.machine === want.machine)
      if (given === undefined) {
        // Not answered this round because the answer was full: asked again.
        if (answer.lines.length > 0) still.push(want)
        continue
      }
      const done = await feeds.take(given, there, now())
      out.took += done.took.lines
      if (done.forked !== null) out.forks.push(done.forked)
      if (done.took.refused === FROM_START) {
        if (want.after !== 0) still.push({ ...want, after: 0, h: CHAIN_START })
      } else if (done.took.refused !== undefined) {
        out.refused.push(done.took.refused)
      } else if (given.more === true && done.took.lines > 0) {
        still.push({
          ...want,
          epoch: given.epoch,
          after: done.took.seq ?? want.after,
          h: done.took.h ?? want.h,
        })
      }
    }
    wanting = still
    if (give.length === 0 && answer.lines.length === 0) break
  }
  out.left = giving.length + wanting.length
  // The closing summaries: where both now stand, written down on both sides.
  const hereNow = await feeds.summaries()
  const extras = await opts.extras()
  const closing = await ask({
    from,
    have: hereNow,
    sync: extras,
    close: true,
    calls: opts.name,
    give: [],
    want: [],
  })
  out.here = { feeds: hereNow, ...extras }
  if (closing.have !== undefined) {
    out.thereSummary = { feeds: closing.have, ...(closing.sync ?? out.thereSummary) }
  }
  return out
}

function nameOf(summaries: readonly FeedSummary[], machine: string): string {
  return summaries.find((one) => one.machine === machine)?.name ?? machine.slice(0, 8)
}

/** One request's worth of what is being given: whole lines, or a piece of one too long for a request. */
async function givePage(
  feeds: Feeds,
  giving: readonly Giving[],
): Promise<{ given: Given; more: boolean }[]> {
  const out: { given: Given; more: boolean }[] = []
  let room = GIVE_BYTES
  for (const one of giving) {
    if (room <= 1024) break
    const epoch = feeds.epochOf(one.machine)
    if (epoch === null) continue
    const given = await feeds.give(
      { machine: one.machine, epoch, after: one.after, h: one.h },
      room,
    )
    if (given === null) continue
    const first = given.lines[0]
    // Every line is quoted once more in the body.
    const cost = (line: string) => JSON.stringify(line).length + 8
    if (first !== undefined && cost(first) > room) {
      // Too long for what is left of this request: a piece of it, alone, or the next request.
      if (out.length > 0) break
      if (first.length > LINE_MOST) continue
      const take = Math.floor((room - 512) / 2)
      const text = first.slice(one.piece, one.piece + take)
      out.push({
        given: {
          ...given,
          lines: [],
          piece: { text, from: one.piece, done: one.piece + text.length >= first.length },
        },
        more: true,
      })
      break
    }
    const lines: string[] = []
    for (const line of given.lines) {
      if (cost(line) > room) break
      room -= cost(line)
      lines.push(line)
    }
    const more = given.more === true || lines.length < given.lines.length
    const { more: _more, ...rest } = given
    out.push({ given: { ...rest, lines }, more })
  }
  return out
}

/** What the far side answered, as this side reads it: a refusal in words, or the answer, checked. */
function answerOf(answer: Answer, name: string): FeedsAnswer {
  if (answer.status !== 200) throw new FeedsRefused('failed', refusedSays(answer, name))
  const body = answer.body as Partial<FeedsAnswer> | null
  const machine = body?.machine
  if (
    body === null ||
    typeof machine?.id !== 'string' ||
    !MACHINE_ID.test(machine.id) ||
    !Array.isArray(body.lines) ||
    !Array.isArray(body.took)
  ) {
    throw new FeedsRefused('failed', `${name} answered with something that is not its journals`)
  }
  return {
    machine: {
      id: machine.id,
      name: typeof machine.name === 'string' ? printable(machine.name).slice(0, 60) : '',
    },
    ...(Array.isArray(body.have) ? { have: body.have.filter(isSummary) } : {}),
    ...(body.sync !== undefined && isExtras(body.sync) ? { sync: body.sync } : {}),
    lines: body.lines.filter(isGiven),
    took: body.took.filter(
      (one): one is Took => typeof one?.machine === 'string' && typeof one.lines === 'number',
    ),
    ...(body.state !== undefined ? { state: body.state } : {}),
  }
}

/** Whether a value is a feed summary another machine could have made. */
export function isSummary(value: unknown): value is FeedSummary {
  const one = value as Partial<FeedSummary> | null
  return (
    typeof one?.machine === 'string' &&
    MACHINE_ID.test(one.machine) &&
    typeof one.name === 'string' &&
    isEpoch(one.epoch) &&
    typeof one.seq === 'number' &&
    Number.isSafeInteger(one.seq) &&
    typeof one.n === 'number' &&
    typeof one.h === 'string' &&
    CHAIN_HASH.test(one.h)
  )
}

function isGiven(value: unknown): value is Given {
  const one = value as Partial<Given> | null
  return (
    typeof one?.machine === 'string' &&
    MACHINE_ID.test(one.machine) &&
    typeof one.name === 'string' &&
    isEpoch(one.epoch) &&
    typeof one.after === 'number' &&
    typeof one.h === 'string' &&
    CHAIN_HASH.test(one.h) &&
    Array.isArray(one.lines) &&
    one.lines.every((line) => typeof line === 'string')
  )
}

function isExtras(value: unknown): value is Omit<SyncSummary, 'feeds'> {
  const one = value as Partial<SyncSummary> | null
  return (
    typeof one?.notes === 'string' &&
    typeof one.settings === 'object' &&
    one.settings !== null &&
    Array.isArray(one.pinned)
  )
}

/** A share the remote answered and would not take, in words. */
function refusedSays(answer: Answer, name: string): string {
  if (answer.status === 404) {
    return `${name}'s Tade does not keep other machines' journals: it is older than this one, or its window is not open there — update it, or open it`
  }
  if (answer.status === 401 || answer.status === 204) return SIGNED_OUT
  const said = (answer.body as { said?: unknown } | null)?.said
  return `${name} would not share its journal (${answer.status})${typeof said === 'string' ? `: ${printable(said)}` : ''}`
}

// ── Reading every feed, for a question ───────────────────────────────────────

/** One copy held under a home, as `tade machines` reads it without the window. */
export interface CopyHeld {
  meta: CopyMeta
  /** Lines in the copy now. */
  lines: number
  sync: KeptSync | null
}

/** Every copy of another machine's journal held under a home, with where it last stood. Throws only where one is there and could not be read. */
export async function copiesHeld(home: string): Promise<CopyHeld[]> {
  const out: CopyHeld[] = []
  const entries = await readdir(join(home, 'machines'), { withFileTypes: true }).catch(
    ifMissing([]),
  )
  for (const entry of entries) {
    if (!entry.isDirectory() || !MACHINE_ID.test(entry.name)) continue
    const dir = join(home, 'machines', entry.name)
    const meta = await readMeta(dir)
    const sync = jsonOf<KeptSync>(
      await readFile(join(dir, 'sync.json'), 'utf8').catch(ifMissing(null)),
    )
    if (meta === null && sync === null) continue
    out.push({
      meta: meta ?? {
        machine: entry.name,
        name: sync?.name ?? entry.name.slice(0, 8),
        epoch: { id: '', at: '' },
        forks: [],
      },
      lines: meta === null ? 0 : await countLines(join(dir, 'events.jsonl')),
      sync,
    })
  }
  return out
}

async function countLines(path: string): Promise<number> {
  let n = 0
  try {
    for await (const line of createInterface({
      input: createReadStream(path),
      crlfDelay: Infinity,
    })) {
      if (line.trim() !== '') n++
    }
  } catch (err) {
    return ifMissing(n)(err)
  }
  return n
}

/**
 * Every line of every copy held under a home, each labelled with the machine
 * it came from — what a question about the whole fleet folds (`tade logs
 * --fleet`, `tade stats --fleet`). Each feed by itself, oldest first; the
 * caller folds each apart or orders them by time, and never compares one
 * feed's numbers with another's. A copy taken away while it is read is left
 * out; one there that cannot be read throws.
 */
export async function readFeeds(
  home: string,
  filter: Omit<EventFilter, 'limit' | 'since'> = {},
): Promise<{ name: string; machine: string; events: FleetEvent[] }[]> {
  const out: { name: string; machine: string; events: FleetEvent[] }[] = []
  for (const held of await copiesHeld(home)) {
    if (held.lines === 0) continue
    const events = await readCopy(home, held.meta, filter)
    if (events !== null) out.push({ name: held.meta.name, machine: held.meta.machine, events })
  }
  return out
}

/**
 * The lines of one copy held under a home, each labelled with the machine it
 * came from; null where the copy was taken away while it was read. One there
 * that cannot be read throws.
 */
export async function readCopy(
  home: string,
  meta: Pick<CopyMeta, 'machine' | 'name'>,
  filter: Omit<EventFilter, 'limit' | 'since'> = {},
): Promise<FleetEvent[] | null> {
  const events: FleetEvent[] = []
  // Asked for a few kinds, a line of any other is passed over on its head
  // alone: a hub keeps every machine's journal, and a name is checked
  // against all of them whenever a task is made.
  const kinds =
    filter.types === undefined ? null : new Set<string>(filter.types.map((one) => typeNow(one)))
  try {
    const input = createReadStream(join(home, 'machines', meta.machine, 'events.jsonl'))
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (line.trim() === '') continue
      if (kinds !== null) {
        const head = headOf(line)
        if (head !== null && !kinds.has(typeNow(head.type))) continue
      }
      try {
        const event = JSON.parse(line) as TadeEvent
        if (matchesFilter(event, filter)) events.push({ ...event, machine: meta.name })
      } catch (err) {
        // A line that will not parse is skipped, never thrown over.
        if (!(err instanceof SyntaxError)) throw err
      }
    }
  } catch (err) {
    // A copy taken away while it was read is one this home does not hold.
    return ifMissing(null)(err)
  }
  return events
}

/** Where one copy held under a home last stood, and what it calls itself; null where none is kept there. */
export async function copyKept(
  home: string,
  machine: string,
): Promise<{ meta: CopyMeta | null; sync: KeptSync | null }> {
  const dir = join(home, 'machines', machine)
  const meta = await readMeta(dir)
  const sync = jsonOf<KeptSync>(
    await readFile(join(dir, 'sync.json'), 'utf8').catch(ifMissing(null)),
  )
  return { meta, sync }
}
