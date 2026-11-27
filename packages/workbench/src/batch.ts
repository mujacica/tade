import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import {
  type Check,
  type CheckLog,
  type CheckRun,
  failingFileIn,
  followRenames,
  HELD_MS,
  type Holders,
  heldBy,
  holdKept,
  type LockHolder,
  plain,
  planFor,
  queueDir,
  RunnerError,
  readChecks,
  readOutcome,
  readRuns,
  rollup,
  runQueueDir,
  SLOT_ENV,
  STILL_MS,
  waitForMachineSlot,
  waitForRunLock,
  waitingAhead,
} from '@tade/checks-core'
import {
  type Config,
  type Culprit,
  checksFor,
  culpritOf,
  type Narrowing,
  nextToTry,
  projectDir,
  readingOf,
  recordsDir,
  runProgram,
  shellQuote,
  type Tried,
  withLook,
} from '@tade/core'
import { git } from '@tade/status'
import { runProjectChecks } from './checks.ts'
import { bringFiles, sourcesIn } from './prepare.ts'

// The full checks for a batch of commits, in a tree of their own.
//
// A shared checkout is never what HEAD holds: agents have files open in it,
// half written, and a run there reads all of them — which is how one machine
// recorded sixty runs in a night, most of them red over somebody else's work
// in progress. So a batch runs in a clone of the project under Tade's home
// (`<home>/projects/<name>/batch`), checked out at exactly the commit and
// prepared as the project says a new tree is (`prepare.ts`): one `git clone
// --shared` the first time, then a checkout per batch, and the setup command
// again only when a manifest or a lockfile changed. Its record is the
// checkout's — the commit is the same commit — so the rollup at HEAD reads it.
//
// The same tree is where a red batch is narrowed: the failing tests run again
// at the commits it covered, halving (`nextToTry`), to say whose commit broke
// it (`culpritOf`). That needs a tree at other commits, which the shared
// checkout can never be moved to. Nothing here starts an agent: what a red
// batch becomes is the window's (`wire/batches.ts`), and it is one proposal.
//
// Everything runs detached, with a deadline, through `runProgram` and the
// status package's `git` — this is called from the window.

/** Who a batch's runs are recorded as. */
export const BATCH_BY = 'batch'

/** The most commits a red batch is narrowed over; past this it is said rather than walked. */
export const MOST_COVERED = 64

/** How long one git step may take. */
const GIT_MS = 60_000

/** The files a setup installs from, as `git ls-tree` lines: a change to one is a new install. */
const INSTALLS_FROM =
  /\t(.*\/)?(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|\.npmrc|\.nvmrc)$/

/** How long the failing tests are given at one commit, on their own. */
const NARROW_MS = 10 * 60_000

/** Where a project's batch tree is: Tade's own home, never the project. */
export function batchDir(home: string, project: string): string {
  return join(projectDir(home, project), 'batch')
}

/** A tree at a commit, prepared, or why it is not. */
export type BatchTree = { dir: string } | { problem: string }

/**
 * The batch tree at `commit`, prepared: cloned the first time, checked out at
 * exactly the commit with anything left over by a run taken away, and the
 * project's setup run again when what it installs from changed.
 */
export async function treeAt(opts: {
  config: Config
  home: string
  project: string
  root: string
  commit: string
}): Promise<BatchTree> {
  const dir = batchDir(opts.home, opts.project)
  // Never the checkout, and never outside Tade's own folder for the project:
  // what follows checks out over and cleans whatever is here.
  const own = resolve(projectDir(opts.home, opts.project)) + sep
  if (!resolve(dir).startsWith(own) || resolve(dir) === resolve(opts.root)) {
    return { problem: `${dir} is not a folder of Tade's own for ${opts.project}` }
  }
  if (!existsSync(join(dir, '.git'))) {
    const cloned = await git(
      opts.home,
      ['clone', '--quiet', '--shared', '--no-checkout', opts.root, dir],
      GIT_MS,
    )
    if (!cloned.ok)
      return { problem: `the batch tree could not be made: ${firstLine(cloned.stderr)}` }
  }
  const top = await git(dir, ['rev-parse', '--show-toplevel'], GIT_MS)
  if (!top.ok || resolve(top.stdout.trim()) !== resolve(dir)) {
    return { problem: `${dir} is not a repository of its own, so nothing was checked out in it` }
  }
  for (const args of [
    ['checkout', '--quiet', '--detach', '--force', opts.commit],
    // Untracked files a run left: a batch reads exactly the commit. Ignored
    // ones stay — they are what the setup installed.
    ['clean', '-fdq'],
  ]) {
    const moved = await git(dir, args, GIT_MS)
    if (!moved.ok)
      return { problem: `git ${args[0]} in the batch tree failed: ${firstLine(moved.stderr)}` }
  }
  const prepared = await prepare(opts, dir)
  return prepared ?? { dir }
}

/** Run the project's setup in the batch tree where its inputs changed. Null when it is ready. */
async function prepare(
  opts: { config: Config; project: string; root: string; commit: string },
  dir: string,
): Promise<{ problem: string } | null> {
  const reading = readingOf(
    await sourcesIn(dir, opts.root),
    opts.config.projects[opts.project]?.prepare,
  )
  if (reading.files.length > 0) {
    await bringFiles({
      root: opts.root,
      worktree: dir,
      patterns: reading.files,
      link: reading.link,
    })
  }
  if (!reading.setup) return null
  // What the setup installs from, by blob: the same manifests and lockfiles
  // install the same tree, so a batch whose commit changed neither skips it.
  const listed = await git(dir, ['ls-tree', '-r', opts.commit], GIT_MS)
  const inputs = listed.ok
    ? listed.stdout
        .split('\n')
        .filter((line) => INSTALLS_FROM.test(line))
        .join('\n')
    : ''
  const key = `${reading.setup.command}\n${inputs}`
  const stamp = join(dir, '.git', 'tade-prepared')
  if (listed.ok && (await stampOf(stamp)) === key) return null
  const ran = await runProgram('sh', ['-c', reading.setup.command], {
    cwd: dir,
    timeoutMs: reading.setup.deadline_s * 1_000,
  })
  if (ran.code !== 0) {
    return {
      problem: `the batch tree's setup (${reading.setup.command}) ${ran.timedOut ? 'ran out of time' : `failed: ${lastLine(ran.stderr || ran.stdout)}`}`,
    }
  }
  if (listed.ok) await writeFile(stamp, key)
  return null
}

/** What a batch came to: its runs, or why it could not run. */
export type Batch = { runs: CheckLog[] } | { problem: string; busy?: boolean }

// A Node that cannot run TypeScript, for a project that runs its `.ts` on Node
// itself. Debian's and Ubuntu's `nodejs` package is built without it (22.22.1
// on Ubuntu 26.04: `process.features.typescript` is `false`), while its version
// clears every floor that only reads numbers. Every check then fails whatever
// was committed, and a red batch is narrowed to whichever covered commit comes
// first — a machine's fault put to an agent as its own. So it is asked before
// a batch, and said instead of run.
//
// Both halves are read, never guessed, and either one missing runs the batch
// as before: the answer is only `false` from the Node a check would find on
// PATH, and the project's own `package.json` at the commit has to run a `.ts`
// file with `node` (Tade's says `node scripts/coverage.ts`). A Node too old to
// have the flag at all is the project's floor to state, not this.

/**
 * A script that runs a TypeScript file on Node itself: `node scripts/coverage.ts`,
 * its flags (and a flag's value: `--import ./r.mjs`) before the file.
 */
const NODE_RUNS_TS =
  /(?:^|[\s;&|(])(node\s+(?:-[^\s;&|()]+(?:\s+[^-\s;&|()][^\s;&|()]*)?\s+)*[^-\s;&|()][^\s;&|()]*\.[cm]?ts)(?=$|[\s;&|)])/

/** The first of a manifest's scripts that runs a `.ts` file on Node, or null. */
export function runsTypeScriptOnNode(manifest: string): string | null {
  let scripts: unknown
  try {
    scripts = (JSON.parse(manifest) as { scripts?: unknown }).scripts
  } catch (err) {
    // A manifest that is not JSON says nothing about what it runs, and the
    // batch runs as before; anything else is not a reading of it.
    if (err instanceof SyntaxError) return null
    throw err
  }
  if (typeof scripts !== 'object' || scripts === null) return null
  for (const line of Object.values(scripts)) {
    const found = typeof line === 'string' ? NODE_RUNS_TS.exec(line) : null
    if (found?.[1]) return found[1]
  }
  return null
}

/**
 * Why a batch at `commit` would be red on this machine's Node whatever was
 * committed, or null where it would not or that cannot be told.
 */
export async function nodeWithoutTypeScript(opts: {
  root: string
  commit: string
  env?: NodeJS.ProcessEnv
}): Promise<string | null> {
  const asked = await runProgram(
    'node',
    ['-p', "[process.features.typescript, process.version, process.execPath].join(' ')"],
    { cwd: opts.root, timeoutMs: 10_000, ...(opts.env ? { env: opts.env } : {}) },
  )
  const [answer, version, ...where] = asked.stdout.trim().split(' ')
  if (asked.code !== 0 || answer !== 'false') return null
  const manifest = await git(opts.root, ['show', `${opts.commit}:package.json`], GIT_MS)
  const script = manifest.ok ? runsTypeScriptOnNode(manifest.stdout) : null
  if (script === null) return null
  return `the Node a check runs here (${version}, ${where.join(' ')}) is built without TypeScript, and this project runs .ts on Node itself (\`${script}\`), so every check would fail whatever was committed — Debian's and Ubuntu's nodejs package is built that way, and Node from nodejs.org or a version manager (mise, nvm, volta) is not`
}

/**
 * Where the batch tree's turn is held: beside the tree and never inside it,
 * where `git clean` would take it away.
 *
 * The tree is one folder that every full run of a shared checkout moves to its
 * own commit — the window's batch, its narrowing, and an agent's `checks_run`
 * before a push. Moved while somebody's suite is reading it, that suite reads
 * a different commit from the one it records, so whoever moves it holds this
 * for as long as they read it.
 */
function treeTurn(home: string, project: string): string {
  return join(projectDir(home, project), 'batch-turn')
}

/**
 * The batch tree's turn, waited for up to `waitMs`, or who has it.
 *
 * A place `by` kept for the machine goes on holding its turn while they wait
 * here, and for `HELD_MS` when they give up, as it does while a run waits for
 * its checkout (`runChecks`): left alone it stopped `HELD_MS` after it was
 * kept, and a suite that asked after them took the slot. Whoever has the
 * tree, waiting for the machine behind it, is let through, and so is whoever
 * has the checkout's lock while the tree's run waits for it: holding against
 * them would leave each waiting for the other. Anybody else behind it — a
 * shell's suite in the checkout — is not who it waits for, and waits its turn
 * (`holdKept`).
 */
async function takeTree(
  opts: { home: string; project: string; root: string; by?: string; signal?: AbortSignal },
  what: string,
  waitMs: number,
): ReturnType<typeof waitForRunLock> {
  const by = opts.by
  const tree = batchDir(opts.home, opts.project)
  const holding = by
    ? async (ms: number, held: LockHolder) =>
        holdKept(queueDir(opts.home), by, {
          waitingFor: [held, ...(await checkoutFor(opts, tree))],
          ms,
          now: Date.now,
        })
    : null
  const turn = await waitForRunLock(treeTurn(opts.home, opts.project), what, {
    waitMs,
    where: tree,
    ...(holding ? { meanwhile: (held: LockHolder) => holding(STILL_MS, held) } : {}),
  })
  // Gone because whoever asked has gone, there is nobody to hold it for.
  if ('held' in turn && holding && !opts.signal?.aborted) await holding(HELD_MS, turn.held)
  return turn
}

/**
 * Whoever has the checkout's lock, while the tree's run waits for it — which
 * only the tree's run does from the tree — or nobody.
 */
async function checkoutFor(
  opts: { home: string; project: string },
  tree: string,
): Promise<LockHolder[]> {
  const records = recordsDir(opts.home, opts.project, null)
  const queued = await waitingAhead(runQueueDir(records), null)
  if (!queued.some((one) => one.where === tree)) return []
  const held = await heldBy(records)
  return held ? [held] : []
}

function treeBusy(held: LockHolder, project: string): string {
  const since = held.at ? ` (since ${held.at})` : ''
  return `the full checks of ${project} are already running in its own tree: ${held.what || 'something'}${since}. Wait for them rather than starting a second run.`
}

/**
 * The full checks at `commit`, in the batch tree, recorded as the checkout's.
 *
 * The window's batch never waits (`waitMs` 0): one that would queue behind an
 * agent's run is a batch for the next look. An agent's `checks_run` without
 * `related`, in a shared checkout whose full checks are batched, comes here
 * too, with its own name as `by` and a wait: what it is about to push is HEAD,
 * and the checkout holds other agents' uncommitted files, which a run there
 * reads and goes red over.
 */
export async function runBatch(opts: {
  config: Config
  home: string
  /** $HOME, so a tail says `~`. */
  userHome: string
  project: string
  root: string
  commit: string
  /** Who asked: `batch` for the window's batch, a task for an agent's run. */
  by?: string
  only?: readonly string[]
  waitMs?: number
  signal?: AbortSignal
  onWait?: (ahead: Holders) => void
  onRun?: (run: CheckRun) => void
}): Promise<Batch> {
  const without = await nodeWithoutTypeScript({ root: opts.root, commit: opts.commit })
  if (without !== null) return { problem: without }
  const waitMs = opts.waitMs ?? 0
  const deadline = Date.now() + waitMs
  const turn = await takeTree(opts, `full checks at ${opts.commit.slice(0, 8)}`, waitMs)
  if ('held' in turn) return { problem: treeBusy(turn.held, opts.project), busy: true }
  try {
    const tree = await treeAt(opts)
    if ('problem' in tree) return tree
    const runs = await runProjectChecks({
      config: opts.config,
      project: opts.project,
      worktree: opts.root,
      runIn: tree.dir,
      commit: opts.commit,
      by: opts.by ?? BATCH_BY,
      home: opts.userHome,
      tadeHome: opts.home,
      waitMs: Math.max(0, deadline - Date.now()),
      ...(opts.only ? { only: opts.only } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onWait ? { onWait: opts.onWait } : {}),
      ...(opts.onRun ? { onRun: opts.onRun } : {}),
    })
    return { runs }
  } catch (err) {
    // Busy — somebody's run has the checkout or the machine — is the ordinary
    // case and the next look's to try again; anything else is said.
    if (err instanceof RunnerError) return { problem: err.message, busy: err.trouble === 'busy' }
    throw err
  } finally {
    await turn.release()
  }
}

/** One commit a batch covered: what it is, and whose by its trailer. */
export interface CoveredCommit {
  commit: string
  /** The `Tade-Task:` trailer: whose it is, read, never guessed. Null is unattributed. */
  task: string | null
  subject: string
}

/**
 * What a batch at HEAD covered: every commit since the last full run that was
 * green, oldest first, with that run's commit as the base. Where no green run
 * is an ancestor, the last `MOST_COVERED` and the commit before them, said.
 */
export async function coveredBy(opts: {
  config: Config
  home: string
  project: string
  root: string
  head: string
}): Promise<{ base: string | null; green: boolean; commits: CoveredCommit[]; cut: boolean }> {
  const read = await readChecks({
    name: opts.project,
    root: opts.root,
    test: opts.config.projects[opts.project]?.test_command,
    chosen: checksFor(opts.config, opts.project).run_here,
  })
  const plan = planFor(read.checks)
  const runs = followRenames(read.checks, await readRuns(recordsDir(opts.home, opts.project, null)))
  const tried = new Set<string>()
  let base: string | null = null
  for (const run of [...runs].reverse()) {
    if (run.commit === opts.head || tried.has(run.commit) || tried.size >= 20) continue
    tried.add(run.commit)
    if (rollup(plan, runs, run.commit).state !== 'pass') continue
    const ancestor = await git(
      opts.root,
      ['merge-base', '--is-ancestor', run.commit, opts.head],
      GIT_MS,
    )
    if (ancestor.ok) {
      base = run.commit
      break
    }
  }
  const range = base ? `${base}..${opts.head}` : opts.head
  const log = await git(
    opts.root,
    [
      'log',
      '--no-color',
      '--first-parent',
      '-n',
      String(MOST_COVERED + 1),
      '--format=%H%x00%(trailers:key=Tade-Task,valueonly,separator=%x2C)%x00%s%x00',
      range,
    ],
    GIT_MS,
  )
  const fields = log.ok ? log.stdout.split('\0') : []
  const commits: CoveredCommit[] = []
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const commit = (fields[i] ?? '').trim()
    if (!/^[0-9a-f]{40}$/.test(commit)) continue
    const task = (fields[i + 1] ?? '').split(',')[0]?.trim() ?? ''
    commits.push({ commit, task: task || null, subject: (fields[i + 2] ?? '').trim() })
  }
  commits.reverse()
  const green = base !== null
  const cut = !green && commits.length > MOST_COVERED
  if (!green && commits.length > 0) {
    // No green run to start from: the oldest listed is the base, unverified,
    // and the narrowing runs the failing tests there before it blames anyone.
    base = commits.shift()?.commit ?? null
  }
  return { base, green, commits, cut }
}

/** What runs again at each commit to narrow one failing check, or why nothing can. */
export function narrowingCommand(
  failed: CheckLog,
  checks: readonly Check[],
): { run: string; files: string[] } | { cannot: string } {
  const related = checks.find((check) => check.related)
  // What the record says failed, from all the run printed, before what its tail names.
  const files = [
    ...(failed.failing?.files ?? []),
    ...readOutcome(failed.tail, { places: 40 }).places.map((place) => place.path),
  ]
  const tests = testsIn(files)
  if (related && tests.length > 0) {
    return { run: `${related.run} ${tests.map(shellQuote).join(' ')}`, files: tests }
  }
  const check = checks.find((one) => one.id === failed.check)
  const seconds =
    failed.startedAt && failed.finishedAt
      ? (Date.parse(failed.finishedAt) - Date.parse(failed.startedAt)) / 1000
      : Number.POSITIVE_INFINITY
  // A cheap check runs again whole; the suite only by the tests that failed,
  // and where it named none — a coverage floor, a crash before any test — it
  // cannot be narrowed, which is said.
  if (check && seconds <= 120) return { run: check.run, files: [] }
  return {
    cannot: related
      ? `${failed.check} failed without naming a test that failed, so there is nothing to run again on its own`
      : `${failed.check} takes minutes and the project says no way to run part of it`,
  }
}

/** The test files among `paths`, each once, in the order first named. */
function testsIn(paths: readonly string[]): string[] {
  return [...new Set(paths.filter((path) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)))]
}

/** The test files a run's output names as failing, read from all of it. */
export function failingTestsIn(output: string): string[] {
  return testsIn(
    plain(output)
      .split('\n')
      .flatMap((line) => failingFileIn(line) ?? []),
  )
}

/** A narrowed red batch: what each commit said, whose it is, and every step taken. */
export interface Narrowed {
  narrowing: Narrowing
  culprit: Culprit
  steps: string[]
}

/**
 * Run `command` again at the commits a red batch covered, halving, until it is
 * clear whose commit broke it. Holds one of the machine's slots throughout:
 * these are the suite's own tests, and they starve the same way.
 */
export async function narrowRed(opts: {
  config: Config
  home: string
  project: string
  root: string
  base: string
  /** The base is where the full checks last passed, so the failing tests passed there too. */
  baseGreen: boolean
  commits: readonly string[]
  command: string
  /**
   * The tests the batch failed, which `command` runs again: a run that fails
   * a different set, or names none, means no commit can be named.
   */
  failing?: readonly string[]
  waitMs?: number
}): Promise<Narrowed> {
  let narrowing: Narrowing = {
    commits: [opts.base, ...opts.commits],
    tried: opts.baseGreen ? { [opts.base]: 'green' } : {},
    ...(opts.failing && opts.failing.length > 0 ? { failing: opts.failing } : {}),
  }
  const steps: string[] = []
  const waitMs = opts.waitMs ?? 30 * 60_000
  const deadline = Date.now() + waitMs
  // The tree before the machine, as every full run takes them, so two runs
  // never each hold one and wait for the other.
  const turn = await takeTree(opts, `narrowing a red batch of ${opts.project}`, waitMs)
  if ('held' in turn) {
    return {
      narrowing,
      culprit: {
        commit: null,
        because: 'the batch tree stayed in use, so nothing was run again',
      },
      steps,
    }
  }
  const slot = await waitForMachineSlot(
    opts.home,
    opts.config.checks.suites,
    { what: `narrowing a red batch of ${opts.project}`, where: batchDir(opts.home, opts.project) },
    { waitMs: Math.max(0, deadline - Date.now()) },
  ).catch(async (err: unknown) => {
    // Let go so the tree is not held for ever, and the machine's trouble is
    // still the one said, before the tree's own.
    await turn.release().catch((also: unknown) => {
      throw new Error(
        `${messageOf(err)}, and the batch tree could not be let go: ${messageOf(also)}`,
      )
    })
    throw err
  })
  if ('held' in slot) {
    await turn.release()
    return {
      narrowing,
      culprit: { commit: null, because: 'the machine stayed busy, so nothing was run again' },
      steps,
    }
  }
  try {
    for (let commit = nextToTry(narrowing); commit; commit = nextToTry(narrowing)) {
      const second = narrowing.tried[commit] !== undefined
      const where = `${commit.slice(0, 8)}${second ? ', a second time' : ''}`
      const tree = await treeAt({ ...opts, commit })
      if ('problem' in tree) {
        narrowing = withLook(narrowing, commit, { tried: 'cannot' })
        steps.push(`${where}: could not be checked out — ${tree.problem}`)
        continue
      }
      const ran = await runProgram('sh', ['-c', opts.command], {
        cwd: tree.dir,
        env: { ...process.env, [SLOT_ENV]: slot.path },
        timeoutMs: NARROW_MS,
      })
      const said: Tried =
        ran.timedOut || ran.missing || ran.code === 127
          ? 'cannot'
          : ran.code === 0
            ? 'green'
            : 'red'
      const named = said === 'red' ? failingTestsIn(`${ran.stdout}\n${ran.stderr}`) : []
      narrowing = withLook(narrowing, commit, {
        tried: said,
        ...(named.length > 0 ? { named } : {}),
      })
      steps.push(
        `${where}: ${said === 'green' ? 'passed' : said === 'red' ? `failed${named.length > 0 ? ` (${named.join(', ')})` : ''}` : `could not run (${ran.timedOut ? 'out of time' : lastLine(ran.stderr)})`}`,
      )
    }
  } finally {
    await slot.release()
    await turn.release()
  }
  return { narrowing, culprit: culpritOf(narrowing), steps }
}

/** What the last setup was run for; null where it never ran here. */
async function stampOf(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

function lastLine(text: string): string {
  return text.trim().split('\n').at(-1) ?? ''
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
