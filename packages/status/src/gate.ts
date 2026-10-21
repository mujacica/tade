import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import type { GitSnapshot } from '@tade/core'

// What lets a poll skip a worktree it has already looked at.
//
// `collectStatus` ran every git probe again from scratch on every beat, and
// nothing gated it: no `stat` of `.git/index`, no `stat` of `.git/HEAD`, no
// mtime, nothing. Thirteen worktrees is fifty spawns every two seconds for an
// answer that is, nearly always, the same answer.
//
// This is the rule Tade already has for probes — "a failed look degrades to
// the last scan that could rather than to an empty list" — asked one question
// earlier: a look that would cost four spawns to tell us what we were told a
// moment ago reuses the snapshot instead. It is not a staleness window, which
// is what makes it safe to hold at all: a kept snapshot stands only while
// everything it was derived from still reads the same.
//
// What the gate belongs to is whoever polls. The window holds one for as long
// as it is open; a one-shot `tade status` is given none and asks everything,
// because a one-shot has nothing to reuse and no second look to be wrong at.

/**
 * What a kept snapshot was derived from. All three parts must match for it to
 * be handed back.
 *
 * `asked` is the question — a different base, or a base that has moved, is a
 * different answer about the same worktree, which is how a branch that has
 * just been merged is still seen as merged. `seen` is the stat signature.
 */
export interface GateKey {
  worktree: string
  asked: string
  seen: string
  now: number
}

/** A probe's answer, kept whole: its warnings are part of what it said. */
export interface Kept {
  snapshot: GitSnapshot
  warnings: string[]
}

export interface ProbeGate {
  /**
   * The stat signature of this worktree, or null when it cannot be read — a
   * worktree being created, or one somebody has taken away. Null is never a
   * reuse: it means ask.
   */
  seen(worktree: string): Promise<string | null>
  /** The snapshot kept for this key, if one still stands. */
  reuse(key: GateKey): Kept | null
  /** Keep this answer against this key. Only a snapshot, never a failed look. */
  keep(key: GateKey, kept: Kept): void
  /**
   * The last answer git gave about this worktree, whatever has moved since and
   * however old: what a look git could not answer degrades to (`probeGit`),
   * because an empty answer there is read as a checkout that is not there.
   * Never a reuse — it is handed back only beside a warning that says so.
   */
  last(worktree: string): Kept | null
  /** Remember an answer as the last one git gave, asked or not through a key. */
  remember(worktree: string, kept: Kept): void
}

/**
 * How long a kept snapshot may stand when nothing a `stat` can see has moved.
 *
 * A stat of `.git/index`, `.git/HEAD` and the worktree's own directory sees a
 * commit, a branch switch, a `git add`, and a file created or deleted at the
 * top of the tree. What it cannot see is an **edit in place to a file git
 * already tracks**: the file's own mtime moves and nothing the gate stats
 * does. So the signature is what makes a worktree that moved re-probe on the
 * very next beat, and this ceiling is what makes one that only looks
 * unchanged re-probe anyway — without it, a window left open would go on
 * reporting a worktree clean for as long as you watched it.
 *
 * Three beats of the window's two seconds. The other gated probe in Tade
 * (`LANDED_MS`, commits that have landed) waits a minute, and can: nobody is
 * watching for a commit that closely. The dirty mark is the opposite — it is
 * the thing you are looking at while you work — so this is as short as it can
 * be and still skip two looks out of three.
 */
export const REUSE_MS = 6_000

/** How many worktrees are remembered at once. Past this the oldest goes. */
export const KEPT = 256

interface Held extends Kept {
  asked: string
  seen: string
  at: number
}

export function newProbeGate(opts: { reuseMs?: number; kept?: number } = {}): ProbeGate {
  const reuseMs = opts.reuseMs ?? REUSE_MS
  const cap = Math.max(1, opts.kept ?? KEPT)
  const held = new Map<string, Held>()
  const lastGood = new Map<string, Kept>()
  // Where each worktree keeps its own HEAD and index. A linked worktree's
  // `.git` is a file pointing at them and never moves, so this is read once
  // rather than on every beat — and it is the gate's own, not the module's, so
  // it dies with the poller that made it.
  const dirs = new Map<string, string>()

  const gitDirOf = async (worktree: string): Promise<string | null> => {
    const known = dirs.get(worktree)
    if (known !== undefined) return known
    const dot = join(worktree, '.git')
    const s = await stat(dot)
    if (s.isDirectory()) {
      dirs.set(worktree, dot)
      return dot
    }
    const found = /^gitdir:\s*(.+)$/m.exec(await readFile(dot, 'utf8'))
    if (!found) return null
    const dir = found[1]!.trim()
    const abs = isAbsolute(dir) ? dir : resolve(worktree, dir)
    dirs.set(worktree, abs)
    return abs
  }

  return {
    async seen(worktree) {
      try {
        const gitDir = await gitDirOf(worktree)
        if (gitDir === null) return null
        const parts = await Promise.all(
          [join(gitDir, 'index'), join(gitDir, 'HEAD'), worktree].map(marks),
        )
        return parts.join('|')
      } catch {
        // A worktree that will not stat is one to look at, not one to answer
        // from memory: the probe says what is wrong with it far better than a
        // gate could.
        return null
      }
    },
    reuse(key) {
      const entry = held.get(key.worktree)
      if (!entry) return null
      if (entry.asked !== key.asked || entry.seen !== key.seen) return null
      if (key.now - entry.at > reuseMs || key.now < entry.at) return null
      return { snapshot: entry.snapshot, warnings: entry.warnings }
    },
    keep(key, kept) {
      if (held.size >= cap && !held.has(key.worktree)) {
        const oldest = held.keys().next().value
        if (oldest !== undefined) held.delete(oldest)
      }
      held.set(key.worktree, {
        asked: key.asked,
        seen: key.seen,
        at: key.now,
        snapshot: kept.snapshot,
        warnings: kept.warnings,
      })
    },
    last(worktree) {
      return lastGood.get(worktree) ?? null
    },
    remember(worktree, kept) {
      lastGood.delete(worktree)
      if (lastGood.size >= cap) {
        const oldest = lastGood.keys().next().value
        if (oldest !== undefined) lastGood.delete(oldest)
      }
      lastGood.set(worktree, { snapshot: kept.snapshot, warnings: [...kept.warnings] })
    },
  }
}

/**
 * One path's marks. The inode is in it because git writes `.git/index` and
 * `.git/HEAD` by rename, so a commit replaces the file rather than touching
 * it — which is a change a filesystem whose mtime only counts whole seconds
 * would otherwise hide. Nanoseconds for the same reason, where there are any.
 * A path that is not there is a mark of its own, and not the same mark as one
 * that is.
 */
async function marks(path: string): Promise<string> {
  try {
    const s = await stat(path, { bigint: true })
    return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
  } catch {
    return 'gone'
  }
}
