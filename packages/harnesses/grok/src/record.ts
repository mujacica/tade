import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  answerIn,
  type HarnessSpend,
  type HistoryAsk,
  type HistoryItem,
  type HistoryLine,
  type HistoryPage,
  historyIn,
  ifMissing,
  noHarnessSpend,
  type ToolAnswer,
} from '@tade/harnesses-core'

// Reading what a Grok agent did out of Grok's own record of the session,
// rather than out of what it told us at the time.
//
// Grok keeps a folder per session at
// `$GROK_HOME/sessions/<the working directory, URL-encoded>/<session id>/`. In
// it `updates.jsonl` is the authoritative, append-only log — one ACP session
// update per line (`session/update`), and Grok's own (`_x.ai/session/update`)
// for what ACP has no word for: a turn that completed, with what it used, a
// hook that ran, a retry. `usage.json` and `grok usage <id>` hold the same
// counts per turn, and `grok usage` is the interface Grok promises; it is what
// a live run asks (`usageOf`), and this file is what is read when no process
// should be started for it — on opening, for every task at once.
//
// The folder is named by the session id, which is ours (`sessionIdFor`), so a
// task's is found by that name under any working directory: an encoding of the
// path is Grok's business and a liability to reimplement for finding, and is
// only used to list a folder's sessions (`sessions.ts`). The format is
// private: anything not recognised is skipped, and a record that cannot be
// read is a gap, never an error.

/**
 * The conversation a task's agent talks in, for the life of the task: a UUID
 * made from the task's name, because Grok takes a UUID and nothing else
 * (`-s/--session-id`), made the same way every time, because that is what
 * makes coming back ordinary.
 */
export function sessionIdFor(task: string): string {
  const hash = createHash('sha1').update(`tade:${task}`).digest()
  // A name-based UUID (version 5, RFC 4122 variant), so it reads as one.
  hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50
  hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80
  const hex = hash.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** A session's folder, by its id, wherever Grok filed it in this account. Null when it has none. */
export async function sessionFolder(id: string, home: string): Promise<string | null> {
  const root = join(home, 'sessions')
  const dirs = await readdir(root).catch(ifMissing([] as string[]))
  for (const dir of dirs) {
    const folder = join(root, dir, id)
    const said = await stat(folder).catch(ifMissing(null))
    if (said?.isDirectory()) return folder
  }
  return null
}

/** A task's session folder, wherever Grok filed it. Null when it has none. */
export function folderFor(task: string, home: string): Promise<string | null> {
  return sessionFolder(sessionIdFor(task), home)
}

/** A task's record (`updates.jsonl`), when its session has been started. */
export async function recordFor(task: string, home: string): Promise<string | null> {
  const folder = await folderFor(task, home)
  return folder ? join(folder, 'updates.jsonl') : null
}

type Json = Record<string, unknown>

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/** One line of the record, as the update it carries and when; null for anything else. */
export function updateIn(line: string): { update: Json; at: number; meta: Json } | null {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof entry !== 'object' || entry === null) return null
  const { method, params, timestamp, timestamp_us } = entry as Json
  if (method !== 'session/update' && method !== '_x.ai/session/update') return null
  const update = (params as Json | undefined)?.update
  if (typeof update !== 'object' || update === null) return null
  const at =
    typeof timestamp_us === 'number'
      ? Math.round(timestamp_us / 1000)
      : typeof timestamp === 'number'
        ? timestamp * 1000
        : 0
  const meta = ((params as Json).update as Json)._meta
  return {
    update: update as Json,
    at,
    meta: typeof meta === 'object' && meta !== null ? (meta as Json) : {},
  }
}

/**
 * What one turn used, in Tade's terms, out of the counts Grok keeps for it
 * (`turn_completed.usage`, `grok usage`'s `turns[]`, `usage.json`).
 *
 * Grok's `inputTokens` is every prompt token, the cached ones included — its
 * status line says `input_tokens`, `cache_read_input_tokens` and
 * `cache_creation_input_tokens` sum back to it — where every other harness
 * reports them apart, so they are taken out once, here. Its `totalTokens` is
 * the turn's whole count: whatever of it is neither prompt nor `outputTokens`
 * is reasoning, which is billed as output, so it is counted there rather than
 * left out. Dollars are `costUsdTicks`, ten billion to the dollar, which Grok
 * stamps on traffic it priced and leaves off a plan's: absent is unknown,
 * never free, and is nought here only because `usd` is a sum.
 */
export function turnSpend(usage: Json): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  usd: number
  model: string | null
} {
  const prompt = count(usage.inputTokens)
  const cacheRead = count(usage.cachedReadTokens)
  const cacheWrite = count(usage.cacheCreationTokens)
  const said = count(usage.outputTokens)
  const total = count(usage.totalTokens)
  const output = Math.max(said, total - prompt)
  const tokens = Math.max(total, prompt + said)
  const models = usage.modelUsage
  const named =
    typeof usage.primaryModelId === 'string'
      ? usage.primaryModelId
      : typeof models === 'object' && models !== null
        ? (Object.keys(models).at(-1) ?? null)
        : null
  return {
    input: Math.max(0, prompt - cacheRead - cacheWrite),
    output,
    cacheRead,
    cacheWrite,
    tokens,
    usd: count(usage.costUsdTicks) / 1e10,
    model: named,
  }
}

/** Add one turn's use into a running total. */
export function addTurn(total: HarnessSpend, usage: Json): void {
  const turn = turnSpend(usage)
  if (turn.tokens <= 0 && turn.usd <= 0) return
  total.input += turn.input
  total.output += turn.output
  total.cacheRead += turn.cacheRead
  total.cacheWrite += turn.cacheWrite
  total.tokens += turn.tokens
  total.usd += turn.usd
  total.messages += 1
  if (turn.model) total.model = turn.model
}

/**
 * What a record has spent: the sum of what each completed turn says it used.
 * A turn that was cut short says nothing, and is not guessed at.
 */
export function spentIn(text: string): HarnessSpend {
  const total = noHarnessSpend()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const one = updateIn(line)
    if (one?.update.sessionUpdate !== 'turn_completed') continue
    const usage = one.update.usage
    if (typeof usage === 'object' && usage !== null) addTurn(total, usage as Json)
  }
  return total
}

/** What a task's agent has spent, from its record. Nothing, when it has none. */
export async function spentOn(task: string, home: string): Promise<HarnessSpend> {
  const file = await recordFor(task, home)
  if (!file) return noHarnessSpend()
  return spentIn(await readFile(file, 'utf8').catch(ifMissing('')))
}

/**
 * The hooks Grok records having run (`hook_execution`) that say no turn is
 * under way any more: a turn cut short or failed writes no `turn_completed`,
 * but the hook it ran does write a line, and so does the session ending.
 */
const ENDS = new Set(['stop_cancelled', 'stop_failure', 'session_end'])

/**
 * The turn under way at the end of a record, and when it began; null when
 * none is. What a window taking an agent back reads, because no hook says
 * anything until that turn ends: words sent to it that nothing since says
 * ended are a turn. A turn somebody stopped with Ctrl+C before anything was
 * answered may fire no hook at all, and so reads as under way until a hook or
 * a person says otherwise.
 */
export function turnIn(text: string): { since: number | null } | null {
  const lines = text.trimEnd().split('\n')
  for (let n = lines.length - 1; n >= 0; n--) {
    const one = updateIn(lines[n] ?? '')
    if (!one) continue
    const kind = one.update.sessionUpdate
    if (kind === 'turn_completed') return null
    if (kind === 'hook_execution' && ENDS.has(String(one.update.event_name))) return null
    if (kind === 'user_message_chunk') return { since: one.at || null }
  }
  return null
}

/** Tade's own tools, as Grok names an MCP server's: `<server>__<tool>`. */
export const OURS = 'tade__'

/**
 * A tool as Tade names it, and what it was given: Grok reaches an MCP server's
 * tools through its own `use_tool`, so that call is the tool it named, with
 * the input it passed; Tade's own lose their server's prefix.
 */
export function toolOf(name: string, input: unknown): { tool: string; input: unknown } {
  if (typeof input === 'object' && input !== null) {
    const { tool_name, tool_input } = input as Json
    // Its record names the call `use_tool`; its hooks name it by the tool it
    // reaches, with `use_tool`'s input still around the tool's own.
    if (
      typeof tool_name === 'string' &&
      tool_name &&
      (name === 'use_tool' || toolName(name) === toolName(tool_name))
    ) {
      return { tool: toolName(tool_name), input: tool_input ?? {} }
    }
  }
  return { tool: toolName(name), input }
}

/** Tade's own tools by their own names; everything else as Grok calls it. */
export function toolName(name: string): string {
  return name.startsWith(OURS) ? name.slice(OURS.length) : name
}

/** A picture it was pointed at, as `promptWithImages` writes one. */
const PICTURE = /^\[picture: (.+)\]$/

/** The words of a content block, or of a list of them. */
function wordsOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(wordsOf).join('\n')
  if (typeof content !== 'object' || content === null) return ''
  const { type, text, content: inner } = content as Json
  if (type === 'text' && typeof text === 'string') return text
  return inner === undefined ? '' : wordsOf(inner)
}

/**
 * What one line of the record says, or null for any line that is not a part
 * of the conversation as it was had: hooks that ran, retries, its thinking,
 * the commands it advertises, and anything unrecognised.
 *
 * A reply is recorded the way it streamed, a line per chunk, so a reply here
 * is a piece of one: `joinReplies` puts the pieces back together.
 */
export function historyLine(text: string): HistoryLine | null {
  const one = updateIn(text)
  if (!one) return null
  const { update, at } = one
  const line: HistoryLine = { items: [], results: [], opens: false }
  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      const said = wordsOf(update.content)
      if (!said.trim()) return null
      const kept = said.split('\n')
      const images: string[] = []
      while (kept.length > 0) {
        const picture = PICTURE.exec(kept.at(-1) ?? '')
        if (!picture?.[1]) break
        images.unshift(picture[1])
        kept.pop()
      }
      line.items.push({ kind: 'sent', text: kept.join('\n').trimEnd(), images, at })
      line.opens = true
      return line
    }
    case 'agent_message_chunk': {
      const said = wordsOf(update.content)
      if (!said) return null
      line.items.push({ kind: 'reply', text: said, at })
      return line
    }
    case 'tool_call': {
      const id = update.toolCallId
      if (typeof id !== 'string') return null
      const named = (update._meta as Json | undefined)?.['x.ai/tool'] as Json | undefined
      const name =
        typeof named?.name === 'string'
          ? named.name
          : typeof update.title === 'string'
            ? update.title
            : 'tool'
      const call = toolOf(name, update.rawInput ?? {})
      line.items.push({
        kind: 'tool',
        id,
        tool: call.tool,
        input: call.input,
        ok: null,
        result: null,
        at,
      })
      return line
    }
    case 'tool_call_update': {
      const id = update.toolCallId
      const status = update.status
      if (typeof id !== 'string' || (status !== 'completed' && status !== 'failed')) return null
      line.results.push({ id, ok: status === 'completed', result: wordsOf(update.content) })
      return line
    }
    default:
      return null
  }
}

/**
 * Replies put back together: the pieces of one reply are next to each other
 * in the record and nothing comes between them, so neighbouring replies are
 * one, said when its first piece was.
 */
export function joinReplies(items: readonly HistoryItem[]): HistoryItem[] {
  const joined: HistoryItem[] = []
  for (const item of items) {
    const last = joined.at(-1)
    if (item.kind === 'reply' && last?.kind === 'reply') {
      joined[joined.length - 1] = { ...last, text: last.text + item.text }
    } else {
      joined.push(item)
    }
  }
  return joined
}

/** A page of a task's conversation, out of its record (`historyIn`). */
export async function historyOn(task: string, home: string, ask: HistoryAsk): Promise<HistoryPage> {
  const page = await historyIn(await recordFor(task, home), ask, historyLine)
  return { ...page, items: joinReplies(page.items) }
}

/** One call's whole answer, out of the record of a task's conversation (`answerIn`). */
export async function answerOn(
  task: string,
  home: string,
  call: string,
): Promise<ToolAnswer | null> {
  return answerIn(await recordFor(task, home), call, historyLine)
}
