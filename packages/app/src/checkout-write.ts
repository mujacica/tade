import { git } from '@tade/status'

// What a person may change of a checkout from the window — switch to a branch
// or make one, rename one, pull, throw away one file's changes — as git is
// asked to do it, said back in git's own first line where it would not.
//
// Here rather than in `wire/files.ts`, because two halves ask it: the panels
// on this machine's own checkout (`files.ts`), and the far half of
// `/api/disk` (`wire/web-disk.ts`), which does the very same thing to this
// machine's checkout where another of the person's machines pressed it. One
// list of git's arguments, so a press there is never a different act from the
// same press here.

/** Done, or git's reason it was not. */
export type Wrote = { ok: true } | { ok: false; said: string }

/** How long a switch, a rename or a discard may take; a pull reaches a server, and is given longer. */
const WRITE_MS = 30_000
const PULL_MS = 60_000

async function wrote(root: string, args: string[], otherwise: string, ms = WRITE_MS) {
  const out = await git(root, args, ms)
  if (out.ok) return { ok: true } as const
  // Git's own words: an unstaged change in the way is a reason worth reading.
  const first = out.stderr.split('\n').find((line) => line.trim() !== '')
  return { ok: false, said: first ?? otherwise } as const
}

/** Onto a branch there is, or one made from where it stands. */
export function switchIn(root: string, name: string, create: boolean): Promise<Wrote> {
  return wrote(root, create ? ['switch', '-c', name] : ['switch', name], 'git refused')
}

/** A branch renamed: `from` is the one it is on, as whoever asked last saw it. */
export function renameIn(root: string, from: string, to: string): Promise<Wrote> {
  return wrote(root, ['branch', '-m', from, to], 'git would not rename it')
}

/** The branch brought up to its upstream, and only where that needs no merge. */
export function pullIn(root: string): Promise<Wrote> {
  return wrote(root, ['pull', '--ff-only'], 'git would not pull', PULL_MS)
}

/**
 * One file's uncommitted changes thrown away: back to the last commit, or gone
 * where it was never committed. `pathspec` is git's, so a caller that did not
 * choose the path itself hands it over as `:(literal)…`.
 */
export function discardIn(root: string, pathspec: string, untracked: boolean): Promise<Wrote> {
  return wrote(
    root,
    untracked
      ? ['clean', '-f', '--', pathspec]
      : ['restore', '--staged', '--worktree', '--source=HEAD', '--', pathspec],
    'git refused',
  )
}

/** What an agent's branch is called when it is renamed: under `tade/`, said or not. */
export function agentBranch(text: string): string {
  return text.startsWith('tade/') ? text : `tade/${text}`
}
