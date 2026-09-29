import type { GitSnapshot } from '@tade/core'
import { ForgeError, repoOf } from '@tade/forges-core'
import { execa } from 'execa'
import { type ForgeChoice, forgeExec, forgeFor } from './forges.ts'

// Git is invoked directly. `--porcelain=v2` and `-z` are stable contracts;
// everything is NUL-delimited because paths contain spaces and newlines.

const GIT_ENV = {
  // A probe runs alongside agents that are committing; never take the index lock.
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
}

export interface CmdResult {
  ok: boolean
  stdout: string
  stderr: string
}

export async function git(dir: string, args: string[], timeoutMs = 5_000): Promise<CmdResult> {
  const r = await execa('git', ['-C', dir, ...args], {
    reject: false,
    env: GIT_ENV,
    timeout: timeoutMs,
    // In its own process group, so the terminal Tade runs in never takes git
    // for the program in front of it: Terminal.app retitles the window after
    // whatever is, and status runs git every couple of seconds.
    detached: true,
    stripFinalNewline: false,
  })
  return {
    ok: r.exitCode === 0,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr.trim() : String(r.message),
  }
}

// --- worktree list -----------------------------------------------------------

export interface WorktreeEntry {
  path: string
  head: string | null
  /** Short branch name (`tade/x`), or null when detached. */
  branch: string | null
  bare: boolean
  prunable: boolean
}

export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  let cur: WorktreeEntry | null = null
  for (const field of stdout.split('\0')) {
    if (field === '') {
      if (cur) out.push(cur)
      cur = null
      continue
    }
    const sp = field.indexOf(' ')
    const key = sp === -1 ? field : field.slice(0, sp)
    const val = sp === -1 ? '' : field.slice(sp + 1)
    if (key === 'worktree') {
      if (cur) out.push(cur)
      cur = { path: val, head: null, branch: null, bare: false, prunable: false }
    } else if (cur) {
      if (key === 'HEAD') cur.head = val
      else if (key === 'branch') cur.branch = val.replace(/^refs\/heads\//, '')
      else if (key === 'bare') cur.bare = true
      else if (key === 'prunable') cur.prunable = true
    }
  }
  if (cur) out.push(cur)
  return out
}

export async function listWorktrees(root: string): Promise<WorktreeEntry[] | { error: string }> {
  const r = await git(root, ['worktree', 'list', '--porcelain', '-z'])
  if (!r.ok) return { error: r.stderr || 'git worktree list failed' }
  return parseWorktreeList(r.stdout)
}

// --- status ------------------------------------------------------------------

export interface StatusV2 {
  oid: string | null
  head: string | null
  upstream: string | null
  ahead: number | null
  behind: number | null
  paths: string[]
}

export function parseStatusV2(stdout: string): StatusV2 {
  const s: StatusV2 = {
    oid: null,
    head: null,
    upstream: null,
    ahead: null,
    behind: null,
    paths: [],
  }
  const parts = stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (!p) continue
    if (p.startsWith('# ')) {
      const [key, ...rest] = p.slice(2).split(' ')
      const val = rest.join(' ')
      if (key === 'branch.oid') s.oid = val === '(initial)' ? null : val
      else if (key === 'branch.head') s.head = val === '(detached)' ? null : val
      else if (key === 'branch.upstream') s.upstream = val
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val)
        if (m) {
          s.ahead = Number(m[1])
          s.behind = Number(m[2])
        }
      }
      continue
    }
    const fields = p.split(' ')
    switch (p[0]) {
      case '1':
        s.paths.push(fields.slice(8).join(' '))
        break
      case '2':
        s.paths.push(fields.slice(9).join(' '))
        i++ // the rename's original path is the next NUL field
        break
      case 'u':
        s.paths.push(fields.slice(10).join(' '))
        break
      case '?':
        s.paths.push(p.slice(2))
        break
    }
  }
  return s
}

// --- base branch -------------------------------------------------------------

/** The branch tasks merge into: local default branch if present, else the remote's. */
export async function resolveBaseRef(root: string): Promise<string | null> {
  const candidates: string[] = []
  const originHead = await git(root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  if (originHead.ok) {
    const remote = originHead.stdout.trim()
    candidates.push(remote.replace(/^origin\//, ''), remote)
  }
  candidates.push('main', 'master', 'origin/main', 'origin/master')
  for (const ref of candidates) {
    const r = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (r.ok) return ref
  }
  return null
}

// --- snapshot ----------------------------------------------------------------

export interface GitProbeOptions {
  baseRef: string | null
  /** Commit the task branched from (from task.yaml). */
  taskBase?: string | undefined
  /** Ask the forge what review this branch has. Off in tests: it is a network call. */
  pr: boolean
  /** How to reach a forge: which one serves which host, and which account. Defaults suffice. */
  forge?: Partial<ForgeChoice>
}

export interface GitProbeResult {
  snapshot: GitSnapshot | null
  warnings: string[]
}

/**
 * Whether merging a branch into the base would change nothing, which is what a
 * branch that was squash-merged looks like: its commits are nowhere in the
 * base, but everything they did is.
 *
 * Kept by the two commits it was asked about, because it is a whole three-way
 * merge and the probe runs every couple of seconds; the same two commits can
 * only ever give the same answer. Needs a git that can merge without a
 * worktree (2.38); an older one simply never sees a squash merge.
 */
const merges = new Map<string, boolean>()
const MERGES_KEPT = 500

async function givesNothing(worktree: string, baseRef: string, head: string): Promise<boolean> {
  const base = await git(worktree, ['rev-parse', `${baseRef}^{tree}`])
  if (!base.ok) return false
  const baseTree = base.stdout.trim()
  const key = `${worktree}\u0000${head}\u0000${baseTree}`
  const known = merges.get(key)
  if (known !== undefined) return known
  const merged = await git(worktree, ['merge-tree', '--write-tree', baseRef, head], 20_000)
  // Conflicts mean there is certainly something left; so does a git too old for this.
  const answer = merged.ok && merged.stdout.split('\n')[0]?.trim() === baseTree
  if (merges.size >= MERGES_KEPT) {
    const oldest = merges.keys().next().value
    if (oldest !== undefined) merges.delete(oldest)
  }
  merges.set(key, answer)
  return answer
}

export async function probeGit(worktree: string, opts: GitProbeOptions): Promise<GitProbeResult> {
  const warnings: string[] = []
  const st = await git(worktree, [
    'status',
    '--porcelain=v2',
    '-z',
    '--branch',
    '--untracked-files=all',
  ])
  if (!st.ok) {
    return { snapshot: null, warnings: [`${worktree}: git status failed: ${firstLine(st.stderr)}`] }
  }
  const status = parseStatusV2(st.stdout)

  let headSubject: string | null = null
  let headTime: number | null = null
  if (status.oid) {
    const log = await git(worktree, ['log', '-1', '--format=%H%x00%ct%x00%s'])
    if (log.ok) {
      const [, ct, subject] = log.stdout.replace(/\n$/, '').split('\0')
      headTime = ct ? Number(ct) * 1000 : null
      headSubject = subject ?? null
    }
  }

  let ahead: number | null = null
  let behind: number | null = null
  let mergedIntoBase = false
  const onBase = opts.baseRef !== null && status.head === opts.baseRef.replace(/^origin\//, '')
  if (opts.baseRef && status.oid && !onBase) {
    const rl = await git(worktree, [
      'rev-list',
      '--left-right',
      '--count',
      `HEAD...${opts.baseRef}`,
    ])
    const m = /^(\d+)\s+(\d+)/.exec(rl.stdout)
    if (m) {
      ahead = Number(m[1])
      behind = Number(m[2])
    } else {
      warnings.push(`${worktree}: could not compare with ${opts.baseRef}`)
    }
    if (opts.taskBase && !status.oid.startsWith(opts.taskBase)) {
      const anc = await git(worktree, ['merge-base', '--is-ancestor', 'HEAD', opts.baseRef])
      mergedIntoBase = anc.ok
      // A squash merge puts the work in the base under a commit of its own, so
      // there is no ancestry to follow: ask whether anything is left to merge.
      if (!mergedIntoBase && (ahead ?? 0) > 0 && status.paths.length === 0) {
        mergedIntoBase = await givesNothing(worktree, opts.baseRef, status.oid)
      }
    }
  }

  let pr: GitSnapshot['pr'] = null
  if (opts.pr && status.head) pr = await probeReview(worktree, status.head, opts.forge ?? {})

  return {
    snapshot: {
      branch: status.head,
      head: status.oid,
      headSubject,
      headTime,
      dirty: [...status.paths].sort(),
      ahead,
      behind,
      baseRef: opts.baseRef,
      mergedIntoBase,
      // Porcelain v2 omits branch.ab when the configured upstream no longer exists.
      upstreamGone: status.upstream !== null && status.ahead === null,
      pr,
    },
    warnings,
  }
}

/**
 * The review this branch is out for, as whatever forge serves its remote
 * says. The one narrow question status asks a forge, on every poll, with the
 * window closed: a branch with no review is `null`, and so is a forge that
 * cannot be reached, is not signed in to, or is rate limiting us — status
 * never throws, and a task whose review state we could not read is a task we
 * say nothing about rather than one we call merged.
 */
async function probeReview(
  worktree: string,
  branch: string,
  choice: Partial<ForgeChoice>,
): Promise<GitSnapshot['pr']> {
  const origin = await git(worktree, ['config', '--get', 'remote.origin.url'])
  const remote = origin.stdout.trim()
  if (!origin.ok || !remote) return null
  const repo = repoOf(remote)
  if (!repo) return null
  const forge = forgeFor(remote, { exec: forgeExec, cwd: worktree, ...choice })
  if (!forge) return null
  try {
    const review = await forge.reviewOf(repo, branch)
    return review ? { state: review.state, url: review.url } : null
  } catch (err) {
    // Nothing here is worth a warning on every poll: the extension says once
    // that it cannot reach the forge, and this degrades to "no review".
    if (err instanceof ForgeError) return null
    return null
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? ''
}
