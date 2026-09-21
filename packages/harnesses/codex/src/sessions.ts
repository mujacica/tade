import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type HarnessSpend, noHarnessSpend, type PlanLimits } from '@tade/harnesses-core'

// Reading what an agent did out of Codex's own records, rather than out of
// what it told us at the time.
//
// Codex keeps one JSONL file per conversation under
// `<home>/sessions/YYYY/MM/DD/rollout-<when>-<thread>.jsonl`, a line per thing
// that happened: `session_meta` once, then `turn_context`, `response_item`,
// `event_msg` and `token_usage_record`. The format is Codex's own and moves
// between releases, so everything here skips what it does not recognise and
// answers `null` or nothing-spent rather than throwing — a record we cannot
// read is a gap, never an error.
//
// The one thing Codex will not take from us is the name of a new conversation:
// it makes the thread id itself. So Tade writes down the id its agent's first
// hook reported, beside the task, and that file is what the launch line reads
// to come back to the same conversation.

/** Where Codex keeps its sign-in, config, sessions and state, unless told otherwise. */
export function defaultHome(home = homedir()): string {
  return join(home, '.codex')
}

/**
 * The conversation a task's agent talks in, as Tade files it: a digest of the
 * task's name, made the same way every time, because that is what makes coming
 * back ordinary. Codex names the thread itself, so this names the note Tade
 * keeps of which thread that was.
 */
export function conversationKey(task: string): string {
  return createHash('sha1').update(`tade:${task}`).digest('hex').slice(0, 24)
}

/** Where Tade writes down which Codex thread a task's agent talks in. */
export function threadFile(task: string, stateDir: string): string {
  return join(stateDir, 'codex', conversationKey(task), 'thread')
}

/** The thread a task's agent talks in, as last written down. Null when it has none. */
export async function threadOf(task: string, stateDir: string): Promise<string | null> {
  const said = await readFile(threadFile(task, stateDir), 'utf8').catch(() => '')
  const id = said.trim()
  return id.length > 0 ? id : null
}

/** Write down the thread Codex made for a task, so the next launch comes back to it. */
export async function rememberThread(
  task: string,
  stateDir: string,
  thread: string,
): Promise<void> {
  const file = threadFile(task, stateDir)
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
  await writeFile(file, `${thread}\n`, { mode: 0o600 })
}

/**
 * The file Codex wrote a thread to, wherever it filed it by date. Null when
 * there is none — a thread nobody has talked in yet, or one whose day's folder
 * has been cleared out.
 */
export async function rolloutFor(thread: string, codexHome: string): Promise<string | null> {
  const root = join(codexHome, 'sessions')
  const ends = `-${thread}.jsonl`
  // Newest day first: a thread is in exactly one, and the newest is the
  // cheapest place to find one that is being written right now.
  for (const year of await sorted(root)) {
    for (const month of await sorted(join(root, year))) {
      for (const day of await sorted(join(root, year, month))) {
        const dir = join(root, year, month, day)
        for (const file of await sorted(dir)) {
          if (file.endsWith(ends)) return join(dir, file)
        }
      }
    }
  }
  return null
}

async function sorted(dir: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => [] as string[])
  return entries.sort().reverse()
}

/** One rollout line, when it is one: `{type, payload}` and nothing assumed of the payload. */
function entries(text: string): { type: string; payload: Record<string, unknown> }[] {
  const found: { type: string; payload: Record<string, unknown> }[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      // A half-written last line is what a live rollout looks like.
      continue
    }
    if (typeof raw !== 'object' || raw === null) continue
    const { type, payload } = raw as { type?: unknown; payload?: unknown }
    if (typeof type !== 'string') continue
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) continue
    found.push({ type, payload: payload as Record<string, unknown> })
  }
  return found
}

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

/** A Codex token count, in Tade's words. Null when the shape is not one we know. */
function tokensIn(usage: Record<string, unknown> | null): Omit<HarnessSpend, 'messages' | 'model'> {
  const cacheRead = count(usage?.cached_input_tokens)
  const billed = count(usage?.input_tokens)
  const output = count(usage?.output_tokens)
  const cacheWrite = count(usage?.cache_write_input_tokens)
  // Codex counts what was read from the cache inside `input_tokens`; Tade
  // keeps the two apart, as every other harness reports them.
  const input = Math.max(0, billed - cacheRead)
  const total = count(usage?.total_tokens) || billed + output
  return { input, output, cacheRead, cacheWrite, tokens: total, usd: 0 }
}

/**
 * What a rollout has spent, in tokens. Codex keeps a running total of the
 * thread on every `token_count`, so the last one is the answer; a rollout from
 * a release that wrote none is added up from its per-response records instead.
 * It records no price anywhere, so dollars stay zero rather than invented.
 */
export function spentIn(text: string): HarnessSpend {
  const total = noHarnessSpend()
  let running: Record<string, unknown> | null = null
  let responses = 0
  const summed = noHarnessSpend()
  for (const { type, payload } of entries(text)) {
    if (type === 'turn_context' && typeof payload.model === 'string') {
      total.model = payload.model
    } else if (type === 'session_meta' && typeof payload.model === 'string') {
      total.model ??= payload.model
    } else if (type === 'token_usage_record') {
      const one = tokensIn(record(payload.usage))
      if (one.tokens <= 0) continue
      responses += 1
      summed.input += one.input
      summed.output += one.output
      summed.cacheRead += one.cacheRead
      summed.cacheWrite += one.cacheWrite
      summed.tokens += one.tokens
    } else if (type === 'event_msg' && payload.type === 'token_count') {
      const info = record(payload.info)
      const said = record(info?.total_token_usage)
      if (said) running = said
    }
  }
  const from = running ? tokensIn(running) : responses > 0 ? summed : null
  if (!from) return total
  Object.assign(total, from)
  total.messages = responses > 0 ? responses : total.tokens > 0 ? 1 : 0
  return total
}

/** What a task's agent has spent, from Codex's own record. Nothing, when it has none. */
export async function spentOn(
  task: string,
  stateDir: string,
  codexHome: string,
): Promise<HarnessSpend> {
  const thread = await threadOf(task, stateDir)
  if (!thread) return noHarnessSpend()
  const file = await rolloutFor(thread, codexHome)
  if (!file) return noHarnessSpend()
  return spentIn(await readFile(file, 'utf8').catch(() => ''))
}

/** The model a rollout's last turn ran on, as Codex wrote it down. */
export function modelIn(text: string): string | null {
  return spentIn(text).model
}

/**
 * How full the context is, as Codex last counted it: the thread's own total
 * against the window its model has. Null until it has counted once.
 */
export function contextIn(text: string): { tokens: number; percent: number | null } | null {
  let found: { tokens: number; percent: number | null } | null = null
  for (const { type, payload } of entries(text)) {
    if (type !== 'event_msg' || payload.type !== 'token_count') continue
    const info = record(payload.info)
    const tokens = count(record(info?.total_token_usage)?.total_tokens)
    const window = count(info?.model_context_window)
    if (tokens <= 0) continue
    found = { tokens, percent: window > 0 ? Math.min(100, (tokens / window) * 100) : null }
  }
  return found
}

/**
 * How much of the plan is used, as Codex last heard from the service. Codex
 * names its windows by how many minutes they cover rather than by "five hours"
 * and "a week", so the shorter of the two is read as the short window and the
 * longer as the long one.
 */
export function limitsIn(text: string, at: number): PlanLimits | null {
  let limits: Record<string, unknown> | null = null
  for (const { type, payload } of entries(text)) {
    if (type !== 'event_msg' || payload.type !== 'token_count') continue
    const said = record(payload.rate_limits)
    if (said) limits = said
  }
  if (!limits) return null
  const window = (value: unknown) => {
    const one = record(value)
    if (!one || typeof one.used_percent !== 'number') return null
    return {
      used: one.used_percent,
      resetsAt: count(one.resets_at) * 1000,
      minutes: count(one.window_minutes),
    }
  }
  const both = [window(limits.primary), window(limits.secondary)].filter((one) => one !== null)
  if (both.length === 0) return null
  const order = [...both].sort((a, b) => a.minutes - b.minutes)
  const short = order[0] ?? null
  const long = order.length > 1 ? (order.at(-1) ?? null) : null
  const said = (one: { used: number; resetsAt: number } | null) =>
    one ? { used: one.used, resetsAt: one.resetsAt } : null
  return { at, fiveHour: said(short), sevenDay: said(long) }
}

/**
 * Who a Codex home is signed in as, from the claims in the sign-in it keeps.
 * Read rather than asked because `codex login status` says only how, not who;
 * the token itself is never read out, kept or passed on.
 */
export async function whoIn(
  codexHome: string,
): Promise<{ who: string | null; plan: string | null }> {
  const none = { who: null, plan: null }
  const text = await readFile(join(codexHome, 'auth.json'), 'utf8').catch(() => '')
  if (!text.trim()) return none
  let auth: unknown
  try {
    auth = JSON.parse(text)
  } catch {
    return none
  }
  const token = record(record(auth)?.tokens)?.id_token
  if (typeof token !== 'string') return none
  const claims = claimsIn(token)
  if (!claims) return none
  const profile = record(claims['https://api.openai.com/auth'])
  const email = claims.email
  const plan = profile?.chatgpt_plan_type
  return {
    who: typeof email === 'string' ? email : null,
    plan: typeof plan === 'string' ? plan : null,
  }
}

/** The middle of a JWT, as an object. Null for anything that is not one. */
function claimsIn(token: string): Record<string, unknown> | null {
  const middle = token.split('.')[1]
  if (!middle) return null
  try {
    return record(JSON.parse(Buffer.from(middle, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}
