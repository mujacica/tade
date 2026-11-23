import { createHash } from 'node:crypto'
import { appendFile, mkdir, open, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ConversationFormat } from './conversation.ts'

// One conversation's record on disk, read the way replicating it needs: which
// entries it holds, and the n-th of them as a canonical line, without reading
// the whole of it again every time somebody asks.
//
// The orchestrator's record on a machine that has run it for a month is a few
// hundred megabytes, most of it the harness's own bookkeeping, and a look is
// taken before every turn. So this keeps, per entry, where its line starts and
// how long it is, its id, and the hash chain over the canonical lines up to it
// (`h_n = sha256(h_{n-1} ‖ line_n)`, as feeds have it) — and reads only what
// was appended since the last look. A record that shrank, or whose last bytes
// are not what they were, was rewritten under it, and is read again whole: the
// harness and the merge only ever append, so that is somebody else's doing and
// the honest answer is to start over rather than trust the numbers.
//
// The same reader serves a copy of another machine's record (`machines/<id>/
// conversation.jsonl`), whose lines are already canonical.

/** Where a chain starts, before any line. */
export const CONVERSATION_CHAIN_START = '0'.repeat(64)

/** The next link of the chain over canonical lines. */
export function conversationChain(h: string, line: string): string {
  return createHash('sha256').update(h).update('\n').update(line).digest('hex')
}

/** How many bytes at the end of what was read are checked again before reading on. */
const TAIL = 256

interface Held {
  offset: number
  length: number
  id: string
}

export class ConversationRecord {
  readonly path: string
  private readonly format: ConversationFormat
  private held: Held[] = []
  private chain: string[] = [CONVERSATION_CHAIN_START]
  private known = new Set<string>()
  private size = 0
  private tail = ''
  private strange: string | null = null

  constructor(path: string, format: ConversationFormat) {
    this.path = path
    this.format = format
  }

  /** How many entries it holds. */
  get entries(): number {
    return this.held.length
  }

  /** The ids it holds. */
  get ids(): ReadonlySet<string> {
    return this.known
  }

  /** The chain over its first `n` canonical lines. */
  chainAt(n: number): string | null {
    return this.chain[n] ?? null
  }

  /** The first line of a shape its format does not know, in words; null while there is none. */
  get unknown(): string | null {
    return this.strange
  }

  /**
   * Read what was appended since the last look. A record that is not there
   * holds nothing; one that cannot be read throws.
   */
  async look(): Promise<void> {
    const found = await stat(this.path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
    if (!found) {
      this.reset()
      return
    }
    if (found.size < this.size || !(await this.tailHolds())) this.reset()
    if (found.size === this.size) return
    const handle = await open(this.path, 'r')
    try {
      // Bytes, split on the newline byte: a chunk may end inside a character.
      let at = this.size
      let rest = Buffer.alloc(0)
      let restStart = at
      const chunk = Buffer.alloc(1024 * 1024)
      while (at < found.size) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, at)
        if (bytesRead === 0) break
        const bytes = Buffer.concat([rest, chunk.subarray(0, bytesRead)])
        let start = 0
        for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
          this.take(bytes.subarray(start, end).toString('utf8'), restStart + start, end - start)
          start = end + 1
        }
        rest = Buffer.from(bytes.subarray(start))
        restStart += start
        at += bytesRead
      }
      // A last line without its newline is one still being written: read next time.
      this.size = restStart
      this.tail = await readTail(handle, this.size)
    } finally {
      await handle.close()
    }
  }

  private take(line: string, offset: number, length: number): void {
    if (line.trim() === '') return
    const read = this.format.read(line)
    if (read.kind === 'kept') return
    if (read.kind === 'unknown') {
      this.strange ??= read.why
      return
    }
    // The same entry twice in one record is the harness's business; it is held once.
    if (this.known.has(read.id)) return
    this.known.add(read.id)
    this.held.push({ offset, length, id: read.id })
    this.chain.push(conversationChain(this.chain.at(-1) ?? CONVERSATION_CHAIN_START, read.text))
  }

  private reset(): void {
    this.held = []
    this.chain = [CONVERSATION_CHAIN_START]
    this.known = new Set()
    this.size = 0
    this.tail = ''
    this.strange = null
  }

  private async tailHolds(): Promise<boolean> {
    if (this.size === 0) return true
    const handle = await open(this.path, 'r')
    try {
      return (await readTail(handle, this.size)) === this.tail
    } finally {
      await handle.close()
    }
  }

  /**
   * Its canonical lines from the `from`-th on, as many as fit in `bytes` — at
   * least one where there is one, however long, so a line longer than the
   * budget still goes.
   */
  async canonical(from: number, bytes = Number.POSITIVE_INFINITY): Promise<string[]> {
    const out: string[] = []
    if (from >= this.held.length) return out
    const handle = await open(this.path, 'r')
    try {
      let used = 0
      for (let n = from; n < this.held.length; n++) {
        const one = this.held[n] as Held
        if (out.length > 0 && used + one.length > bytes) break
        const buffer = Buffer.alloc(one.length)
        const { bytesRead } = await handle.read(buffer, 0, one.length, one.offset)
        if (bytesRead !== one.length)
          throw new Error(`${this.path} shrank under Tade as it read it`)
        const read = this.format.read(buffer.toString('utf8'))
        if (read.kind !== 'entry') throw new Error(`${this.path} changed under Tade as it read it`)
        out.push(read.text)
        used += one.length
      }
    } finally {
      await handle.close()
    }
    return out
  }

  /** The canonical lines of the entries it holds that `wanted` names, in its order. */
  async only(wanted: (id: string) => boolean): Promise<string[]> {
    const out: string[] = []
    const handle = await open(this.path, 'r')
    try {
      for (const one of this.held) {
        if (!wanted(one.id)) continue
        const buffer = Buffer.alloc(one.length)
        const { bytesRead } = await handle.read(buffer, 0, one.length, one.offset)
        if (bytesRead !== one.length)
          throw new Error(`${this.path} shrank under Tade as it read it`)
        const read = this.format.read(buffer.toString('utf8'))
        if (read.kind !== 'entry') throw new Error(`${this.path} changed under Tade as it read it`)
        out.push(read.text)
      }
    } finally {
      await handle.close()
    }
    return out
  }

  /** Every canonical line it holds, in its order: for a merge, which is rare. */
  all(): Promise<string[]> {
    return this.canonical(0)
  }
}

async function readTail(handle: Awaited<ReturnType<typeof open>>, size: number): Promise<string> {
  const from = Math.max(0, size - TAIL)
  const buffer = Buffer.alloc(size - from)
  await handle.read(buffer, 0, buffer.length, from)
  return buffer.toString('latin1')
}

/** Lines appended to a record, made first where there is none. Each ends in a newline. */
export async function appendLines(path: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${lines.join('\n')}\n`, { mode: 0o600 })
}

/** A record written whole, put in place at once so nothing reads half of it. */
export async function writeLines(path: string, lines: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const writing = `${path}.writing`
  await writeFile(writing, lines.length > 0 ? `${lines.join('\n')}\n` : '', { mode: 0o600 })
  await rename(writing, path)
}
