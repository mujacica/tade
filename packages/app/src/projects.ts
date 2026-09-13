import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { git } from '@wilco/status'

// Finding a project to open: the ones you have looked at lately, and any
// folder, browsed from your home folder or by typing its path.
//
// Recent projects are a convenience, like the pane the window reopens on:
// written to `<home>/recent.json`, and harmless to lose. Folders are listed
// from the disk as you type; whether one is a git repository is checked the
// only reliable way, by asking git.

export interface Recent {
  name: string
  root: string
  /** When you last opened or went to it, as epoch milliseconds. */
  at: number
}

export interface Folder {
  name: string
  path: string
  /** A git repository, and the branch it is on. */
  git: { branch: string | null } | null
}

const RECENT_MAX = 12

export function readRecents(home: string): Recent[] {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'recent.json'), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (entry): entry is Recent =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as Recent).name === 'string' &&
          typeof (entry as Recent).root === 'string' &&
          typeof (entry as Recent).at === 'number',
      )
      .slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

/** Put a project at the top of the recent list. Never fails loudly: it is a convenience. */
export function noteRecent(home: string, name: string, root: string, now: number): void {
  try {
    const rest = readRecents(home).filter((entry) => entry.name !== name && entry.root !== root)
    const next = [{ name, root, at: now }, ...rest].slice(0, RECENT_MAX)
    writeFileSync(join(home, 'recent.json'), `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    // A recent list we cannot write is a list that is out of date, nothing more.
  }
}

/**
 * The recent list as it should be shown: every configured project, most
 * recently used first, then those never opened in the window, by name.
 */
export function recentProjects(
  recents: readonly Recent[],
  configured: Readonly<Record<string, { root: string }>>,
): Recent[] {
  const seen = new Map<string, Recent>()
  for (const entry of recents) if (configured[entry.name]) seen.set(entry.name, entry)
  const known = Object.entries(configured).map(
    ([name, project]) => seen.get(name) ?? { name, root: project.root, at: 0 },
  )
  return known.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
}

/** Whether what was typed is a path, rather than a name to find in the list. */
export function isPath(query: string): boolean {
  return /^(~|\/|\.{1,2}(\/|$))/.test(query.trim())
}

export function expand(query: string, cwd: string): string {
  const text = query.trim()
  if (text === '~' || text.startsWith('~/')) return join(homedir(), text.slice(1))
  return resolve(cwd, text)
}

/**
 * The folder a typed path is browsing, and what to narrow its contents by:
 * `~/src/pay` lists `~/src` for entries starting `pay`; `~/src/` lists all of it.
 */
export function browsing(query: string, cwd: string): { dir: string; prefix: string } {
  const full = expand(query, cwd)
  if (query.trim().endsWith('/') || query.trim() === '~') return { dir: full, prefix: '' }
  return { dir: dirname(full), prefix: basename(full) }
}

/** The folders in a directory, narrowed, hidden ones left out unless asked for. */
export function listFolders(dir: string, prefix: string, limit = 30): Folder[] {
  let names: string[] = []
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const lower = prefix.toLowerCase()
  return names
    .filter((name) => (prefix.startsWith('.') ? true : !name.startsWith('.')))
    .filter((name) => name.toLowerCase().startsWith(lower))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit)
    .map((name) => {
      const path = join(dir, name)
      return { name, path, git: isRepo(path) ? { branch: null } : null }
    })
}

/** Whether a folder is the top of a git repository. */
export function isRepo(path: string): boolean {
  try {
    return existsSync(join(path, '.git')) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The branch a repository is on, or null when git cannot say. */
export async function branchOf(root: string): Promise<string | null> {
  const out = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = out.stdout.trim()
  return out.ok && branch !== '' && branch !== 'HEAD' ? branch : null
}

/**
 * Make a folder a repository with one commit, so a worktree has something to
 * branch from. The commit is Wilco's, not yours: what Wilco writes is marked
 * as Wilco's, and you can see and undo it like anything else in git.
 */
export async function initialise(root: string): Promise<void> {
  const steps: string[][] = [
    ['init', '-b', 'main'],
    ['add', '-A'],
    [
      '-c',
      'user.name=Wilco',
      '-c',
      'user.email=wilco@localhost',
      'commit',
      '--allow-empty',
      '-m',
      'First commit, so agents have something to branch from',
    ],
  ]
  for (const args of steps) {
    const out = await git(root, args, 60_000)
    if (!out.ok)
      throw new Error(
        `git ${args.find((a) => !a.startsWith('-') && !a.includes('=')) ?? ''} failed: ${out.stderr.split('\n')[0]}`,
      )
  }
}

/** How long ago, the way people say it. */
export function ago(at: number, now: number): string {
  if (at <= 0) return 'never opened'
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}
