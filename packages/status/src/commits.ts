import { git } from './git.ts'

// What has been committed, and how much of it there was.
//
// Tade reads a commit's task back out of its `Tade-Task:` trailer wherever it
// needs to know whose work it was — which is git's own mechanism, survives a
// squash merge, and is readable in a year by somebody with no Tade. This reads
// the same trailer and adds what `--numstat` says beside it, so "how much did
// this project's agents actually write" has an answer that is not a guess.
//
// A commit with no trailer is nobody's. That is always an allowed answer here,
// exactly as it is for reviews: guessing by author or by timestamp would
// attribute a person's own commit to whichever agent happened to be running.
//
// Pure parsing, so it is tested against real git output rather than trusted.

/**
 * The record separator. A control character because a commit subject can hold
 * anything a person can type, and a separator somebody can write by accident
 * is a parser that lies.
 */
const RECORD = '\u0001'
const FIELD = '\u0002'
const TRAILERS = '\u0003'

/** One commit per record: its sha, when it landed, and whose it says it is. */
export const STATS_FORMAT = `${RECORD}%H${FIELD}%ct${FIELD}%(trailers:key=Tade-Task,valueonly,separator=%x03)${FIELD}`

/** A commit as it was seen: whose it is, and how much it changed. */
export interface SeenCommit {
  sha: string
  /** When it was committed, in milliseconds. */
  at: number
  /** The task its trailer names, or null when it names none. */
  task: string | null
  added: number
  removed: number
  files: number
}

/**
 * What `git log --numstat` in `STATS_FORMAT` said.
 *
 * A binary file counts as a file changed and as no lines, which is what git
 * itself says by printing `-` for both counts: inventing a line count for a
 * PNG would put noise into every total it appears in.
 */
export function commitStatsFrom(stdout: string): SeenCommit[] {
  const out: SeenCommit[] = []
  for (const record of stdout.split(RECORD)) {
    if (record === '') continue
    const [sha = '', ct = '', trailer = '', rest = ''] = record.split(FIELD)
    if (sha.trim() === '') continue
    // Several trailers on one commit is somebody copying a message: the first
    // is the one that was meant, the same reading the window already takes.
    const task = (trailer.split(TRAILERS)[0] ?? '').trim()
    let added = 0
    let removed = 0
    let files = 0
    for (const line of rest.split('\n')) {
      const fields = line.split('\t')
      if (fields.length < 3) continue
      const [plus = '', minus = ''] = fields
      files += 1
      if (plus !== '-') added += Number(plus) || 0
      if (minus !== '-') removed += Number(minus) || 0
    }
    const seconds = Number(ct)
    out.push({
      sha: sha.trim(),
      at: Number.isFinite(seconds) ? seconds * 1000 : 0,
      task: task === '' ? null : task,
      added,
      removed,
      files,
    })
  }
  return out
}

export interface ReadCommitsOptions {
  /** How far back to walk. A bound, not a window: history is unbounded. */
  limit: number
  /** Only commits at or after this, when there is somewhere sensible to start. */
  since?: number | undefined
}

/**
 * The commits at the head of this checkout, newest first, with what each one
 * changed. Never throws: a directory that is not a repository, a git that is
 * not there and a history with nothing in it are all the same empty answer,
 * because nothing that only counts things may be the reason a window fails.
 */
export async function readCommits(root: string, opts: ReadCommitsOptions): Promise<SeenCommit[]> {
  const log = await git(root, [
    'log',
    '--no-color',
    '-n',
    String(Math.max(1, opts.limit)),
    `--format=${STATS_FORMAT}`,
    '--numstat',
    ...(opts.since === undefined ? [] : [`--since=${new Date(opts.since).toISOString()}`]),
  ])
  return log.ok ? commitStatsFrom(log.stdout) : []
}
