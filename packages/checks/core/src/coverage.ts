import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CheckRun, Covered, CoveredPath } from './port.ts'
import type { At } from './records.ts'

// What a run covered, and when it still speaks for a commit made after it.
//
// A run is recorded against the commit that was checked out when it started,
// and an agent's ordinary minute is: run the checks, then commit. HEAD moves,
// and the commit nobody has looked at reads `not run` — though the bytes the
// commands read are byte-for-byte what was committed. That is the bug this
// file exists for, and the invariant it must not break is that a check nobody
// ran is not a check that passed.
//
// What makes carrying it over sound is that a run is about a *tree*, not a
// commit id: the same commands over the same bytes give the same answer. So a
// run covers a commit exactly when the commit's content is the content the
// run read, and `coverageOf` records what that was — the tree of the commit it
// ran at, every tracked path whose bytes on disk differed from it, and the
// untracked files that were also lying about. A later commit carries the run
// only when applying that record to the run's tree yields the commit's tree:
// every path the run read differently is in the commit with the bytes the run
// read, and the commit changes nothing else.
//
// Which is exact about the case this project lives in. Agents share one
// checkout, so the bytes a run reads routinely include another agent's
// uncommitted work. Committing your own files then leaves that agent's changes
// in the run's record and out of the commit, the two trees differ, and the
// answer stays `unknown` — as it must, because that commit's tree is a tree
// nobody has run anything over. The same falls out for a partial commit of
// your own files, and for anything edited between the run and the commit: the
// bytes committed are not the bytes read, so nothing carries.
//
// Untracked files are the one thing not in that comparison, and cannot be — no
// commit's tree holds them. They are recorded so a commit that *adds* one can
// be matched against the bytes the run read at that path, which is the
// commonest carry there is: a new file written, checked, and committed. One
// that stays untracked stays on disk, exactly where it was during the run and
// where it would be for a re-run here, so it is not what makes the run's tree
// and the commit's tree differ.

/** How many untracked files are read into a record. A commit that adds one beyond it reads `unknown`. */
const MOST_UNTRACKED = 64

/** And none bigger than this: an artifact nobody commits is not worth reading. */
const BIGGEST_BYTES = 4_000_000

/**
 * Beyond this many tracked changes we record nothing: a worktree in that
 * state is not about to be committed whole, and a record of it, kept a
 * couple of hundred times over, costs more than running the checks again.
 */
const MOST_DIRTY = 200

/** How many `git diff-tree` calls one question may cost, however many runs are recorded. */
const MOST_TREES = 4

/** How long any one git call is given. A probe that hangs is a window that hangs. */
const TIMEOUT_MS = 20_000

/** And how much it may print. A diff of a whole tree is not an answer we want. */
const MOST_BYTES = 16_000_000

/**
 * What the worktree holds right now, as a run's coverage.
 *
 * Null when it cannot be read whole — no repository, a merge in progress, a
 * submodule, a symlink or a path git and we would hash differently. A run with
 * no coverage covers nothing but the commit it names, which is where this all
 * started, so an unreadable worktree costs nothing but the carry.
 */
export async function coverageOf(worktree: string, commit: string): Promise<Covered | null> {
  const tree = await treeOf(worktree, commit)
  if (!tree) return null
  const out = await git(worktree, ['status', '--porcelain=v2', '-z', '-uall', '--no-renames'])
  if (out === null) return null
  const seen = readStatus(out)
  if (!seen) return null
  if (seen.tracked.length > MOST_DIRTY) return null

  // Everything whose bytes have to be read, hashed the way `git add` would
  // hash them — one call, in one order, so a path and its blob cannot drift
  // apart.
  const changed = seen.tracked.filter((one) => one.workMode !== '000000')
  if (changed.some((one) => one.workMode !== '100644' && one.workMode !== '100755')) return null
  const extra: { path: string; mode: string }[] = []
  for (const path of seen.untracked) {
    if (extra.length >= MOST_UNTRACKED) break
    const info = await lstat(join(worktree, path)).catch(() => null)
    if (!info?.isFile() || info.size > BIGGEST_BYTES) continue
    extra.push({ path, mode: (info.mode & 0o111) === 0 ? '100644' : '100755' })
  }
  const paths = [...changed.map((one) => one.path), ...extra.map((one) => one.path)]
  // A newline in a path would misalign every hash after it against its path,
  // which is the one way this could be quietly wrong rather than unknown.
  if (paths.some((path) => path.includes('\n'))) return null
  const oids = paths.length === 0 ? [] : await hashObjects(worktree, paths)
  if (!oids || oids.length !== paths.length) return null

  const dirty: CoveredPath[] = []
  let n = 0
  for (const one of seen.tracked) {
    if (one.workMode === '000000') {
      dirty.push({ path: one.path, oid: null, mode: null })
      continue
    }
    const oid = oids[n++] ?? ''
    // Listed as changed and yet the commit's own bytes and mode: staged and
    // put back, or touched and not written. Not a difference.
    if (oid === one.headOid && one.workMode === one.headMode) continue
    dirty.push({ path: one.path, oid, mode: one.workMode })
  }
  const untracked = extra.map((one, i) => ({
    path: one.path,
    oid: oids[changed.length + i] ?? '',
    mode: one.mode,
  }))
  return { tree, dirty: byPath(dirty), untracked: byPath(untracked) }
}

/**
 * Whether the bytes a run read are exactly what a commit holds, given how the
 * commit's tree differs from the tree the run ran at.
 */
export function coversCommit(covered: Covered, delta: readonly CoveredPath[]): boolean {
  const read = new Map(covered.dirty.map((one) => [one.path, one]))
  const alsoOnDisk = new Map(covered.untracked.map((one) => [one.path, one]))
  const answered = new Set<string>()
  for (const at of delta) {
    const was = read.get(at.path) ?? alsoOnDisk.get(at.path)
    // The commit holds something at a path the run read as the tree had it —
    // somebody else's work, or an edit made after the run. Nobody has run
    // anything over these bytes.
    if (!was) return false
    if (was.oid !== at.oid || was.mode !== at.mode) return false
    answered.add(at.path)
  }
  // And the other way: something the run read differently that the commit did
  // not take. A partial commit, and the commit still holds the old bytes.
  for (const path of read.keys()) if (!answered.has(path)) return false
  return true
}

/**
 * The commit in hand, and which recorded runs still speak for it because the
 * bytes they read are what it holds. Reads git; writes nothing, not even an
 * object. Costs no git call at all when nothing was recorded that could carry.
 */
export async function carryOver(
  worktree: string,
  runs: readonly CheckRun[],
  commit: string | null,
): Promise<At> {
  if (!commit) return { commit }
  // Newest first, so a bounded number of git calls goes to the runs most
  // likely to be the ones somebody just made.
  const candidates = [...runs].reverse().filter((run) => run.covered && run.commit !== commit)
  if (candidates.length === 0) return { commit }
  const now = await treeOf(worktree, commit)
  if (!now) return { commit }
  const carried = new Set<string>()
  const deltas = new Map<string, readonly CoveredPath[] | null>()
  for (const run of candidates) {
    const covered = run.covered
    if (!covered) continue
    // Nothing differed from the commit it ran at, and this commit holds that
    // same content: the run read these bytes, whatever the commit is called.
    if (covered.dirty.length === 0 && covered.tree === now) {
      carried.add(run.id)
      continue
    }
    if (!deltas.has(covered.tree)) {
      if (deltas.size >= MOST_TREES) continue
      deltas.set(covered.tree, await delta(worktree, covered.tree, now))
    }
    const between = deltas.get(covered.tree)
    if (between && coversCommit(covered, between)) carried.add(run.id)
  }
  return { commit, carried }
}

// --- git ---------------------------------------------------------------------

/** A commit's tree. Cached: what a commit points at never changes. */
async function treeOf(worktree: string, commit: string): Promise<string | null> {
  const key = commit
  const known = trees.get(key)
  if (known) return known
  const out = await git(worktree, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`])
  const tree = out?.trim()
  if (!tree) return null
  remember(trees, key, tree)
  return tree
}

/** How two trees differ, path by path, as the second one holds it. Cached for the same reason. */
async function delta(
  worktree: string,
  from: string,
  to: string,
): Promise<readonly CoveredPath[] | null> {
  const key = `${from}:${to}`
  const known = deltas.get(key)
  if (known) return known
  const out = await git(worktree, ['diff-tree', '-r', '-z', '--no-renames', from, to])
  if (out === null) return null
  const fields = out.split('\0')
  const paths: CoveredPath[] = []
  for (let i = 0; i < fields.length; i++) {
    const head = fields[i] ?? ''
    if (!head.startsWith(':')) continue
    const path = fields[++i]
    if (path === undefined) return null
    // :<srcmode> <dstmode> <srcoid> <dstoid> <status>
    const parts = head.slice(1).split(' ')
    const mode = parts[1]
    const oid = parts[3]
    if (!mode || !oid) return null
    const gone = /^0+$/.test(mode)
    paths.push({ path, oid: gone ? null : oid, mode: gone ? null : mode })
  }
  remember(deltas, key, paths)
  return paths
}

/** Hash what is on disk at each path, as `git add` would. In, and back, in order. */
async function hashObjects(worktree: string, paths: readonly string[]): Promise<string[] | null> {
  const out = await git(
    worktree,
    ['hash-object', '--stdin-paths'],
    `${paths.map((path) => join(worktree, path)).join('\n')}\n`,
  )
  if (out === null) return null
  const oids = out.split('\n').filter((line) => line !== '')
  return oids.length === paths.length ? oids : null
}

interface StatusEntry {
  path: string
  headOid: string
  headMode: string
  workMode: string
}

/** `--porcelain=v2 -z`, hand-parsed. Null on anything we do not model. */
function readStatus(out: string): { tracked: StatusEntry[]; untracked: string[] } | null {
  const tracked: StatusEntry[] = []
  const untracked: string[] = []
  for (const record of out.split('\0')) {
    if (record === '') continue
    const kind = record[0]
    if (kind === '?') {
      untracked.push(record.slice(2))
      continue
    }
    if (kind === '!') continue
    if (kind !== '1') return null // unmerged, or a rename we asked not to have
    // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    const f = record.split(' ')
    if (f.length < 9) return null
    if (!f[2]?.startsWith('N')) return null // a submodule is not ours to model
    tracked.push({
      path: f.slice(8).join(' '),
      headMode: f[3] ?? '',
      workMode: f[5] ?? '',
      headOid: f[6] ?? '',
    })
  }
  untracked.sort()
  return { tracked, untracked }
}

function byPath(paths: CoveredPath[]): CoveredPath[] {
  return [...paths].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** What a commit points at, and how two trees differ: both immutable, so both worth keeping. */
const trees = new Map<string, string>()
const deltas = new Map<string, readonly CoveredPath[]>()
const MOST_REMEMBERED = 64

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= MOST_REMEMBERED) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(key, value)
}

/**
 * Git, read-only and never in the way: no index lock, because this runs beside
 * agents that are committing, and in a process group of its own, because the
 * terminal renames its window after whatever it takes for the program in front.
 */
function git(dir: string, args: string[], input?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (value: string | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn('git', ['-C', dir, ...args], {
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C',
      },
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, TIMEOUT_MS)
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
      if (out.length > MOST_BYTES) {
        child.kill('SIGKILL')
        finish(null)
      }
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? out : null))
    child.stdin.on('error', () => finish(null))
    child.stdin.end(input ?? '')
  })
}
