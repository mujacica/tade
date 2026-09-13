import type { Turn } from '@wilco/voice-core'

// The conversation with the orchestrator, as it happens.
//
// It used to show only finished exchanges, so for as long as the orchestrator
// was working there was nothing to see: not what you had said, not which tool
// it reached for, and — worst — not that it had failed or why. This keeps every
// step as it arrives, and `transcriptLines` lays it out like a terminal you
// can read: your words, what it did, what it answered.
//
// Pure: events in, entries out. The view wraps them to a width.

export type ToolState = 'running' | 'ok' | 'failed'

export type Entry =
  /** What you said or typed, with the pictures you sent along. */
  | { kind: 'you'; text: string; images: string[]; at: number }
  /** Where Wilco's own grammar sent it, and why: `start · checkout/refunds`. */
  | { kind: 'routed'; text: string; at: number }
  /** Words back: the orchestrator's (markdown), or a reply from Wilco itself. */
  | { kind: 'said'; text: string; streaming: boolean; at: number }
  /** A tool it reached for, and how that went. */
  | {
      kind: 'tool'
      id: string
      tool: string
      /** The arguments that tell you which one: a project, a command. */
      detail: string
      state: ToolState
      /** What it answered: the reason, when it failed. */
      result: string
      /** The latest thing it said while working, for tools that report progress. */
      progress: string | null
      at: number
    }
  /** Something went wrong, in words you can act on. */
  | { kind: 'problem'; text: string; at: number }
  /** Something worth asking, offered with the words to ask it: click to send. */
  | { kind: 'suggestion'; text: string; ask: string; at: number }

/** What the orchestrator did, in the terms a surface draws. */
export type ThinkerEvent =
  | { type: 'delta'; text: string }
  | { type: 'message'; text: string }
  | { type: 'tool'; id: string; tool: string; input: unknown }
  | { type: 'progress'; id: string; text: string }
  | { type: 'tool_done'; id: string; ok: boolean; text: string }
  | { type: 'idle' }
  | { type: 'failed'; reason: string }
  | { type: 'exited'; code: number | null }

export interface Transcript {
  entries: Entry[]
  /** When the orchestrator started on what you asked, while it is still on it. */
  thinking: number | null
}

/** Enough to scroll back through a morning; older entries fall off the top. */
export const TRANSCRIPT_MAX = 300

export function emptyTranscript(): Transcript {
  return { entries: [], thinking: null }
}

function push(transcript: Transcript, entry: Entry): Transcript {
  return { ...transcript, entries: [...transcript.entries, entry].slice(-TRANSCRIPT_MAX) }
}

/** You said something: shown at once, before anything has answered. */
export function youSaid(
  transcript: Transcript,
  text: string,
  at: number,
  images: readonly string[] = [],
): Transcript {
  return push(transcript, { kind: 'you', text, images: [...images], at })
}

/** The orchestrator has been handed something, and is working until it is idle again. */
export function thinking(transcript: Transcript, at: number): Transcript {
  return { ...transcript, thinking: transcript.thinking ?? at }
}

/**
 * An exchange Wilco finished. Its own grammar says where it sent what you said
 * and answers; free text was the orchestrator's, whose words are already here
 * as they arrived — unless it never got that far, and the reply says why.
 */
export function fromTurn(transcript: Transcript, turn: Turn): Transcript {
  if (turn.intent === 'free') {
    const since = lastYou(transcript.entries)
    const answered = transcript.entries
      .slice(since + 1)
      .some((entry) => entry.kind === 'said' || entry.kind === 'tool' || entry.kind === 'problem')
    const settled = { ...transcript, thinking: null }
    if (answered || turn.reply.trim() === '') return settled
    return push(settled, { kind: 'said', text: turn.reply, streaming: false, at: turn.at })
  }
  const parts: string[] = [turn.intent]
  if (turn.task) parts.push(turn.task)
  if (turn.why) parts.push(`"${turn.why}"`)
  let next = push(transcript, { kind: 'routed', text: parts.join(' · '), at: turn.at })
  if (turn.reply)
    next = push(next, { kind: 'said', text: turn.reply, streaming: false, at: turn.at })
  return next
}

/** One thing the orchestrator did, folded into what is shown. */
export function fromThinker(transcript: Transcript, event: ThinkerEvent, at: number): Transcript {
  const entries = transcript.entries
  const last = entries.at(-1)
  switch (event.type) {
    case 'delta':
      if (last?.kind === 'said' && last.streaming) {
        return replaceLast(transcript, { ...last, text: last.text + event.text })
      }
      return push(thinking(transcript, at), {
        kind: 'said',
        text: event.text,
        streaming: true,
        at,
      })
    case 'message':
      // The whole block, which is the truth about what the parts added up to.
      if (last?.kind === 'said' && last.streaming) {
        return replaceLast(transcript, { ...last, text: event.text, streaming: false })
      }
      return push(transcript, { kind: 'said', text: event.text, streaming: false, at })
    case 'tool':
      return push(thinking(settleStreaming(transcript), at), {
        kind: 'tool',
        id: event.id,
        tool: event.tool,
        detail: toolDetail(event.input),
        state: 'running',
        result: '',
        progress: null,
        at,
      })
    case 'progress':
      return updateTool(transcript, event.id, (entry) => ({ ...entry, progress: event.text }))
    case 'tool_done':
      return updateTool(transcript, event.id, (entry) => ({
        ...entry,
        state: event.ok ? 'ok' : 'failed',
        // A tool that answered with its own name said nothing worth repeating.
        result: event.text === entry.tool ? '' : event.text,
        progress: null,
      }))
    case 'idle':
      return { ...settleStreaming(transcript), thinking: null }
    case 'failed':
      return push(
        { ...settleStreaming(transcript), thinking: null },
        { kind: 'problem', text: `The orchestrator stopped: ${event.reason}`, at },
      )
    case 'exited': {
      const running = entries.some((entry) => entry.kind === 'tool' && entry.state === 'running')
      let next: Transcript = { ...settleStreaming(transcript), thinking: null }
      if (running) {
        next = {
          ...next,
          entries: next.entries.map((entry) =>
            entry.kind === 'tool' && entry.state === 'running'
              ? { ...entry, state: 'failed', result: 'the orchestrator stopped before it answered' }
              : entry,
          ),
        }
      }
      return next
    }
  }
}

/** Something went wrong outside the orchestrator: shown where you were looking for the answer. */
export function problem(transcript: Transcript, text: string, at: number): Transcript {
  return push({ ...transcript, thinking: null }, { kind: 'problem', text, at })
}

/** Offer something worth asking, with the words that ask it. */
export function suggest(transcript: Transcript, text: string, ask: string, at: number): Transcript {
  return push(transcript, { kind: 'suggestion', text, ask, at })
}

/**
 * The few arguments that say which thing a tool was used on, as a short line:
 * `wilco · "pnpm test"`. Long values are cut, and structure is not repeated.
 */
export function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (parts.length >= 3) break
    if (typeof value === 'string' && value.trim() !== '') {
      const flat = value.replace(/\s+/g, ' ').trim()
      const cut = flat.length > 48 ? `${flat.slice(0, 47)}…` : flat
      parts.push(/\s/.test(cut) || key === 'command' ? `"${cut}"` : cut)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key} ${value}`)
    }
  }
  return parts.join(' · ')
}

/** A tool's name the way it reads: `wilco_terminal_run` is "terminal run". */
export function toolName(tool: string): string {
  return tool.replace(/^wilco_/, '').replace(/_/g, ' ')
}

function lastYou(entries: readonly Entry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i]?.kind === 'you') return i
  return -1
}

function replaceLast(transcript: Transcript, entry: Entry): Transcript {
  return { ...transcript, entries: [...transcript.entries.slice(0, -1), entry] }
}

function settleStreaming(transcript: Transcript): Transcript {
  const last = transcript.entries.at(-1)
  return last?.kind === 'said' && last.streaming
    ? replaceLast(transcript, { ...last, streaming: false })
    : transcript
}

function updateTool(
  transcript: Transcript,
  id: string,
  change: (entry: Extract<Entry, { kind: 'tool' }>) => Entry,
): Transcript {
  let found = false
  const entries = transcript.entries.map((entry) => {
    if (found || entry.kind !== 'tool' || entry.id !== id) return entry
    found = true
    return change(entry)
  })
  return found ? { ...transcript, entries } : transcript
}
