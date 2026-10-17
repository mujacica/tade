import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Your extensions as the folder has them: which there are, and what each says
// it is — read and never run, because one nobody turned on is never imported.
// Its own file because none of it touches the host's state; `host.ts` is the
// thing that holds extensions and calls into them.

/**
 * Your extension folders: each directory in the extensions directory with an
 * `extension.ts`, in name order. There is one place they live; whether each
 * runs is what the settings say.
 */
export function yourFolders(root: string | null | undefined): string[] {
  if (!root) return []
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('_'),
      )
      .map((entry) => join(root, entry.name))
      .filter((folder) => existsSync(join(folder, 'extension.ts')))
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * What a file says it is, from the comment it starts with: the one thing that
 * can be known about an extension nobody has turned on, because reading a file
 * is not running it. Empty when there is nothing to read.
 */
export function firstComment(file: string): string {
  try {
    const first =
      readFileSync(file, 'utf8')
        .split('\n')
        .find((line) => line.trim() !== '') ?? ''
    return first
      .replace(/^\s*(\/\/+|\/\*+|\*)\s?/, '')
      .replace(/\*\/\s*$/, '')
      .trim()
  } catch {
    return ''
  }
}
