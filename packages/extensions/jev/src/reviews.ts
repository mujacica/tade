import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// The record: what was read, what every question answered, and what came of
// it.
//
// Almost all of it is derived — the looks, the findings, what each became — and
// stays that way: `jev_findings` works it out from the journal, the way status
// does. What cannot be derived is kept here, append-only, next to the journal:
// every answer including the ones that did not fire, and the version that gave
// them. Keep only what cleared the threshold and you can never ask what 0.75
// would have done; lose the version and the first time the numbers drift after
// a release there is nothing to argue from.
//
// This file is evidence, not state. Delete it and the watch behaves exactly
// the same — it just goes blind about itself. Nothing in the loop reads it to
// decide anything.

const DIR = 'jev'
const FILE = 'reviews.jsonl'

/** What one reading of one change answered. */
export interface Review {
  at: string
  project: string
  /** What the finding keys are built from: a task, or a project and a branch. */
  unit: string
  tasks: string[]
  base: string
  head: string
  /** The version that answered. */
  version: string
  files: number
  requests: number
  cost_usd: number
  /** Every question's answer, not only the ones that fired. */
  answers: Record<string, number>
  /** The questions that cleared the reporting threshold. */
  raised: string[]
  /** What somebody who could explain it said afterwards, per question. */
  verdict: Record<string, Verdict>
}

/** What a reader made of one finding: the half of the record Jev cannot give. */
export interface Verdict {
  was: 'confirmed' | 'false positive'
  by: string
  said: string
  at: string
}

type Line = Partial<Review> & { verdict?: Record<string, Verdict> }

function pathOf(home: string): string {
  return join(home, DIR, FILE)
}

/** Write one reading down. Never throws over a record: evidence is not the work. */
export function recordReview(home: string, review: Review): void {
  append(home, review)
}

/**
 * What a reader made of a finding, afterwards. Appended like everything else,
 * never a rewrite: the review as it was read stays exactly as it was.
 */
export function recordVerdict(
  home: string,
  about: { project: string; unit: string; question: string; verdict: Verdict },
): void {
  append(home, {
    at: about.verdict.at,
    project: about.project,
    unit: about.unit,
    verdict: { [about.question]: about.verdict },
  })
}

function append(home: string, line: Line): void {
  try {
    mkdirSync(join(home, DIR), { recursive: true, mode: 0o700 })
    const path = pathOf(home)
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
  } catch {
    // A record that cannot be written is not a reason to fail the reading.
  }
}

/**
 * Every reading, oldest first, with the verdicts folded onto the reading they
 * are about. A line that will not read is skipped, never thrown over.
 */
export function readReviews(home: string): Review[] {
  let raw: string
  try {
    raw = readFileSync(pathOf(home), 'utf8')
  } catch {
    // Nothing has been read yet, which is the normal case.
    return []
  }
  const reviews: Review[] = []
  for (const text of raw.split('\n')) {
    if (text.trim() === '') continue
    let line: Line
    try {
      line = JSON.parse(text) as Line
    } catch {
      continue
    }
    if (!line || typeof line !== 'object' || typeof line.unit !== 'string') continue
    if (!line.answers) {
      // A verdict on its own: it belongs to the newest reading of that unit.
      const about = [...reviews].reverse().find((one) => one.unit === line.unit)
      if (about && line.verdict) Object.assign(about.verdict, line.verdict)
      continue
    }
    reviews.push({
      at: String(line.at ?? ''),
      project: String(line.project ?? ''),
      unit: line.unit,
      tasks: Array.isArray(line.tasks) ? line.tasks.map(String) : [],
      base: String(line.base ?? ''),
      head: String(line.head ?? ''),
      version: String(line.version ?? ''),
      files: Number(line.files ?? 0),
      requests: Number(line.requests ?? 0),
      cost_usd: Number(line.cost_usd ?? 0),
      answers: { ...(line.answers ?? {}) },
      raised: Array.isArray(line.raised) ? line.raised.map(String) : [],
      verdict: { ...(line.verdict ?? {}) },
    })
  }
  return reviews
}
