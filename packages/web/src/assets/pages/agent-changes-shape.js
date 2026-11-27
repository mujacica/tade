// What one agent's changes say, as words and rows — pure, so
// `test/changes-client.test.ts` can hold it without a browser.
//
// The answer is `@tade/web`'s `changes.ts`: every file the agent changed and
// the whole of each one's diff from its first hunk, cleaned at the machine.
// Nothing here decides anything about the work; it only says what came.

/** The kind of one line of a diff, by its first character, as the window's diff panel reads it. */
export function lineKind(line) {
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  if (line.startsWith('\\')) return 'meta'
  return 'same'
}

/** A file's diff as rows: each line and its kind. A trailing newline is not a row. */
export function diffRows(text) {
  if (text === null || text === '') return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((line) => ({ line, kind: lineKind(line) }))
}

/** git's letter as a word, for a screen reader and for the tag beside a path. */
export const MARKS = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  '?': 'new',
  U: 'unmerged',
}

export function markWord(mark) {
  return MARKS[mark] ?? 'changed'
}

/** `+12 −3`, or what is known of it; a dash where git did not count. */
export function countSaid(added, removed) {
  if (added === null && removed === null) return '—'
  return `+${added ?? '—'} −${removed ?? '—'}`
}

/** The bar's figure: how many files, and the lines either way where every file counted them. */
export function figureOf(answer) {
  if (answer === null || answer.says !== 'files') return ''
  const files = answer.files
  const noun = files.length === 1 ? 'file' : 'files'
  const counted = files.every((one) => one.added !== null && one.removed !== null)
  if (!counted) return `${files.length} ${noun}`
  const added = files.reduce((sum, one) => sum + one.added, 0)
  const removed = files.reduce((sum, one) => sum + one.removed, 0)
  return `${files.length} ${noun} · +${added} −${removed}`
}

/** What a file whose lines did not come says instead, or null for one whose lines did. */
export function fileSaid(file) {
  switch (file.says) {
    case 'lines':
      return null
    case 'binary':
      return 'A binary file: git shows no lines for it.'
    case 'nothing':
      return 'git shows no lines for it now: a mode change, or it was changed back.'
    default:
      return 'git could not be asked about it in time. Read them again.'
  }
}

/** What a file's foot says it was cleaned of, or null. */
export function takenSaid(file) {
  if (file.taken === 0) return null
  return `${file.taken} taken out — a path, a key or something shaped like one`
}

/** A state box as `stateBoxIn` takes it; `icon` absent lets the kind choose its mark. */
function boxOf(kind, title, line, icon) {
  return icon === undefined ? { kind, title, line } : { kind, icon, title, line }
}

/**
 * The region's state for an answer that has no files, as `{ kind, title, line }`,
 * or null where there are files to draw. `failed` is the trouble's own words.
 */
export function stateFor(answer, failed) {
  if (answer === null) {
    if (failed === null) return null
    return boxOf('error', 'Could not read its changes', failed, 'alert')
  }
  switch (answer.says) {
    case 'files':
      return null
    case 'none':
      return boxOf(
        'empty',
        'Nothing changed yet',
        answer.base === null ? 'Its tree matches HEAD.' : `Its tree matches ${answer.base}.`,
      )
    case 'not looked':
      return boxOf('loading', 'Looking at its tree', 'The machine has not looked yet.')
    case 'not here':
      return boxOf(
        'empty',
        'Not on this device',
        'This agent is not one this device may read, or its task is not on Tade’s list any more.',
        'folder',
      )
    default:
      return boxOf(
        'error',
        'Could not read its changes',
        'git did not answer at the machine in time.',
        'alert',
      )
  }
}
