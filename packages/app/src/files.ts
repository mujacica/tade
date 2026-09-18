// The FILES tree down the side: the folder you are working in, with the
// folders you opened opened.
//
// Pure given something that lists a folder, so what is shown — the order, what
// is left out, how deep it goes — is tested without a disk. The disk, and how
// often it is read, is `live.ts`'s business.

export interface FileEntry {
  /** Relative to the folder the tree is of, with `/` between parts. */
  path: string
  name: string
  /** How many folders down: 0 for what is at the top. */
  depth: number
  folder: boolean
  /** A folder whose contents are listed under it. */
  open: boolean
}

export interface Listed {
  name: string
  folder: boolean
}

/**
 * Left out of every listing: git's own folder, Tade's record of an agent, and
 * the file Finder leaves everywhere. Nobody opens these from a sidebar, and
 * `.git` alone would be the longest thing in it.
 */
const HIDDEN = new Set(['.git', '.tade', '.wilco', '.DS_Store'])

/** Our own folder in a checkout, under either name: the new one and the one before the rename. */
const ours = (path: string) =>
  path === '.tade' || path.startsWith('.tade/') || path === '.wilco' || path.startsWith('.wilco/')

/** No sidebar is long enough to be worth reading past this. */
export const TREE_MAX = 2_000

/**
 * The tree, top to bottom: folders before files at each level, each in name
 * order, and an open folder's contents straight under it.
 */
export function treeOf(
  expanded: readonly string[],
  list: (folder: string) => readonly Listed[],
  max = TREE_MAX,
): FileEntry[] {
  const open = new Set(expanded)
  const out: FileEntry[] = []
  const walk = (folder: string, depth: number) => {
    const entries = list(folder)
      .filter((entry) => !HIDDEN.has(entry.name))
      .slice()
      .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (out.length >= max) return
      const path = folder === '' ? entry.name : `${folder}/${entry.name}`
      const opened = entry.folder && open.has(path)
      out.push({ path, name: entry.name, depth, folder: entry.folder, open: opened })
      if (opened) walk(path, depth + 1)
    }
  }
  walk('', 0)
  return out
}

/**
 * What git says about each file in a worktree, from `git status --porcelain=v2
 * -z`, as the letter VS Code shows beside it: `M`odified, `A`dded, `D`eleted,
 * `R`enamed, `U`ntracked, or `!` for a conflict. Tade's own record is left out.
 */
export function marksFrom(status: string): Record<string, string> {
  const marks: Record<string, string> = {}
  const fields = status.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]
    if (!field) continue
    const parts = field.split(' ')
    let path: string | null = null
    let mark = 'M'
    switch (field[0]) {
      case '1': {
        path = parts.slice(8).join(' ')
        const xy = parts[1] ?? '..'
        mark = xy.includes('A') ? 'A' : xy.includes('D') ? 'D' : 'M'
        break
      }
      case '2':
        path = parts.slice(9).join(' ')
        mark = 'R'
        i++ // the original path is the next field
        break
      case 'u':
        path = parts.slice(10).join(' ')
        mark = '!'
        break
      case '?':
        path = field.slice(2)
        mark = 'U'
        break
    }
    if (path && !ours(path)) marks[path] = mark
  }
  return marks
}

/**
 * The mark a folder takes from what is inside it: a conflict first, then a
 * change, then only new files — the one that most needs looking at.
 */
export function folderMark(folder: string, marks: Readonly<Record<string, string>>): string | null {
  const inside = Object.entries(marks).filter(([path]) => path.startsWith(`${folder}/`))
  if (inside.length === 0) return null
  const has = (mark: string) => inside.some(([, one]) => one === mark)
  if (has('!')) return '!'
  if (has('M') || has('R') || has('D')) return 'M'
  return 'U'
}
