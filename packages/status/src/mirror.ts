import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { mirrorRef, runProgram } from '@tade/core'
import { git } from './git.ts'

// The mirror (REMOTE-TADE.md §9.3): another machine's branches in one of this
// machine's projects, kept in this home (`mirrorDir`) and read by the forecast,
// the landing desk and the patch reader. The rules are core's `elsewhere.ts`.
//
// **A bare repository that borrows the checkout's objects as alternates**, so
// it costs only what the other machine added: everything both already have —
// the base's whole history, nearly always — is read out of the checkout's own
// object store, and git's fetch tells the far side it has it. Each machine's
// branches are under a namespace of their own (`refs/remotes/<machine>/*`), so
// several machines are one mirror and a branch called `main` on two of them is
// two refs.
//
// **Nothing is ever written into the person's checkout.** Alternates are read
// and never written through; the fetch, its pack and its refs are the
// mirror's; and `git merge-tree` run here writes its trees here. The one thing
// asked of the checkout is where its objects are. What that costs is a mirror
// that can go wrong under it: a checkout that gc'd away an object a mirror's
// branch was built on leaves the mirror reading a hole. The mirror is derived
// and always safe to delete, so a fetch git refuses for a missing object makes
// it again from nothing, once, rather than leave it broken.
//
// What git says is answered, never thrown: each answer is the work done, or
// the sentence why not. A folder this machine could not look at throws.

/** How long one fetch may take: a first fetch of a busy branch over a slow link. */
export const FETCH_MS = 120_000

/** What makes a refspec's namespace: a machine's name, as `remotes.<name>` allows it. */
const MACHINE = /^[a-z0-9][a-z0-9-]{0,23}$/

/** What git says when an object the mirror leans on is not there to lean on. */
const HOLE =
  /missing|bad object|(unable to|could not) read|did not send all necessary objects|corrupt|could not parse|failed to traverse|revision walk setup failed/i

/** Whether a repository is there yet: no `HEAD` is none, and a folder that could not be looked at throws. */
async function isRepository(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, 'HEAD'))).isFile()
  } catch (err) {
    if (missing(err)) return false
    throw err
  }
}

/** A file's text, or empty where there is no such file yet; any other failure throws. */
async function textOf(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if (missing(err)) return ''
    throw err
  }
}

function missing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The mirror, made where there is none and pointed at the checkout's objects
 * wherever it is now: null when it is ready, or why it could not be.
 */
export async function readyMirror(mirror: string, checkout: string): Promise<string | null> {
  const common = await git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const where = common.stdout.trim()
  if (!common.ok || !isAbsolute(where)) {
    return `${checkout} is not a checkout git can read: ${common.stderr.split('\n')[0] || 'no answer'}`
  }
  try {
    if (!(await isRepository(mirror))) {
      await mkdir(mirror, { recursive: true })
      const made = await git(mirror, ['init', '--bare', '--quiet'])
      if (!made.ok) return `could not make a mirror: ${made.stderr.split('\n')[0] || 'no answer'}`
    }
    const alternates = join(mirror, 'objects', 'info', 'alternates')
    const objects = `${resolve(where, 'objects')}\n`
    const was = await textOf(alternates)
    if (was !== objects) {
      await mkdir(join(mirror, 'objects', 'info'), { recursive: true })
      await writeFile(alternates, objects)
    }
    return null
  } catch (err) {
    return `could not make a mirror: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** Where git here fetches a machine's repository from, and what it is run with (`RepositoryThere`). */
export interface FetchFrom {
  url: string
  env: Readonly<Record<string, string>>
}

/**
 * Every branch a machine has in one repository, fetched into the mirror under
 * that machine's namespace, and what has gone there gone here too: null when
 * it was, or why not. A mirror git finds a hole in is made again and fetched
 * into once more.
 */
export async function fetchMirror(
  mirror: string,
  checkout: string,
  machine: string,
  from: FetchFrom,
  timeoutMs = FETCH_MS,
): Promise<string | null> {
  if (!MACHINE.test(machine)) return `${JSON.stringify(machine)} is not a machine's name`
  const first = await fetchOnce(mirror, checkout, machine, from, timeoutMs)
  if (first !== null && !HOLE.test(first)) return first
  // A fetch that worked can still stand on a hole: git takes the other side's
  // word that the mirror has what its refs are built on, and the object may
  // have been the checkout's. So what the mirror must hold itself is walked.
  if (first === null && (await whole(mirror, machine))) return null
  await rm(mirror, { recursive: true, force: true })
  return fetchOnce(mirror, checkout, machine, from, timeoutMs)
}

/**
 * Whether everything a machine's branches are built on is there to read:
 * every object reachable from them and not from the checkout's own refs —
 * which is only what that machine added, so the walk costs what the fetch did.
 */
async function whole(mirror: string, machine: string): Promise<boolean> {
  const walked = await git(
    mirror,
    [
      'rev-list',
      '--quiet',
      '--objects',
      `--glob=${mirrorRef(machine, '*')}`,
      '--not',
      '--alternate-refs',
    ],
    FETCH_MS,
  )
  return walked.ok || !HOLE.test(walked.stderr)
}

async function fetchOnce(
  mirror: string,
  checkout: string,
  machine: string,
  from: FetchFrom,
  timeoutMs: number,
): Promise<string | null> {
  const ready = await readyMirror(mirror, checkout)
  if (ready !== null) return ready
  const ran = await runProgram(
    'git',
    [
      '-C',
      mirror,
      // Nothing left running behind the fetch: no gc, no maintenance of its own.
      '-c',
      'gc.auto=0',
      '-c',
      'maintenance.auto=false',
      'fetch',
      '--quiet',
      '--no-tags',
      '--prune',
      '--no-write-fetch-head',
      from.url,
      `+refs/heads/*:${mirrorRef(machine, '*')}`,
    ],
    {
      timeoutMs,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...from.env },
    },
  )
  if (ran.missing) return 'there is no git on this machine'
  if (ran.timedOut) return `fetching from ${machine} did not finish in ${timeoutMs / 1000}s`
  if (ran.code === 0) {
    // The trees the forecast's merges write here are loose and nobody's: git's
    // own threshold packs and prunes them, in the foreground, never past us.
    await git(mirror, ['-c', 'gc.autoDetach=false', 'gc', '--auto', '--quiet'], FETCH_MS)
    return null
  }
  // git's own reason is its first `fatal:` or `error:`; what follows it is advice.
  const said = ran.stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const why = said.find((line) => /^(fatal|error):/.test(line)) ?? said[0]
  return why?.replace(/^(fatal|error):\s*/, '').slice(0, 300) || `git fetch exited ${ran.code}`
}

/**
 * The commit each of a machine's branches is on in the mirror, by ref — every
 * machine's where none is named — or null where git could not say, which is
 * never the same as none: a mirror nothing was fetched into answers an empty map.
 */
export async function mirrorHeads(
  mirror: string,
  machine?: string,
): Promise<Map<string, string> | null> {
  if (!(await isRepository(mirror))) return new Map()
  const out = await git(mirror, [
    'for-each-ref',
    '--format=%(objectname) %(refname)',
    machine === undefined ? 'refs/remotes/' : mirrorRef(machine, ''),
  ])
  if (!out.ok) return null
  const heads = new Map<string, string>()
  for (const line of out.stdout.split('\n')) {
    const [oid, ref] = line.split(' ')
    if (oid && ref) heads.set(ref, oid)
  }
  return heads
}

/**
 * Where a branch's work is measured from in the mirror: where it left its
 * base, as `git merge-base` finds it — so what landed on the base since is not
 * counted as the branch's — or null where the base is not there to ask.
 */
async function sinceBase(mirror: string, base: string, head: string): Promise<string | null> {
  const found = await git(mirror, ['merge-base', base, head])
  return found.ok ? found.stdout.trim() || null : null
}

/**
 * The files a branch in the mirror changed since it left its base, sorted, or
 * null where git could not say — never an empty list for that.
 */
export async function mirrorChanged(
  mirror: string,
  base: string,
  head: string,
): Promise<string[] | null> {
  const from = await sinceBase(mirror, base, head)
  if (from === null) return null
  const out = await git(mirror, ['diff', '--name-only', '-z', from, head])
  if (!out.ok) return null
  return out.stdout.split('\0').filter(Boolean).sort()
}

/** One file's diff on a branch in the mirror, since it left its base; null where git could not say. */
export async function mirrorDiff(
  mirror: string,
  base: string,
  head: string,
  path: string,
): Promise<string | null> {
  const from = await sinceBase(mirror, base, head)
  if (from === null) return null
  const out = await git(mirror, ['diff', '--no-color', '-U3', from, head, '--', path])
  return out.ok ? out.stdout : null
}
