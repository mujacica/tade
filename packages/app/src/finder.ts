import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { git } from '@tade/status'

// Finding things in the places agents work: the files of each worktree, and
// the lines inside them.
//
// Both answers come from git, which already knows what is ignored: a search
// that walked `node_modules` would be slow and would find the wrong things.
// The parsing is pure and tested against real git output; asking is here too,
// because it is two commands and nothing else.
//
// The one place search looks that is not a worktree is the documents tasks
// produced (`listDocuments`), kept in Tade's home where git has nothing to say.

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

/** Nobody reads a list longer than this of one project's documents; past it, the rest are not listed. */
export const DOCUMENTS_MAX = 2_000

/**
 * Every file in a project's documents folder, as paths below it, in order.
 *
 * A listing of names and nothing read: what a document says is read when it is
 * chosen. Hidden files — an editor's swap file, a `.DS_Store` — are not
 * documents. A folder that is not there is a project none of whose tasks has
 * produced one yet, which is an answer; any other failure to list it is not,
 * and is thrown for whoever asked to say.
 */
export async function listDocuments(dir: string, max = DOCUMENTS_MAX): Promise<string[]> {
  const found = await readdir(dir, { recursive: true, withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      // No folder is a project none of whose tasks has produced one yet.
      if (err.code === 'ENOENT') return []
      throw err
    },
  )
  const files: string[] = []
  for (const entry of found) {
    if (!entry.isFile()) continue
    const path = relative(dir, join(entry.parentPath, entry.name))
    if (path.split('/').some((part) => part.startsWith('.'))) continue
    files.push(path)
  }
  return files.sort().slice(0, max)
}
