import type { CheckRun } from '@tade/checks-core'
import {
  type Access,
  type Forge,
  type ForgeCapabilities,
  ForgeError,
  type ForgeTrouble,
  hostOf,
  type OpenRequest,
  type Page,
  type RemotePlace,
  type Review,
  type ReviewDetail,
  type ReviewQuery,
  type ReviewRef,
} from '@tade/forges-core'

// A forge that answers from a table.
//
// It is what every test uses, what makes the loop demoable with no account at
// all, and the second implementation the port needs to stay honest. Nothing
// here reaches anything: writes change the table, so a test can ask what
// Tade would have done to somebody's repository without doing it.

/** One review the table holds, as much of it as a test cares to say. */
export type ScriptedReview = Partial<ReviewDetail> & { ref: ReviewRef }

/** Something the forge was asked to change, kept so a test can ask what Tade did. */
export type Wrote =
  | { kind: 'opened'; request: OpenRequest }
  | { kind: 'said'; ref: ReviewRef; body: string; thread?: string }
  | { kind: 'marked'; ref: ReviewRef; what: Record<string, unknown> }
  | { kind: 'merged'; ref: ReviewRef; how: string }

export interface ScriptedForgeOptions {
  /** Who we are here; null for nobody signed in. */
  me?: string | null
  can?: 'read' | 'write'
  /** What is wrong with everything it is asked, when something is. */
  trouble?: ForgeTrouble | null
  /** When a rate limit lifts, as a moment. */
  retryAt?: number
  reviews?: readonly ScriptedReview[]
  /** What ran on a review's head, by `<repo>#<number>`. */
  checks?: Readonly<Record<string, readonly CheckRun[]>>
  /**
   * What ran on a commit, by `<repo>@<commit>` — a branch nobody opened
   * anything for included, which is what watching CI on `main` reads.
   */
  commits?: Readonly<Record<string, readonly CheckRun[]>>
  /** The tail of a check's log, by `<repo>@<commit>:<check>`. */
  logs?: Readonly<Record<string, string>>
  hosts?: readonly string[]
  /** Repositories this sign-in cannot see, for the `no access` answer. */
  unseen?: readonly string[]
  capabilities?: Partial<ForgeCapabilities>
  now?: () => number
}

export type ScriptedForge = Forge & {
  /** Everything it was asked to change, in order. */
  readonly wrote: readonly Wrote[]
}

export function makeScriptedForge(options: ScriptedForgeOptions = {}): ScriptedForge {
  const now = options.now ?? Date.now
  const me = options.me === undefined ? 'you' : options.me
  const hosts = options.hosts ?? ['scripted.test']
  const wrote: Wrote[] = []
  const table: ReviewDetail[] = (options.reviews ?? []).map((one) => full(one, me))
  const capabilities: ForgeCapabilities = {
    assigned: true,
    checks: true,
    commitChecks: true,
    checkLogs: true,
    threads: true,
    drafts: true,
    rules: true,
    mergeQueue: false,
    stacks: false,
    write: true,
    since: true,
    // A table has one sign-in and no URLs to read one out of. Declaring it
    // false is the answer the port wants: `placeOf` then never names an
    // account, and nothing above has to wonder.
    accounts: false,
    costPerPoll: 1,
    ...options.capabilities,
  }

  const complain = (): void => {
    if (!options.trouble) return
    throw new ForgeError(options.trouble, `the scripted forge is ${options.trouble}`, {
      ...(options.trouble === 'rate' ? { retryAt: options.retryAt ?? now() + 60_000 } : {}),
    })
  }
  const writable = (): void => {
    complain()
    if (!capabilities.write || (options.can ?? 'write') === 'read') {
      throw new ForgeError('refused', 'this account may only read here')
    }
  }
  const found = (ref: ReviewRef): ReviewDetail => {
    complain()
    const one = table.find(
      (review) => review.ref.repo === ref.repo && review.ref.number === ref.number,
    )
    if (!one) throw new ForgeError('missing', `there is no review ${ref.repo}#${ref.number}`)
    return one
  }

  /** Where a remote goes. A table has one sign-in, so it never names an account. */
  function placeOf(remote: string): RemotePlace | null {
    const where = hostOf(remote)
    return where !== null && hosts.includes(where) ? { host: where, account: null } : null
  }

  return {
    id: 'scripted',
    capabilities,
    words: { one: 'review', many: 'reviews', short: 'review', number: (n) => `#${n}` },
    get wrote() {
      return wrote
    },
    serves(remote) {
      return placeOf(remote) !== null
    },
    placeOf,
    async whoami() {
      if (options.trouble === 'auth' || me === null) {
        return { problem: 'nobody is signed in to the scripted forge' }
      }
      return { login: me, can: options.can ?? 'write' }
    },
    async access(repo): Promise<Access> {
      if (options.trouble === 'auth' || me === null) {
        return { kind: 'not signed in', account: null, said: 'nobody is signed in' }
      }
      if (options.trouble) return { kind: 'cannot tell', said: `the table says ${options.trouble}` }
      // Whatever the table has been told about is visible; anything else is a
      // repository this sign-in cannot see, which is what a test wants to say.
      const known =
        options.unseen === undefined ? true : !options.unseen.some((one) => one === repo)
      return known
        ? { kind: 'signed in', account: me, can: options.can ?? 'write' }
        : { kind: 'no access', account: me, said: `${repo} is not shown to ${me}` }
    },
    async reviews(query: ReviewQuery): Promise<Page<Review>> {
      complain()
      let items = table.filter((review) => wanted(review, query))
      if (query.cursor) {
        const from = items.findIndex((review) => review.url === query.cursor)
        items = from < 0 ? items : items.slice(from + 1)
      }
      const limit = query.limit ?? items.length
      const page = items.slice(0, limit)
      return {
        items: page.map(plain),
        cursor: items.length > limit ? (page.at(-1)?.url ?? null) : null,
        more: items.length > limit,
      }
    },
    async review(ref) {
      return found(ref)
    },
    async reviewOf(repo, branch) {
      complain()
      const one = table.find((review) => review.ref.repo === repo && review.head.branch === branch)
      return one ? plain(one) : null
    },
    async checks(ref) {
      if (!capabilities.checks) {
        throw new ForgeError('unsupported', 'this forge does not report checks')
      }
      const one = found(ref)
      return (
        options.checks?.[`${ref.repo}#${ref.number}`] ??
        options.commits?.[`${ref.repo}@${one.head.sha}`] ??
        one.checksRan
      )
    },
    async checksOn(repo, commit) {
      if (!capabilities.commitChecks) {
        throw new ForgeError('unsupported', 'this forge cannot say what ran on a commit')
      }
      complain()
      // Nothing in the table for a commit is nothing having run on it, never
      // `missing`: on a branch that is the ordinary answer for the first
      // minute after every push.
      return options.commits?.[`${repo}@${commit}`] ?? []
    },
    async checkLog(ref, check, lines) {
      if (!capabilities.checkLogs) {
        throw new ForgeError('unsupported', 'this forge cannot hand back a check log')
      }
      return this.checkLogOn(ref.repo, found(ref).head.sha, check, lines)
    },
    async checkLogOn(repo, commit, check, lines) {
      if (!capabilities.checkLogs) {
        throw new ForgeError('unsupported', 'this forge cannot hand back a check log')
      }
      complain()
      const text = options.logs?.[`${repo}@${commit}:${check}`]
      if (text === undefined) {
        throw new ForgeError('missing', `${check} did not run on ${repo}@${commit}`)
      }
      return text.split('\n').slice(-lines).join('\n')
    },
    async open(request) {
      writable()
      const already = table.find(
        (review) => review.ref.repo === request.repo && review.head.branch === request.head,
      )
      if (already) return plain(already)
      const number = Math.max(0, ...table.map((review) => review.ref.number)) + 1
      const made = full(
        {
          ref: { repo: request.repo, number, host: hosts[0] ?? 'scripted.test' },
          title: request.title,
          state: request.draft ? 'draft' : 'open',
          author: me ?? 'you',
          mine: true,
          head: { branch: request.head, sha: 'head' },
          base: { branch: request.base, sha: null },
          url: `https://${hosts[0] ?? 'scripted.test'}/${request.repo}/pull/${number}`,
          task: taskIn(request.body),
        },
        me,
      )
      table.push(made)
      wrote.push({ kind: 'opened', request })
      return plain(made)
    },
    async say(ref, what) {
      writable()
      found(ref)
      if (!what.body.trim()) throw new ForgeError('refused', 'there is nothing to say')
      wrote.push({
        kind: 'said',
        ref,
        body: what.body,
        ...(what.thread === undefined ? {} : { thread: what.thread }),
      })
    },
    async mark(ref, what) {
      writable()
      const one = found(ref)
      if (what.ready) one.state = 'open'
      if (what.draft) one.state = 'draft'
      wrote.push({ kind: 'marked', ref, what: { ...what } })
    },
    async merge(ref, how) {
      writable()
      if (how === 'queue' && !capabilities.mergeQueue) {
        throw new ForgeError('unsupported', 'this forge has no merge queue')
      }
      const one = found(ref)
      one.state = 'merged'
      wrote.push({ kind: 'merged', ref, how })
    },
    limits() {
      return options.trouble === 'rate'
        ? { remaining: 0, of: 5_000, resetsAt: options.retryAt ?? now() + 60_000 }
        : { remaining: 4_900, of: 5_000, resetsAt: now() + 3_600_000 }
    },
  }
}

function wanted(review: ReviewDetail, query: ReviewQuery): boolean {
  if (query.who === 'mine' && !review.mine) return false
  if (query.who === 'waiting on you' && !review.waitingOnYou) return false
  if (query.state && !query.state.includes(review.state)) return false
  if (query.repos && query.repos.length > 0) {
    const ok = query.repos.some((glob) =>
      new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(
        review.ref.repo,
      ),
    )
    if (!ok) return false
  }
  if (query.since && review.updatedAt < query.since) return false
  return true
}

/** The review without its detail: what a list hands back. */
function plain(review: ReviewDetail): Review {
  const {
    checksRan: _checks,
    verdicts: _verdicts,
    threads: _threads,
    files: _files,
    ...rest
  } = review
  return rest
}

function taskIn(body: string): string | null {
  return /^Tade-Task:\s*(\S+)\s*$/m.exec(body)?.[1] ?? null
}

function full(one: ScriptedReview, me: string | null): ReviewDetail {
  const host = one.ref.host || 'scripted.test'
  return {
    ref: { ...one.ref, host },
    title: one.title ?? `review ${one.ref.number}`,
    url: one.url ?? `https://${host}/${one.ref.repo}/pull/${one.ref.number}`,
    state: one.state ?? 'open',
    author: one.author ?? me ?? 'somebody',
    mine: one.mine ?? (one.author ?? me) === me,
    waitingOnYou: one.waitingOnYou ?? false,
    head: one.head ?? { branch: `branch-${one.ref.number}`, sha: 'headsha' },
    base: one.base ?? { branch: 'main', sha: null },
    updatedAt: one.updatedAt ?? '2026-09-19T05:00:00.000Z',
    openedAt: one.openedAt === undefined ? '2026-09-18T05:00:00.000Z' : one.openedAt,
    checks: one.checks ?? 'none',
    decision: one.decision ?? 'none',
    conflicts: one.conflicts ?? false,
    blocked: one.blocked ?? null,
    task: one.task ?? null,
    checksRan: one.checksRan ?? [],
    verdicts: one.verdicts ?? [],
    threads: one.threads ?? [],
    files: one.files ?? [],
    ...(one.below === undefined ? {} : { below: one.below }),
  }
}
