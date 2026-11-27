// When the full checks run for a batch of commits, and whose commit broke a red one.
//
// Where a project batches its full checks (`checks.full: batched`, and only in
// a shared checkout — `batchedFor`), an agent finishing a task runs the commit
// hook and the tests its change touches, and the full checks run once for
// everything committed since the last green run: at HEAD, one at a time, by
// the window (`wire/batches.ts`), in a tree of their own at exactly that commit
// (`workbench/src/batch.ts`). One full run at HEAD covers every task committed
// before it, which is the whole argument: five agents finishing in an hour
// were five suites, run back to back on one machine.
//
// Pure, like the queue's rules: facts and `now` in, an answer out. The window
// applies them and writes down what it did.

/** How long HEAD must sit still before a batch starts: commits arrive in bursts. */
export const SETTLE_MS = 60_000

/** How soon a batch that could not run — the machine was busy, a tree would not prepare — is tried again. */
export const RETRY_MS = 5 * 60_000

/** What the rule is asked about one project's checkout. */
export interface BatchFacts {
  /** HEAD of the checkout; null where it has no commit or git could not say. */
  head: string | null
  /** The full checks' rollup at HEAD (`rollup`). */
  rollup: 'pass' | 'fail' | 'unknown'
  /** How many checks a full run has here. */
  checks: number
  /** A batch already ran at this HEAD: its answer stands until HEAD moves. */
  batched: boolean
  /** A run is going in the checkout now, whoever started it. */
  running: boolean
  /** How long HEAD has been where it is. */
  stillMs: number
  /** The last batch this window tried and could not finish, if any. */
  tried: { head: string; at: number } | null
  now: number
}

export type BatchAnswer = { run: true } | { run: false; because: string }

/**
 * Whether to start a full run for a batch now. Never a second one beside a run
 * already going, never at a HEAD that is already green, never again at a HEAD
 * a batch already answered — red included: running the same tree again asks
 * the same question, and the next commit is what changes the answer.
 */
export function batchDue(facts: BatchFacts): BatchAnswer {
  if (!facts.head) return { run: false, because: 'there is no commit to check' }
  if (facts.checks === 0) return { run: false, because: 'the project checks nothing' }
  if (facts.rollup === 'pass') return { run: false, because: 'HEAD is green already' }
  if (facts.batched) return { run: false, because: 'a batch already ran at this HEAD' }
  if (facts.running) return { run: false, because: 'a run is going in the checkout' }
  if (facts.stillMs < SETTLE_MS) return { run: false, because: 'HEAD moved a moment ago' }
  if (facts.tried?.head === facts.head && facts.now - facts.tried.at < RETRY_MS) {
    return { run: false, because: 'the last try at this HEAD could not run' }
  }
  return { run: true }
}

/** One commit's answer when the failing tests are run again there on their own. */
export type Tried = 'red' | 'green' | 'cannot'

/**
 * A red batch, narrowed: the commits it covered, oldest first, with the last
 * commit before them first (`base`) and HEAD last, and what each said when the
 * failing tests ran again there.
 */
export interface Narrowing {
  /** `[base, …covered, HEAD]`: the base is the commit the last green full run was at. */
  commits: readonly string[]
  /** What each commit said the first time the failing tests ran there. */
  tried: Readonly<Record<string, Tried>>
  /**
   * The tests the batch failed, where it was narrowed by its tests; absent or
   * empty where a whole check runs again, which names no tests to compare.
   */
  failing?: readonly string[]
  /** The tests each red look named as failing, by commit; absent where it named none. */
  named?: Readonly<Record<string, readonly string[]>>
  /** The second look at the commit the halving came to, before it is named. */
  again?: Readonly<Record<string, Look>>
}

/** One run of the failing tests at a commit: what it said, and which tests a red one named. */
export interface Look {
  tried: Tried
  named?: readonly string[]
}

/**
 * The narrowing with one more look at `commit`: its first goes in `tried`, and
 * a look at a commit already tried is the second look `nextToTry` asked for.
 */
export function withLook(narrowing: Narrowing, commit: string, look: Look): Narrowing {
  const named = look.named ? { [commit]: [...new Set(look.named)].sort() } : {}
  if (narrowing.tried[commit] === undefined) {
    return {
      ...narrowing,
      tried: { ...narrowing.tried, [commit]: look.tried },
      named: { ...narrowing.named, ...named },
    }
  }
  const again: Look = { tried: look.tried, ...(look.named ? { named: named[commit] } : {}) }
  return { ...narrowing, again: { ...narrowing.again, [commit]: again } }
}

/**
 * Which commit to run the failing tests at next, or null when there is an
 * answer. HEAD first, because a failure that does not come back on its own is
 * not anybody's commit; then the base, because one that was already there is
 * not either; then halving what is left; then the one commit left a second
 * time. And nothing more once a run fails other tests than the batch did: a
 * failure that moves between tests is the machine's, and no commit is named.
 */
export function nextToTry(narrowing: Narrowing): string | null {
  const { commits, tried } = narrowing
  const head = commits.at(-1)
  const base = commits[0]
  if (!head || !base) return null
  // Once the failing tests fail differently, no commit can be named: stop.
  if (changedAt(narrowing) !== null) return null
  if (tried[head] === undefined) return head
  if (tried[head] !== 'red') return null
  if (tried[base] === undefined) return base
  if (tried[base] !== 'green') return null
  const { lo, hi } = bounds(narrowing)
  const open = commits.map((_, i) => i).filter((i) => i > lo && i < hi && !tried[commits[i] ?? ''])
  if (open.length === 0) {
    // One commit is left: look at it a second time before naming it, because
    // a failure that depends on the machine's load fails once and then not.
    const blamed = commits[hi]
    if (hi === lo + 1 && blamed && narrowing.again?.[blamed] === undefined) return blamed
    return null
  }
  const middle = (lo + hi) / 2
  const pick = open.reduce((best, i) => (Math.abs(i - middle) < Math.abs(best - middle) ? i : best))
  return commits[pick] ?? null
}

/** Whose commit it was, or why that cannot be said — always one of the two. */
export type Culprit = { commit: string } | { commit: null; because: string; flaky?: boolean }

/** What a finished narrowing comes to. Asked only once `nextToTry` says null. */
export function culpritOf(narrowing: Narrowing): Culprit {
  const { commits, tried } = narrowing
  const head = commits.at(-1) ?? ''
  const base = commits[0] ?? ''
  if (tried[head] === 'green') {
    return {
      commit: null,
      flaky: true,
      because: `the failing tests passed when they ran again on their own at ${short(head)}`,
    }
  }
  if (tried[head] !== 'red')
    return { commit: null, because: `they could not be run again at ${short(head)}` }
  const changed = changedAt(narrowing)
  if (changed !== null) return { commit: null, flaky: true, because: changed }
  if (tried[base] === 'red') {
    return { commit: null, because: `they fail at ${short(base)} too, before any of these commits` }
  }
  if (tried[base] !== 'green') {
    return {
      commit: null,
      because: `they could not be run at ${short(base)}, before these commits`,
    }
  }
  const { lo, hi } = bounds(narrowing)
  if (hi === lo + 1) {
    const blamed = commits[hi] ?? head
    const again = narrowing.again?.[blamed]
    if (again?.tried === 'red') return { commit: blamed }
    if (again?.tried === 'green') {
      return {
        commit: null,
        flaky: true,
        because: `the failing tests failed at ${short(blamed)} and then passed when they ran there a second time`,
      }
    }
    return {
      commit: null,
      because: again
        ? `the failing tests could not be run a second time at ${short(blamed)}, so its one failure is all there is`
        : `${short(blamed)} was not looked at a second time, so its one failure is all there is`,
    }
  }
  return {
    commit: null,
    because: `it is one of the commits after ${short(commits[lo] ?? base)} up to ${short(commits[hi] ?? head)}, and the ones between could not be run`,
  }
}

/**
 * Why the failing tests are not failing the same way from one run to the next,
 * or null while they are: a red look that named a different set of tests than
 * the batch failed, or named none at all. Asked only where the batch was
 * narrowed by its tests (`failing`); a whole check run again names nothing.
 */
function changedAt(narrowing: Narrowing): string | null {
  const failing = [...new Set(narrowing.failing ?? [])].sort()
  if (failing.length === 0) return null
  const looks: [string, string, Look][] = [
    ...narrowing.commits.flatMap((commit): [string, string, Look][] => {
      const tried = narrowing.tried[commit]
      if (tried === undefined) return []
      const named = narrowing.named?.[commit]
      return [[commit, 'at', { tried, ...(named ? { named } : {}) }]]
    }),
    ...narrowing.commits.flatMap((commit): [string, string, Look][] => {
      const again = narrowing.again?.[commit]
      return again ? [[commit, 'a second time at', again]] : []
    }),
  ]
  for (const [commit, when, look] of looks) {
    if (look.tried !== 'red') continue
    const named = [...new Set(look.named ?? [])].sort()
    if (named.join('\n') === failing.join('\n')) continue
    const batch = `the batch failed ${listed(failing)}`
    return named.length === 0
      ? `the failing tests did not fail the same way from one run to the next: ${batch}, and ${when} ${short(commit)} they failed without naming which`
      : `the failing tests did not fail the same way from one run to the next: ${batch}, and ${when} ${short(commit)} ${listed(named)} failed`
  }
  return null
}

/** A few test files by name, and how many more. */
function listed(files: readonly string[]): string {
  const shown = files.slice(0, 3).join(', ')
  return files.length > 3 ? `${shown} and ${files.length - 3} more` : shown
}

/** The newest commit known green, and the oldest known red after it. */
function bounds({ commits, tried }: Narrowing): { lo: number; hi: number } {
  let lo = 0
  commits.forEach((commit, i) => {
    if (tried[commit] === 'green') lo = i
  })
  let hi = commits.length - 1
  for (let i = commits.length - 1; i > lo; i--) if (tried[commits[i] ?? ''] === 'red') hi = i
  return { lo, hi }
}

function short(commit: string): string {
  return commit.slice(0, 8)
}
