import {
  LANDING_TIERS,
  type Landing,
  type LandingConflict,
  type LandingFacts,
  type LandingFindings,
  TaskState,
} from '@tade/core'
import { listIn, numberIn, objectIn, stringIn, text } from './machines.ts'

// Another machine's work on this window's landing desk (REMOTE-TADE.md §9.3):
// what its own desk holds, read out of its projection, so the desk here is
// every finished piece of work on every machine in one order.
//
// **Where it stands is that machine's answer** — its `landing` row, the tier
// and the sentence its own desk drew (`@tade/web`'s `landing.ts`) — exactly as
// a remote agent's mark is its machine's (`machines.ts`): it holds the judge's
// findings and the checks that ran there, which this machine has not got. What
// is folded here is only the facts the order reads, so one desk orders both
// machines' work by one rule (`deskOrder`).
//
// **Everything here was written on another machine**, so it is read for its
// shape and bounded, and every string a person reads is reduced to text first
// (`printable`, through `machines.ts`' readers). Pure.

/** One piece of another machine's work on its own desk, as this desk reads it. */
export interface DeskThere {
  /** The machine it is on: its `remotes.<name>` here. */
  machine: string
  /** Its project there. */
  project: string
  facts: LandingFacts
  landing: Landing
  /** What it has cost there, in dollars, or null where nothing recorded money. */
  usd: number | null
  /** The review it is out for, by its forge's neutral word. */
  review: 'open' | 'draft' | null
}

/** How long a reason may be here. */
const WHY_MOST = 240

/** Every piece of work on a machine's own desk, out of its projection; none where it holds no desk. */
export function deskThere(machine: string, projection: unknown, skew: number): DeskThere[] {
  const out: DeskThere[] = []
  for (const row of listIn(objectIn(projection)?.tasks)) {
    const landing = objectIn(row.landing)
    const tier = LANDING_TIERS.find((one) => one === landing?.tier)
    const task = stringIn(row, 'id')
    const project = text(row.project, 80)
    const state = TaskState.safeParse(row.state)
    if (!landing || !tier || task === null || project === '' || !state.success) continue
    const checks = objectIn(row.checks)
    const said = stringIn(checks, 'state')
    const review = stringIn(objectIn(row.review), 'state')
    const moved = Date.parse(stringIn(row, 'movedAt') ?? '')
    const spend = objectIn(row.spend)
    const why = text(landing.why, WHY_MOST)
    out.push({
      machine,
      project,
      facts: {
        task: text(task, 200),
        state: state.data,
        finished: row.finished === true,
        wantsYou: row.wantsYou === true,
        review:
          review === 'open' || review === 'draft' || review === 'merged' || review === 'closed'
            ? review
            : null,
        checks: said === 'pass' || said === 'fail' || said === 'unknown' ? said : null,
        failed: names(checks?.failed),
        missing: names(checks?.missing),
        findings: findingsIn(landing.findings),
        conflicts: conflictsIn(row.conflicts),
        size: sizeIn(row.size),
        waitingSince: Number.isFinite(moved) ? moved + skew : null,
      },
      landing: { tier, why: why === '' ? null : why, also: numberIn(landing, 'also') ?? 0 },
      usd: spend?.hasCost === true ? numberIn(spend, 'usd') : null,
      review: review === 'open' || review === 'draft' ? review : null,
    })
  }
  return out
}

/** Check names, as text, bounded. */
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((one) => (typeof one === 'string' ? [text(one, 80)] : [])).slice(0, 20)
}

function findingsIn(value: unknown): LandingFindings | null {
  const found = objectIn(value)
  if (found === null) return null
  const count = (key: string) => numberIn(found, key) ?? 0
  return {
    open: count('open'),
    answered: count('answered'),
    confirmed: count('confirmed'),
    dismissed: count('dismissed'),
  }
}

function conflictsIn(value: unknown): LandingConflict[] | null {
  if (!Array.isArray(value)) return null
  return listIn(value).map((one) => ({
    with: typeof one.with === 'string' ? text(one.with, 200) : null,
    files: numberIn(one, 'files') ?? 0,
  }))
}

function sizeIn(value: unknown): LandingFacts['size'] {
  const size = objectIn(value)
  const commits = numberIn(size, 'commits')
  if (size === null || commits === null) return null
  return { commits, added: numberIn(size, 'added'), removed: numberIn(size, 'removed') }
}
