import { commandOut, type Places } from './command.ts'
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

/** No place known: every absolute path in a brief is its last name behind `…/`. */
export const NOWHERE: Places = { work: null, tade: null, home: null }

/**
 * The line that names a call, as a device reads it: `briefOf` over arguments
 * let out **by an approval's own rule** (`commandOut`) — credentials out, and
 * paths shortened rather than taken out, so a call that read a file says which
 * (`~/.tade/…/NAMES.md`) where the screen's rule would leave `…`. A path too
 * long for the line keeps its first two names and its last.
 */
export function briefOut(input: unknown, places: Places, known: readonly string[]): string {
  const out = (value: string) => pathCut(commandOut(value, places, known))
  if (typeof input === 'string') return briefOf(out(input))
  if (!isRecord(input)) return ''
  const shown: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    shown[key] = typeof value === 'string' ? out(value) : value
  }
  return briefOf(shown)
}

/** A lone path longer than a brief's value, cut in its middle: `~/.tade/…/NAMES.md`. */
function pathCut(value: string): string {
  const flat = value.trim()
  if (flat.length <= 48 || /\s/.test(flat) || !flat.includes('/')) return value
  const names = flat.split('/')
  const last = names.at(-1) ?? ''
  const head = names.slice(0, 2).join('/')
  const cut = `${head}/…/${last}`
  return cut.length < flat.length ? cut : value
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

/**
 * One call, cleaned and bounded, and how many things were taken out of it.
 *
 * An answer of `''` crosses as words of `''` — it answered nothing — and a
 * `result` of null as null, an answer nobody kept: `cleanSaid` makes both
 * null, and the page would say of a call that answered nothing that what it
 * answered was not written down.
 */
export function callOf(
  input: unknown,
  result: string | null,
  known: readonly string[],
  places: Places = NOWHERE,
): { call: Call; taken: number } {
  const words = briefOut(input, places, known)
  const brief = { said: textOf(words, CALL.brief), taken: 0 }
  const asked = cleanSaid(inputText(input), CALL.input, known)
  const answered = result === '' ? NOTHING : cleanSaid(result ?? '', CALL.result, known)
  return {
    call: {
      brief: brief.said === null ? null : brief.said.words,
      input: asked.said,
      result: answered.said,
    },
    taken: brief.taken + asked.taken + answered.taken,
  }
}

/** An answer of nothing at all. */
const NOTHING = { said: { words: '', more: false }, taken: 0 } as const

/** One cleaned call, and what it was cleaned from. */
interface Kept {
  input: unknown
  result: string | null
  known: readonly string[]
  places: Places
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
  result: string | null,
  known: readonly string[],
  places: Places = NOWHERE,
): Call {
  const was = kept.get(id)
  if (
    was !== undefined &&
    was.input === input &&
    was.result === result &&
    sameKeys(was.known, known) &&
    samePlaces(was.places, places)
  ) {
    return was.call
  }
  const { call } = callOf(input, result, known, places)
  kept.delete(id)
  kept.set(id, { input, result, known, places, call })
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
      /** `''` where it answered nothing; null where no answer was recorded. */
      result: string | null
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
  places: Places = NOWHERE,
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
    const made = callOf(one.input, one.result, known, places)
    taken += made.taken
    return {
      id,
      at: when,
      kind: 'tool',
      text: null,
      tool: oneLine(cleanText(one.tool, known).text) || 'a tool',
      outcome:
        one.result === null ? 'none' : one.ok === null ? 'unknown' : one.ok ? 'ok' : 'failed',
      call: made.call,
    }
  })
  return { turns: rows, taken }
}

/** The same keys, compared by value: the window works them out again every beat. */
function samePlaces(a: Places, b: Places): boolean {
  return a.work === b.work && a.tade === b.tade && a.home === b.home
}

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
