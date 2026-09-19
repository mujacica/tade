import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

// The history of what Tade wrote for itself.
//
// Tools an agent wrote and lessons it proposed are the one part of Tade that
// Tade changes, so they are the one part where "when did this appear, and what
// was happening at the time" has to be answerable months later. A directory of
// files cannot answer it; a git repository can, and costs a commit.
//
// This is the first of the four things that make self-extension safe to allow
// at all. The others — `--safe`, nothing loading until somebody turns it on,
// and no hot reload — are elsewhere and were built first; this one is what
// makes an unwelcome change reviewable and undoable rather than merely
// stoppable.
//
// Never throws. A machine without git, or a directory that is already inside
// someone else's repository, loses the history and nothing else: refusing to
// accept a lesson because its history could not be recorded would be an absurd
// thing to do to somebody.

export interface AuthoredHistory {
  /** Whether anything was recorded. False is not a failure. */
  recorded: boolean
}

/**
 * Where git runs, and in its own process group: like every other process Tade
 * starts, so the terminal it runs in never names its window `git`. `execFile`
 * hands `detached` to the spawn beneath it; its types just do not say so.
 */
function gitOptions(cwd: string): { cwd: string } {
  const options = { cwd, detached: true }
  return options
}

/**
 * Record the current state of a directory Tade writes to.
 *
 * Called after anything changes it — a tool Tade wrote for itself arriving, a
 * human turning one on or off — and on opening, which catches whatever agents
 * wrote while nobody was looking.
 */
export async function recordAuthored(root: string, message: string): Promise<AuthoredHistory> {
  try {
    await mkdir(root, { recursive: true })
    const git = (args: string[]) => run('git', args, gitOptions(root))
    // `rev-parse --git-dir` rather than testing for `.git`: a directory that
    // is already inside a repository must not get a second one nested in it.
    const inside = await git(['rev-parse', '--git-dir']).then(
      () => true,
      () => false,
    )
    if (!inside) {
      await git(['init', '--quiet'])
      // Its own identity, so it never depends on a global git config being set
      // — and so the log says plainly that these commits are not yours.
      await git(['config', 'user.name', 'Tade'])
      await git(['config', 'user.email', 'tade@localhost'])
    }
    await git(['add', '-A'])
    // `diff --cached --quiet` exits 1 when there is something staged, which is
    // the only reliable way to avoid an empty commit without parsing status.
    const changed = await git(['diff', '--cached', '--quiet']).then(
      () => false,
      () => true,
    )
    if (!changed) return { recorded: false }
    await git(['commit', '--quiet', '--no-gpg-sign', '-m', message])
    return { recorded: true }
  } catch {
    return { recorded: false }
  }
}
