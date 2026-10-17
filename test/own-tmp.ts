import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { opendir, rm } from 'node:fs/promises'
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

export interface OwnTmp {
  /** This run's root. `TMPDIR` and `TMUX_TMPDIR` point at it until `done`. */
  root: string
  /**
   * Put the environment back and remove the root, then for a guarded run
   * throw when anything new is left in the temp folders.
   */
  done(): Promise<void>
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
  const was = { TMPDIR: opts.env.TMPDIR, TMUX_TMPDIR: opts.env.TMUX_TMPDIR }
  opts.env.TMPDIR = root
  opts.env.TMUX_TMPDIR = root
  return {
    root,
    done: async () => {
      for (const [key, value] of Object.entries(was)) {
        if (value === undefined) delete opts.env[key]
        else opts.env[key] = value
      }
      const kept = removeRoot(root)
      if (kept && !before) say(`\n${kept}\n`)
      if (!before) return
      if (kept) throw new Error(kept)
      const left = await leftBehind(before, await lookAt(watched), opts.settleMs)
      if (left.length > 0) throw new Error(leftSaid(left, watched))
    },
  }
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
