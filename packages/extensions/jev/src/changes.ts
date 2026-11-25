import { readdir, readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { projectDir, taskFolder } from '@tade/core'
import type { ExtensionContext, ProjectRef } from '@tade/extensions-core'
import { parse as parseYaml } from 'yaml'

// What an agent changed, read out of git and cut down to what a question can
// be about.
//
// The unit is a task's whole diff against what it branched from, not a
// commit: ten times fewer things to read, each one something a person asked
// for, and it makes room for the question nobody else asks — does this do what
// was asked, and what else did it do? A commit is a step; a task is a change.

/** What one file's part of a change looks like. */
export interface FileChange {
  file: string
  patch: string
  /** How much of the patch was left behind, in characters. */
  cut: number
}

/**
 * One change as it was read: the files a question can be about, and what of it
 * was left behind.
 *
 * The second half is the whole reason this is an object rather than a list. A
 * reading of part of a change is a perfectly good answer — it is the only
 * answer there is about a change nothing could read whole — but it is a
 * different answer from a reading of all of it, and a caller handed a bare
 * list has no way to tell the two apart or to say which it got.
 */
export interface Change {
  files: FileChange[]
  /** The files that changed and that no question was asked about, by name. */
  unread: string[]
  /** Characters of patch left behind inside the files that were read. */
  cut: number
  /**
   * The files left out before anything was read, by name and why: what a
   * question is not about (a lockfile, a binary, what the repository marks
   * generated or vendored) and what is too big to be read as a judgement.
   */
  left: LeftOut[]
}

/**
 * Why a file the change touched was left out of the reading.
 *
 * - `lockfile` and `output` are the names `SKIP` and `SKIP_IN` know: bulk, not
 *   judgement.
 * - `generated`, `vendored` and `no-diff` are the repository's own word for
 *   it, out of its `.gitattributes` (`linguist-generated`, `linguist-vendored`,
 *   `-diff` and the `binary` macro that sets it), read with `git check-attr` —
 *   never guessed from a name.
 * - `binary` is git's own answer, from the patch it printed.
 * - `too-big` is a file over `FILE_BYTES` at the change's head, or a patch
 *   over `PATCH_BYTES`: read whole it would be most of an ask, and read in
 *   part it would be twenty thousand characters of a generated city.
 */
export type LeftWhy =
  | 'lockfile'
  | 'output'
  | 'generated'
  | 'vendored'
  | 'no-diff'
  | 'binary'
  | 'too-big'

export interface LeftOut {
  file: string
  why: LeftWhy
}

/** A branch with work on it that somebody asked for: what a review is about. */
export interface Unit {
  /** What a finding about it is keyed by: the task, or the project and branch. */
  key: string
  project: string
  /** The tasks whose work is in it. */
  tasks: string[]
  /** The words the work was asked for in, verbatim. */
  intent: string
  /** Where git runs for it. */
  root: string
  branch: string
  head: string
  base: string
  /**
   * The commits this unit is made of, newest last, when it is one agent's own
   * work on a branch everybody shares. Empty where the unit is the whole range
   * `base...head`, which is what a worktree of its own and a branch nobody
   * signed are.
   */
  commits: string[]
  /**
   * Where `commits` is one agent's own, what else is in `base..head` and was
   * not read: `base` is where the oldest task in the checkout branched, so the
   * range is everybody's, and saying it bare reads as a reading of all of it.
   */
  beside?: Beside
  /** When its head landed, so a branch still being typed into is left alone. */
  at: number
}

/** What the range around one agent's own commits holds that was not read as its change. */
export interface Beside {
  /** Where the range that was counted ends: the branch's head, not this task's last commit. */
  head: string
  /** Commits other tasks signed, and how many tasks they are. */
  others: number
  tasks: number
  /** Commits nobody signed: whose they are, nothing here can say. */
  unsigned: number
  /** This task's own commits older than the newest `COMMIT_LIMIT`, which are not read. */
  older: number
}

/**
 * Files a question in the pack cannot be about. Dropped in code rather than
 * asked about: a lockfile is not a judgement, it is bulk, and bulk costs
 * accuracy as well as money. Tade's own bookkeeping is not among them: none of
 * it is in the repository at all.
 *
 * An image is an image whether it is bytes or markup, and a terminal capture
 * is bytes with escapes in them: `.svg` and `.ansi` are here with `.png` and
 * `.snap` because they are output rather than judgement, and because dense
 * generated markup is where a budget counted in characters is furthest from
 * the tokens it is standing in for. One redrawn picture — a 97 KB change to
 * one line of SVG — was enough to come back `max_tokens_exceeded` and read as
 * a review that could not look at anything at all.
 */
const SKIP_IN = /(^|\/)(node_modules|vendor|dist)\//

const LOCKFILE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock|Pipfile\.lock|flake\.lock)$/i

const SKIP =
  /(^|\/)(.*\.min\.(js|css)|.*\.(snap|ansi)|.*\.(png|jpg|jpeg|gif|webp|ico|svg|pdf|zip|gz|wav|mp3|mp4|woff2?|ttf))$/i

/**
 * The biggest file, at the change's head, that is read at all, in bytes.
 *
 * A change is listed before any of it is read, so a file this size is named
 * and never fetched: a nightly change that carried a generated city and the
 * night's records was one `git show` of more than 64 MB, which the program
 * runner stops — and the whole change, its real fixes included, came back as a
 * review that could not look, every ten minutes. Nothing a person wrote by
 * hand and a question can be about is a megabyte in one file.
 */
const FILE_BYTES = 1_000_000

/**
 * The biggest patch of one file that is read, in bytes: the backstop for what
 * `FILE_BYTES` cannot see — a file deleted, or one rewritten end to end.
 *
 * Each file is fetched on its own with this as the cap on what git may print,
 * so git is stopped at the first byte past it rather than at 64 MB. Ten times
 * `PATCH_LIMIT`: a patch under it is read up to `PATCH_LIMIT` as before, and
 * one over it is not a reading of the file, so it is named instead.
 */
const PATCH_BYTES = 200_000

/** How many paths one `git check-attr` or `git ls-tree` is handed, so no argument list is too long. */
const PATHS_PER_CALL = 200

/** How much of one file's patch is read. Past this, a question is about the first half anyway. */
const PATCH_LIMIT = 20_000

/** The most files one unit is read as. Past this it is a rewrite, and saying so is the answer. */
const FILE_LIMIT = 60

/**
 * How much of one change is read, in characters, across every file in it.
 *
 * The two limits above are each about a *part* of a change and neither is a
 * bound on the whole of it: sixty files at twenty thousand characters each is
 * 1.2M characters, which is the same lesson the `SKIP` comment records, one
 * scale up. It is read in as many asks as it takes, so what that buys is
 * twenty-five requests and several minutes for a reading nobody asked to be
 * exhaustive — and what a question answers about the twenty-fifth file is not
 * worth holding the other nine changes on the machine up for.
 *
 * Past this the change is read as far as the budget goes and what was left out
 * is **named**, because a judge that cannot look at everything can still look
 * at something, and silence is the one answer that teaches nobody. A backstop
 * rather than a routine cut: sixty files of ordinary work is nearer 180,000
 * characters, so on nearly every change this never fires.
 */
const CHANGE_LIMIT = 300_000

/**
 * How many characters of the kind of text a question here is about — a diff, a
 * line of a log, source — stand in for one token, for sizing an ask.
 *
 * The port estimates four, which is every provider's own guidance and right
 * for prose. None of this is prose: indentation, punctuation and identifiers
 * tokenise far worse, so a batch sized at four characters a token holds
 * half as much again as it was budgeted for — which is how an ask *inside* a
 * 32k state budget came back `max_tokens_exceeded`, and the whole reading with
 * it. This is the number that bug was made of, and it is conservative on
 * purpose: being refused a batch that would have fit costs a smaller batch,
 * and being over costs the review.
 */
export const CHARS_PER_TOKEN = 2.5

/**
 * What of a change is read and what is left out: one rule, whichever way the
 * patches were got, so the two ways of getting them cannot drift about it.
 *
 * A file is read whole — as whole as `PATCH_LIMIT` leaves it — or not at all.
 * Cutting the last one to whatever room is left over would hand a question
 * three hundred characters of somebody's file and call it a reading.
 */
export function cutTo(
  patches: readonly { file: string; patch: string }[],
  skipped: readonly string[] = [],
  left: readonly LeftOut[] = [],
): Change {
  const files: FileChange[] = []
  const unread = [...skipped]
  let spent = 0
  let cut = 0
  for (const one of patches) {
    if (files.length >= FILE_LIMIT || spent >= CHANGE_LIMIT) {
      unread.push(one.file)
      continue
    }
    const patch = one.patch.slice(0, PATCH_LIMIT)
    cut += one.patch.length - patch.length
    files.push({ file: one.file, patch, cut: one.patch.length - patch.length })
    spent += patch.length
  }
  return { files, unread, cut, left: [...left] }
}

/**
 * What a reading left out, in a sentence, or null when it read the whole
 * change. One sentence in one place: the table, the finding an agent is handed
 * and the record all say it the same way, because three wordings of it would
 * be three different claims about the same reading.
 */
export function partSaid(change: Change): string | null {
  const left = leftSaid(change.left)
  if (change.unread.length === 0 && change.cut === 0) return left
  const said: string[] = []
  if (change.unread.length > 0) {
    said.push(
      `${change.unread.length} of ${change.files.length + change.unread.length} files were not read (${named(change.unread)})`,
    )
  }
  if (change.cut > 0) said.push(`${change.cut} characters of patch were left behind`)
  return [
    `Read in part: ${said.join('; ')}. What it did not read, it cannot have answered about.`,
    left,
  ]
    .filter(Boolean)
    .join(' ')
}

/** Up to three names, and that there were others. */
function named(files: readonly string[]): string {
  return `${files.slice(0, 3).join(', ')}${files.length > 3 ? ', and others' : ''}`
}

/** What each reason a file is left out is called, in the order they are said. */
const LEFT_WORDS: Record<LeftWhy, string> = {
  'too-big': 'too big to read',
  generated: 'marked linguist-generated',
  vendored: 'vendored',
  'no-diff': 'marked -diff',
  binary: 'binary',
  lockfile: 'lockfiles',
  output: 'images, snapshots or build output',
}

/** The files left out before reading, by reason and by name, or null where none were. */
function leftSaid(left: readonly LeftOut[]): string | null {
  if (left.length === 0) return null
  const groups = (Object.keys(LEFT_WORDS) as LeftWhy[])
    .map((why) => ({ why, files: left.filter((one) => one.why === why).map((one) => one.file) }))
    .filter((group) => group.files.length > 0)
    .map((group) => `${LEFT_WORDS[group.why]} (${group.files.length}): ${named(group.files)}`)
  const big = left.some((one) => one.why === 'too-big')
    ? ' Too big is a file over 1 MB, or a patch over 200 KB.'
    : ''
  return `Left out by name and never read — ${groups.join('; ')}.${big}`
}

async function git(
  ctx: ExtensionContext,
  root: string,
  args: readonly string[],
  timeoutMs = 10_000,
  maxBuffer?: number,
): Promise<{ ok: boolean; out: string; said: string }> {
  const ran = await ctx.exec('git', ['-C', root, ...args], {
    timeoutMs,
    ...(maxBuffer ? { maxBuffer } : {}),
  })
  return { ok: ran.code === 0, out: ran.stdout, said: ran.stderr.trim() }
}

/**
 * A change git could not list or show at all: the change's own trouble, which
 * reading it again at the same head will not mend — never the judge's, which
 * is a look's trouble and is tried again. The review watch says one of these
 * once, as a notice, and does not read it again until the change moves.
 */
export class Unreadable extends Error {
  override name = 'Unreadable'
}

/** A task file, as far as anything here needs it. Never throws: a file nobody can read is no task. */
export async function taskFile(path: string): Promise<TaskSaid | null> {
  try {
    const parsed = parseYaml(await readFile(path, 'utf8')) as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') return null
    const id = typeof parsed.id === 'string' ? parsed.id : ''
    const intent = typeof parsed.intent_spoken === 'string' ? parsed.intent_spoken : ''
    const base = typeof parsed.base === 'string' ? parsed.base : ''
    return id ? { id, intent, base, shared: parsed.workspace === 'checkout' } : null
  } catch {
    return null
  }
}

/** What one task file says, as everything here needs it. */
export interface TaskSaid {
  id: string
  intent: string
  base: string
  /** `checkout` when the task shares the project's own checkout with others. */
  shared: boolean
}

/**
 * The tasks working in a directory, out of Tade's own home: the one whose
 * worktree it is, or everyone sharing the project's checkout.
 *
 * Nothing about this is in the repository, so a directory is matched to a task
 * the way status matches one — by the branch it is on, and by the folder Tade
 * made it in when it has no branch yet.
 */
export async function tasksIn(
  home: string,
  project: string,
  where: { path: string; branch?: string | null; root: string },
): Promise<TaskSaid[]> {
  const dir = join(projectDir(home, project), 'tasks')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const all: TaskSaid[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await taskFile(join(dir, entry.name, 'task.yaml'))
    if (found) all.push(found)
  }
  if (resolve(where.path) === resolve(where.root)) {
    return all.filter((one) => one.shared).sort((a, b) => a.id.localeCompare(b.id))
  }
  const here = basename(where.path)
  const branch = where.branch?.replace(/^tade\//, '').replaceAll('/', '-') ?? ''
  const folders = new Set(
    [branch, here.startsWith(`${project}-`) ? here.slice(project.length + 1) : ''].filter(Boolean),
  )
  return all.filter((one) => !one.shared && folders.has(taskFolder(one.id)))
}

/** Where a project's work joins the rest of it: what everything is diffed against. */
export async function baseRefOf(ctx: ExtensionContext, root: string): Promise<string> {
  const head = await git(ctx, root, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ])
  if (head.ok && head.out.trim()) return head.out.trim()
  for (const name of ['main', 'master']) {
    const found = await git(ctx, root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    if (found.ok && found.out.trim()) return name
  }
  return 'HEAD'
}

/** The most commits of one agent's own that are read as its change. */
const COMMIT_LIMIT = 50

/**
 * Who wrote each commit in a range, out of the `Tade-Task:` trailer.
 *
 * Read back, never guessed — the same fact the ACTIONS tab and the queue's
 * look at the trees read, and the only thing on a shared branch that says
 * whose a line is. A commit nobody signed belongs to nobody and is left out
 * rather than given to whoever was nearest.
 */
export async function commitsByTask(
  ctx: ExtensionContext,
  root: string,
  range: string,
): Promise<{
  byTask: Map<string, { sha: string; at: number }[]>
  signed: number
  /** Every commit in the range, signed or not: what `signed` is out of. */
  total: number
  /**
   * Whether git answered at all. A log that could not be read is not a range
   * with nothing in it, and anybody counting on these numbers has to be able
   * to tell the two apart — `unitsIn` already reads no answer as no units,
   * which is the same answer either way; `whoseIn` may not, because there
   * `total: 0` would otherwise come out as a sentence saying nobody's.
   */
  read: boolean
}> {
  const log = await git(ctx, root, ['log', '--format=%H%x1f%ct%x1f%B%x1e', range])
  const byTask = new Map<string, { sha: string; at: number }[]>()
  let signed = 0
  let total = 0
  if (!log.ok) return { byTask, signed, total, read: false }
  for (const record of log.out.split('\x1e')) {
    const [sha, at, body] = record.replace(/^\s+/, '').split('\x1f')
    if (!sha) continue
    total += 1
    if (!body) continue
    const said = /^Tade-Task:[ \t]*(.+)$/m.exec(body)
    const task = said?.[1]?.trim()
    if (!task) continue
    signed += 1
    const mine = byTask.get(task) ?? []
    mine.push({ sha, at: Number(at ?? 0) * 1000 })
    byTask.set(task, mine)
  }
  // `git log` is newest first and a change reads oldest first, as it was made.
  for (const mine of byTask.values()) mine.reverse()
  return { byTask, signed, total, read: true }
}

/**
 * What to say to an agent about whose work the range it named actually holds,
 * or null where it is all its own and there is nothing to say.
 *
 * A range is whatever is in it. In a checkout everybody shares `HEAD` is
 * whoever committed last, so `HEAD~5..HEAD` asked for by one agent can be five
 * of somebody else's commits — and a reading of that comes back as a table of
 * probabilities under the heading of a change the agent never made, which is
 * a finding it cannot account for about work it did not do. Whose a commit is
 * is already knowable and already read back out of the `Tade-Task:` trailer,
 * so this only has to be *said*: reviewing it silently is the bug.
 *
 * It never refuses. A range somebody named is a range somebody meant, and
 * `unattributed` is always an allowed answer — what it may not be is a quiet
 * one. Nor may a look that could not look be read as one that found nothing:
 * `read: false` is git having no answer, which is its own sentence and never
 * `nobody's`.
 */
export function whoseWork(of: {
  ref: string
  /** Whether git answered about the range at all. */
  read: boolean
  /** Every commit in the range. */
  commits: number
  /** Of those, how many carry the asking task's own trailer. */
  mine: number
  /** The other tasks in the range, with how many commits each, biggest first. */
  others: readonly { task: string; commits: number }[]
  /** Of those, how many carry no trailer at all. */
  unsigned: number
}): string | null {
  if (!of.read) {
    return `Nothing here could read whose the commits in \`${of.ref}\` are, so this is not known to be your own change.`
  }
  if (of.commits > 0 && of.mine === of.commits) return null
  const rest = [
    ...of.others.map((one) => `${one.task} (${one.commits})`),
    ...(of.unsigned > 0 ? [`${of.unsigned} nobody signed`] : []),
  ]
  const whose = rest.length > 0 ? ` It holds ${rest.join(', ')}.` : ''
  if (of.commits === 0) {
    return `\`${of.ref}\` holds no commits at all, so nothing below is anybody's change in particular.`
  }
  if (of.mine === 0) {
    return `None of the ${of.commits} commits in \`${of.ref}\` carry your \`Tade-Task:\` trailer, so this is not your own change.${whose} Ask with no ref to read only your own.`
  }
  return `${of.mine} of the ${of.commits} commits in \`${of.ref}\` are yours; the rest are not.${whose} Ask with no ref to read only your own.`
}

/**
 * Whose work a named range holds: read out of git, said by `whoseWork`.
 *
 * `base..head` and not `base...head`, because the three-dot form is what the
 * *diff* is and `git log base..head` is the commits that diff is made of —
 * which is the same set, asked the way git asks it.
 */
export async function whoseIn(
  ctx: ExtensionContext,
  unit: Pick<Unit, 'root' | 'base' | 'head'>,
  asking: string,
  ref: string,
): Promise<string | null> {
  const range = `${unit.base}..${unit.head}`
  const { byTask, signed, total, read } = await commitsByTask(ctx, unit.root, range)
  return whoseWork({
    ref,
    read,
    commits: total,
    mine: byTask.get(asking)?.length ?? 0,
    others: [...byTask.entries()]
      .filter(([task]) => task !== asking)
      .map(([task, commits]) => ({ task, commits: commits.length }))
      .sort((a, b) => b.commits - a.commits || a.task.localeCompare(b.task)),
    unsigned: total - signed,
  })
}

/**
 * What a reading of one agent's own commits read, and what of the range around
 * them it did not, or null where the unit is a whole range and says so itself.
 *
 * `base..head` for one agent in a shared checkout runs from where the oldest
 * task branched — the repository's first commit, for a plan made on day one —
 * so printed bare it says a no-findings answer covered everybody's work. What
 * nobody signed is named rather than given to anybody: it may be this agent's
 * own, and nothing here can say.
 */
export function ownSaid(unit: Pick<Unit, 'base' | 'head' | 'commits' | 'beside'>): string | null {
  if (unit.commits.length === 0) return null
  const shas = unit.commits.map((sha) => sha.slice(0, 8))
  const listed = shas.length > 6 ? `${shas.slice(0, 3).join(' ')} … ${shas.at(-1)}` : shas.join(' ')
  const own = `Read its own ${plural(unit.commits.length, 'commit')} by its \`Tade-Task:\` trailer (${listed})`
  const beside = unit.beside
  if (!beside) return `${own}.`
  const rest = [
    ...(beside.others > 0
      ? [`${plural(beside.others, 'commit')} of ${plural(beside.tasks, 'other task')}`]
      : []),
    ...(beside.unsigned > 0
      ? [
          `${plural(beside.unsigned, 'commit')} nobody signed, which may be its own and ${beside.unsigned === 1 ? 'was' : 'were'} not read`,
        ]
      : []),
  ]
  const range = `${unit.base.slice(0, 8)}..${beside.head.slice(0, 8)}`
  const around = rest.length > 0 ? `, and none of the rest of ${range}: ${rest.join(', and ')}` : ''
  const older =
    beside.older > 0
      ? ` ${beside.older === 1 ? 'Its oldest commit was' : `Its ${beside.older} oldest commits were`} not read: only the newest ${COMMIT_LIMIT} are.`
      : ''
  return `${own}${around}.${older}`
}

function plural(n: number, word: string): string {
  return n === 1 ? `1 ${word}` : `${n} ${word}s`
}

/**
 * Every branch in a project with work on it somebody asked for, and what it is
 * diffed against.
 *
 * One worktree with a task file of its own is that task. A checkout everybody
 * shares is **one unit per agent**, made of that agent's own commits — which
 * is knowable, because every commit Tade's agents write carries a
 * `Tade-Task:` trailer naming whose it is, and that trailer is read back
 * rather than guessed. Read as one branch instead, the change a question is
 * asked about is seven agents' work and the words it was asked for in are
 * seven intents joined together, which is a question nothing could answer
 * truthfully: `did_what_was_asked` fired on two changes out of three that way.
 * It also means one busy agent no longer holds up everybody's reading — a
 * branch that never settles is still one agent's work that has.
 *
 * What nobody signed stays nobody's: a repository where no commit in the range
 * carries a trailer is read as one branch, exactly as before, and uncommitted
 * work is in no unit at all, because a working tree four agents are writing in
 * belongs to none of them.
 */
export async function unitsIn(ctx: ExtensionContext, project: ProjectRef): Promise<Unit[]> {
  const listed = await git(ctx, project.root, ['worktree', 'list', '--porcelain'])
  if (!listed.ok) throw new Error(`${project.root} is not a git repository: ${listed.said}`)
  const worktrees: { path: string; head: string; branch: string }[] = []
  let current: { path: string; head: string; branch: string } | null = null
  for (const line of listed.out.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current)
      current = { path: line.slice('worktree '.length).trim(), head: '', branch: '' }
    } else if (line.startsWith('HEAD ') && current) current.head = line.slice(5).trim()
    else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim().replace('refs/heads/', '')
    }
  }
  if (current) worktrees.push(current)

  const baseRef = await baseRefOf(ctx, project.root)
  const units: Unit[] = []
  for (const worktree of worktrees) {
    const tasks = await tasksIn(ctx.home, project.name, {
      path: worktree.path,
      branch: worktree.branch,
      root: project.root,
    })
    if (tasks.length === 0 || !worktree.head) continue
    const shared = tasks.length > 1 || tasks.some((one) => one.shared)
    const whole = { project: project.name, root: worktree.path, branch: worktree.branch }
    const mine = shared ? await perAgent(ctx, worktree, tasks, baseRef) : null
    if (mine) {
      units.push(...mine.map((unit) => ({ ...whole, ...unit })))
      continue
    }
    const recorded = tasks.map((task) => task.base).filter(Boolean)
    const base = await baseOf(ctx, worktree.path, recorded, worktree.head, baseRef)
    if (!base || base === worktree.head) continue
    const when = await git(ctx, worktree.path, ['log', '-1', '--format=%ct', worktree.head])
    // On a branch several tasks share that could not be read one agent at a
    // time, the tasks it is about are the ones whose trailer is on a commit in
    // it, as `unitFor` reads them — never everybody working there, which is
    // nobody at all where no commit carries one.
    const signed = shared
      ? (await commitsByTask(ctx, worktree.path, `${base}..${worktree.head}`)).byTask
      : null
    const about = signed ? tasks.filter((task) => signed.has(task.id)) : tasks
    units.push({
      ...whole,
      base,
      key: shared
        ? `${project.name}:${worktree.branch || worktree.head.slice(0, 8)}`
        : (tasks[0]?.id ?? ''),
      tasks: about.map((task) => task.id),
      intent: about
        .map((task) => task.intent)
        .filter(Boolean)
        .join('\n'),
      head: worktree.head,
      commits: [],
      at: Number(when.out.trim() || 0) * 1000,
    })
  }
  return units
}

/**
 * One unit per agent on a branch they share, or null where nothing says whose
 * a commit is and the branch is all there is to read.
 *
 * It is measured from the oldest point any of them branched at, and never from
 * one of them: `baseOf` takes the first recorded base that is an ancestor,
 * which in a folder of nineteen tasks is whichever sorts first by name — and a
 * task made at HEAD five minutes ago then decided that nobody else's morning
 * was worth reading. That is not a hypothetical: it is why the watch's one
 * look at this repository found nothing at all.
 */
async function perAgent(
  ctx: ExtensionContext,
  worktree: { path: string; head: string },
  tasks: readonly TaskSaid[],
  baseRef: string,
): Promise<Omit<Unit, 'project' | 'root' | 'branch'>[] | null> {
  const oldest = await oldestBase(ctx, worktree, tasks, baseRef)
  if (!oldest || oldest === worktree.head) return null
  const { byTask, signed, total } = await commitsByTask(
    ctx,
    worktree.path,
    `${oldest}..${worktree.head}`,
  )
  if (byTask.size === 0) return null
  const units: Omit<Unit, 'project' | 'root' | 'branch'>[] = []
  for (const task of tasks) {
    const own = byTask.get(task.id) ?? []
    const last = own.at(-1)
    if (!last) continue
    units.push({
      key: task.id,
      tasks: [task.id],
      intent: task.intent,
      base: oldest,
      head: last.sha,
      commits: own.slice(-COMMIT_LIMIT).map((commit) => commit.sha),
      beside: {
        head: worktree.head,
        others: signed - own.length,
        tasks: byTask.size - 1,
        unsigned: total - signed,
        older: Math.max(0, own.length - COMMIT_LIMIT),
      },
      at: last.at,
    })
  }
  return units.length > 0 ? units : null
}

/**
 * Where the oldest task in a shared checkout branched: what every agent's own
 * commits are looked for after.
 *
 * One recorded base git no longer has — a task file older than a rebase, or a
 * sha from another clone — fails the octopus, and that used to make the whole
 * checkout one branch, which `jev_review` with `task:` then read under that one
 * task's name. So the bases git can place are used without it, and with none
 * of them, or a task file that recorded none, where the branch left the base.
 */
async function oldestBase(
  ctx: ExtensionContext,
  worktree: { path: string; head: string },
  tasks: readonly TaskSaid[],
  baseRef: string,
): Promise<string> {
  const bases = [...new Set(tasks.map((task) => task.base).filter(Boolean))]
  if (bases.length === 1 && bases[0]) {
    const ancestor = await git(ctx, worktree.path, [
      'merge-base',
      '--is-ancestor',
      bases[0],
      worktree.head,
    ])
    if (ancestor.ok) return bases[0]
  } else if (bases.length > 1) {
    const all = await git(ctx, worktree.path, ['merge-base', '--octopus', ...bases])
    if (all.ok && all.out.trim()) return all.out.trim()
    const placed: string[] = []
    for (const said of bases) {
      const ancestor = await git(ctx, worktree.path, [
        'merge-base',
        '--is-ancestor',
        said,
        worktree.head,
      ])
      if (ancestor.ok) placed.push(said)
    }
    if (placed.length > 0) {
      const some = await git(ctx, worktree.path, ['merge-base', '--octopus', ...placed])
      if (some.ok && some.out.trim()) return some.out.trim()
    }
  }
  const found = await git(ctx, worktree.path, ['merge-base', baseRef, worktree.head])
  return found.ok ? found.out.trim() : ''
}

/**
 * What a unit is measured from: the commit its task file says it branched at,
 * when that is still in the history, and otherwise where it left the base.
 */
async function baseOf(
  ctx: ExtensionContext,
  root: string,
  recorded: readonly string[],
  head: string,
  baseRef: string,
): Promise<string> {
  for (const said of recorded) {
    const ancestor = await git(ctx, root, ['merge-base', '--is-ancestor', said, head])
    if (ancestor.ok) return said
  }
  const found = await git(ctx, root, ['merge-base', baseRef, head])
  return found.ok ? found.out.trim() : ''
}

/**
 * One change, as somebody asked about it: a range they named, or a branch's
 * own work since it left the base. What it is keyed by is the task when the
 * directory is one task's, and the project and what was asked for otherwise.
 */
export async function unitFor(
  ctx: ExtensionContext,
  project: ProjectRef,
  where: { root: string; ref?: string | null },
): Promise<Unit> {
  const root = where.root
  const on0 = await git(ctx, root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  const tasks = await tasksIn(ctx.home, project.name, {
    path: root,
    branch: on0.ok ? on0.out.trim() : '',
    root: project.root,
  })
  const on = await git(ctx, root, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const branch = on.ok ? on.out.trim().replace(/^HEAD$/, '') : ''
  const resolve = async (rev: string) => {
    const found = await git(ctx, root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
    if (!found.ok || !found.out.trim()) throw new Error(`${rev} does not resolve in ${root}`)
    return found.out.trim()
  }
  let base: string
  let head: string
  if (where.ref) {
    const range = where.ref.includes('...')
      ? where.ref.split('...')
      : where.ref.includes('..')
        ? where.ref.split('..')
        : [`${where.ref}~1`, where.ref]
    base = await resolve(range[0] || 'HEAD~1')
    head = await resolve(range[1] || 'HEAD')
  } else {
    head = await resolve('HEAD')
    base = await baseOf(
      ctx,
      root,
      tasks.map((task) => task.base).filter(Boolean),
      head,
      await baseRefOf(ctx, root),
    )
    if (!base) throw new Error(`nothing to diff ${branch || head.slice(0, 8)} against in ${root}`)
  }
  const when = await git(ctx, root, ['log', '-1', '--format=%ct', head])
  // In a directory several tasks share, the tasks a change is about are the
  // ones whose commits are in it, read out of the trailer as `perAgent` reads
  // them — never everybody working there. Recorded as everybody, one agent's
  // `HEAD~1..HEAD` put a finding about one commit in front of thirty-six
  // agents as their own change, and asked about thirty-six intents joined.
  const shared = tasks.length > 1 || tasks.some((one) => one.shared)
  const signed = shared ? (await commitsByTask(ctx, root, `${base}..${head}`)).byTask : null
  const about = signed ? tasks.filter((task) => signed.has(task.id)) : tasks
  return {
    // A finding's key is one change for ever, so a key may never be made out
    // of a moving reference: `HEAD~1..HEAD` is a different change every time
    // somebody commits, and two readings of it days apart folded into one
    // finding, which put an account written about today's diff on a question
    // raised about another one. The commits it resolved to are what it was.
    key:
      tasks.length === 1 && tasks[0]
        ? tasks[0].id
        : `${project.name}:${where.ref ? `${base.slice(0, 8)}..${head.slice(0, 8)}` : branch || head.slice(0, 8)}`,
    project: project.name,
    tasks: about.map((task) => task.id),
    intent: about
      .map((task) => task.intent)
      .filter(Boolean)
      .join('\n'),
    root,
    branch,
    head,
    base,
    commits: [],
    at: Number(when.out.trim() || 0) * 1000,
  }
}

/**
 * One file's patch out of a combined `git show`, and which file it is about.
 *
 * Pure, and a table test holds it: a diff is the one external format here that
 * a question is asked about, and a reading that got the file wrong would put a
 * finding on somebody else's code. Anything it cannot name is skipped, never
 * guessed at — the same rule the transcript parsers keep.
 */
export function patchesIn(shown: string): { file: string; patch: string }[] {
  const out: { file: string; patch: string }[] = []
  let lines: string[] = []
  const keep = () => {
    if (lines.length === 0) return
    const patch = `${lines.join('\n')}\n`
    // `+++ b/<path>` names it, except where it was deleted and that line is
    // `/dev/null`; then `--- a/<path>` is what it was called.
    const file = /^\+\+\+ b\/(.+)$/m.exec(patch)?.[1] ?? /^--- a\/(.+)$/m.exec(patch)?.[1] ?? ''
    if (file) out.push({ file, patch })
    lines = []
  }
  for (const line of shown.split('\n')) {
    if (line.startsWith('diff --git ')) keep()
    if (lines.length > 0 || line.startsWith('diff --git ')) lines.push(line)
  }
  keep()
  return out
}

/**
 * What a unit changed: the range where it is a branch, and the sum of one
 * agent's own commits where it is one agent's work on a branch it shares.
 *
 * Summing the commits rather than diffing across them is what keeps it that
 * agent's: `git diff first^..last` over a shared branch takes in whatever
 * anybody else committed in between, and a finding on somebody else's line is
 * worse than no finding. A file two agents both touched appears in both, which
 * is true — they both changed it.
 *
 * Listed first and read second. The listing is `--name-status`, which reads
 * no file's content; then what no question is about is left out by name —
 * lockfiles and output by `SKIP`, what the repository marks generated,
 * vendored or `-diff` by its own `.gitattributes`, and any file over
 * `FILE_BYTES` at the head — and only then is each file left fetched, on its
 * own and with a cap on what git may print, until the change's budget is
 * spent. One combined `git show` of everything used to be the whole of it, and
 * a change carrying 64 MB of generated files was a change nothing could read.
 *
 * Throws `Unreadable` only where git could not even list it.
 */
export async function changesFor(
  ctx: ExtensionContext,
  unit: Pick<Unit, 'root' | 'base' | 'head' | 'commits'>,
  paths: readonly string[] = [],
): Promise<Change> {
  const scope = unit.commits.length === 0 ? [`${unit.base}...${unit.head}`] : unit.commits
  const verb = unit.commits.length === 0 ? ['diff'] : ['show', '--format=']
  const only = paths.length > 0 ? ['--', ...paths] : []
  const listing = await git(
    ctx,
    unit.root,
    [...verb, '--name-status', '-z', '--no-renames', ...scope, ...only],
    30_000,
  )
  if (!listing.ok) {
    throw new Unreadable(`git ${verb[0]}: ${listing.said || 'it would not resolve'}`)
  }
  const files = namesIn(listing.out)
  const left: LeftOut[] = []
  const rest: string[] = []
  for (const file of files) {
    const why = LOCKFILE.test(file)
      ? 'lockfile'
      : SKIP.test(file) || SKIP_IN.test(file)
        ? 'output'
        : null
    if (why) left.push({ file, why })
    else rest.push(file)
  }
  const marked = await attributesOf(ctx, unit.root, rest)
  const sizes = await sizesAt(ctx, unit.root, unit.head, rest)
  const candidates: string[] = []
  for (const file of rest) {
    const why =
      marked.get(file) ?? ((sizes.get(file) ?? 0) > FILE_BYTES ? ('too-big' as const) : null)
    if (why) left.push({ file, why })
    else candidates.push(file)
  }
  const patches: { file: string; patch: string }[] = []
  const unread: string[] = []
  let spent = 0
  for (const file of candidates) {
    // The same two bounds `cutTo` keeps, kept here as well so that what is
    // past them is named without being fetched: known to have changed, and
    // known not to have been read.
    if (patches.length >= FILE_LIMIT || spent >= CHANGE_LIMIT) {
      unread.push(file)
      continue
    }
    const shown = await git(
      ctx,
      unit.root,
      [...verb, '--unified=3', ...scope, '--', file],
      20_000,
      // Past the cap by a margin, so a cut that lands inside a character is
      // still over it once decoded.
      PATCH_BYTES + 4_096,
    )
    if (Buffer.byteLength(shown.out) > PATCH_BYTES) {
      left.push({ file, why: 'too-big' })
      continue
    }
    if (!shown.ok) {
      unread.push(file)
      continue
    }
    // Asked of what git printed and not of the patch: a binary file added has
    // no `---`/`+++` lines, so `patchesIn` cannot name it, and it would go
    // unsaid as an empty patch.
    if (/^(Binary files .* differ|GIT binary patch)$/m.test(shown.out)) {
      left.push({ file, why: 'binary' })
      continue
    }
    const patch = patchesIn(shown.out)
      .filter((one) => one.file === file)
      .map((one) => one.patch)
      .join('')
    if (patch.trim() === '') continue
    patches.push({ file, patch })
    spent += Math.min(patch.length, PATCH_LIMIT)
  }
  return cutTo(patches, unread, left)
}

/** The paths out of `--name-status -z`, each once, in the order git gave them. */
export function namesIn(listed: string): string[] {
  const words = listed.split('\0')
  const seen = new Set<string>()
  // Status, then path; `--no-renames` means there is never a second path.
  for (let at = 0; at + 1 < words.length; at += 2) {
    const file = words[at + 1]?.replace(/^\n+/, '')
    if (file) seen.add(file)
  }
  return [...seen]
}

/**
 * What the repository's own `.gitattributes` say each file is, where it says
 * it is something no question is about. A repository that cannot be asked is
 * read as one that marks nothing: the size caps still hold, so the failure is
 * reading more than was needed, never less than was asked.
 */
async function attributesOf(
  ctx: ExtensionContext,
  root: string,
  files: readonly string[],
): Promise<Map<string, LeftWhy>> {
  const marked = new Map<string, LeftWhy>()
  for (let at = 0; at < files.length; at += PATHS_PER_CALL) {
    const asked = await git(ctx, root, [
      'check-attr',
      '-z',
      'linguist-generated',
      'linguist-vendored',
      'diff',
      '--',
      ...files.slice(at, at + PATHS_PER_CALL),
    ])
    if (!asked.ok) continue
    const words = asked.out.split('\0')
    for (let one = 0; one + 2 < words.length; one += 3) {
      const [file, name, value] = [words[one] ?? '', words[one + 1], words[one + 2]]
      const set = value === 'set' || value === 'true'
      const why: LeftWhy | null =
        name === 'linguist-generated' && set
          ? 'generated'
          : name === 'linguist-vendored' && set
            ? 'vendored'
            : name === 'diff' && value === 'unset'
              ? 'no-diff'
              : null
      // The first reason found stands: generated is said before -diff.
      if (why && file && !marked.has(file)) marked.set(file, why)
    }
  }
  return marked
}

/**
 * Each file's size in bytes at `head`, where it is a file there: a file the
 * change deleted has none, and is caught by `PATCH_BYTES` instead.
 */
async function sizesAt(
  ctx: ExtensionContext,
  root: string,
  head: string,
  files: readonly string[],
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()
  for (let at = 0; at < files.length; at += PATHS_PER_CALL) {
    const listed = await git(ctx, root, [
      'ls-tree',
      '-l',
      '-z',
      '--full-tree',
      head,
      '--',
      ...files.slice(at, at + PATHS_PER_CALL),
    ])
    if (!listed.ok) continue
    for (const entry of listed.out.split('\0')) {
      const found = /^\d+ blob [0-9a-f]+ +(\d+)\t(.+)$/s.exec(entry)
      if (found?.[1] && found[2]) sizes.set(found[2], Number(found[1]))
    }
  }
  return sizes
}

/**
 * What a judge is given about a change: structure, with the words the work was
 * asked for in beside the diff — never a blob of prose, and never bulk the
 * questions do not need.
 */
export function stateOf(
  unit: { intent: string; branch: string; tasks: readonly string[] },
  changes: readonly FileChange[],
): Record<string, unknown> {
  return {
    asked_for: unit.intent,
    branch: unit.branch,
    tasks: [...unit.tasks],
    files_changed: changes.map((change) => change.file),
    diff: changes.map((change) => change.patch).join('\n'),
  }
}

/**
 * The files of one change in groups that fit an ask, and how much had to be cut
 * to make them fit.
 *
 * Every batch fits. It used to be that a file whose own patch was bigger than
 * the budget went in on its own anyway — the check is `batch.length > 0`, so the
 * first file of a batch is never measured — which is an ask built to be refused:
 * `PATCH_LIMIT` is a cap on one file and says nothing about what one *ask*
 * takes, and the two are only ever comfortably apart while the rest of the state
 * is small. The state is measured now, so on a change with a long intent and
 * forty file names the room left can fall below one file's patch, and then the
 * old rule sent a state over the limit and lost the whole reading.
 *
 * So such a file is cut to what is left and how much was left behind is
 * returned, because that is a reading of part of a file and the caller has to
 * say so: what it did not read, it cannot have answered about.
 */
export function inBatches(
  changes: readonly FileChange[],
  budgetChars: number,
): { batches: FileChange[][]; cut: number } {
  const batches: FileChange[][] = []
  let batch: FileChange[] = []
  let size = 0
  let cut = 0
  const room = Math.max(1, budgetChars)
  for (const change of changes) {
    const names = change.file.length
    const fits = Math.max(1, room - names)
    const patch = change.patch.length > fits ? change.patch.slice(0, fits) : change.patch
    cut += change.patch.length - patch.length
    const one =
      patch.length === change.patch.length
        ? change
        : { ...change, patch, cut: change.cut + (change.patch.length - patch.length) }
    const length = patch.length + names
    if (batch.length > 0 && size + length > room) {
      batches.push(batch)
      batch = []
      size = 0
    }
    batch.push(one)
    size += length
  }
  if (batch.length > 0) batches.push(batch)
  return { batches, cut }
}
