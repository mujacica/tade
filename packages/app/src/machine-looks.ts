import { type DomainLine, EVAL_BY, type EvalBy, printable } from '@tade/core'
import type { CardRead, EvaluationsAnswer, RecordsAnswer } from '@tade/web'

// Two things another machine says only while somebody here is looking, beside
// what it is (`machine-there.ts`): the records its public name needs, looked at
// there on the asking — while Settings › Remotes is open here — and its
// scorecards, while /evals is open on a grouping (`wire/remote-machine.ts`
// asks both).
//
// **Everything here was written on another machine**, read for its shape at
// the link (`RecordsAnswerSchema`, `EvaluationsAnswerSchema`), and every word a
// person reads reduced to text here. Each keeps when it came, in this machine's
// clock, so what is drawn says as of when — a look at DNS is a moment, and a
// scorecard is of a journal that has moved on since.
//
// Pure: an answer and when it came, in; what `Machine.detail` draws, out.

/** One look asked for while somebody was looking: its last answer, when it came, and why there is none. */
export interface LookHeld<T> {
  answer: T | null
  /** When the answer came, in this machine's clock. */
  at: number | null
  /** Why it could not be asked, or did not answer: Tade's words, or that machine's as text. */
  said: string | null
  /** An ask is under way. */
  busy: boolean
}

/** What its public name's records came to when it last looked, as text. */
export interface RecordsThere {
  /** When the answer came, in this machine's clock. */
  at: number
  name: string | null
  /** The line about the zone; null where nothing was looked at. */
  head: string | null
  lines: readonly DomainLine[]
  /** Why nothing was looked at, in that machine's words. */
  cannot: string | null
}

/** One row of its scorecards, as text: the counts it sent, and its own words for each. */
export interface CardThere {
  key: string
  label: string
  /** Somebody named it, rather than nothing recorded or none. */
  named: boolean
  tasks: number
  done: { count: number; of: number }
  landed: { count: number; of: number }
  merged: number
  firstPushGreen: { count: number; of: number }
  redsHere: number | null
  findings: { fired: number; confirmed: number; wrong: number; open: number } | null
  cost: readonly { said: string; kind: 'billed' | 'worked out' | 'at list' | 'none' }[] | null
  tokensPerLanded: number | null
  toDoneMs: number | null
  moved: number
}

/** Its scorecards over all its work, as it folded them over its own journal. */
export interface CardsThere {
  /** When the answer came, in this machine's clock. */
  at: number
  /** False where it had not read its journal yet: nothing to draw, rather than noughts. */
  read: boolean
  /** Whether money and the judge were sent: each that machine's grant to this one. */
  granted: { spend: boolean; findings: boolean }
  total: CardThere | null
  by: Readonly<Record<EvalBy, readonly CardThere[]>>
}

/** Its records, as text, or null before any answer. */
export function recordsOf(held: LookHeld<RecordsAnswer> | null | undefined): RecordsThere | null {
  const answer = held?.answer ?? null
  if (answer === null || held?.at == null) return null
  const said = (value: string | null) => (value === null ? null : printable(value).trim() || null)
  return {
    at: held.at,
    name: said(answer.name),
    head: said(answer.head),
    lines: answer.lines.map((one) => ({
      record: one.record,
      state: one.state,
      said: printable(one.said),
      // A record is a line somebody types in at a registrar: as text, and whole.
      add: said(one.add),
      remove: one.remove.map((gone) => printable(gone)),
      loud: one.loud,
    })),
    cannot: said(answer.cannot),
  }
}

/** Its scorecards, as text, or null before any answer. */
export function cardsOf(held: LookHeld<EvaluationsAnswer> | null | undefined): CardsThere | null {
  const answer = held?.answer ?? null
  if (answer === null || held?.at == null) return null
  return {
    at: held.at,
    read: answer.read,
    granted: answer.granted,
    total: answer.total === null ? null : cardOf(answer.total),
    by: Object.fromEntries(EVAL_BY.map(({ id }) => [id, answer.by[id].map(cardOf)])) as Record<
      EvalBy,
      CardThere[]
    >,
  }
}

/** Why there is nothing held, as text: the asking's own words, or that machine's. */
export function heldSaid(held: LookHeld<unknown> | null | undefined): string | null {
  const said = held?.said ?? null
  return said === null ? null : printable(said).trim() || null
}

function cardOf(card: CardRead): CardThere {
  const rate = (one: { count: number; of: number }) => ({ count: one.count, of: one.of })
  return {
    key: printable(card.key),
    label: printable(card.label),
    named: card.named,
    tasks: card.tasks,
    done: rate(card.done),
    landed: rate(card.landed),
    merged: card.merged,
    firstPushGreen: rate(card.firstPushGreen),
    redsHere: card.redsHere,
    findings:
      card.findings === null
        ? null
        : {
            fired: card.findings.fired,
            confirmed: card.findings.confirmed,
            wrong: card.findings.wrong,
            open: card.findings.open,
          },
    cost:
      card.cost === null
        ? null
        : card.cost.map((part) => ({ said: printable(part.said), kind: part.kind })),
    tokensPerLanded: card.tokensPerLanded,
    toDoneMs: card.toDoneMs,
    moved: card.moved,
  }
}
