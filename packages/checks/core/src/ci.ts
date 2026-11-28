import { readdir, readFile, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { idFor } from './identity.ts'
import type { Check } from './port.ts'

// What a project's CI already says it checks.
//
// This used to be a best-effort reading that nothing was allowed to run,
// because "a CI config holds releases and deploys beside its tests and nothing
// can tell which is which". That was wrong, and the reason it was wrong is
// that nobody had read the *triggers*. A release is not told from a gate by
// the wording of a step name; it is told by facts the file states about itself:
//
//   on: pull_request / push: branches:   this runs on every change — the gate
//   on: push: tags: / release:           this ships something
//   environment:                         GitHub's own word for a deploy target
//   permissions: …: write                it publishes rather than checks
//   services:                            it needs a database only CI has
//   ${{ … }} in a run:                   it needs what only the runner knows
//   no run:                              it is somebody's action
//   working-directory: an action's path  it needs what only the runner made
//   after actions/download-artifact      it reads what another job made
//
// So the rule is a conjunction of declared facts, and the design principle
// underneath it is one sentence:
//
//   **Reading may only ever narrow what Tade claims.**
//
// Everything this cannot place is *named* rather than run. The failure mode is
// therefore "Tade checked less than CI does, and said so", never "Tade ran a
// deploy" — which is what makes reading safe enough to be the definition
// rather than a suggestion.
//
// A parser of an external format: it never throws on a shape it does not know.
//
// **What this does to the trust boundary, said out loud.** These commands are
// run through a shell, and they now come out of `.github/workflows/` rather
// than out of `.tade/checks.yaml`. Both are files in the branch that is checked
// out, so the level is the one it always was — whoever can write a file in this
// checkout decides what a check runs, and an agent working here is already
// running that branch's build and its tests with nothing containing it. What
// *did* change is the default: `checks.from_ci: 'show'` used to mean a command
// read from CI was never run until somebody adopted it, and a workflow's
// commands now run without that step. The reason that is the right trade is
// that adoption was never a reading of the command — it was a person pressing a
// button — and a branch nobody trusts is not one to run any of Tade's checks
// in. A branch from a fork is the case to have in mind, and the answer to it is
// the same answer as for everything else an agent does in a checkout: it is the
// harness's or the agent's, never a manifest's.
//
// One more distinction, and it is the one that decides what a person sees.
//
// A step that is **not a check at all** — somebody's action, an install that
// prepares the machine, a job that deploys, a workflow that ships a release —
// is named in `unread` and is nowhere else, because there is nothing about it
// for a page about checks to draw.
//
// A step that **is** a check and cannot run *here* — it interpolates something
// only the runner knows, its job needs a database — is a check with a `skip`
// and `required: false`. It keeps its row, drawn apart from what does run here
// with the reason beside it; and it is out of the rollup, because a rollup is
// what a run *here* adds up to, and a project with one `${{ secrets.… }}` step
// would otherwise be unknown for ever. `required` means merging waits on it:
// CI still holds on these, and Tade never claimed to be CI.
//
// The `skip` is the bare reason and never a sentence that frames it — "its job
// needs service containers, which only CI has", not "cannot run here: …" — so
// that every surface can frame it in its own words. One of them has no frame
// at all, because it draws these under a heading that already says it; and the
// one thing a fixed frame could not have said is the other reason a check does
// not run here, which is that somebody turned it off (`choice.ts`).

/** A reading of somebody else's config: what it found, from where, and what it left. */
export interface Reading {
  checks: readonly Check[]
  /** The files it was read from, relative to the project, in reading order. */
  from: readonly string[]
  /**
   * Everything that did not become a check, each a sentence naming the thing
   * and why. Complete on purpose: a step dropped in silence is how somebody
   * comes to believe Tade checks something it has never looked at.
   */
  unread: readonly string[]
}

const WORKFLOWS = join('.github', 'workflows')

/** No `timeout-minutes` anywhere: long enough for a suite, short enough to end a hang. */
const DEFAULT_MINUTES = 20

/** Past this a declared timeout is CI's patience, not a local run's. */
const MOST_MINUTES = 60

/**
 * Commands that prepare the machine rather than check the code. A failing
 * `pnpm install` means the network is down, and a check whose red light means
 * that is a check that cries wolf.
 *
 * The one rule here that is a list of verbs rather than a fact the file
 * states — and it is safe because it may only ever *exclude*, which is the
 * direction that makes Tade claim less.
 */
const SETUP =
  /(^|\s|&&|\|\||;)(?:sudo\s+)?(?:(?:pnpm|npm|yarn|bun)\s+(?:install|ci|i)\b|corepack\s+enable\b|(?:pip|pip3)\s+install\b|uv\s+sync\b|poetry\s+install\b|bundle\s+install\b|apt(?:-get)?\s+(?:update|install)\b|brew\s+(?:install|update)\b|choco\s+install\b|go\s+mod\s+download\b|cargo\s+fetch\b|playwright\s+install\b)/

/** Permissions that mean a job changes something outside the repository. */
function publishes(permissions: unknown): string | null {
  if (typeof permissions === 'string') {
    return permissions === 'write-all' ? 'write-all' : null
  }
  const raw = asObject(permissions)
  if (!raw) return null
  for (const [scope, level] of Object.entries(raw)) {
    if (level === 'write' && scope !== 'contents') return `${scope}: write`
  }
  return null
}

/**
 * Whether this workflow is the gate every change goes through, and why not
 * where it is not. `workflow_call` on its own is somebody else's piece: what
 * calls it decides what it is, and guessing that it is a gate is the one guess
 * that could run a release.
 */
export function gateTrigger(on: unknown): { gate: true } | { gate: false; because: string } {
  if (typeof on === 'string') {
    return on === 'pull_request' || on === 'push'
      ? { gate: true }
      : { gate: false, because: `it runs on ${on}` }
  }
  const names = Array.isArray(on)
    ? on.map(String)
    : asObject(on)
      ? Object.keys(asObject(on) as Record<string, unknown>)
      : []
  if (names.length === 0) return { gate: false, because: 'it says nothing about when it runs' }
  if (names.includes('pull_request') || names.includes('pull_request_target')) return { gate: true }
  if (names.includes('push')) {
    const push = asObject(on) ? asObject(on)?.push : null
    const at = asObject(push)
    // A push with tags and no branches is a release. A push that says nothing
    // is every branch, which is the gate.
    if (!at) return { gate: true }
    if (at.branches || at['branches-ignore']) return { gate: true }
    if (at.tags || at['tags-ignore']) {
      return { gate: false, because: 'it runs on a tag, which is a release and not a gate' }
    }
    return { gate: true }
  }
  return { gate: false, because: `it runs on ${names.join(', ')} and not on a change` }
}

/**
 * What a project's CI checks on every change. Null where there are no
 * workflows to read at all — which is not the same as a project whose
 * workflows hold no checks, and reads differently to whoever is told.
 *
 * Reads files and nothing else: no processes, no network, safe from a
 * draw-adjacent poll.
 */
export async function readWorkflows(root: string): Promise<Reading | null> {
  const dir = join(root, WORKFLOWS)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name)).sort()
  } catch {
    return null
  }
  if (files.length === 0) return null
  const checks: Check[] = []
  const from: string[] = []
  const unread: string[] = []
  const taken = new Set<string>()
  for (const file of files) {
    const at = `${WORKFLOWS}/${file}`
    let parsed: unknown
    try {
      parsed = parseYaml(await readFile(join(dir, file), 'utf8'))
    } catch {
      unread.push(`${at} is not readable YAML, so nothing in it was read`)
      continue
    }
    const raw = asObject(parsed)
    // YAML 1.2 keeps `on` a plain key; a 1.1 parser would make it `true`.
    // Reading both so a parser change cannot silently empty every reading.
    const trigger = gateTrigger(raw?.on ?? raw?.true)
    if (!trigger.gate) {
      unread.push(`${at} was not read: ${trigger.because}`)
      continue
    }
    const before = checks.length
    const event = eventOf(raw?.on ?? raw?.true)
    // Every job sees the workflow's own `env:`, as every step sees its job's.
    // No matrix is in scope at the top of a workflow, so none is answered.
    const envNeedsRunner = runnerEnv(raw?.env, new Set()).needs
    await readJobs(
      root,
      asObject(raw?.jobs),
      runDirOf(raw),
      at,
      event,
      checks,
      unread,
      taken,
      envNeedsRunner,
    )
    if (checks.length > before) from.push(at)
  }
  if (checks.length === 0 && unread.length === 0) return null
  return { checks, from, unread }
}

async function readJobs(
  root: string,
  jobs: Record<string, unknown> | null,
  workflowDir: string | null,
  at: string,
  event: ChangeEvent | null,
  checks: Check[],
  unread: string[],
  taken: Set<string>,
  workflowEnvNeedsRunner: boolean,
): Promise<void> {
  if (!jobs) return
  const skipped = notRunOn(jobs, event)
  for (const [name, value] of Object.entries(jobs)) {
    const job = asObject(value)
    const where = `${at} › ${name}`
    const off = skipped.get(name)
    if (off) {
      unread.push(`${where} ${off}, so none of it was read`)
      continue
    }
    // A job that calls another workflow has no steps of its own. The workflow
    // it calls is read on its own terms, where it is a gate.
    if (typeof job?.uses === 'string') continue
    if (job?.environment) {
      unread.push(`${where} deploys to an environment, so none of it was read`)
      continue
    }
    const write = publishes(job?.permissions)
    if (write) {
      unread.push(`${where} asks for ${write}, so it publishes rather than checks`)
      continue
    }
    // These are checks the job really runs; what they need is what this machine
    // has not got. So they keep their rows and say so, rather than vanishing.
    const matrix = matrixKeysOf(job)
    const jobEnv = runnerEnv(job?.env, matrix)
    const cannot = job?.services
      ? 'its job needs service containers, which only CI has'
      : job?.container
        ? 'its job runs in a container, which is not this machine'
        : job?.if !== undefined && holdsOn(job.if, event) === null
          ? `its job runs only when \`${conditionText(job.if)}\`, which only CI can answer`
          : null
    await readSteps(
      root,
      Array.isArray(job?.steps) ? job.steps : [],
      runDirOf(job) ?? workflowDir,
      where,
      event,
      checks,
      unread,
      taken,
      cannot,
      // Every step sees its job's `env:` and is bounded by its job's
      // timeout, so both are read as if each step had said them.
      { needs: workflowEnvNeedsRunner || jobEnv.needs, rows: jobEnv.rows, matrix },
      minutesOf(job, DEFAULT_MINUTES),
    )
  }
}

async function readSteps(
  root: string,
  steps: readonly unknown[],
  jobDir: string | null,
  where: string,
  event: ChangeEvent | null,
  checks: Check[],
  unread: string[],
  taken: Set<string>,
  jobCannot: string | null,
  jobEnv: { needs: boolean; rows: readonly string[]; matrix: ReadonlySet<string> },
  jobMinutes: number,
): Promise<void> {
  // The folders an earlier action in this job made — a second repository
  // checked out beside this one, an artifact downloaded — which this checkout
  // does not have, or has only as whatever a run here last left in them.
  const made: { path: string; by: string }[] = []
  // An artifact another job of the run uploaded, once one is downloaded: every
  // step after it may be reading it, and this checkout has nothing of it.
  let fetched: string | null = null
  for (const entry of steps) {
    const step = asObject(entry)
    const name = typeof step?.name === 'string' ? step.name.trim() : ''
    const said = name ? `${where} › ${name}` : where
    const run = typeof step?.run === 'string' ? step.run.trim() : ''
    // Before anything else about it: a step that never runs on a change makes
    // no folder and checks nothing.
    const when = step?.if === undefined ? true : holdsOn(step.if, event)
    if (when === false) {
      unread.push(`${said} ${neverOn(step?.if, event)}`)
      continue
    }
    if (!run) {
      const uses = typeof step?.uses === 'string' ? step.uses : ''
      // An action prepares the machine or talks to the forge; either way there
      // is no command here to run.
      if (uses) {
        unread.push(`${said} is the action ${uses}, which only the runner can run`)
        for (const path of pathsOf(asObject(step?.with)?.path)) made.push({ path, by: uses })
        if (DOWNLOADS_ARTIFACT.test(uses)) fetched ??= uses
      }
      continue
    }
    if (SETUP.test(run)) {
      unread.push(`${said} prepares the machine rather than checking the code`)
      continue
    }
    const own = step?.['working-directory']
    const dir = typeof own === 'string' && own.trim() ? own.trim() : jobDir
    const stepEnv = runnerEnv(step?.env, jobEnv.matrix)
    const runnerOnly =
      jobEnv.needs ||
      stepEnv.needs ||
      /\$\{\{/.test(run) ||
      /\$\{\{/.test(dir ?? '') ||
      [...jobEnv.rows, ...stepEnv.rows].some((variable) => names(run, variable))
    const cannot =
      jobCannot ??
      (runnerOnly
        ? 'it uses something only the runner knows'
        : fetched
          ? `it reads what the action ${fetched} brought from another job`
          : ((dir ? await placeOf(root, dir, made) : null) ??
            (when === null
              ? `it runs only when \`${conditionText(step?.if)}\`, which only CI can answer`
              : null)))
    const cwd = dir && !/\$\{\{/.test(dir) ? inside(dir) : null
    checks.push({
      id: idFor(name, run, taken),
      title: name || run.split('\n')[0] || 'check',
      run,
      // Every step of a CI job has the runner to itself: steps go one at a
      // time on a machine nothing else is using. Running two of them side by
      // side here would be *less* faithful than CI, not more — and it is what
      // starves a suite's own subprocesses into looking like a regression.
      //
      // Steps of *different* jobs do go side by side in CI, and these do not,
      // which is the one thing this gives up. Faithful would need a check to
      // know which job it came from, and the trade is the safe direction: a
      // local run is never faster than CI and never starves anything. A
      // project that wants two of them at once has `checks.only`.
      alone: true,
      minutes: minutesOf(step, jobMinutes),
      // Declared, not assumed: a step CI is willing to be red on is a step
      // nothing should be held on here either. Nor is one nothing here can run:
      // it is drawn, and it is out of what a local run adds up to.
      required: step?.['continue-on-error'] !== true && cannot === null,
      from: where,
      ...(cwd ? { cwd } : {}),
      ...(cannot ? { skip: cannot } : {}),
    })
  }
}

// An `if:` is a question about the run CI is making, and almost every one of
// them is only CI's to answer — a ref, a secret, an earlier step's outcome.
// One kind is not: a run here stands for a change, so a condition that asks
// nothing but *which event this is* has an answer here too. That is what lets
// a workflow that also runs on a schedule — `check` behind
// `github.event_name != 'schedule'`, `calibrate` behind `== 'schedule'` — be
// read as the gate it is, rather than have every check in it skipped.
//
// Only the narrowest grammar is answered: `github.event_name` compared with a
// quoted literal by `==` or `!=`, joined by `&&`, `||`, `!` and parentheses,
// bare or inside `${{ }}`. Anything else in the expression — another context,
// a function such as `always()`, a literal compared with a literal, a value
// used for its truth — makes the whole of it unanswerable, as every `if:` was
// before, so the reading can only ever run less than it would by guessing.

/** The event a run here stands for, in a workflow that is a gate. */
type ChangeEvent = 'push' | 'pull_request'

/**
 * Which event a run here stands for: a push where the workflow runs on a push
 * to a branch, a pull request where it runs on pull requests only. Null for
 * anything else (`pull_request_target`, a push only of tags), where no event
 * is answered for it and every condition on one stays CI's.
 */
export function eventOf(on: unknown): ChangeEvent | null {
  if (typeof on === 'string') return on === 'push' || on === 'pull_request' ? on : null
  const names = Array.isArray(on) ? on.map(String) : Object.keys(asObject(on) ?? {})
  if (names.includes('push')) {
    const at = asObject(asObject(on)?.push)
    const tagsOnly =
      at !== null && !at.branches && !at['branches-ignore'] && !!(at.tags || at['tags-ignore'])
    if (!tagsOnly) return 'push'
  }
  return names.includes('pull_request') ? 'pull_request' : null
}

/**
 * Whether an `if:` holds on a run standing for `event`: true or false where
 * it asks nothing but which event this is (or is a YAML boolean), null where
 * it asks anything else and only CI can answer.
 */
export function holdsOn(condition: unknown, event: ChangeEvent | null): boolean | null {
  if (typeof condition === 'boolean') return condition
  if (typeof condition !== 'string') return null
  let text = condition.trim()
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text)
  if (wrapped) text = (wrapped[1] ?? '').trim()
  const tokens = tokensOf(text)
  if (!tokens || tokens.length === 0) return null
  let at = 0
  const peek = (): Token | undefined => tokens[at]
  // Each returns null for "not this grammar", which the caller passes up whole.
  const or = (): boolean | null => {
    let value = and()
    while (value !== null && peek()?.kind === '||') {
      at++
      const right = and()
      value = right === null ? null : value || right
    }
    return value
  }
  const and = (): boolean | null => {
    let value = unary()
    while (value !== null && peek()?.kind === '&&') {
      at++
      const right = unary()
      value = right === null ? null : value && right
    }
    return value
  }
  const unary = (): boolean | null => {
    if (peek()?.kind === '!') {
      at++
      const value = unary()
      return value === null ? null : !value
    }
    if (peek()?.kind === '(') {
      at++
      const value = or()
      if (value === null || peek()?.kind !== ')') return null
      at++
      return value
    }
    return comparison()
  }
  const comparison = (): boolean | null => {
    const left = tokens[at]
    const op = tokens[at + 1]
    const right = tokens[at + 2]
    if (!left || !right || (op?.kind !== '==' && op?.kind !== '!=')) return null
    const literal =
      left.kind === 'event' && right.kind === 'literal'
        ? right.text
        : left.kind === 'literal' && right.kind === 'event'
          ? left.text
          : null
    if (literal === null || event === null) return null
    at += 3
    // GitHub compares strings without regard to case.
    const same = literal.toLowerCase() === event
    return op.kind === '==' ? same : !same
  }
  const value = or()
  return value !== null && at === tokens.length ? value : null
}

type Token =
  | { kind: '(' | ')' | '!' | '==' | '!=' | '&&' | '||' | 'event' }
  | { kind: 'literal'; text: string }

/** The tokens of an expression in the grammar above, or null at anything outside it. */
function tokensOf(text: string): Token[] | null {
  const tokens: Token[] = []
  let at = 0
  while (at < text.length) {
    const rest = text.slice(at)
    const space = /^\s+/.exec(rest)
    if (space) {
      at += space[0].length
      continue
    }
    const op = /^(==|!=|&&|\|\||[()!])/.exec(rest)
    if (op) {
      tokens.push({ kind: op[0] as '(' | ')' | '!' | '==' | '!=' | '&&' | '||' })
      at += op[0].length
      continue
    }
    // A context's property names are not case-sensitive either.
    const name = /^github\.event_name(?![\w.[-])/i.exec(rest)
    if (name) {
      tokens.push({ kind: 'event' })
      at += name[0].length
      continue
    }
    const literal = /^'((?:[^']|'')*)'/.exec(rest)
    if (literal) {
      tokens.push({ kind: 'literal', text: (literal[1] ?? '').replaceAll("''", "'") })
      at += literal[0].length
      continue
    }
    return null
  }
  return tokens
}

/** An `if:` as somebody wrote it, for a sentence. */
function conditionText(condition: unknown): string {
  return typeof condition === 'string' ? condition.trim() : String(condition)
}

function kindOf(event: ChangeEvent | null): string {
  return event === 'pull_request' ? 'a pull request' : event === 'push' ? 'a push' : 'a change'
}

/** Why a step or job whose `if:` came out false is not read, after its name. */
function neverOn(condition: unknown, event: ChangeEvent | null): string {
  return typeof condition === 'boolean'
    ? `says \`if: ${condition}\`, so it never runs`
    : `runs only when \`${conditionText(condition)}\`, which does not hold for ${kindOf(event)}`
}

/**
 * The jobs of a workflow that do not run on a change, each with why. A job
 * whose own `if:` is answered false, and — since GitHub puts an implicit
 * `success()` before every condition without a status function, and a job
 * whose needs were skipped is skipped — a job that needs one of those and
 * whose own condition, if it has one, was answered. One whose condition was
 * not answered may say `always()`, so it stays CI's to answer.
 */
function notRunOn(jobs: Record<string, unknown>, event: ChangeEvent | null): Map<string, string> {
  const off = new Map<string, string>()
  const answered = new Set<string>()
  for (const [name, value] of Object.entries(jobs)) {
    const condition = asObject(value)?.if
    const held = condition === undefined ? true : holdsOn(condition, event)
    if (held === false) off.set(name, neverOn(condition, event))
    if (held !== null) answered.add(name)
  }
  for (let grew = true; grew; ) {
    grew = false
    for (const [name, value] of Object.entries(jobs)) {
      if (off.has(name) || !answered.has(name)) continue
      const needs = asObject(value)?.needs
      const list =
        typeof needs === 'string' ? [needs] : Array.isArray(needs) ? needs.map(String) : []
      const gone = list.find((need) => off.has(need))
      if (gone === undefined) continue
      off.set(name, `needs ${gone}, which does not run on ${kindOf(event)}`)
      grew = true
    }
  }
  return off
}

/** `defaults.run.working-directory`, for a workflow or a job. */
function runDirOf(raw: Record<string, unknown> | null): string | null {
  const dir = asObject(asObject(raw?.defaults)?.run)?.['working-directory']
  return typeof dir === 'string' && dir.trim() ? dir.trim() : null
}

/** A folder relative to the checkout, without `./` or a trailing `/`; null for the root itself or anywhere outside it. */
function inside(dir: string): string | null {
  const at = posix.normalize(dir.replaceAll('\\', '/')).replace(/\/+$/, '')
  if (at === '.' || at === '') return null
  if (posix.isAbsolute(at) || at === '..' || at.startsWith('../')) return null
  return at
}

/** What an action's `with.path` names: one folder, or one per line (`actions/cache`). */
function pathsOf(raw: unknown): string[] {
  if (typeof raw !== 'string' || /\$\{\{/.test(raw)) return []
  return raw
    .split('\n')
    .map((line) => inside(line.trim()))
    .filter((line): line is string => line !== null)
}

/**
 * Why a step cannot be run in the folder it says, or null when it can. Only
 * ever a reason to run less: a folder outside the checkout, one an action
 * makes on the runner, one this checkout has not got. Run at the root
 * instead, any of them is a red light about the wrong folder.
 */
async function placeOf(
  root: string,
  dir: string,
  made: readonly { path: string; by: string }[],
): Promise<string | null> {
  const at = inside(dir)
  if (at === null) {
    const normal = posix.normalize(dir.replaceAll('\\', '/'))
    return normal === '.' || normal === './'
      ? null
      : `it runs in ${dir}, which is outside this checkout`
  }
  // Even when the folder is here: what is in it is whatever a run here last
  // left, and not what the action puts there on the runner.
  const by = made.find((one) => at === one.path || at.startsWith(`${one.path}/`))
  if (by) return `it runs in ${at}, which the action ${by.by} makes`
  try {
    if ((await stat(join(root, at))).isDirectory()) return null
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // A folder that could not be looked at is not one that is missing: say which.
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      return `it runs in ${at}, which could not be looked at here (${code ?? String(err)})`
    }
  }
  return `it runs in ${at}, which is not in this checkout`
}

// A matrix is one check, run once, here — `runs-on: ${{ matrix.os }}` has
// always been read that way, and a run here is the run with no row of the
// matrix at all. So an `env:` value that interpolates nothing but the job's own
// `matrix.<key>` is a variable a row sets and this run does not have, the same
// as it does not have the job's literal `env:` (a check read from CI is handed
// none of it). That is what lets a job be split into shards by its `env:` and
// still be read as the check it is: Tade's own `tests` runs the whole suite
// with `VITEST_SHARD` unset (`scripts/coverage.ts`).
//
// Two conditions keep it narrow. The key has to be one the job's
// `strategy.matrix` states as a literal, so `${{ fromJSON(…) }}` or a key it
// does not have stays the runner's; and a command that names the variable
// (`$SHARD`, `${SHARD}`) is reading the row's value in the command itself, so
// that step stays the runner's too. Anything else inside `${{ }}` — a secret,
// `github.…`, an expression around the matrix value — stays the runner's.

/** `actions/download-artifact`, or anybody's fork of it. */
const DOWNLOADS_ARTIFACT = /(^|\/)download-artifact@/

/** The keys a job's `strategy.matrix` states as literals, `include:` rows' keys among them. */
function matrixKeysOf(job: Record<string, unknown> | null): Set<string> {
  const keys = new Set<string>()
  const matrix = asObject(asObject(job?.strategy)?.matrix)
  if (!matrix) return keys
  for (const [key, value] of Object.entries(matrix)) {
    if (key === 'exclude') continue
    if (key === 'include') {
      for (const row of Array.isArray(value) ? value : []) {
        for (const name of Object.keys(asObject(row) ?? {})) keys.add(name)
      }
      continue
    }
    if (Array.isArray(value)) keys.add(key)
  }
  return keys
}

/**
 * What an `env:` needs of the runner: `needs` where any value interpolates
 * anything but one of `matrix`'s keys, and `rows`, the variables whose values
 * are set by a row of that matrix and so are unset here.
 */
function runnerEnv(env: unknown, matrix: ReadonlySet<string>): { needs: boolean; rows: string[] } {
  const raw = asObject(env)
  if (!raw) return { needs: /\$\{\{/.test(JSON.stringify(env ?? '')), rows: [] }
  const rows: string[] = []
  let needs = false
  for (const [name, value] of Object.entries(raw)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
    if (!/\$\{\{/.test(text)) continue
    const rest = text.replace(/\$\{\{\s*matrix\.([A-Za-z_][\w-]*)\s*\}\}/g, (whole, key: string) =>
      matrix.has(key) ? '' : whole,
    )
    if (/\$\{\{/.test(rest)) needs = true
    else rows.push(name)
  }
  return { needs, rows }
}

/** Whether a shell command names this variable, `$NAME` or `${NAME…}`. */
function names(run: string, variable: string): boolean {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\$\\{?${escaped}(?!\\w)`).test(run)
}

function minutesOf(step: Record<string, unknown> | null, fallback: number): number {
  const said = step?.['timeout-minutes']
  const minutes = typeof said === 'number' ? said : Number(said)
  if (!Number.isFinite(minutes) || minutes <= 0) return fallback
  return Math.min(MOST_MINUTES, Math.ceil(minutes))
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
