import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Taking Tade's own rule back out of somebody's ignore file.
//
// Tade used to write its bookkeeping into `.tade/` in the checkout — task
// files, pasted attachments, check runs, locks — and none of it was the
// project's, so it appended `/.tade/*` to the project's `.gitignore` the first
// time it worked there. That rule was right for as long as the files were
// there. They are not: everything Tade writes about a project is in its own
// home now (`projectDir`), so there is nothing under the project to ignore,
// and a project Tade has worked in for a year should look exactly like one it
// has never seen.
//
// So the append is gone and this is what is left: the undo. It is the same
// argument the append made, turned round — Tade edited a file that was not its
// own, so Tade takes its own lines back out, once, and says in the journal
// that it did.
//
// It is deliberately timid. It removes a rule only where the comment block
// directly above it is Tade's own — that is what tells Tade's line from the
// identical line somebody wrote themselves, which is theirs and stays. Nothing
// else in the file is read, reordered or reformatted.

/** The rules Tade ever wrote, in every spelling it used. */
export const IGNORE_RULES: readonly string[] = ['/.tade/*', '!/.tade/checks.yaml']

/** The ignore file Tade wrote into, relative to the project. */
export const IGNORE_PATH = '.gitignore'

/** What `removeOwnIgnore` did, for the line the journal keeps. */
export interface IgnoreOutcome {
  /** Lines taken out, in order. Empty when there was nothing of Tade's to take. */
  removed: readonly string[]
  /** Why nothing was removed, in words — empty when something was. */
  because: string
}

/** What an ignore file reading like this becomes once Tade's own lines are gone. */
export interface IgnoreRemoval {
  removed: readonly string[]
  text: string
}

/** A comment line, however it is indented. */
const comment = (line: string): boolean => line.trim().startsWith('#')

/**
 * Tade's own lines out of an ignore file that reads like this, or null when
 * there are none. Pure, and the only edit it makes: whole lines disappear and
 * nothing else moves.
 *
 * A rule counts as Tade's when the run of comment lines directly above it
 * names Tade. Somebody who wrote `/.tade/*` for their own reasons wrote no
 * such comment, and keeps their line.
 */
export function ignoreRemoval(existing: string): IgnoreRemoval | null {
  const lines = existing.split('\n')
  const rule = (at: number) => IGNORE_RULES.includes(lines[at]?.trim() ?? '')
  const drop = new Set<number>()
  const removed: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i) || !rule(i)) continue
    // The comment block this rule sits under, if any: from the last blank or
    // non-comment line up to here, and only when Tade signed it.
    let top = i
    while (top > 0 && comment(lines[top - 1] ?? '')) top--
    const header = lines.slice(top, i)
    if (header.length === 0 || !header.some((one) => /\btade\b/i.test(one))) continue
    // The block is its header and every rule of Tade's under it, together: the
    // second line of the pair it used to write has no comment of its own.
    let end = i
    while (end + 1 < lines.length && rule(end + 1)) end++
    for (let n = top; n <= end; n++) drop.add(n)
    for (let n = i; n <= end; n++) removed.push(lines[n]?.trim() ?? '')
  }
  if (removed.length === 0) return null
  const kept = lines.filter((_, n) => !drop.has(n))
  return { removed, text: tidy(kept) }
}

/**
 * Take Tade's own lines out of this project's ignore rules, and say what that
 * took. Never throws: a task is not worth failing to create over an ignore
 * rule, so trouble comes back as a sentence for the caller to journal.
 *
 * Idempotent: once the lines are gone this reads the file and writes nothing,
 * which is also what it does for the projects that never had them.
 */
export async function removeOwnIgnore(root: string): Promise<IgnoreOutcome> {
  const path = join(root, IGNORE_PATH)
  let existing: string
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    return { removed: [], because: `there is no ${IGNORE_PATH} here` }
  }
  const removal = ignoreRemoval(existing)
  if (!removal) return { removed: [], because: 'none of its rules are in there' }
  try {
    await writeFile(path, removal.text, 'utf8')
  } catch (err) {
    return { removed: [], because: `${IGNORE_PATH} could not be written: ${message(err)}` }
  }
  return { removed: removal.removed, because: '' }
}

/**
 * The file with the hole closed up: no run of blank lines where a block was,
 * no blank line left at the top, and the trailing newline the file had.
 */
function tidy(lines: readonly string[]): string {
  const out: string[] = []
  for (const line of lines) {
    if (line.trim() === '' && (out.length === 0 || out[out.length - 1]?.trim() === '')) continue
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1]?.trim() === '') out.pop()
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
