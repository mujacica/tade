import { createHash } from 'node:crypto'
import {
  type HarnessSpend,
  type HistoryAsk,
  type HistoryItem,
  type HistoryPage,
  headOf,
  momentOf,
  NO_HISTORY,
  noHarnessSpend,
  oneLine,
  type ToolAnswer,
} from '@tade/harnesses-core'

// Reading what an OpenCode agent did out of OpenCode's own record of it.
//
// OpenCode V2 keeps every session in one SQLite database, event-sourced and
// private: its tables are its business and have changed shape once already.
// What it promises is `opencode session export <id>`, one JSON document —
// `{ info, messages }` — with the session's totals on `info` and every message
// after it: what was sent (`user`), each step the model took (`assistant`, its
// `content` the text and tool calls of that step, with what the step used and
// cost), and an `idle` line, with how it came out, each time a turn ended.
// This file reads that document and nothing else, so nothing outside the
// adapter knows OpenCode keeps a database at all. Anything not recognised is
// skipped, and a document that is not one is null — never an error.

/**
 * The conversation a task's agent talks in, for the life of the task: made
 * from the task's name, the same way every time, because `-s` both starts a
 * session under an id it is given and comes back to one it has — which is
 * what makes coming back ordinary. OpenCode takes any id that starts `ses`.
 */
export function sessionIdFor(task: string): string {
  return `ses_tade${createHash('sha1').update(`tade:${task}`).digest('hex').slice(0, 22)}`
}

type Json = Record<string, unknown>

/** One of OpenCode's records of a session, as `session export` prints it. */
export interface Exported {
  info: Json
  messages: Json[]
}

const obj = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/** What `session export` printed, as a session; null for anything that is not one. */
export function exportedIn(text: string): Exported | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const doc = obj(parsed)
  const info = obj(doc?.info)
  if (!doc || !info || !Array.isArray(doc.messages) || !str(info.id)) return null
  return { info, messages: doc.messages.map(obj).filter((one): one is Json => one !== null) }
}

/**
 * How a compaction Tade asked for came out, as the record says: the message it
 * left is filed under the id `session.compact` answered with, `completed` or
 * `failed` with OpenCode's own words. Null where the record has no word of it
 * — the compaction never ran, or has not ended.
 */
export function compactionOf(
  exported: Exported | null,
  id: string,
): { done: true } | { failed: string } | null {
  const message = exported?.messages.find((one) => one.type === 'compaction' && one.id === id)
  if (message?.status === 'completed') return { done: true }
  if (message?.status !== 'failed') return null
  const error = obj(message.error)
  return { failed: str(error?.message) ?? str(error?.type) ?? 'OpenCode did not say why' }
}

/** `provider/id`, as a step names the model it ran on. Null where it does not say. */
export function modelOfStep(message: Json): string | null {
  const model = obj(message.model)
  const id = str(model?.id)
  const provider = str(model?.providerID)
  if (!id) return null
  return provider ? `${provider}/${id}` : id
}

/** The provider a step ran on, as OpenCode names it. */
export function providerOfStep(message: Json): string | null {
  return str(obj(message.model)?.providerID)
}

/**
 * What one step used, Tade's way: OpenCode already counts input apart from
 * what was read from the cache, and its reasoning is output the model was
 * paid for, so it goes in with the output.
 */
export function stepSpend(message: Json): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  usd: number
} {
  const tokens = obj(message.tokens)
  const cache = obj(tokens?.cache)
  const input = count(tokens?.input)
  const output = count(tokens?.output) + count(tokens?.reasoning)
  const cacheRead = count(cache?.read)
  const cacheWrite = count(cache?.write)
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    tokens: input + output + cacheRead + cacheWrite,
    usd: count(message.cost),
  }
}

/**
 * Whether a plan paid for a step. OpenCode records a plan's turn as costing
 * nothing — "usage counts against your plan, so these models show no cost" —
 * and a step it could not price at all the same way, so the record alone can
 * never tell a plan from a free model. Which provider it ran on, and how this
 * account reaches that provider, can (`planPays`, `plan.ts`).
 */
export type PlanOf = (provider: string | null, usd: number) => boolean

/**
 * What a record has spent: the sum of every step that used something, and of
 * every compaction — a call to a model of its own, which OpenCode files on the
 * `compaction` message it leaves, done or failed, and never on a step. The
 * dollars are only what nobody's plan paid for, and what a plan paid for is
 * counted apart (`plan`), so a plan's `cost: 0` is never money of nought.
 */
export function spentIn(exported: Exported | null, planOf: PlanOf): HarnessSpend {
  const total = noHarnessSpend()
  if (!exported) return total
  const onPlan = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, messages: 0 }
  for (const message of exported.messages) {
    const reply = message.type === 'assistant'
    if (!reply && message.type !== 'compaction') continue
    const step = stepSpend(message)
    if (step.tokens <= 0 && step.usd <= 0) continue
    const plan = planOf(providerOfStep(message), step.usd)
    total.input += step.input
    total.output += step.output
    total.cacheRead += step.cacheRead
    total.cacheWrite += step.cacheWrite
    total.tokens += step.tokens
    if (!plan) total.usd += step.usd
    total.messages += 1
    // A summary is not a reply: the model it ran on may be one set aside for compacting.
    if (reply) total.model = modelOfStep(message) ?? total.model
    if (plan) {
      onPlan.input += step.input
      onPlan.output += step.output
      onPlan.cacheRead += step.cacheRead
      onPlan.cacheWrite += step.cacheWrite
      onPlan.tokens += step.tokens
      onPlan.messages += 1
    }
  }
  if (onPlan.messages > 0) total.plan = onPlan
  return total
}

/**
 * The turn under way at the end of a record, and when it began; null when
 * none is. Every turn OpenCode finishes — done, failed or stopped — ends in an
 * `idle` line, so something sent after the last of those is a turn still
 * running: what a window taking an agent back reads, because nothing else
 * says so until that turn ends.
 */
export function turnIn(exported: Exported | null): { since: number | null } | null {
  if (!exported) return null
  for (let n = exported.messages.length - 1; n >= 0; n--) {
    const message = exported.messages[n] as Json
    if (message.type === 'idle') return null
    if (message.type === 'user') return { since: momentOf(obj(message.time)?.created, 0) || null }
  }
  return null
}

/** How the last turn ended, as its `idle` line says: `succeeded`, `failed`, `interrupted`. */
export function lastOutcome(exported: Exported | null): string | null {
  if (!exported) return null
  for (let n = exported.messages.length - 1; n >= 0; n--) {
    const message = exported.messages[n] as Json
    if (message.type === 'idle') return str(message.outcome)
    if (message.type === 'user') return null
  }
  return null
}

/** A tool call's answer as its step recorded it: every text it gave back, whole. */
function answerOfPart(part: Json): ToolAnswer | null {
  const state = obj(part.state)
  const status = str(state?.status)
  if (!state || !status || status === 'pending' || status === 'running') return null
  const texts: string[] = []
  for (const piece of Array.isArray(state.content) ? state.content : []) {
    const text = str(obj(piece)?.text)
    if (text) texts.push(text)
  }
  if (status === 'error') {
    const error = obj(state.error)
    const said = str(error?.message) ?? str(state.error) ?? ''
    return { ok: false, result: [said, ...texts].filter(Boolean).join('\n') }
  }
  return { ok: status === 'completed', result: texts.join('\n') }
}

/** Tade's own tools, as OpenCode names an MCP server's: `<server>_<tool>`. */
export const OURS = 'tade_'

/** A tool as Tade names it: Tade's own lose their server's prefix, every other is OpenCode's name. */
export function toolName(name: string): string {
  return name.startsWith(OURS) ? name.slice(OURS.length) : name
}

/** What one message says, as history: what was sent, what was said back, what was reached for. */
function itemsOf(message: Json): { items: HistoryItem[]; opens: boolean } {
  const at = momentOf(obj(message.time)?.created, 0)
  if (message.type === 'user') {
    const text = typeof message.text === 'string' ? message.text : ''
    const images: string[] = []
    for (const file of Array.isArray(message.files) ? message.files : []) {
      const one = obj(file)
      const name = str(one?.path) ?? str(one?.filename) ?? str(one?.name)
      if (name || str(one?.mime)?.startsWith('image/')) images.push(name ?? 'picture')
    }
    return { items: [{ kind: 'sent', text, images, at }], opens: true }
  }
  if (message.type !== 'assistant') return { items: [], opens: false }
  const items: HistoryItem[] = []
  for (const piece of Array.isArray(message.content) ? message.content : []) {
    const part = obj(piece)
    if (!part) continue
    if (part.type === 'text') {
      const text = typeof part.text === 'string' ? part.text.trim() : ''
      if (text) items.push({ kind: 'reply', text, at })
    } else if (part.type === 'tool') {
      const id = str(part.id) ?? ''
      const answer = answerOfPart(part)
      const head = answer ? headOf(answer.result) : null
      items.push({
        kind: 'tool',
        id,
        tool: toolName(str(part.name) ?? 'tool'),
        input: obj(part.state)?.input ?? {},
        ok: answer ? answer.ok : null,
        result: head ? head.result : null,
        ...(head?.cut ? { cut: true as const } : {}),
        at: momentOf(obj(part.time)?.created, at),
      })
    }
  }
  return { items, opens: false }
}

/**
 * A page of what was said, from the newest end: at least `ask.limit` items,
 * back to something sent, so a tool and its answer are never split — the
 * whole record is one document, so a page is an index into its messages
 * (`earlier`) rather than an offset into a file.
 */
export function historyOf(exported: Exported | null, ask: HistoryAsk): HistoryPage {
  if (!exported) return NO_HISTORY
  const all = exported.messages
  const before = ask.before === undefined || ask.before === null ? all.length : Number(ask.before)
  if (!Number.isInteger(before) || before < 0 || before > all.length) return NO_HISTORY
  const pages: HistoryItem[][] = []
  let count = 0
  let start = 0
  for (let n = before - 1; n >= 0; n--) {
    const { items, opens } = itemsOf(all[n] as Json)
    pages.push(items)
    count += items.length
    if (count >= ask.limit && opens) {
      start = n
      break
    }
  }
  return { items: pages.reverse().flat(), earlier: start > 0 ? String(start) : null }
}

/** The whole of what one call answered, by its id; null where nothing answered it. */
export function answerOf(exported: Exported | null, call: string): ToolAnswer | null {
  if (!exported || call === '') return null
  for (let n = exported.messages.length - 1; n >= 0; n--) {
    const message = exported.messages[n] as Json
    if (message.type !== 'assistant') continue
    for (const piece of Array.isArray(message.content) ? message.content : []) {
      const part = obj(piece)
      if (part?.type === 'tool' && part.id === call) return answerOfPart(part)
    }
  }
  return null
}

/** The first thing sent in a record, on one line: what a person picking a session up sees. */
export function firstSaid(exported: Exported | null): string {
  for (const message of exported?.messages ?? []) {
    if (message.type === 'user' && typeof message.text === 'string' && message.text.trim()) {
      return oneLine(message.text)
    }
  }
  return ''
}

/** The record as another session's: the same conversation under the id it is to be known by. */
export function renamedTo(exported: Exported, id: string): Exported {
  const from = str(exported.info.id)
  const text = JSON.stringify(exported)
  // Its id is named in every message that says which session it belongs to,
  // and nowhere as part of anything else: it is OpenCode's own `ses_…` token.
  const moved = from ? text.split(JSON.stringify(from)).join(JSON.stringify(id)) : text
  return exportedIn(moved) ?? { ...exported, info: { ...exported.info, id } }
}
