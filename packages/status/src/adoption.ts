import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TurnState } from '@wilco/core'

// Adoption: find agent sessions started outside Wilco by reading the
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

export interface TranscriptChunk {
  file: string
  /** First bytes of the file (may end mid-line). */
  head: string
  /** Last bytes of the file (may start mid-line unless `whole`). */
  tail: string
  whole: boolean
}

type Parsed = Omit<AdoptedSession, 'provider' | 'parserVersion' | 'file'>

export interface TranscriptParser {
  provider: string
  version: number
  /** Where this provider keeps transcripts, relative to $HOME. */
  dir: string
  /** How deep below `dir` transcript files sit. */
  depth: number
  parse(chunk: TranscriptChunk): Parsed | null
}

// --- helpers -----------------------------------------------------------------

type Json = Record<string, unknown>

function jsonLines(text: string, skipFirst: boolean): Json[] {
  const lines = text.split('\n')
  if (skipFirst) lines.shift()
  const out: Json[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const v: unknown = JSON.parse(line)
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Json)
    } catch {
      // partial or corrupt line: skip
    }
  }
  return out
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const obj = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null

function ts(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

function maxTs(entries: Json[], key = 'timestamp'): number | null {
  let max: number | null = null
  for (const e of entries) {
    const t = ts(e[key])
    if (t !== null && (max === null || t > max)) max = t
  }
  return max
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

export const claudeCode: TranscriptParser = {
  provider: 'claude-code',
  version: 1,
  dir: '.claude/projects',
  depth: 2,
  parse(chunk) {
    const entries = jsonLines(chunk.tail, !chunk.whole)
    const conv = entries.filter(
      (e) =>
        (e.type === 'user' || e.type === 'assistant') &&
        e.isSidechain !== true &&
        str(e.sessionId) !== null,
    )
    const last = conv.at(-1)
    if (!last) return null
    const cwd = str(last.cwd) ?? cwdFromRaw(chunk.head)
    if (!cwd) return null

    let turn: TurnState = 'unknown'
    const msg = obj(last.message)
    if (last.type === 'user') turn = 'running'
    else if (msg) {
      const stop = msg.stop_reason
      if (stop === 'end_turn' || stop === 'stop_sequence') turn = 'idle'
      else if (stop === 'tool_use') turn = 'running'
    }

    // API errors after the last assistant reply are consecutive failures.
    let failures = 0
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]!
      if (e.type === 'assistant') break
      if (e.type === 'system' && e.subtype === 'api_error') failures++
    }

    const titleEntry = entries.findLast((e) => e.type === 'ai-title')
    return {
      sessionId: str(last.sessionId)!,
      cwd,
      lastActivityAt: maxTs(entries),
      turn,
      // Claude Code renders permission prompts in its UI; they are not in the
      // transcript. Never guess: a false "blocked" is worse than none.
      pendingPermissions: [],
      consecutiveFailures: failures,
      title: titleEntry ? str(titleEntry.aiTitle) : null,
    }
  },
}

// --- Codex -----------------------------------------------------------------------
// ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl
// Records: {timestamp, type: session_meta|turn_context|response_item|event_msg, payload}.

const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/

export const codex: TranscriptParser = {
  provider: 'codex',
  version: 1,
  dir: '.codex/sessions',
  depth: 4,
  parse(chunk) {
    const sessionId = UUID.exec(chunk.file)?.[1]
    if (!sessionId) return null
    const entries = jsonLines(chunk.tail, !chunk.whole).filter(
      (e) => str(e.type) !== null && obj(e.payload) !== null,
    )
    if (entries.length === 0) return null

    let cwd: string | null = null
    let turn: TurnState = 'unknown'
    let pending: string[] = []
    let failures = 0
    for (const e of entries) {
      const p = obj(e.payload)!
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
          pending.push(describeCodexApproval(p))
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
    cwd ??= cwdFromRaw(chunk.head)
    if (!cwd) return null

    return {
      sessionId,
      cwd,
      lastActivityAt: maxTs(entries),
      turn,
      pendingPermissions: pending,
      consecutiveFailures: failures,
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

// --- scanning ------------------------------------------------------------------

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 256 * 1024

export async function readChunk(file: string): Promise<TranscriptChunk> {
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    const headLen = Math.min(size, HEAD_BYTES)
    const head = Buffer.alloc(headLen)
    await fh.read(head, 0, headLen, 0)
    const tailLen = Math.min(size, TAIL_BYTES)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    return {
      file,
      head: head.toString('utf8'),
      tail: tail.toString('utf8'),
      whole: tailLen === size,
    }
  } finally {
    await fh.close()
  }
}

/** Parse one file with one parser. Never throws. */
export async function parseTranscript(
  parser: TranscriptParser,
  file: string,
): Promise<AdoptedSession | null> {
  try {
    const parsed = parser.parse(await readChunk(file))
    if (!parsed) return null
    return { ...parsed, provider: parser.provider, parserVersion: parser.version, file }
  } catch {
    return null
  }
}

async function walk(dir: string, depth: number, since: number, out: string[]): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names) {
    const full = join(dir, name)
    if (depth > 1) {
      await walk(full, depth - 1, since, out)
    } else if (name.endsWith('.jsonl')) {
      try {
        if ((await stat(full)).mtimeMs >= since) out.push(full)
      } catch {}
    }
  }
}

export interface ScanOptions {
  home: string
  now: number
  /** Only files modified within this window are read. */
  windowMs: number
  parsers?: TranscriptParser[]
}

export async function scanTranscripts(
  opts: ScanOptions,
): Promise<{ sessions: AdoptedSession[]; warnings: string[] }> {
  const sessions: AdoptedSession[] = []
  const warnings: string[] = []
  for (const parser of opts.parsers ?? parsers) {
    const files: string[] = []
    await walk(join(opts.home, parser.dir), parser.depth, opts.now - opts.windowMs, files)
    let unrecognised = 0
    for (const file of files) {
      const s = await parseTranscript(parser, file)
      if (s) sessions.push(s)
      else unrecognised++
    }
    if (unrecognised > 0) {
      warnings.push(
        `${parser.provider}: ${unrecognised} transcript(s) in an unrecognised format (parser v${parser.version})`,
      )
    }
  }
  sessions.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || cmp(a.file, b.file))
  return { sessions, warnings }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
