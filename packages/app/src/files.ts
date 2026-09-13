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
 * Left out of every listing: git's own folder, Wilco's record of an agent, and
 * the file Finder leaves everywhere. Nobody opens these from a sidebar, and
 * `.git` alone would be the longest thing in it.
 */
const HIDDEN = new Set(['.git', '.wilco', '.DS_Store'])

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
