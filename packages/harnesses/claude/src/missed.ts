import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

// The end of a turn Tade was not there to hear, kept for the window that comes
// back to the agent.
//
// Under tmux an agent outlives the window, and each of its hooks is a process
// that asks once and exits: a Stop that found nobody listening was gone, so a
// done rule, a turn count and the news waited on a `turn_done` that never came.
// So the hook that could not say it leaves it beside the run's socket, and the
// adapter that takes the run back says it once, stamped when it ended — what
// pi's extension does in memory (`missed`), since it is still running.
//
// One, however many ended: it says a turn ended since, not how many. A turn
// begun after it, unheard too, is written on it, so what is said after it —
// idle, or a turn under way — is what is true.
//
// Loaded by Claude Code's own processes, like `ask.ts`: Node's built-ins and
// nothing of ours.

/** What a hook nobody heard left: the event that ended a turn, when, and when one began since. */
export interface Missed {
  at: number
  event: Record<string, unknown>
  began?: number
}

/** The hooks that end a turn. */
const ENDS = new Set(['Stop', 'StopFailure'])

/** Where a run's missed turn is kept: beside its socket, which only its own hooks are told. */
export function missedPath(socket: string): string {
  return `${socket}.missed`
}

/**
 * Leave what a hook nobody heard has to say, where it is something a window
 * coming back must be told. Never throws: a hook carries on regardless, and
 * one that cannot leave it says why on its standard error — the agent's own
 * log, the one place left to say it — and is where things were before this.
 */
export function leave(socket: string, event: Record<string, unknown>, now = Date.now()): void {
  const path = missedPath(socket)
  const name = event.hook_event_name
  try {
    if (typeof name === 'string' && ENDS.has(name)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(path, JSON.stringify({ at: now, event }), { mode: 0o600 })
    } else if (name === 'UserPromptSubmit' && existsSync(path)) {
      const kept = missedIn(readFileSync(path, 'utf8'))
      if (kept) writeFileSync(path, JSON.stringify({ ...kept, began: now }), { mode: 0o600 })
    }
  } catch (err) {
    process.stderr.write(
      `tade: could not keep a turn that ended while Tade was away, so it will not be said: ${(err as Error).message}\n`,
    )
  }
}

/**
 * What was left for this run, taken, so it is said once: moved aside before it
 * is read, so a hook leaving one at the same moment leaves it for next time
 * rather than having it removed unsaid. Null when nothing was. What was left
 * and is not a record throws, because that is not no turn having ended; so does
 * one that cannot be taken, since it would be said again.
 */
export async function takeMissed(socket: string): Promise<Missed | null> {
  const taking = `${missedPath(socket)}.taking`
  try {
    await rename(missedPath(socket), taking)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const text = await readFile(taking, 'utf8')
  await rm(taking, { force: true })
  const missed = missedIn(text)
  if (!missed) throw new Error(`what was left at ${missedPath(socket)} is not a turn that ended`)
  return missed
}

/** A kept record, or null on any other shape. */
export function missedIn(text: string): Missed | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { at, event, began } = raw as { at?: unknown; event?: unknown; began?: unknown }
  if (typeof at !== 'number' || typeof event !== 'object' || event === null) return null
  if (Array.isArray(event)) return null
  return {
    at,
    event: event as Record<string, unknown>,
    ...(typeof began === 'number' ? { began } : {}),
  }
}

/**
 * A permission prompt a hook answered by rule while nobody heard it
 * (`hook.ts`): what the journal would have had from the window, kept to be
 * said by the one that comes back. Every one, not the last: each is its own
 * answer, unlike a turn ending.
 */
export interface AnsweredAway {
  at: number
  /** The tool as Claude Code named it. */
  tool: string
  input: unknown
  answered: { allowed: boolean; rule: string; reason: string }
}

/** Where a run's prompts answered with Tade away are kept, one JSON line each. */
export function answeredPath(socket: string): string {
  return `${socket}.answered`
}

/**
 * Keep a prompt this hook answered with nobody to hear it. Never throws, and
 * says why on standard error where it cannot, like `leave`.
 */
export function leaveAnswer(
  socket: string,
  prompt: Omit<AnsweredAway, 'at'>,
  now = Date.now(),
): void {
  const path = answeredPath(socket)
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    appendFileSync(path, `${JSON.stringify({ at: now, ...prompt })}\n`, { mode: 0o600 })
  } catch (err) {
    process.stderr.write(
      `tade: could not keep a permission prompt answered while Tade was away, so it will not be said: ${(err as Error).message}\n`,
    )
  }
}

/**
 * What was left for this run, taken once, the same way as `takeMissed`: in the
 * order they were answered, with how many lines were not one counted rather
 * than passed over. Throws only where it cannot be taken.
 */
export async function takeAnswered(
  socket: string,
): Promise<{ answered: AnsweredAway[]; unread: number }> {
  const taking = `${answeredPath(socket)}.taking`
  try {
    await rename(answeredPath(socket), taking)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { answered: [], unread: 0 }
    throw err
  }
  const text = await readFile(taking, 'utf8')
  await rm(taking, { force: true })
  const answered: AnsweredAway[] = []
  let unread = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const one = answeredIn(line)
    if (one) answered.push(one)
    else unread++
  }
  return { answered, unread }
}

/** One kept answer, or null on any other shape. */
export function answeredIn(line: string): AnsweredAway | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (err) {
    if (err instanceof SyntaxError) return null
    throw err
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const { at, tool, input, answered } = raw as Record<string, unknown>
  if (typeof at !== 'number' || typeof tool !== 'string') return null
  if (typeof answered !== 'object' || answered === null) return null
  const { allowed, rule, reason } = answered as Record<string, unknown>
  if (typeof allowed !== 'boolean' || typeof rule !== 'string' || typeof reason !== 'string') {
    return null
  }
  return { at, tool, input, answered: { allowed, rule, reason } }
}
