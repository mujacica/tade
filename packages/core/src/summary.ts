import type { TadeEvent } from './events.ts'
import { ago } from './history.ts'
import type { TaskState } from './model.ts'

// What an agent has actually been doing.
//
// `historyFrom` answers which task moved last, and `summarise` batches what
// happened across all of them into one spoken line. Neither answers the
// question you actually ask about a single agent — "what has it been up to?" —
// which is about the work: how much of it, of what kind, and what stopped.
//
// Pure: events in, an account out, `now` passed.

export interface ToolUse {
  tool: string
  count: number
}

export interface WorkSummary {
  task: string
  /** Nothing about this task was in the journal at all. */
  empty: boolean
  turns: number
  tools: number
  /** Distinct tools, most used first. */
  used: ToolUse[]
  /**
   * Things that ran which would have needed asking under a policy: worth
   * seeing afterwards even though nothing interrupted you at the time.
   */
  notable: string[]
  /** What it is waiting on right now, if anything. */
  waiting: string | null
  /** Why it failed, if it did. */
  failed: string | null
  state: TaskState | null
  lastAt: number | null
}

export function summariseWork(
  events: readonly TadeEvent[],
  task: string,
  now: number,
): WorkSummary {
  const summary: WorkSummary = {
    task,
    empty: true,
    turns: 0,
    tools: 0,
    used: [],
    notable: [],
    waiting: null,
    failed: null,
    state: null,
    lastAt: null,
  }
  const counts = new Map<string, number>()
  // Waiting is a balance, not a flag: a request opens it, an answer closes it.
  const open = new Map<string, string>()

  for (const event of events) {
    if (event.task !== task) continue
    summary.empty = false
    const at = Date.parse(event.ts)
    const when = Number.isNaN(at) ? now : at
    summary.lastAt = Math.max(summary.lastAt ?? when, when)

    const requestId = String(event.detail.requestId ?? '')
    switch (event.type) {
      case 'tool_call': {
        summary.tools += 1
        const tool = String(event.detail.tool ?? 'something')
        counts.set(tool, (counts.get(tool) ?? 0) + 1)
        if (event.detail.tier === 'hard' && typeof event.detail.summary === 'string') {
          summary.notable.push(event.detail.summary)
        }
        break
      }
      case 'turn_done':
        summary.turns += 1
        break
      case 'failed':
        summary.failed = String(event.detail.error ?? 'no reason given')
        break
      case 'permission_request':
        if (requestId) open.set(requestId, String(event.detail.summary ?? 'a decision'))
        break
      case 'permission_granted':
      case 'permission_denied':
        if (requestId) open.delete(requestId)
        break
      case 'run_exited':
        // Whatever it was holding is moot once it has gone.
        open.clear()
        break
      case 'state_change':
        if (typeof event.detail.state === 'string') summary.state = event.detail.state as TaskState
        break
      default:
        break
    }
  }

  summary.used = [...counts.entries()]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))
  summary.waiting = [...open.values()].at(-1) ?? null
  return summary
}

/**
 * The same thing, as something you would say out loud. Short on purpose: down
 * an earbud, three clauses is the most anyone can follow.
 */
export function describeWork(summary: WorkSummary, now: number): string {
  const name = short(summary.task)
  if (summary.empty) return `Nothing recorded for ${name}.`

  const sentences: string[] = []
  const opening = summary.state ? `${name} is ${summary.state}` : name
  const work = describeEffort(summary)
  sentences.push(work ? `${opening}: ${work}.` : `${opening}, with nothing done yet.`)

  if (summary.failed) sentences.push(`It failed: ${summary.failed}.`)
  if (summary.waiting) sentences.push(`It is waiting on ${summary.waiting}.`)
  if (summary.notable.length > 0) {
    // Said afterwards precisely because nothing interrupted you at the time.
    const [first] = summary.notable
    const rest = summary.notable.length - 1
    sentences.push(rest > 0 ? `It ran ${first}, and ${rest} more like it.` : `It ran ${first}.`)
  }
  if (summary.lastAt !== null) sentences.push(`Last moved ${ago(now - summary.lastAt)}.`)
  return sentences.join(' ')
}

function describeEffort(summary: WorkSummary): string {
  const parts: string[] = []
  if (summary.tools > 0) parts.push(`${count(summary.tools, 'tool call')}`)
  if (summary.turns > 0) parts.push(`${count(summary.turns, 'turn')}`)
  if (parts.length === 0) return ''
  const mostly = summary.used.slice(0, 2).map((use) => use.tool)
  const how = mostly.length > 0 ? `, mostly ${joinWords(mostly)}` : ''
  return `${joinWords(parts)}${how}`
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`
}

function short(task: string): string {
  return task.split('/').at(-1) ?? task
}
