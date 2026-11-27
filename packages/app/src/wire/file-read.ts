import { closeSync, openSync, readSync, statSync, writeFileSync } from 'node:fs'
import { languageOf } from '../highlight.ts'
import { shownByItsApp, VIEW_BYTES, type ViewedFile } from '../viewer.ts'

// Reading a file to look at, and writing back what was typed into it: the two
// things the viewer does to a disk. Here, behind the wire, so that `viewer.ts`
// — the edit as a value, Markdown laid out, finding in it — is pure, and draws
// in a browser as well as here (`browser.ts`).

/** How far into a file the viewer looks to tell what it is. */
const TELLS_ITS_KIND = 8000

export function readForView(path: string, limit = VIEW_BYTES): ViewedFile {
  const empty = { path, size: 0, binary: false, truncated: false, text: '', mtimeMs: 0 }
  const language = languageOf(path)
  try {
    const stat = statSync(path)
    if (stat.isDirectory()) return { ...empty, language, error: 'That is a folder.' }
    const size = stat.size
    const buffer = Buffer.alloc(Math.min(size, limit))
    const fd = openSync(path, 'r')
    try {
      readSync(fd, buffer, 0, buffer.length, 0)
    } finally {
      closeSync(fd)
    }
    // The test git itself uses: a NUL in the first 8000 bytes.
    const binary = buffer.subarray(0, TELLS_ITS_KIND).includes(0)
    return {
      path,
      size,
      binary,
      truncated: size > limit,
      language,
      text: binary ? '' : buffer.toString('utf8'),
      mtimeMs: stat.mtimeMs,
      error: null,
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    const error =
      code === 'ENOENT'
        ? 'It is not there any more.'
        : code === 'EACCES' || code === 'EPERM'
          ? 'Tade is not allowed to read it.'
          : err instanceof Error
            ? err.message
            : String(err)
    return { ...empty, language, error }
  }
}

/** The same answer about a file not opened yet, from no more of it than that takes. */
export function onlyItsAppShows(path: string): boolean {
  return shownByItsApp(readForView(path, TELLS_ITS_KIND))
}

/**
 * Write what was typed back, and read the file again so what is on screen is
 * what is on disk.
 *
 * Refused if the file moved underneath: agents edit these files while you are
 * looking at them, and a window that quietly writes a minute-old copy over an
 * agent's work is worse than one that cannot save at all.
 */
export function saveEdited(file: ViewedFile, text: string): ViewedFile {
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(file.path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(code === 'ENOENT' ? 'It is not there any more.' : why(err))
  }
  if (stat.size !== file.size || stat.mtimeMs !== file.mtimeMs)
    throw new Error('It changed on disk since you opened it. Close it and open it again.')
  try {
    writeFileSync(file.path, text)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    throw new Error(
      code === 'EACCES' || code === 'EPERM' ? 'Tade is not allowed to write it.' : why(err),
    )
  }
  return readForView(file.path)
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
