import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import {
  type CheckedOut,
  type Contains,
  ORIGIN,
  type SyncFacts,
  type SyncSource,
  targetOf,
} from '@tade/core'
import { git, resolveBase } from './git.ts'
import { mirrorHeads } from './mirror.ts'

// Keeping a project's branch in step, as git sees it: what one look at a
// checkout finds for core's six rules (`sync.ts`), and the one move they
// allow. The rules, the lock and the telling are not here.
//
// **A look asks git and changes nothing in the checkout but its objects.**
// Origin's branch is fetched into its own remote-tracking ref, the way any
// `git fetch` there does, and another machine's commits are fetched out of
// this home's mirror of it (`mirror.ts`) as objects alone — no ref, no
// `FETCH_HEAD` — so that `git merge-base` and `git merge` can read them.
// Uncommitted work is read with `status --porcelain=v2 -z` under status's
// own environment, which never takes the index lock.
//
// **The move is git's own fast-forward**: `merge --ff-only` to a commit, never
// `git pull`, whose behaviour is the user's config, and never with an
// autostash; or, for a branch nothing has checked out, `update-ref` guarded
// on the commit the look saw, so a branch that moved since is not moved over.

/** How long fetching one branch from origin, or one machine's commits out of the mirror, may take. */
export const SYNC_FETCH_MS = 60_000

/** How long the move itself may take: a fast-forward rewrites the files it changes. */
export const SYNC_MOVE_MS = 60_000

/**
 * Nothing left running behind a fetch: no gc, no maintenance of its own. Given
 * as the environment's config rather than `-c`, so the command is still the
 * first word git is handed, which is what `gitLoad` counts.
 */
const QUIET_FETCH = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'gc.auto',
  GIT_CONFIG_VALUE_0: '0',
  GIT_CONFIG_KEY_1: 'maintenance.auto',
  GIT_CONFIG_VALUE_1: 'false',
}

/** What one look found, and what it could not do on the way — each said, never swallowed. */
export interface SyncLooked {
  facts: SyncFacts
  troubles: string[]
}

export interface SyncLookOptions {
  project: string
  /** The project's checkout. */
  root: string
  /** This home's mirror of the project (`mirrorDir`), holding other machines' branches. */
  mirror: string
  /** Fetch origin's branch first, rather than reading what was fetched last. */
  fetchOrigin: boolean
  /** Only these sources (`origin`, a machine's name); every one where absent. */
  only?: readonly string[]
  /** Where each task works, so a branch checked out in a worktree is said as whose. */
  tasks?: readonly { id: string; dir: string }[]
}

/**
 * Whether one commit is another or an ancestor of it, by the pair: commits do
 * not change, so neither does the answer, and a quiet project asks git nothing
 * twice. Bounded, oldest out.
 */
const ancestry = new Map<string, boolean>()
const ANCESTRY_KEPT = 2048

async function isAncestor(dir: string, older: string, newer: string): Promise<boolean> {
  if (older === newer) return true
  const key = `${older}:${newer}`
  const known = ancestry.get(key)
  if (known !== undefined) return known
  const asked = await git(dir, ['merge-base', '--is-ancestor', older, newer])
  // 1 is "no"; anything else is git unable to say, which is no answer to keep.
  if (!asked.ok && asked.exitCode !== 1) return false
  if (ancestry.size >= ANCESTRY_KEPT) ancestry.delete(ancestry.keys().next().value as string)
  ancestry.set(key, asked.ok)
  return asked.ok
}

/** One look at a project's checkout, for the rules. Never throws for anything git says. */
export async function lookSync(opts: SyncLookOptions): Promise<SyncLooked> {
  const troubles: string[] = []
  const { root, project } = opts
  const empty = (branch: string | null, at: CheckedOut, head: string | null): SyncFacts => ({
    project,
    branch,
    at,
    head,
    target: { kind: 'none', why: 'nothing was looked at' },
    forward: false,
    ahead: 0,
    behind: 0,
    incoming: [],
    dirty: [],
    staged: [],
    inTheWay: [],
    committing: false,
  })
  const branch = await branchOf(root)
  if (branch === null) return { facts: empty(null, { kind: 'nowhere' }, null), troubles }
  const at = await checkedOut(root, branch, opts.tasks ?? [])
  const headRead = await git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}^{commit}`,
  ])
  const head = headRead.ok ? headRead.stdout.trim() : null
  if (head === null) return { facts: empty(branch, at, null), troubles }

  const wanted = (from: string) => opts.only === undefined || opts.only.includes(from)
  const sources: SyncSource[] = []
  if (wanted(ORIGIN)) {
    const origin = await fromOrigin(root, branch, opts.fetchOrigin)
    if (origin.trouble) troubles.push(origin.trouble)
    if (origin.sha) sources.push({ from: ORIGIN, sha: origin.sha })
  }
  const heads = await mirrorHeads(opts.mirror)
  if (heads === null) troubles.push(`the mirror at ${opts.mirror} could not be read`)
  for (const [ref, sha] of heads ?? []) {
    const machine = machineOf(ref, branch)
    if (machine === null || machine === ORIGIN || !wanted(machine)) continue
    const had = await objectsFrom(root, opts.mirror, ref, sha)
    if (had !== null) troubles.push(`${machine}'s ${branch} could not be read here: ${had}`)
    else sources.push({ from: machine, sha })
  }

  const shas = [head, ...sources.map((one) => one.sha)]
  const known = new Map<string, boolean>()
  for (const older of shas) {
    for (const newer of shas) {
      if (older !== newer && !known.has(`${older}:${newer}`)) {
        known.set(`${older}:${newer}`, await isAncestor(root, older, newer))
      }
    }
  }
  const contains: Contains = (older, newer) =>
    older === newer || known.get(`${older}:${newer}`) === true
  const target = targetOf(head, sources, contains)
  const facts: SyncFacts = { ...empty(branch, at, head), target }
  if (target.kind !== 'one') return { facts, troubles }

  facts.forward = contains(head, target.sha)
  facts.behind = await countOf(root, `${head}..${target.sha}`)
  if (!facts.forward) {
    facts.ahead = await countOf(root, `${target.sha}..${head}`)
    return { facts, troubles }
  }
  facts.incoming = await incomingOf(root, head, target.sha)
  if (at.kind !== 'checkout') return { facts, troubles }
  const tree = await uncommitted(at.dir)
  if (tree === null) {
    // Unread is never clean: a look that could not see the tree waits.
    troubles.push(`what is uncommitted in ${at.dir} could not be read`)
    return { facts: { ...facts, committing: true }, troubles }
  }
  facts.dirty = tree.dirty
  facts.staged = tree.staged
  facts.committing = await committing(at.dir)
  facts.inTheWay = await inTheWay(
    at.dir,
    facts.incoming.filter((one) => one.added).map((one) => one.path),
  )
  return { facts, troubles }
}

/**
 * The move the rules allowed, by the facts of the look under the lock, in the
 * project's checkout at `root`: null when it landed, or why not.
 */
export async function moveSync(
  root: string,
  facts: SyncFacts,
  target: string,
): Promise<string | null> {
  const { branch, head } = facts
  if (branch === null || head === null) return 'there is no branch to move'
  if (facts.at.kind === 'nowhere') {
    // Guarded on what the look saw: a branch that moved since is left as it is.
    const moved = await git(
      root,
      ['update-ref', '-m', 'tade: kept in step', `refs/heads/${branch}`, target, head],
      SYNC_MOVE_MS,
    )
    return moved.ok ? null : gitSaid(moved.stderr, 'update-ref')
  }
  const dir = facts.at.dir
  const merged = await git(
    dir,
    // `--no-autostash` over whatever `merge.autoStash` says: nothing is ever stashed.
    ['merge', '--ff-only', '--no-autostash', '--quiet', target],
    SYNC_MOVE_MS,
  )
  if (!merged.ok) return gitSaid(merged.stderr || merged.stdout, 'merge --ff-only')
  const now = await git(dir, ['rev-parse', 'HEAD'])
  return now.ok && now.stdout.trim() === target
    ? null
    : `HEAD is at ${now.stdout.trim().slice(0, 7) || 'nothing git could name'} after the move, not ${target.slice(0, 7)}`
}

/** The branch kept in step: the checkout's own, or its base where it is on none. */
async function branchOf(root: string): Promise<string | null> {
  const on = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (on.ok && on.stdout.trim() !== '') return on.stdout.trim()
  const base = await resolveBase(root)
  if (base === null || base.ref.startsWith('origin/')) return null
  return base.ref
}

/**
 * Where a branch is checked out: the project's checkout, another worktree, or
 * nowhere. Read line by line, because `worktree list -z` is newer than git
 * 2.34, which Ubuntu 22.04 has.
 */
async function checkedOut(
  root: string,
  branch: string,
  tasks: readonly { id: string; dir: string }[],
): Promise<CheckedOut> {
  const listed = await git(root, ['worktree', 'list', '--porcelain'])
  const own = await real(root)
  let dir: string | null = null
  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice('worktree '.length)
    else if (line === `branch refs/heads/${branch}` && dir !== null) {
      const there = await real(dir)
      if (there === own) return { kind: 'checkout', dir: root }
      const task = await taskAt(there, tasks)
      return { kind: 'worktree', dir, task }
    }
  }
  if (!listed.ok) {
    // Unread is never nowhere: moving a ref somebody has checked out would move it under them.
    const on = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    return on.ok && on.stdout.trim() === branch
      ? { kind: 'checkout', dir: root }
      : { kind: 'worktree', dir: '(git could not list the worktrees)', task: null }
  }
  return { kind: 'nowhere' }
}

async function taskAt(
  dir: string,
  tasks: readonly { id: string; dir: string }[],
): Promise<string | null> {
  for (const one of tasks) if ((await real(one.dir)) === dir) return one.id
  return null
}

/** A folder by its real path; one that is not there (a worktree removed) by the path given. */
async function real(dir: string): Promise<string> {
  return realpath(dir).catch((err: unknown) => {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return resolve(dir)
    throw err
  })
}

/** Origin's branch: fetched first where asked, then read. */
async function fromOrigin(
  root: string,
  branch: string,
  fetch: boolean,
): Promise<{ sha: string | null; trouble: string | null }> {
  const url = await git(root, ['config', '--get', 'remote.origin.url'])
  if (!url.ok || url.stdout.trim() === '') return { sha: null, trouble: null }
  let trouble: string | null = null
  if (fetch) {
    const fetched = await git(
      root,
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-write-fetch-head',
        'origin',
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      SYNC_FETCH_MS,
      QUIET_FETCH,
    )
    // A branch origin does not have is no source, and no trouble.
    if (!fetched.ok && !/couldn't find remote ref|not our ref/i.test(fetched.stderr)) {
      trouble = fetched.timedOut
        ? `fetching ${branch} from origin did not finish in ${SYNC_FETCH_MS / 1000}s`
        : `${branch} could not be fetched from origin: ${gitSaid(fetched.stderr, 'fetch')}`
    }
  }
  const read = await git(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${branch}^{commit}`,
  ])
  return { sha: read.ok ? read.stdout.trim() : null, trouble }
}

/** The machine a mirror ref is the branch of: `refs/remotes/<machine>/<branch>`, or null. */
function machineOf(ref: string, branch: string): string | null {
  const prefix = 'refs/remotes/'
  const suffix = `/${branch}`
  if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) return null
  const machine = ref.slice(prefix.length, ref.length - suffix.length)
  return machine !== '' && !machine.includes('/') ? machine : null
}

/**
 * A machine's commits made readable in the checkout: fetched out of the
 * mirror as objects alone, where the checkout has not got them. Null when it
 * has them now, or git's reason.
 */
async function objectsFrom(
  root: string,
  mirror: string,
  ref: string,
  sha: string,
): Promise<string | null> {
  const has = await git(root, ['cat-file', '-e', `${sha}^{commit}`])
  if (has.ok) return null
  const fetched = await git(
    root,
    ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', mirror, ref],
    SYNC_FETCH_MS,
    QUIET_FETCH,
  )
  if (!fetched.ok) return gitSaid(fetched.stderr, 'fetch')
  const now = await git(root, ['cat-file', '-e', `${sha}^{commit}`])
  return now.ok ? null : `the mirror did not hand over ${sha.slice(0, 7)}`
}

async function countOf(root: string, range: string): Promise<number> {
  const counted = await git(root, ['rev-list', '--count', range])
  const n = Number(counted.stdout.trim())
  return counted.ok && Number.isInteger(n) ? n : 0
}

/** What a move from `head` to `target` changes: each path, and whether the target adds it. */
async function incomingOf(
  root: string,
  head: string,
  target: string,
): Promise<{ path: string; added: boolean }[]> {
  if (head === target) return []
  const diff = await git(
    root,
    ['diff', '--name-status', '--no-renames', '-z', head, target],
    30_000,
  )
  const out: { path: string; added: boolean }[] = []
  const words = diff.stdout.split('\0')
  for (let i = 0; i + 1 < words.length; i += 2) {
    const status = words[i] ?? ''
    const path = words[i + 1] ?? ''
    if (path !== '') out.push({ path, added: status.startsWith('A') })
  }
  return out
}

/**
 * Every uncommitted path in a checkout, and what of it is staged: modified,
 * added, deleted, renamed (both names), unmerged and untracked, each file
 * by itself. Null where git could not say.
 */
export async function uncommitted(
  dir: string,
): Promise<{ dirty: string[]; staged: string[] } | null> {
  const status = await git(
    dir,
    ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=none'],
    30_000,
  )
  if (!status.ok) return null
  const dirty = new Set<string>()
  const staged = new Set<string>()
  const entries = status.stdout.split('\0')
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i] ?? ''
    const kind = entry[0]
    if (kind === '1') {
      const path = fieldsAfter(entry, 8)
      dirty.add(path)
      if (entry[2] !== '.') staged.add(path)
    } else if (kind === '2') {
      const path = fieldsAfter(entry, 9)
      const orig = entries[++i] ?? ''
      dirty.add(path)
      if (orig !== '') dirty.add(orig)
      if (entry[2] !== '.') {
        staged.add(path)
        if (orig !== '') staged.add(orig)
      }
    } else if (kind === 'u') {
      const path = fieldsAfter(entry, 10)
      dirty.add(path)
      staged.add(path)
    } else if (kind === '?') {
      dirty.add(entry.slice(2))
    }
  }
  return { dirty: [...dirty].sort(), staged: [...staged].sort() }
}

/** The rest of a porcelain v2 entry after its first `n` space-separated fields: the path, spaces and all. */
function fieldsAfter(entry: string, n: number): string {
  let at = 0
  for (let i = 0; i < n; i++) {
    const next = entry.indexOf(' ', at)
    if (next < 0) return ''
    at = next + 1
  }
  return entry.slice(at)
}

/** Whether somebody holds the checkout's index lock: mid-commit, mid-merge, mid-anything. */
async function committing(dir: string): Promise<boolean> {
  const gitDir = await git(dir, ['rev-parse', '--absolute-git-dir'])
  const where = gitDir.stdout.trim()
  if (!gitDir.ok || !isAbsolute(where)) return true
  return exists(join(where, 'index.lock'))
}

/**
 * The paths a move would add that are already on disk — untracked, or ignored,
 * which `git merge` would write over without a word — and those whose folder
 * is a file here.
 */
async function inTheWay(dir: string, added: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const path of added) if (await exists(join(dir, path))) out.push(path)
  return out
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (err) {
    // A folder on the way that is a file here is in the way too.
    return (err as NodeJS.ErrnoException).code === 'ENOTDIR'
  }
}

/** git's own reason: its first `fatal:` or `error:`, or its first line. */
function gitSaid(stderr: string, what: string): string {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const why = lines.find((line) => /^(fatal|error):/.test(line)) ?? lines[0]
  return why?.replace(/^(fatal|error):\s*/, '').slice(0, 300) || `git ${what} said nothing`
}
