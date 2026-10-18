import { open, readdir, readFile, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  answerIn,
  type HistoryAsk,
  type HistoryLine,
  type HistoryPage,
  historyIn,
  momentOf,
  type ToolAnswer,
} from '@tade/harnesses-core'
import { sessionIdFor } from './adapter.ts'
import { agentDir, homeExpanded } from './agent-dir.ts'
import { modelOfMessage, spentBy } from './usage.ts'

// Reading what an agent did out of pi's own session, rather than out of what
// it told us at the time.
//
// It is the same information either way — the supervision extension reports
// each turn as it happens — but the extension can only report while Tade is
// listening, and under a driver whose lanes outlive the window that is not
// always. The session file is written by pi regardless, so it is the ledger
// that survives us being closed, and this is how the gap gets filled in.
//
// The format is pi's and private. Nothing here assumes more than "JSONL, one
// entry per line", priced the way `spentBy` says pi prices them, and anything
// else is skipped: a session we cannot read is a gap in the accounting, never
// an error.

/**
 * Where pi keeps sessions when nothing names it a directory for them
 * (`sessionsOf`): under its agent directory (`agentDir`), wherever
 * `PI_CODING_AGENT_DIR` in the environment pi is launched with puts it.
 */
export function sessionsRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(agentDir(env, home), 'sessions')
}

export interface SessionUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  usd: number
  /** How many priced entries were counted, so "none yet" is distinguishable. */
  messages: number
  /** The model its last reply ran on, as `provider/id`. */
  model: string | null
}

export function noUsage(): SessionUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    usd: 0,
    messages: 0,
    model: null,
  }
}

/**
 * The directory pi keeps a working directory's sessions in: the path without
 * its leading slash, every separator and colon a dash, between double dashes.
 * It is pi's `getDefaultSessionDir`, which pi does not export, so a test holds
 * this to pi's own and a pi that files them differently fails there rather
 * than reading as no session at all.
 *
 * `cwd` is meant as pi's `process.cwd()` says it, already resolved: a path
 * through a symlink names a directory pi never writes to. A relative `root`
 * is pi's from there too, as pi resolves its agent directory.
 */
export function sessionDirFor(cwd: string, root = sessionsRoot()): string {
  return join(resolve(cwd, root), `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
}

/**
 * Where pi files the sessions it starts in `cwd`, launched with `env` and no
 * `--session-dir`, which a lane is never given: the directory
 * `PI_CODING_AGENT_SESSION_DIR` names, or else the one a `sessionDir` in its
 * settings names — the project's `.pi/settings.json` over the agent
 * directory's, as pi merges them — or else its own for `cwd` (`sessionDirFor`).
 * The order is pi's `main`, which exports none of it; a test holds the
 * settings half to pi's `SettingsManager`. A directory named either way holds
 * every working directory's sessions together, which `shared` says, and is read
 * as pi reads it: a leading `~` is the home, and a relative one is from `cwd`.
 */
export async function sessionsOf(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): Promise<{ dir: string; shared: boolean }> {
  const own = sessionDirFor(cwd, sessionsRoot(env, home))
  const named = env.PI_CODING_AGENT_SESSION_DIR || (await sessionDirSetting(cwd, env, home))
  const dir = named ? resolve(cwd, homeExpanded(named, home)) : own
  return { dir, shared: dir !== own }
}

/** The `sessionDir` pi's settings name: the project's over the agent directory's, key by key. */
async function sessionDirSetting(
  cwd: string,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<string | undefined> {
  const [mine, project] = await Promise.all([
    settingsIn(join(resolve(cwd, agentDir(env, home)), 'settings.json')),
    settingsIn(join(cwd, '.pi', 'settings.json')),
  ])
  const named = project.sessionDir !== undefined ? project.sessionDir : mine.sessionDir
  return typeof named === 'string' && named ? named : undefined
}

/**
 * A pi settings file, or nothing for one that is not there or not JSON, which
 * pi reads as no settings. One that is there and cannot be read throws: pi
 * would have read it, so Tade cannot say where it files sessions.
 */
async function settingsIn(file: string): Promise<Record<string, unknown>> {
  const text = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null
    throw new Error(`could not read pi's settings at ${file}: ${err.message}`)
  })
  if (text === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (err) {
    if (err instanceof SyntaxError) return {}
    throw err
  }
  return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
}

/**
 * Where to look for a task's session: `root` is a test's own sessions root,
 * looked in the way pi looks in its own (`sessionDirFor`) with nothing else
 * read; without it, wherever pi launched with `env` files them (`sessionsOf`).
 */
export interface SessionsAt {
  root?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Find a task's session file: the one pi carries on when it is started in
 * `cwd` with the task's session id.
 *
 * Only the directory pi files that working directory's sessions in is looked
 * in (`sessionsOf`), because it is the only one pi looks in
 * (`SessionManager.findById(cwd, …)`): a session the task left under another
 * working directory is not the one pi would continue. Reading every directory
 * instead cost a tenth of a millisecond for each — every working directory pi
 * was ever run in, one more per worktree — once per agent when Tade opens and
 * again each time one starts. In a directory they all share, pi carries on
 * only a session whose header says it was started in this one, and so here.
 */
export async function sessionFileFor(
  task: string,
  cwd: string,
  opts: SessionsAt = {},
): Promise<string | null> {
  const real = await realpath(cwd).catch(() => cwd)
  const { dir, shared } = opts.root
    ? { dir: sessionDirFor(real, opts.root), shared: false }
    : await sessionsOf(real, opts.env)
  const id = sessionIdFor(task)
  const entries = await readdir(dir).catch(() => [] as string[])
  // The name starts with a timestamp, so the newest sorts first here.
  const found = entries
    .filter((entry) => entry.endsWith(`_${id}.jsonl`))
    .sort()
    .reverse()
  for (const name of found) {
    const file = join(dir, name)
    if (!shared) return file
    const header = await headerOf(file)
    if (header?.id === id && header.cwd === real) return file
  }
  return null
}

/** How far into a session pi reads for its header (`MAX_SESSION_HEADER_SCAN_BYTES`). */
const HEADER_BYTES = 1024 * 1024

/**
 * A session's header as pi reads it — the first line that parses, which must
 * be the session's own — with the working directory resolved, or null.
 */
async function headerOf(file: string): Promise<{ id: string; cwd: string | null } | null> {
  const handle = await open(file, 'r').catch((err: NodeJS.ErrnoException) => {
    // Gone since it was listed, so not a session pi would find either.
    if (err.code === 'ENOENT') return null
    throw new Error(`could not read ${file}: ${err.message}`)
  })
  if (!handle) return null
  try {
    const { buffer, bytesRead } = await handle.read(
      Buffer.allocUnsafe(HEADER_BYTES),
      0,
      HEADER_BYTES,
      0,
    )
    for (const line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
      let entry: unknown
      try {
        entry = JSON.parse(line)
      } catch (err) {
        // pi skips a line that does not parse on its way to the header.
        if (err instanceof SyntaxError) continue
        throw err
      }
      if (!entry) continue
      const { type, id, cwd } = entry as Record<string, unknown>
      if (type !== 'session' || typeof id !== 'string') return null
      return { id, cwd: typeof cwd === 'string' && cwd ? resolve(cwd) : null }
    }
    return null
  } finally {
    await handle.close()
  }
}

/** What a session has cost so far: every entry pi priced, as its own totals count them. */
export async function usageOf(file: string): Promise<SessionUsage> {
  const total = noUsage()
  const text = await readFile(file, 'utf8').catch(() => '')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      // A half-written last line is what a live session looks like.
      continue
    }
    const spent = spentBy(entry)
    if (!spent) continue
    total.input += spent.input
    total.output += spent.output
    total.cacheRead += spent.cacheRead
    total.cacheWrite += spent.cacheWrite
    total.tokens += spent.tokens
    total.usd += spent.usd
    total.messages += 1
    total.model = modelOfMessage((entry as { message?: unknown }).message) ?? total.model
  }
  return total
}

/** What a task's agent has cost, from pi's own record. Zero if it has none. */
export async function usageOfTask(
  task: string,
  cwd: string,
  opts: SessionsAt = {},
): Promise<SessionUsage> {
  const file = await sessionFileFor(task, cwd, opts)
  return file ? usageOf(file) : noUsage()
}

/**
 * A page of a task's conversation, out of pi's own session (`historyIn`).
 *
 * A headless run keeps its session flat in `headless` (`--session-dir`), and
 * one in a lane where pi files it (`sessionsOf`); the first found is it.
 */
export async function historyOfTask(
  task: string,
  cwd: string,
  ask: HistoryAsk,
  opts: SessionsAt & { headless?: string } = {},
): Promise<HistoryPage> {
  return historyIn(await conversationFileOf(task, cwd, opts), ask, historyLine)
}

/** One call's whole answer, out of the session file of a task's conversation (`answerIn`). */
export async function answerOfTask(
  task: string,
  cwd: string,
  call: string,
  opts: SessionsAt & { headless?: string } = {},
): Promise<ToolAnswer | null> {
  return answerIn(await conversationFileOf(task, cwd, opts), call, historyLine)
}

/** The file a task's conversation is in: a headless run's, newest first, else its session's. */
async function conversationFileOf(
  task: string,
  cwd: string,
  opts: SessionsAt & { headless?: string },
): Promise<string | null> {
  const suffix = `_${sessionIdFor(task)}.jsonl`
  const flat = opts.headless
    ? (await readdir(opts.headless).catch(() => [] as string[]))
        .filter((name) => name.endsWith(suffix))
        .sort()
        .map((name) => join(opts.headless ?? '', name))
    : []
  return flat.at(-1) ?? (await sessionFileFor(task, cwd, opts).catch(() => null))
}

/** What one session line says, or null for anything that is not a message of the conversation. */
export function historyLine(text: string): HistoryLine | null {
  let entry: unknown
  try {
    entry = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null) return null
  const { type, message, timestamp } = entry as Record<string, unknown>
  if (type !== 'message' || typeof message !== 'object' || message === null) return null
  const { role, content, toolCallId, isError } = message as Record<string, unknown>
  const at = momentOf(timestamp)
  const parts: Record<string, unknown>[] =
    typeof content === 'string'
      ? [{ type: 'text', text: content }]
      : Array.isArray(content)
        ? content.filter(
            (part): part is Record<string, unknown> => typeof part === 'object' && part !== null,
          )
        : []
  const words = parts.flatMap((part) =>
    part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
  )
  const line: HistoryLine = { items: [], results: [], opens: false }
  if (role === 'user') {
    const images = parts.filter((part) => part.type === 'image').map(() => 'picture')
    if (words.join('').trim() === '' && images.length === 0) return line
    line.items.push({ kind: 'sent', text: words.join('\n'), images, at })
    line.opens = true
  } else if (role === 'assistant') {
    for (const part of parts) {
      if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
        line.items.push({ kind: 'reply', text: part.text, at })
      } else if (part.type === 'toolCall' && typeof part.id === 'string') {
        line.items.push({
          kind: 'tool',
          id: part.id,
          tool: String(part.name ?? ''),
          input: part.arguments ?? {},
          ok: null,
          result: null,
          at,
        })
      }
    }
  } else if (role === 'toolResult' && typeof toolCallId === 'string') {
    const failed = isError === true
    line.results.push({
      id: toolCallId,
      ok: !failed,
      result: words.join('\n'),
    })
  } else {
    return null
  }
  return line
}
