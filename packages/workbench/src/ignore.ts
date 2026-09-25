import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
// There used to be one exception, `.tade/checks.yaml`, because CI was
// generated from it. Nothing is now: what a project checks is read out of its
// own workflows and its own commit hook, so Tade writes nothing under `.tade/`
// that anybody else should ever pull. The rule is a plain denial, which is what
// it always wanted to be — and whatever Tade learns to write under there next
// is ignored the day it is written, with no second line to remember.
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
export const IGNORE_RULES: readonly string[] = [`/${PROJECT_DIR}/*`]

/**
 * Written above the rules so whoever finds them knows who put them there and
 * why, and can delete them.
 */
export const IGNORE_HEADER: readonly string[] = [
  '# Tade writes its own bookkeeping under .tade/ -- task files, pasted',
  '# attachments, check runs, locks -- and none of it is the project’s: it is',
  '# one machine’s and one person’s. What Tade checks this project with is not',
  '# in here at all; it is read from .github/workflows and the commit hook.',
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
 * `/.tade/*` and not `/.tade/`, which now mean the same thing: it was the
 * contents because there used to be an exception under them, and it stays the
 * contents because that is the line already written in every repository Tade
 * has worked in. Spelling it the other way would append a second rule to all of
 * them to say what the first one already says.
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
  if (await alreadyIgnored(root)) {
    // Somebody has already said it, in their own words -- `.tade/`, `.tade/*`,
    // or a global excludes file. However they spelled it, the outcome holds and
    // does not need saying again.
    return { added: [], because: 'this project already ignores them its own way' }
  }
  try {
    await writeFile(path, existing + addition.text, 'utf8')
  } catch (err) {
    return { added: [], because: `${IGNORE_PATH} could not be written: ${message(err)}` }
  }
  return { added: addition.added, because: '' }
}

/**
 * Whether git already ignores what the rules are about. False where git cannot
 * be asked at all -- somewhere that is not a repository yet, or no git on the
 * machine -- which is never read as "already arranged": the rules are written,
 * and they are right by the time there is a repository to read them.
 *
 * `--no-index` because by default `check-ignore` says nothing about a path that
 * is tracked, and this is a path that might be. Knowing it is a repository
 * first is what lets a non-zero exit mean "not ignored" rather than "could not
 * tell".
 */
async function alreadyIgnored(root: string): Promise<boolean> {
  const repo = await git(root, ['rev-parse', '--git-dir'])
  if (!repo.ok) return false
  return (await git(root, ['check-ignore', '--no-index', '-q', '--', A_TASK_FILE])).ok
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
