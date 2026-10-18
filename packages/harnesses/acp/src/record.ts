import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type HarnessSpend,
  type HistoryAsk,
  type HistoryLine,
  type HistoryPage,
  historyIn,
  noHarnessSpend,
} from '@tade/harnesses-core'

// What was said in an ACP agent's conversation, as Tade's lane heard it.
//
// ACP carries a conversation but keeps no record of it that a client can
// read: each agent keeps its own, in its own format, where it likes — Gemini
// CLI's chats, opencode's database, goose's sessions — and none of them is a
// promise. So the lane writes down what it heard, one line per thing that
// happened, under Tade's home and never inside a project: the session it is
// in (which is how it comes back to it), what it was sent, what it answered
// and the tools it reached for, and what it said the session cost. History,
// spend and "is there a conversation" are read out of this file and nothing
// else.
//
// Read like any provider's transcript: a fold over its lines, a line in a
// shape this does not know is skipped, and nothing throws. `v` is the record's
// version — a change of shape bumps it, and the fixtures under
// `test/fixtures/transcripts/acp/` hold every version still being read.

export const RECORD_VERSION = 1

export type RecordLine =
  /** The conversation the lane is in: started, or come back to. */
  | { type: 'session'; at: number; agent: string; sessionId: string; resumed: boolean }
  /** The model chosen within the agent, where one was. */
  | { type: 'model'; at: number; model: string }
  | { type: 'sent'; at: number; text: string }
  | { type: 'reply'; at: number; text: string }
  | { type: 'tool'; at: number; id: string; tool: string; title: string; input: unknown }
  | { type: 'tool_result'; at: number; id: string; ok: boolean; result: string }
  /** How full the context is, and what the session has cost so far, as the agent said. */
  | {
      type: 'usage'
      at: number
      sessionId: string
      used: number
      size: number
      cost: { amount: number; currency: string } | null
    }
  | { type: 'turn'; at: number; stop: string; reason?: string }

/** The conversation a task's agent talks in, as this harness names it. */
export function conversationKey(task: string): string {
  return `acp-${createHash('sha1').update(task).digest('hex').slice(0, 16)}`
}

/** Where a task's record is kept. */
export function recordPath(runDir: string, task: string): string {
  return join(runDir, 'acp', `${conversationKey(task)}.jsonl`)
}

/**
 * Write one line down. Synchronous on purpose: this runs in the lane, never in
 * the window, and a line half-written when the lane is killed is a line the
 * reader skips, where one still in a queue is a line lost.
 */
export function append(path: string, line: RecordLine): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  appendFileSync(path, `${JSON.stringify({ v: RECORD_VERSION, ...line })}\n`, { mode: 0o600 })
}

const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** One line of the record, or null for anything this version does not read. */
export function lineOf(text: string): RecordLine | null {
  let raw: Record<string, unknown> | null
  try {
    raw = obj(JSON.parse(text))
  } catch {
    return null
  }
  if (!raw || raw.v !== RECORD_VERSION) return null
  const at = num(raw.at)
  if (at === null) return null
  switch (raw.type) {
    case 'session': {
      const agent = str(raw.agent)
      const sessionId = str(raw.sessionId)
      if (!agent || !sessionId) return null
      return { type: 'session', at, agent, sessionId, resumed: raw.resumed === true }
    }
    case 'model': {
      const model = str(raw.model)
      return model ? { type: 'model', at, model } : null
    }
    case 'sent':
    case 'reply': {
      const text = str(raw.text)
      return text === null ? null : { type: raw.type, at, text }
    }
    case 'tool': {
      const id = str(raw.id)
      const tool = str(raw.tool)
      if (!id || !tool) return null
      return { type: 'tool', at, id, tool, title: str(raw.title) ?? tool, input: raw.input }
    }
    case 'tool_result': {
      const id = str(raw.id)
      if (!id || typeof raw.ok !== 'boolean') return null
      return { type: 'tool_result', at, id, ok: raw.ok, result: str(raw.result) ?? '' }
    }
    case 'usage': {
      const sessionId = str(raw.sessionId)
      const used = num(raw.used)
      const size = num(raw.size)
      if (!sessionId || used === null || size === null) return null
      const cost = obj(raw.cost)
      const amount = num(cost?.amount)
      const currency = str(cost?.currency)
      return {
        type: 'usage',
        at,
        sessionId,
        used,
        size,
        cost: amount !== null && currency ? { amount, currency } : null,
      }
    }
    case 'turn': {
      const stop = str(raw.stop)
      if (!stop) return null
      const reason = str(raw.reason)
      return { type: 'turn', at, stop, ...(reason ? { reason } : {}) }
    }
    default:
      return null
  }
}

/** What the record comes to, folded from its first line to its last. */
export interface Recorded {
  /** The agent the conversation is in, and its session, as last written down. */
  agent: string | null
  sessionId: string | null
  /** The model chosen within that agent, where one was. */
  model: string | null
  /**
   * What each session had cost at the last figure it gave, in US dollars.
   * An agent says a session's total so far, so the last figure is the
   * session's, and a conversation that had to move to a new session (an agent
   * that could not come back to the old one) adds the new one's on top.
   */
  costs: Readonly<Record<string, number>>
  /** How many figures were counted, so "none yet" is not "nothing spent". */
  priced: number
}

export function emptyRecorded(): Recorded {
  return { agent: null, sessionId: null, model: null, costs: {}, priced: 0 }
}

/** Fold lines into what is known, never changing what it was given. */
export function fold(known: Recorded, lines: Iterable<RecordLine>): Recorded {
  let next = known
  for (const line of lines) {
    switch (line.type) {
      case 'session':
        next = {
          ...next,
          agent: line.agent,
          sessionId: line.sessionId,
          // A session it came back to keeps the model it was on; a new one
          // starts on the agent's own.
          model: line.resumed && line.agent === next.agent ? next.model : null,
        }
        break
      case 'model':
        next = { ...next, model: line.model }
        break
      case 'usage':
        // Dollars only: a figure in another currency is not added to them.
        if (line.cost?.currency.toUpperCase() !== 'USD') break
        next = {
          ...next,
          costs: { ...next.costs, [line.sessionId]: line.cost.amount },
          priced: next.priced + 1,
        }
        break
      default:
        break
    }
  }
  return next
}

/** What the conversation spent, as the agent priced it: dollars and nothing else. */
export function spendOf(recorded: Recorded): HarnessSpend {
  const usd = Object.values(recorded.costs).reduce((sum, one) => sum + one, 0)
  return {
    ...noHarnessSpend(),
    usd,
    messages: recorded.priced,
    model: recorded.agent ? `${recorded.agent}/${recorded.model ?? 'default'}` : null,
  }
}

/** Every line of a record that this version reads, oldest first. */
export function* linesIn(text: string): Generator<RecordLine> {
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    const line = lineOf(raw)
    if (line) yield line
  }
}

/** What a record file comes to. A record that is not there is an empty one. */
export async function recordedIn(path: string): Promise<Recorded> {
  const text = await readFile(path, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return ''
    throw new Error(`could not read ${path}: ${err.message}`)
  })
  return fold(emptyRecorded(), linesIn(text))
}

/** The same, for the lane, which reads its own record once as it starts. */
export function recordedInSync(path: string): { recorded: Recorded; lines: RecordLine[] } {
  let text = ''
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    // Nothing written yet: a conversation that has not started.
  }
  const lines = [...linesIn(text)]
  return { recorded: fold(emptyRecorded(), lines), lines }
}

/** What one line of the record says of the conversation, for `historyIn`. */
export function historyLine(text: string): HistoryLine | null {
  const line = lineOf(text)
  if (!line) return null
  switch (line.type) {
    case 'sent':
      return {
        items: [{ kind: 'sent', text: line.text, images: [], at: line.at }],
        results: [],
        opens: true,
      }
    case 'reply':
      return { items: [{ kind: 'reply', text: line.text, at: line.at }], results: [], opens: false }
    case 'tool':
      return {
        items: [
          {
            kind: 'tool',
            id: line.id,
            tool: line.tool,
            input: line.input,
            ok: null,
            result: null,
            at: line.at,
          },
        ],
        results: [],
        opens: false,
      }
    case 'tool_result':
      return {
        items: [],
        results: [{ id: line.id, ok: line.ok, result: line.result }],
        opens: false,
      }
    default:
      return null
  }
}

export function historyOf(path: string, ask: HistoryAsk): Promise<HistoryPage> {
  return historyIn(path, ask, historyLine)
}
