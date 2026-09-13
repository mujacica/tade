import { git } from '@wilco/status'

// Finding things in the places agents work: the files of each worktree, and
// the lines inside them.
//
// Both answers come from git, which already knows what is ignored: a search
// that walked `node_modules` would be slow and would find the wrong things.
// The parsing is pure and tested against real git output; asking is here too,
// because it is two commands and nothing else.

/** A folder to search, and what to call it in the results: a project, or an agent in one. */
export interface SearchRoot {
  path: string
  label: string
  /** The agent working there, if one is. */
  task: string | null
}

/** Nobody scrolls past this many files; a repository that has more is still searched, by name. */
export const FILES_MAX = 50_000

/** A line found inside a file. */
export interface Match {
  root: SearchRoot
  path: string
  line: number
  text: string
}

/** `git ls-files -z`, as paths. */
export function filesFrom(out: string, max = FILES_MAX): string[] {
  const files = out.split('\0').filter(Boolean)
  return files.length > max ? files.slice(0, max) : files
}

/** `git grep -n -z`: `path NUL line NUL text` per line. */
export function matchesFrom(out: string, root: SearchRoot, max: number): Match[] {
  const found: Match[] = []
  for (const record of out.split('\n')) {
    if (found.length >= max) break
    const first = record.indexOf('\0')
    const second = first < 0 ? -1 : record.indexOf('\0', first + 1)
    if (second < 0) continue
    const line = Number(record.slice(first + 1, second))
    if (!Number.isFinite(line)) continue
    found.push({ root, path: record.slice(0, first), line, text: record.slice(second + 1) })
  }
  return found
}

/** Every file in a worktree that git would show you: tracked, and new but not ignored. */
export async function listFiles(root: string): Promise<string[]> {
  const out = await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
  return out.ok ? [...new Set(filesFrom(out.stdout))] : []
}

/**
 * Lines containing some text, case-insensitively, in tracked and new files.
 * Fixed strings, not patterns: what you type in a search box is what you mean.
 */
export async function grep(root: SearchRoot, text: string, max = 100): Promise<Match[]> {
  const out = await git(root.path, [
    'grep',
    '-n',
    '-z',
    '-I',
    '-i',
    '-F',
    '--no-color',
    '--untracked',
    '--max-count',
    '5',
    '-e',
    text,
  ])
  // Exit 1 is "nothing found", which is an answer, not a failure.
  return matchesFrom(out.stdout, root, max)
}
