import { textOf } from './page.ts'
import type { Call, Said, TurnRow } from './protocol.ts'
import { cleanText } from './screen.ts'

// A conversation's words, as a device granted an agent's own bytes may read
// them: the orchestrator's tool calls (`chatRows`) and an agent's turns out of
// its harness's record (`agentOf`).
//
// **Nobody's words, cleaned at this boundary.** What a model said and what a
// tool was handed or answered can be anything — a command with a key in it, a
// file's contents, a page an agent fetched with a `<script>` in it — so every
// string here goes through the screen's own rule (`cleanText`) **before** it is
// cut to a budget, and the page builds no markup out of any of it.
//
// Pure: no `node:` import, no clock, nothing awaited.

/** How much of a call crosses: the line that says which, what it was handed, what it answered. */
export const CALL = { brief: 160, input: 2_000, result: 2_000 } as const

/** How much of an agent's conversation one answer carries. */
export const TURNS = { turns: 40, text: 4_000 } as const

/**
 * How far past a bound text is cleaned before it is cut.
 *
 * Cleaning is cut **after**, so a key straddling the cut is never half let
 * through; cleaning a megabyte a tool answered to show two thousand characters
 * of it is cost for nothing. What is cleaned is the bound and this much more,
 * which is longer than any key — so whatever straddles the first cut is past
 * the second, and is not shown at all.
 */
const SLACK = 1_024

/** Words cleaned, then bounded: the count of what was taken out goes with them. */
export function cleanSaid(
  text: string,
  most: number,
  known: readonly string[],
): { said: Said | null; taken: number } {
  if (text === '') return { said: null, taken: 0 }
  const clean = cleanText(text.slice(0, most + SLACK), known)
  const said = textOf(clean.text, most)
  if (said === null) return { said: null, taken: clean.taken }
  // Cut before cleaning is still cut: said so, rather than read as the whole.
  return { said: { ...said, more: said.more || text.length > most + SLACK }, taken: clean.taken }
}

/**
 * The arguments that tell you which call it was, on one line: up to three
 * values, each cut short — `"git status" · checks 2`. The window's own reading
 * of a call (`toolDetail`), so a row on a phone names it as the window does.
 */
export function briefOf(input: unknown): string {
  if (typeof input === 'string') return oneLine(input)
  if (!isRecord(input)) return ''
  const parts: string[] = []
  for (const [key, value] of Object.entries(input)) {
    if (parts.length >= 3) break
    if (typeof value === 'string' && value.trim() !== '') {
      const cut = oneLine(value)
      parts.push(/\s/.test(cut) || key === 'command' ? `"${cut}"` : cut)
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key} ${value}`)
    }
  }
  return parts.join(' · ')
}

/**
 * Everything a call was handed, a line per argument: `command: git status`.
 *
 * A string as itself, so a file's contents or a prompt reads as it was
 * written; anything else as JSON. Never `JSON.stringify` of the whole call,
 * which makes a multi-line argument one line of `\n`.
 */
export function inputText(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'string') return input
  if (!isRecord(input)) return jsonOf(input)
  return Object.entries(input)
    .map(([key, value]) => {
      const said = typeof value === 'string' ? value : jsonOf(value)
      return said.includes('\n') ? `${key}:\n${said}` : `${key}: ${said}`
    })
    .join('\n')
}

/** One call, cleaned and bounded, and how many things were taken out of it. */
export function callOf(
  input: unknown,
  result: string,
  known: readonly string[],
): { call: Call; taken: number } {
  const brief = cleanSaid(briefOf(input), CALL.brief, known)
  const asked = cleanSaid(inputText(input), CALL.input, known)
  const answered = cleanSaid(result, CALL.result, known)
  return {
    call: {
      brief: brief.said === null ? null : brief.said.words,
      input: asked.said,
      result: answered.said,
    },
    taken: brief.taken + asked.taken + answered.taken,
  }
}

/** One cleaned call, and what it was cleaned from. */
interface Kept {
  input: unknown
  result: string
  known: readonly string[]
  call: Call
}

/** How many cleaned calls are kept: more than a conversation's lines (`TRANSCRIPT_MAX`). */
const KEPT_CALLS = 512

const kept = new Map<string, Kept>()

/**
 * `callOf` for one line of the conversation, cleaned once rather than once a
 * beat for every device.
 *
 * The projection is built for each device on every beat, and the lines it
 * carries are the same lines: a call cleaned again each time is the window's
 * thread doing the same regular expressions over the same two kilobytes a
 * hundred times a minute. Kept by line, and used only where what it was made
 * from is **the same** — the same arguments, the same answer, the same keys —
 * so a call that answered since, or a key added in Settings, is cleaned again.
 */
export function callFor(
  id: string,
  input: unknown,
  result: string,
  known: readonly string[],
): Call {
  const was = kept.get(id)
  if (
    was !== undefined &&
    was.input === input &&
    was.result === result &&
    sameKeys(was.known, known)
  ) {
    return was.call
  }
  const { call } = callOf(input, result, known)
  kept.delete(id)
  kept.set(id, { input, result, known, call })
  if (kept.size > KEPT_CALLS) {
    const oldest = kept.keys().next().value
    if (oldest !== undefined) kept.delete(oldest)
  }
  return call
}

/**
 * One turn of an agent's conversation as its harness recorded it, in the
 * shape the window hands over (`HistoryItem`'s, read structurally).
 */
export type TurnIn =
  | { kind: 'sent' | 'reply'; text: string; at: number }
  | {
      kind: 'tool'
      /** The call's own id in the record. */
      id: string
      tool: string
      input: unknown
      ok: boolean | null
      result: string
      at: number
    }

/**
 * An agent's turns as they cross: the newest `TURNS.turns`, each cleaned, with
 * an id that does not move as the conversation grows — a call's own id, and
 * otherwise the moment it was written and how many before it in the same
 * millisecond — because the page keys its rows by it, and an id that moved
 * would redraw every turn every time one was added.
 */
export function turnsOf(
  turns: readonly TurnIn[],
  known: readonly string[],
): { turns: TurnRow[]; taken: number } {
  const kept = turns.slice(-TURNS.turns)
  const same = new Map<number, number>()
  let taken = 0
  const rows = kept.map((one): TurnRow => {
    const n = same.get(one.at) ?? 0
    same.set(one.at, n + 1)
    // Never the record's own text as a key the page writes into an attribute
    // unexamined: a call's id is a harness's, so it goes through the same rule.
    const id =
      one.kind === 'tool' && /^[\w.:-]{1,80}$/.test(one.id)
        ? `c:${one.id}`
        : `${one.kind}:${one.at}#${n}`
    const when = one.at > 0 ? new Date(one.at).toISOString() : null
    if (one.kind !== 'tool') {
      const words = cleanSaid(one.text, TURNS.text, known)
      taken += words.taken
      return {
        id,
        at: when,
        kind: one.kind,
        text: words.said,
        tool: null,
        outcome: null,
        call: null,
      }
    }
    const made = callOf(one.input, one.result, known)
    taken += made.taken
    return {
      id,
      at: when,
      kind: 'tool',
      text: null,
      tool: oneLine(cleanText(one.tool, known).text) || 'a tool',
      outcome: one.ok === null ? 'none' : one.ok ? 'ok' : 'failed',
      call: made.call,
    }
  })
  return { turns: rows, taken }
}

/** The same keys, compared by value: the window works them out again every beat. */
function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a === b || (a.length === b.length && a.every((one, at) => one === b[at]))
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat
}

function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch (err) {
    // A value JSON cannot say — a cycle, a bigint — is said to whoever opens
    // the call, with why, rather than drawn as an argument that was empty.
    return `(not shown: ${err instanceof Error ? err.message : String(err)})`
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
