import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
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

/**
 * How much of one task's folder is listed. A cap per task and never per project:
 * one over the whole folder, sorted, kept the first two thousand files of a
 * folder holding forty-eight thousand, and one task's 42,756 frames took every
 * document sorted after them out of search.
 */
export const DOCUMENTS_MAX = 50_000

/**
 * Every file in a project's documents folder, as paths below it: what is loose
 * in it, then each task's folder, nearest the top first.
 *
 * A listing of names and nothing read: what a document says is read when it is
 * chosen. Hidden files — an editor's swap file, a `.DS_Store` — are not
 * documents. Read a folder at a time, so tens of thousands of names reach the
 * window's thread in pieces and not as one long turn of it. A folder that is
 * not there is a project none of whose tasks has produced one yet, which is an
 * answer; any other failure to list it is not, and is thrown for whoever asked
 * to say.
 */
export async function listDocuments(dir: string, max = DOCUMENTS_MAX): Promise<string[]> {
  const { files, folders } = await namesIn(dir, '')
  const below = await Promise.all(folders.map((folder) => listTask(dir, folder, max)))
  return [...files, ...below.flat()]
}

/** One task's folder, breadth first: what is cut by `max` is what is buried deepest. */
async function listTask(dir: string, task: string, max: number): Promise<string[]> {
  const found: string[] = []
  const waiting = [task]
  for (let at = 0; at < waiting.length && found.length < max; at++) {
    const { files, folders } = await namesIn(dir, waiting[at] ?? '')
    found.push(...files.slice(0, max - found.length))
    waiting.push(...folders)
  }
  return found
}

/** What is in one folder below `dir`, as paths below `dir`, each list in order. */
async function namesIn(
  dir: string,
  within: string,
): Promise<{ files: string[]; folders: string[] }> {
  const entries = await readdir(join(dir, within), { withFileTypes: true }).catch(
    (err: NodeJS.ErrnoException) => {
      // No folder is a project none of whose tasks has produced one yet, or
      // one the cleanup took between being listed and being read.
      if (err.code === 'ENOENT') return []
      throw err
    },
  )
  const files: string[] = []
  const folders: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = within === '' ? entry.name : `${within}/${entry.name}`
    if (entry.isFile()) files.push(path)
    else if (entry.isDirectory()) folders.push(path)
  }
  return { files: files.sort(), folders: folders.sort() }
}
