import { type FileHandle, open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TurnState } from '@tade/core'

// Adoption: find agent sessions started outside Tade by reading the
// providers' own transcript files. These formats were never promised to
// anyone, so this is the most brittle code in the repo:
//   - each provider has one parser with a `version`, and a fixture corpus in
//     test/fixtures/transcripts/<provider>/;
//   - parsers return `null` on anything they don't recognise and never throw.

export interface AdoptedSession {
  provider: string
  parserVersion: number
  sessionId: string
  cwd: string
  file: string
  lastActivityAt: number | null
  turn: TurnState
  pendingPermissions: string[]
  consecutiveFailures: number
  title: string | null
}

type Parsed = Omit<AdoptedSession, 'provider' | 'parserVersion' | 'file'>

/** One line of a transcript that parsed as a JSON object. */
export type Json = Record<string, unknown>

/**
 * How one provider's transcripts are read: a fold over their lines.
 *
 * A fold rather than a function of the file's last bytes, so that a window,
 * which looks every two seconds, reads only what was written since it last
 * looked (`TranscriptReads`). `begin` is asked once, `read` with each run of
 * whole lines in the order they were written, and `end` whenever an answer is
 * wanted — so `read` hands back what it knows now and never changes what it
 * was given, because what it was given is kept for the next beat.
 */
export interface TranscriptParser<Known = unknown> {
  provider: string
  version: number
  /** Where this provider keeps transcripts, relative to $HOME. */
  dir: string
  /** How deep below `dir` transcript files sit. */
  depth: number
  /** What is known before a line is read: the file's path, and its first bytes (which may end mid-line). */
  begin(file: string, head: string): Known
  /** Fold whole lines, oldest first, into what is known. */
  read(known: Known, lines: Iterable<Json>): Known
  /** What it comes to: a session, or `null` for anything it does not recognise. */
  end(known: Known): Parsed | null
}

// --- helpers -----------------------------------------------------------------

/**
 * The lines of `text` that parse as JSON objects, one at a time: each is
 * garbage as soon as it is folded in, rather than a quarter of a megabyte of
 * them living long enough to be promoted to the old generation.
 */
function* jsonLines(text: string): Generator<Json> {
  for (let at = 0; at < text.length; ) {
    const nl = text.indexOf('\n', at)
    const line = text.slice(at, nl < 0 ? text.length : nl)
    at = nl < 0 ? text.length : nl + 1
    if (!line.trim()) continue
    try {
      const v: unknown = JSON.parse(line)
      if (v && typeof v === 'object' && !Array.isArray(v)) yield v as Json
    } catch {
      // partial or corrupt line: skip
    }
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const obj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null

function ts(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function latest(at: number | null, v: unknown): number | null {
  const t = ts(v)
  return t !== null && (at === null || t > at) ? t : at
}

/** Pull a `"cwd":"..."` value out of possibly truncated JSON. */
function cwdFromRaw(text: string): string | null {
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text)
  if (!m) return null
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return null
  }
}

function truncate(s: string, n = 80): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

// --- Claude Code ---------------------------------------------------------------
// ~/.claude/projects/<escaped-cwd>/<session-uuid>.jsonl
// Conversational entries: {type: user|assistant, sessionId, cwd, timestamp, message, isSidechain}.
// assistant.message.stop_reason: end_turn | stop_sequence (turn over) | tool_use (mid-turn).

interface ClaudeKnown {
  /** The first cwd in the file, for a session whose last entry does not say. */
  headCwd: string | null
  /** The last conversational entry, which the session and its turn are read from. */
  last: { sessionId: string; cwd: string | null; turn: TurnState } | null
  /** API errors since the last assistant reply. */
  failures: number
  title: string | null
  lastActivityAt: number | null
}

function claudeTurn(e: Json): TurnState {
  if (e.type === 'user') return 'running'
  const stop = obj(e.message)?.stop_reason
  if (stop === 'end_turn' || stop === 'stop_sequence') return 'idle'
  if (stop === 'tool_use') return 'running'
  return 'unknown'
}

export const claudeCode: TranscriptParser<ClaudeKnown> = {
  provider: 'claude-code',
  version: 1,
  dir: '.claude/projects',
  depth: 2,
  begin(_file, head) {
    return { headCwd: cwdFromRaw(head), last: null, failures: 0, title: null, lastActivityAt: null }
  },
  read(known, lines) {
    let { last, failures, title, lastActivityAt } = known
    for (const e of lines) {
      lastActivityAt = latest(lastActivityAt, e.timestamp)
      // Any assistant entry ends a run of failures, a sidechain's included.
      if (e.type === 'assistant') failures = 0
      else if (e.type === 'system' && e.subtype === 'api_error') failures++
      if (e.type === 'ai-title') title = str(e.aiTitle)
      const sessionId = str(e.sessionId)
      if ((e.type === 'user' || e.type === 'assistant') && e.isSidechain !== true && sessionId) {
        last = { sessionId, cwd: str(e.cwd), turn: claudeTurn(e) }
      }
    }
    return { headCwd: known.headCwd, last, failures, title, lastActivityAt }
  },
  end(known) {
    const cwd = known.last?.cwd ?? known.headCwd
    if (!known.last || !cwd) return null
    return {
      sessionId: known.last.sessionId,
      cwd,
      lastActivityAt: known.lastActivityAt,
      turn: known.last.turn,
      // Claude Code renders permission prompts in its UI; they are not in the
      // transcript. Never guess: a false "blocked" is worse than none.
      pendingPermissions: [],
      consecutiveFailures: known.failures,
      title: known.title,
    }
  },
}

// --- Codex -----------------------------------------------------------------------
// ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl
// Records: {timestamp, type: session_meta|turn_context|response_item|event_msg, payload}.

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

interface CodexKnown {
  /** Out of the file's name: a file without one is not a Codex session. */
  sessionId: string | null
  headCwd: string | null
  cwd: string | null
  turn: TurnState
  pending: string[]
  failures: number
  /** Whether any record of Codex's shape has been read. */
  records: boolean
  lastActivityAt: number | null
}

export const codex: TranscriptParser<CodexKnown> = {
  provider: 'codex',
  version: 1,
  dir: '.codex/sessions',
  depth: 4,
  begin(file, head) {
    return {
      sessionId: UUID.exec(file)?.[1] ?? null,
      headCwd: cwdFromRaw(head),
      cwd: null,
      turn: 'unknown',
      pending: [],
      failures: 0,
      records: false,
      lastActivityAt: null,
    }
  },
  read(known, lines) {
    let { cwd, turn, pending, failures, records, lastActivityAt } = known
    for (const e of lines) {
      const p = obj(e.payload)
      if (str(e.type) === null || !p) continue
      records = true
      lastActivityAt = latest(lastActivityAt, e.timestamp)
      const pt = p.type
      if (e.type === 'session_meta' || e.type === 'turn_context') {
        cwd = str(p.cwd) ?? cwd
      } else if (e.type === 'event_msg') {
        if (pt === 'task_started' || pt === 'user_message') {
          turn = 'running'
          pending = []
        } else if (pt === 'task_complete' || pt === 'turn_aborted') {
          turn = 'idle'
          pending = []
        } else if (pt === 'error' || pt === 'stream_error') {
          failures++
        } else if (typeof pt === 'string' && pt.endsWith('_approval_request')) {
          pending = [...pending, describeCodexApproval(p)]
        }
      } else if (e.type === 'response_item') {
        if (pt === 'function_call' || pt === 'custom_tool_call') {
          turn = 'running'
        } else if (pt === 'function_call_output' || pt === 'custom_tool_call_output') {
          turn = 'running'
          pending = []
          failures = 0
        } else if (pt === 'message' && p.role === 'assistant') {
          turn = 'idle'
          failures = 0
        }
      }
    }
    return { ...known, cwd, turn, pending, failures, records, lastActivityAt }
  },
  end(known) {
    const cwd = known.cwd ?? known.headCwd
    if (!known.sessionId || !known.records || !cwd) return null
    return {
      sessionId: known.sessionId,
      cwd,
      lastActivityAt: known.lastActivityAt,
      turn: known.turn,
      pendingPermissions: [...known.pending],
      consecutiveFailures: known.failures,
      title: null,
    }
  },
}

function describeCodexApproval(p: Json): string {
  const cmd = p.command
  if (Array.isArray(cmd)) return `bash: ${truncate(cmd.map(String).join(' '))}`
  if (typeof cmd === 'string') return `bash: ${truncate(cmd)}`
  const changes = obj(p.changes)
  if (changes) return `patch: ${Object.keys(changes).length} files`
  return str(p.type) ?? 'approval'
}

export const parsers: TranscriptParser[] = [claudeCode, codex]

// --- reading -------------------------------------------------------------------
//
// A window's status child scans every two seconds, and every transcript
// touched in the last day is 147 files and 290 MB on one laptop — read again
// from the top each beat, the last 256 KiB of each, was 140 MB of garbage a
// beat and a child sitting at 150–200 MB. Nearly all of those files had not
// changed since the beat before. So what was read of a file is kept
// (`TranscriptReads`), owned by whoever scans again, as the probe gate is:
//
// - a file whose inode, size and mtime all read as they did is not opened;
// - a file that only grew is read from just past the last whole line folded
//   in, and the bytes before that point must still be there (`SEAM_BYTES`) or
//   it was rewritten rather than appended to, and is read again in full;
// - anything else is read in full, which is the first 64 KiB and the last
//   256 KiB, as it always was.
//
// What is kept is kept because the file still says it, never because it is
// recent: a `stat` of the file itself sees every write to it.

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 256 * 1024
/** How much of what came before must read the same for a longer file to be an append. */
const SEAM_BYTES = 128
const NL = 0x0a

/** What was read of one transcript, kept while it is the same file. */
interface Held {
  version: number
  ino: number
  size: number
  mtimeMs: number
  /** Just past the last whole line folded in; null when the next read must be from the start. */
  offset: number | null
  /** The bytes just before `offset`. */
  seam: Buffer
  known: unknown
  session: AdoptedSession | null
}

/**
 * What earlier scans read, for whoever scans again — a window's status child,
 * for as long as it lives. A one-shot `tade status` is given none, and reads
 * everything.
 */
export interface TranscriptReads {
  /** By provider, then by path. */
  readonly held: Map<string, Map<string, Held>>
}

export function newTranscriptReads(): TranscriptReads {
  return { held: new Map() }
}

let opened = 0
let bytesRead = 0

/**
 * Transcripts opened and bytes read since the process started: the instrument
 * the tests hold the reads to, as `gitLoad()` is for spawns. Never a stretch
 * of wall clock.
 */
export function transcriptLoad(): { opened: number; bytes: number } {
  return { opened, bytes: bytesRead }
}

interface Found {
  file: string
  ino: number
  size: number
  mtimeMs: number
}

/** What a look at one file came to. */
type Look = { held: Held } | { gone: true } | { failed: string }

const absent = (err: unknown) => {
  const code = codeOf(err)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : err instanceof Error ? err.message : String(err)
}

async function bytes(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const { bytesRead: n } = await fh.read(buf, got, length - got, position + got)
    if (n === 0) break
    got += n
  }
  bytesRead += got
  return got < length ? buf.subarray(0, got) : buf
}

function answer(parser: TranscriptParser, file: string, known: unknown): AdoptedSession | null {
  const parsed = parser.end(known)
  return parsed
    ? { ...parsed, provider: parser.provider, parserVersion: parser.version, file }
    : null
}

/**
 * Fold the whole lines of `buf` from `start` into `known`. `at` is where in the
 * file `buf` begins.
 *
 * A last line with no newline yet may be whole and waiting for it, or still
 * being written: it is read for this answer and not kept, so that it is read
 * again, whole, next time rather than folded in twice.
 */
function settle(
  parser: TranscriptParser,
  seen: Found,
  known: unknown,
  buf: Buffer,
  at: number,
  start: number,
  resumable: boolean,
): Held {
  const nl = buf.lastIndexOf(NL)
  const end = nl >= start ? nl + 1 : start
  const base = { version: parser.version, ino: seen.ino, size: seen.size, mtimeMs: seen.mtimeMs }
  try {
    const whole =
      end > start ? parser.read(known, jsonLines(buf.toString('utf8', start, end))) : known
    const rest = end < buf.length ? [...jsonLines(buf.toString('utf8', end))] : []
    return {
      ...base,
      offset: resumable ? at + end : null,
      seam: Buffer.from(buf.subarray(Math.max(0, end - SEAM_BYTES), end)),
      known: whole,
      session: answer(parser, seen.file, rest.length > 0 ? parser.read(whole, rest) : whole),
    }
  } catch {
    // A parser that threw is a bug in it, and its file reads as unrecognised
    // until it changes — and is then read from the start, never from a fold
    // that went wrong halfway.
    return { ...base, offset: null, seam: Buffer.alloc(0), known: null, session: null }
  }
}

/** The first 64 KiB and the last 256 KiB, whose first line is cut in half unless it is the whole file. */
async function readAll(parser: TranscriptParser, fh: FileHandle, seen: Found): Promise<Held> {
  const head = await bytes(fh, 0, Math.min(seen.size, HEAD_BYTES))
  const from = Math.max(0, seen.size - TAIL_BYTES)
  const tail = await bytes(fh, from, seen.size - from)
  const nl = from > 0 ? tail.indexOf(NL) : -1
  const start = from === 0 ? 0 : nl < 0 ? tail.length : nl + 1
  const known = parser.begin(seen.file, head.toString('utf8'))
  // One line longer than the tail leaves nowhere known to go on from.
  return settle(parser, seen, known, tail, from, start, from === 0 || nl >= 0)
}

/** What was appended since `held`, or null when the file must be read in full instead. */
async function readMore(
  parser: TranscriptParser,
  fh: FileHandle,
  seen: Found,
  held: Held,
): Promise<Held | null> {
  const { offset, seam } = held
  if (offset === null || seen.ino !== held.ino || seen.size < offset) return null
  // More than a tail's worth is read the way a new file is, as it always was.
  if (seen.size - offset > TAIL_BYTES) return null
  const at = offset - seam.length
  const buf = await bytes(fh, at, seen.size - at)
  if (!buf.subarray(0, seam.length).equals(seam)) return null
  return settle(parser, seen, held.known, buf, at, seam.length, true)
}

async function lookAt(
  parser: TranscriptParser,
  found: Found,
  held: Held | undefined,
): Promise<Look> {
  const same = held?.version === parser.version ? held : undefined
  if (
    same &&
    same.ino === found.ino &&
    same.size === found.size &&
    same.mtimeMs === found.mtimeMs
  ) {
    return { held: same }
  }
  let fh: FileHandle
  try {
    fh = await open(found.file, 'r')
  } catch (err) {
    return absent(err) ? { gone: true } : { failed: codeOf(err) }
  }
  opened++
  try {
    const st = await fh.stat()
    const seen = { file: found.file, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs }
    return {
      held: (same && (await readMore(parser, fh, seen, same))) || (await readAll(parser, fh, seen)),
    }
  } catch (err) {
    return { failed: codeOf(err) }
  } finally {
    await fh.close().catch(() => {})
  }
}

/** Parse one file with one parser, from the start. Never throws. */
export async function parseTranscript(
  parser: TranscriptParser,
  file: string,
): Promise<AdoptedSession | null> {
  try {
    const st = await stat(file)
    const look = await lookAt(
      parser,
      { file, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs },
      undefined,
    )
    return 'held' in look ? look.held.session : null
  } catch {
    return null
  }
}

/**
 * Every `.jsonl` file `depth` below `dir` modified since `since`, and every
 * folder or file that could not be looked at. Nothing there is nothing there;
 * anything else is a look that could not be had.
 */
async function walk(
  dir: string,
  depth: number,
  since: number,
  out: Found[],
  failed: Map<string, string>,
): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if (!absent(err)) failed.set(dir, codeOf(err))
    return
  }
  for (const name of names) {
    const full = join(dir, name)
    if (depth > 1) {
      await walk(full, depth - 1, since, out, failed)
    } else if (name.endsWith('.jsonl')) {
      try {
        const st = await stat(full)
        if (st.mtimeMs >= since) {
          out.push({ file: full, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs })
        }
      } catch (err) {
        if (!absent(err)) failed.set(full, codeOf(err))
      }
    }
  }
}

export interface ScanOptions {
  home: string
  now: number
  /** Only files modified within this window are read. */
  windowMs: number
  parsers?: TranscriptParser[]
  /** What earlier scans read. None: everything is read, and nothing kept. */
  reads?: TranscriptReads | undefined
}

export async function scanTranscripts(
  opts: ScanOptions,
): Promise<{ sessions: AdoptedSession[]; warnings: string[] }> {
  const reads = opts.reads ?? newTranscriptReads()
  const since = opts.now - opts.windowMs
  const sessions: AdoptedSession[] = []
  const warnings: string[] = []
  for (const parser of opts.parsers ?? parsers) {
    const files: Found[] = []
    const failed = new Map<string, string>()
    await walk(join(opts.home, parser.dir), parser.depth, since, files, failed)
    const held = reads.held.get(parser.provider) ?? new Map<string, Held>()
    const kept = new Map<string, Held>()
    for (const found of files) {
      const look = await lookAt(parser, found, held.get(found.file))
      if ('held' in look) kept.set(found.file, look.held)
      else if ('failed' in look) failed.set(found.file, look.failed)
    }
    // A file that could not be looked at, or that is in a folder that could
    // not be, is not a session that has gone: what was last read of it
    // stands, as long as it is still inside the window.
    for (const [file, last] of held) {
      if (kept.has(file) || last.mtimeMs < since) continue
      if ([...failed.keys()].some((where) => file === where || file.startsWith(`${where}/`))) {
        kept.set(file, last)
      }
    }
    reads.held.set(parser.provider, kept)

    let unrecognised = 0
    for (const one of kept.values()) {
      if (one.session) sessions.push(one.session)
      else unrecognised++
    }
    if (unrecognised > 0) {
      warnings.push(
        `${parser.provider}: ${unrecognised} transcript(s) in an unrecognised format (parser v${parser.version})`,
      )
    }
    if (failed.size > 0) {
      const why = [...new Set(failed.values())].sort().join(', ')
      warnings.push(`${parser.provider}: some transcripts could not be read (${why})`)
    }
  }
  sessions.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || cmp(a.file, b.file))
  return { sessions, warnings }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
