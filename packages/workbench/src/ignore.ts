import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MANIFEST_PATH } from '@tade/checks-core'
import { PROJECT_DIR, SHARED_TASKS_DIR } from '@tade/core'
import { git } from '@tade/status'

// Keeping Tade's own bookkeeping out of somebody's history.
//
// Almost everything Tade writes under a project is one machine's or one
// person's: a task file is whoever asked for the work, `checks.jsonl` rotates
// and dies with the worktree it ran in, an attachment is a screenshot somebody
// pasted, a lock holds a pid. None of it means anything on another machine,
// and all of it was being committed -- twenty-six files of it in Tade's own
// repository before this existed.
//
// The one exception is `.tade/checks.yaml`, which is the opposite in every
// way: a person writes it, CI is generated from it, and a test holds it to the
// gate. It is shared, so it is tracked.
//
// So the rule is written as a denial with one exception, never as a list of
// what to deny. Whatever Tade learns to write under `.tade/` next is ignored
// the day it is written, and only a file somebody decides is the project's has
// to be named here; a list of paths would leak every new one.
//
// It goes in `.gitignore` and not `.git/info/exclude`. The failure this
// answers is a *push*, which is everybody's: an exclude fixes one clone, and
// the teammate who never ran Tade still pulls the branch with somebody's
// screenshots on it. And a rule nobody can see is the worse surprise --
// `.gitignore` arrives as one hunk in `git status`, `git check-ignore -v`
// points at the line, and git is the undo. The cost is that Tade edits a file
// that is not its own, so it only ever appends, only ever once, and says in
// the journal that it did.

/** What Tade adds to a project's ignore rules, in the order it writes them. */
export const IGNORE_RULES: readonly string[] = [`/${PROJECT_DIR}/*`, `!/${MANIFEST_PATH}`]

/**
 * Written above the rules so whoever finds them knows who put them there and
 * why, and can delete them.
 */
export const IGNORE_HEADER: readonly string[] = [
  '# Tade writes its own bookkeeping under .tade/ -- task files, pasted',
  '# attachments, check runs, locks -- and none of it is the project’s: it is',
  '# one machine’s and one person’s. checks.yaml is the exception, because a',
  '# person writes it and CI is generated from it.',
  '# Added by Tade the first time it worked here; delete it and it stays deleted.',
]

/** The ignore file Tade writes, relative to the project. */
export const IGNORE_PATH = '.gitignore'

/**
 * A path standing for everything the rules deny, used to ask git whether the
 * outcome already holds however somebody spelled it. It does not have to
 * exist: `check-ignore` matches patterns against a string.
 */
const A_TASK_FILE = `${SHARED_TASKS_DIR}/example/task.yaml`

/** What `ensureIgnored` did, for the line the journal keeps. */
export interface IgnoreOutcome {
  /** Lines appended, in order. Empty when nothing needed adding. */
  added: readonly string[]
  /** Why nothing was added, in words -- empty when something was. */
  because: string
}

/** The lines to append to an ignore file that reads like this, and the text to append them as. */
export interface IgnoreAddition {
  added: readonly string[]
  text: string
}

/**
 * What an ignore file reading like this is missing, or null when it is missing
 * nothing. Pure, and append-only by construction: what is already there is
 * read for one question -- is this line present -- and written back unchanged.
 *
 * `/.tade/*` and not `/.tade/`: git does not descend into an excluded
 * directory, so excluding the folder itself would make the exception below it
 * unreachable. Excluding its *contents* leaves the folder readable and the
 * negation works.
 */
export function ignoreAddition(existing: string): IgnoreAddition | null {
  const lines = new Set(existing.split('\n').map((line) => line.trim()))
  const added = IGNORE_RULES.filter((rule) => !lines.has(rule))
  if (added.length === 0) return null
  const block = `${[...IGNORE_HEADER, ...added].join('\n')}\n`
  if (existing.trim() === '') return { added, text: block }
  return { added, text: `${existing.endsWith('\n') ? '' : '\n'}\n${block}` }
}

/**
 * Make sure this project ignores what Tade writes under it, and say what that
 * took. Never throws: a task is not worth failing to create over an ignore
 * rule, so trouble comes back as a sentence for the caller to journal.
 *
 * Idempotent twice over. It writes nothing when its own lines are already
 * there, and nothing when git says the outcome already holds -- somebody who
 * wrote `.tade/*` their own way, or a global excludes file, has said the same
 * thing and does not need it said again.
 */
export async function ensureIgnored(root: string): Promise<IgnoreOutcome> {
  const path = join(root, IGNORE_PATH)
  let existing: string
  try {
    existing = await readFile(path, 'utf8')
  } catch {
    existing = ''
  }
  const addition = ignoreAddition(existing)
  if (!addition) return { added: [], because: 'the rules were already there' }
  const said = await asGitSees(root)
  if (said?.bookkeeping) {
    // Somebody has already said it, in their own words. The second case is
    // the one worth a sentence rather than a shrug: excluding the folder
    // itself takes `checks.yaml` with it, and git cannot re-include a file
    // under an excluded directory -- so the only fix is to edit the line they
    // wrote, and that is theirs to do, not Tade's.
    return {
      added: [],
      because: said.manifest
        ? `this project ignores all of ${PROJECT_DIR}/, ${MANIFEST_PATH} with it: nothing under an ignored folder can be put back, so change that line to ${IGNORE_RULES[0]} if the manifest should be committed`
        : 'this project already ignores them its own way',
    }
  }
  try {
    await writeFile(path, existing + addition.text, 'utf8')
  } catch (err) {
    return { added: [], because: `${IGNORE_PATH} could not be written: ${message(err)}` }
  }
  return { added: addition.added, because: '' }
}

/**
 * What git makes of the two paths the rules are about, or null where git
 * cannot be asked at all -- somewhere that is not a repository yet, or no git
 * on the machine. Null is never read as "already arranged": the rules are
 * written, and they are right by the time there is a repository to read them.
 *
 * `--no-index` because by default `check-ignore` says nothing about a path
 * that is tracked, and both of these are paths that might be. Knowing it is a
 * repository first is what lets a non-zero exit mean "not ignored" rather than
 * "could not tell".
 */
async function asGitSees(
  root: string,
): Promise<{ bookkeeping: boolean; manifest: boolean } | null> {
  const repo = await git(root, ['rev-parse', '--git-dir'])
  if (!repo.ok) return null
  const asked = async (path: string): Promise<boolean> =>
    (await git(root, ['check-ignore', '--no-index', '-q', '--', path])).ok
  return { bookkeeping: await asked(A_TASK_FILE), manifest: await asked(MANIFEST_PATH) }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
