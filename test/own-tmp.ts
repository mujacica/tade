import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { opendir, rm } from 'node:fs/promises'
import { constants } from 'node:os'
import { basename, join } from 'node:path'

// Each suite run has a temp root of its own, and the root goes when the run
// ends.
//
// Nearly every test makes a real git repository, a home, a socket folder or a
// session store under `os.tmpdir()`, and almost none of them took it away
// again: 2.78 million folders and 55–90 GB in nine days on one laptop, about
// 300,000 a day, `tade-repo-*` alone 610,000 of them and 46 GB. Teaching eight
// hundred `mkdtemp` calls to clean up after themselves would be a promise
// every new test has to keep. Moving the place they all write to takes one
// line that none of them can forget. So the suite's `globalSetup`
// (`test/one-suite.ts`) points `TMPDIR` at a fresh root before vitest forks a
// worker (it builds each worker's environment from `process.env` after
// `globalSetup`, and `own-tmp.test.ts` holds that), every `os.tmpdir()` in the
// workers and in what they start lands under it, and teardown removes it.
//
// - **Short, and in `/tmp`.** A Unix socket path is capped near 104 bytes on
//   macOS, and the suite makes plenty: ssh control sockets, runtime folders,
//   pi's RPC. `/tmp/tade-suite-<pid>-XXXXXX` is 30 bytes resolved, against
//   57 for macOS's own `/var/folders/…/T`, so every path a test builds gets
//   shorter. Where `/tmp` cannot be written, it is the real temp folder.
// - **tmux's too** (`TMUX_TMPDIR`). tmux does not read `TMPDIR`, so the
//   servers the tests start put their sockets in `/tmp/tmux-<uid>`. A server
//   that is killed leaves its socket there, which had added up to 1,813 of them.
//   A server still running when the root goes would run on with no socket for
//   anything to reach it by, so each one under the root is stopped first
//   (`stopServersUnder`) and named, since a test should have stopped it.
// - **And Tade's runtime folder** (`TADE_RUNTIME_DIR`, `runtimeDir`), where a
//   home's sockets go. On Linux that is `XDG_RUNTIME_DIR` otherwise, outside
//   the root, and `systemctl --user` reads that one to find the user's
//   manager, so it is left alone.
// - **A run ended by a signal never reaches its teardown** — ctrl+c, a
//   shell's timeout, a terminal closed — so SIGINT, SIGTERM and SIGHUP take the
//   root away before the run exits (`onEnding`), once everything the run
//   started has ended (`endWhatItStarted`), so nothing writes there after.
// - **A run that was killed leaves its root**, so every run starts by removing
//   any root older than `STALE_MS` whose suite is gone (`sweepRoots`). The
//   suite's pid is in the root's name.
// - **A full run must leave the temp folder as it found it** (`leftBehind`):
//   nothing new under a name this repository makes, in the real temp folder
//   or in `/tmp`, which is where a child started without `TMPDIR` writes. A
//   run that leaves something there fails and names each entry, by its prefix.

/** What every root's name starts with, before the suite's pid. */
export const ROOT = 'tade-suite-'

/** A root's name: `tade-suite-<pid>-` and mkdtemp's six. */
const ROOT_NAME = /^tade-suite-(\d+)-[A-Za-z0-9]{6}$/

/**
 * How old a root has to be before somebody else's run removes it. The suite's
 * pid has to be gone as well. Hours, because the age is only the second test
 * and is there for a pid that cannot be asked, such as one from another
 * machine sharing `/tmp`. A live run writes into its root all the time, so
 * the root's age is how long since anything did.
 */
export const STALE_MS = 3 * 60 * 60_000

/**
 * The names this repository's own code gives what it makes in a temp folder:
 * every prefix handed to `tmp()` or `mkdtemp` starts with one of these, and
 * `own-tmp.test.ts` fails when a new one does not. They are exact where a
 * word is shared. Real pi makes `pi-editor-` and `pi-share-` in the temp
 * folder, and any MCP server may make an `mcp-` one, so either of those, made
 * by an agent working beside the suite, would turn the run red.
 */
export const GUARDED = [
  'tade',
  'tcc-',
  'tcx-',
  'tacp',
  'tsd-',
  'mcp-broker-',
  'mcp-cache-',
  'mcp-off-',
  'mcp-standing-',
  'pi-agent-',
  'pi-cwd-',
  'pi-flat-',
  'pi-home-',
  'pi-link-',
  'pi-sessions-',
  'wd-',
  'wl-',
  'wr-',
  'wx-',
] as const

/**
 * What a Tade window keeps in the temp folder while it is open, or longer: a
 * tmux driver's lane output (`tade-tmux-`), a picture pasted from the
 * clipboard (`tade-clipboard-`), and a home's socket folder (`tade-` and eight
 * hex). A window opened beside the suite makes them, and there is nearly
 * always one. The suite's own go under its root with everything else, and a
 * test process that ignored `TMPDIR` would leave a hundred fixtures' names
 * here as well, so passing these over costs the guard nothing.
 */
const A_WINDOWS = /^tade-(tmux-|clipboard-|[0-9a-f]{8}$)/

/** How long an entry that looks left behind is given to go: something mid-flight beside the suite. */
export const SETTLE_MS = 2_000

/** Whether a name in a temp folder is one this guard answers for. */
export function guarded(name: string): boolean {
  return (
    GUARDED.some((prefix) => name.startsWith(prefix)) &&
    !ROOT_NAME.test(name) &&
    !A_WINDOWS.test(name)
  )
}

/** Whether a pid is still there. EPERM is somebody else's process, which counts. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Remove the roots in `base` that runs killed before their teardown left:
 * older than `STALE_MS`, and their suite gone. Answers what it removed. A root
 * that cannot be read or removed stays for the next run, and that is said.
 */
export async function sweepRoots(
  base: string,
  now: number,
  say: (line: string) => void = () => {},
): Promise<string[]> {
  const removed: string[] = []
  for (const name of await namesIn(base, (one) => ROOT_NAME.test(one))) {
    const pid = Number(ROOT_NAME.exec(name)?.[1])
    const root = join(base, name)
    try {
      if (now - statSync(root).mtimeMs < STALE_MS || alive(pid)) continue
      await rm(root, { recursive: true, force: true, maxRetries: 3 })
      removed.push(root)
    } catch (err) {
      say(`\nCould not remove ${root}, a temp root an earlier suite left: ${String(err)}\n`)
    }
  }
  return removed
}

/**
 * The names in one folder that pass `keep`, read a page at a time, since a
 * folder this suite once filled had millions. A folder that does not exist has
 * none.
 */
async function namesIn(dir: string, keep: (name: string) => boolean): Promise<string[]> {
  const names: string[] = []
  try {
    for await (const entry of await opendir(dir, { bufferSize: 1024 })) {
      if (keep(entry.name)) names.push(entry.name)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  return names
}

/** What is in each watched folder under a guarded name, by folder. */
export async function lookAt(dirs: readonly string[]): Promise<Map<string, Set<string>>> {
  const seen = new Map<string, Set<string>>()
  for (const dir of dirs) seen.set(dir, new Set(await namesIn(dir, guarded)))
  return seen
}

/**
 * What the run left: each path that is in `after` and was not in `before`,
 * and was still there `settleMs` later.
 */
export async function leftBehind(
  before: Map<string, Set<string>>,
  after: Map<string, Set<string>>,
  settleMs = SETTLE_MS,
): Promise<string[]> {
  const fresh: string[] = []
  for (const [dir, names] of after) {
    const had = before.get(dir) ?? new Set()
    for (const name of names) if (!had.has(name)) fresh.push(join(dir, name))
  }
  if (fresh.length === 0) return []
  await new Promise((done) => setTimeout(done, settleMs))
  return fresh.filter((path) => {
    try {
      statSync(path)
      return true
    } catch {
      return false
    }
  })
}

/**
 * The prefix a name was made with: mkdtemp's six characters off the end, so
 * it is the string to search the code for. A name with no such tail is its own
 * prefix.
 */
export function prefixOf(name: string): string {
  return /^(.+[-_. ])[A-Za-z0-9]{6}$/.exec(name)?.[1] ?? name
}

/** The failure, naming every entry the run left under the prefix it was made with. */
export function leftSaid(left: readonly string[], dirs: readonly string[]): string {
  const byPrefix = new Map<string, string[]>()
  for (const path of [...left].sort()) {
    const prefix = prefixOf(basename(path))
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), path])
  }
  const most = 5
  const rows = [...byPrefix]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([prefix, paths]) => {
      const shown = paths.slice(0, most).join(', ')
      const more = paths.length > most ? `, and ${paths.length - most} more` : ''
      return `  ${prefix}*  ${paths.length}: ${shown}${more}`
    })
  const things = left.length === 1 ? '1 thing' : `${left.length} things`
  return [
    `This suite left ${things} in ${dirs.join(' and ')}, which it must leave as it found it:`,
    ...rows,
    'Everything a test makes belongs under the suite’s own temp root (TMPDIR, test/own-tmp.ts), which is taken away at the end.',
    'Something here did not use it. Most likely a child was started with an environment of its own and no TMPDIR, so it wrote to /tmp,',
    'or a path was built from somewhere other than os.tmpdir(). Search the code for the prefix to find what made it.',
  ].join('\n')
}

/** What `ownTmp` points at the root: the temp folder, tmux's, and Tade's runtime folder. */
export const POINTED = ['TMPDIR', 'TMUX_TMPDIR', 'TADE_RUNTIME_DIR'] as const

export interface OwnTmp {
  /** This run's root. Each of `POINTED` points at it until `done`. */
  root: string
  /**
   * Put the environment back and remove the root, then for a guarded run
   * throw when anything new is left in the temp folders.
   */
  done(): Promise<void>
  /**
   * Remove the root now, at once and without looking at anything else: a run
   * that is ending before its teardown. Safe to call twice, and before `done`.
   */
  abandon(): void
}

/**
 * Give this run a temp root of its own, in `env`. When `guard` is set,
 * remember what the temp folders hold, so `done` can say what the run left in
 * them.
 */
export async function ownTmp(opts: {
  env: NodeJS.ProcessEnv
  guard: boolean
  say?: (line: string) => void
  now?: number
  /** Where roots go: `/tmp` when it can be written. */
  base?: string
  /** The folders the guard looks at: the real temp folder and `/tmp`. */
  watch?: readonly string[]
  settleMs?: number
}): Promise<OwnTmp> {
  const say = opts.say ?? (() => {})
  // What `os.tmpdir()` answers, from the environment it would read.
  const real = (opts.env.TMPDIR || '/tmp').replace(/(.)\/+$/, '$1')
  const watched = opts.watch ?? [...new Set([real, '/tmp'])]
  const made = makeRoot(opts.base ? [opts.base] : ['/tmp', real])
  await sweepRoots(made.base, opts.now ?? Date.now(), say)
  const before = opts.guard ? await lookAt(watched) : null
  const { root } = made
  const was = Object.fromEntries(POINTED.map((key) => [key, opts.env[key]]))
  for (const key of POINTED) opts.env[key] = root
  // Once, whichever comes first: the end of the run, or a signal before it.
  let kept: string | null | undefined
  const takeAway = (): string | null => {
    if (kept === undefined) {
      try {
        const stopped = stopServersUnder(root)
        if (stopped.length > 0) say(`\n${serversSaid(stopped)}\n`)
      } catch (err) {
        say(`\nCould not look for tmux servers under ${root}: ${String(err)}\n`)
      }
      kept = removeRoot(root)
    }
    return kept
  }
  return {
    root,
    abandon: () => {
      const why = takeAway()
      if (why) say(`\n${why}\n`)
    },
    done: async () => {
      for (const [key, value] of Object.entries(was)) {
        if (value === undefined) delete opts.env[key]
        else opts.env[key] = value
      }
      const why = takeAway()
      if (why && !before) say(`\n${why}\n`)
      if (!before) return
      if (why) throw new Error(why)
      const left = await leftBehind(before, await lookAt(watched), opts.settleMs)
      if (left.length > 0) throw new Error(leftSaid(left, watched))
    },
  }
}

/** The signals that end a run before its teardown: ctrl+c, a shell's timeout or `kill`, a terminal closed. */
export const ENDINGS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const

/**
 * How long a signalled run has to exit by itself before `onEnding` ends it:
 * short, because vitest starts another worker for a file whose worker died,
 * and one started now would find no root.
 */
export const EXIT_MS = 20

/**
 * Call `takeAway` when one of `ENDINGS` arrives, then end the run the way that
 * signal ends it, and answer how to stop listening.
 *
 * Synchronously, because vitest exits on SIGINT and SIGTERM by itself a
 * millisecond later; nothing exits on SIGHUP but this, which is what the timer
 * is for. The exit status is the signal's, as Node's own would be, whatever a
 * worker ended under it made vitest set. A second signal finds nobody
 * listening and ends the process where it stands.
 */
export function onEnding(takeAway: () => void, proc: NodeJS.Process = process): () => void {
  const ended = (signal: NodeJS.Signals) => {
    off()
    const status = 128 + (constants.signals[signal] ?? 0)
    try {
      takeAway()
    } finally {
      proc.exitCode = status
      setTimeout(() => proc.exit(status), EXIT_MS).unref()
    }
  }
  const off = () => {
    for (const signal of ENDINGS) proc.off(signal, ended)
  }
  for (const signal of ENDINGS) proc.on(signal, ended)
  return off
}

/**
 * Kill every process `pid` started, and every process those started, and
 * answer which. Synchronous, for a signal's handler.
 *
 * A signal sent to the suite's own process alone — `kill`, a shell's timeout —
 * leaves vitest's workers running tests after the suite has gone, and a tmux a
 * test starts then, finding its `TMUX_TMPDIR` gone with the root, makes its
 * socket in `/tmp` instead and outlives everything. So a run that is ending
 * ends its whole tree first, at once, since nothing in it has anything left to
 * finish. What has already left the tree, as a tmux server has, is
 * `stopServersUnder`'s.
 */
export function endWhatItStarted(pid = process.pid): number[] {
  const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: TMUX_MS })
  if (listed.status !== 0) {
    throw new Error(`ps could not list processes: ${listed.error?.message ?? listed.stderr}`)
  }
  const children = new Map<number, number[]>()
  for (const line of listed.stdout.split('\n')) {
    const [one, parent] = line.trim().split(/\s+/).map(Number)
    if (one === undefined || parent === undefined || one === listed.pid) continue
    children.set(parent, [...(children.get(parent) ?? []), one])
  }
  const tree: number[] = []
  const walk = (from: number) => {
    for (const one of children.get(from) ?? []) {
      if (one === process.pid || tree.includes(one)) continue
      tree.push(one)
      walk(one)
    }
  }
  walk(pid)
  for (const one of tree) {
    try {
      process.kill(one, 'SIGKILL')
    } catch {
      // Ended by itself since the listing.
    }
  }
  return tree
}

/** A tmux server `stopServersUnder` stopped: its socket's name and its sessions'. */
export interface Stopped {
  socket: string
  sessions: string[]
}

/** How long one tmux command may take here. */
const TMUX_MS = 5_000

/**
 * Stop every tmux server whose socket is under `root`, and answer which. Only
 * one answering is stopped: a server that ended leaves its socket behind.
 * Synchronous, because a signal's handler has no later.
 */
export function stopServersUnder(root: string): Stopped[] {
  const dir = join(root, `tmux-${process.getuid?.() ?? 0}`)
  let sockets: string[]
  try {
    sockets = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isSocket())
      .map((entry) => entry.name)
  } catch (err) {
    // No test started a tmux server.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const stopped: Stopped[] = []
  for (const socket of sockets) {
    const at = join(dir, socket)
    const sessions = tmux(['-S', at, 'list-sessions', '-F', '#{session_name}'])
    if (sessions === null) continue
    tmux(['-S', at, 'kill-server'])
    stopped.push({ socket, sessions })
  }
  return stopped
}

/** What a tmux command printed, a line each, or null where it failed: no server there, or no tmux. */
function tmux(args: string[]): string[] | null {
  const ran = spawnSync('tmux', args, {
    encoding: 'utf8',
    timeout: TMUX_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return ran.status === 0 ? ran.stdout.split('\n').filter(Boolean) : null
}

/** The servers that had to be stopped, by socket, with the sessions that say which test left each. */
export function serversSaid(stopped: readonly Stopped[]): string {
  const most = 3
  const rows = stopped.map(({ socket, sessions }) => {
    const more = sessions.length > most ? `, and ${sessions.length - most} more` : ''
    return `  tmux -L ${socket}: ${sessions.slice(0, most).join(', ') || 'no sessions'}${more}`
  })
  const servers = stopped.length === 1 ? 'a tmux server' : `${stopped.length} tmux servers`
  return [
    `This suite stopped ${servers} its tests left running, which would have run on with no socket once its temp root went:`,
    ...rows,
    'A test that starts a tmux server has to kill it when it is done. The sessions say which test it was.',
  ].join('\n')
}

/**
 * Remove a root, or say why it is still there. Retried, because a process a
 * test started can still be writing in it as the run ends. A folder a test
 * made unwritable and never gave back is made writable again so its contents
 * can go.
 */
export function removeRoot(root: string): string | null {
  const remove = () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  try {
    remove()
    return null
  } catch (first) {
    try {
      writable(root)
      remove()
      return null
    } catch (err) {
      return `This suite's temp root ${root} could not be removed (${String(err)}, after ${String(first)}).`
    }
  }
}

/** Every folder under `dir` made writable by its owner, so what is in it can be removed. */
function writable(dir: string): void {
  chmodSync(dir, 0o700)
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) writable(join(dir, entry.name))
  }
}

/** The first of `bases` a root can be made in, and the root. */
function makeRoot(bases: readonly string[]): { base: string; root: string } {
  let last: unknown = null
  for (const base of bases) {
    try {
      return { base, root: mkdtempSync(join(base, `${ROOT}${process.pid}-`)) }
    } catch (err) {
      last = err
    }
  }
  throw new Error(`no temp root could be made in ${bases.join(' or ')}: ${String(last)}`)
}
