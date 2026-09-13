// A unified diff, as lines a panel can draw.
//
// Only what `git diff --no-color -U3` emits for one file: the file headers are
// dropped, hunks keep their `@@` line, and every other line knows which side
// of the change it is and its line number there. Anything unrecognised is
// kept as context rather than thrown over — a diff that draws oddly is better
// than one that does not draw.

export interface DiffLine {
  kind: 'hunk' | 'context' | 'add' | 'remove'
  /** Line number in the old file, where the line exists there. */
  old: number | null
  /** Line number in the new file, where the line exists there. */
  new: number | null
  text: string
}

export interface ParsedDiff {
  lines: DiffLine[]
  added: number
  removed: number
  /** Git said the file is binary: there are no lines to show. */
  binary: boolean
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

export function parseDiff(unified: string): ParsedDiff {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let binary = false
  let oldLine = 0
  let newLine = 0
  let inHunk = false

  for (const raw of unified.split('\n')) {
    if (raw.startsWith('Binary files ')) binary = true
    const hunk = HUNK.exec(raw)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      inHunk = true
      lines.push({ kind: 'hunk', old: null, new: null, text: raw })
      continue
    }
    if (!inHunk) continue
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', old: null, new: newLine++, text: raw.slice(1) })
      added++
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'remove', old: oldLine++, new: null, text: raw.slice(1) })
      removed++
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file": about the line above, not a line.
    } else if (raw !== '' || lines.length > 0) {
      lines.push({ kind: 'context', old: oldLine++, new: newLine++, text: raw.slice(1) })
    }
  }
  // A trailing newline in git's output reads as one empty context line.
  while (lines.at(-1)?.kind === 'context' && lines.at(-1)?.text === '') lines.pop()
  return { lines, added, removed, binary }
}
