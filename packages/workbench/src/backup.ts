import { randomBytes } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join, relative } from 'node:path'
import {
  agentUsers,
  BACKUP_TAG,
  type BackupError,
  type BackupManifest,
  type BackupSummary,
  backupSaid,
  type Config,
  expandHome,
  MANIFEST,
  manifestOf,
  type ProjectKept,
  passwordFor,
  type RecordsFolder,
  type RunResult,
  resticBackup,
  runProgram,
  type SnapshotKept,
  snapshotsSaid,
} from '@tade/core'
import { homeOf, ownUser } from './agent-user.ts'
import { HARNESS_ADAPTERS } from './harnesses.ts'
import { runningVersion } from './programs.ts'

// A backup of this machine's Tade, and putting one back: the half of
// `tade host backup` and `tade host restore` that runs things. What is kept
// and why, the arguments and the words are `@tade/core`'s `backup.ts`.
//
// It never opens the workbench: a backup runs beside the window or the
// service that holds the home, from a timer, and reads files as they are. The
// journal is append-only, so the worst a backup taken mid-write holds is one
// torn last line — which a restore cuts off (`cutTornTail`), because the next
// line appended to it would be torn too.

/** How restic is run: its arguments, and what is added to the environment it inherits. */
export type Restic = (args: readonly string[], env: Record<string, string>) => Promise<RunResult>

/** restic as a child of this process, waited on as long as it takes — a first backup is gigabytes. */
export const restic: Restic = (args, env) =>
  runProgram('restic', args, { env: { ...process.env, ...env }, timeoutMs: 0 })

/** What every backup and restore is handed. */
export interface BackupPlace {
  config: Config
  home: string
  env?: Readonly<Record<string, string | undefined>>
  restic?: Restic
  /**
   * Somebody is at the terminal restic runs in, so with no password set it
   * asks for one itself — a restore on a new machine, whose config is the
   * thing being restored.
   */
  asks?: boolean
}

/** Whether a failed look means only that nothing is there. Anything else is thrown. */
function nothingThere(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** `fallback` where nothing is there, and the error thrown on otherwise. */
function orIfNothing<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (nothingThere(err)) return fallback
    throw err
  }
}

/** Whether something is at a path, without following a link to it. */
async function there(path: string): Promise<boolean> {
  return lstat(path).then(() => true, orIfNothing(false))
}

/** Take away a folder that is empty, and leave one that is not: what is in it is said elsewhere. */
async function rmdirIfEmpty(folder: string): Promise<void> {
  await rmdir(folder).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST' || nothingThere(err)) return
    throw err
  })
}

/**
 * Where each harness would keep its agents' conversations on this machine,
 * for Tade's own user and each user its agents run as (`agentUsers`), whether
 * or not the folder is there yet. Every registered harness is asked, not only
 * the ones in use: one used last month still holds the conversations of the
 * tasks it ran. Asking makes an adapter and nothing else — no I/O in a
 * constructor — and a user the config names and this machine has not got
 * keeps nothing here.
 */
export async function recordsFolders(place: BackupPlace): Promise<RecordsFolder[]> {
  const users: (string | null)[] = [null, ...agentUsers(place.config, ownUser())]
  const all: RecordsFolder[] = []
  for (const user of users) {
    const home = user === null ? undefined : await homeOf(user)
    if (user !== null && !home) continue
    for (const [harness, make] of Object.entries(HARNESS_ADAPTERS)) {
      const adapter = make({
        runDir: join(place.home, 'runs'),
        socketDir: join(place.home, 'runs'),
        approvals: 'bypass',
        ...(user !== null && home ? { user, home } : {}),
      })
      for (const path of adapter.records?.() ?? []) all.push({ harness, user, path })
    }
  }
  return all
}

/** The records folders that are there: what a backup reads beside the home. */
export async function recordsHere(place: BackupPlace): Promise<RecordsFolder[]> {
  const found: RecordsFolder[] = []
  for (const one of await recordsFolders(place)) if (await there(one.path)) found.push(one)
  return found
}

/** git, answering its output or nothing. */
async function git(cwd: string, args: readonly string[]): Promise<string | null> {
  const ran = await runProgram('git', ['-C', cwd, ...args], { timeoutMs: 30_000 })
  return ran.code === 0 ? ran.stdout : null
}

/** Each project with where it is cloned from, so a restore elsewhere can say how to clone it. */
export async function projectsKept(config: Config): Promise<ProjectKept[]> {
  const kept: ProjectKept[] = []
  for (const [name, project] of Object.entries(config.projects).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const root = expandHome(project.root)
    const origin = (await git(root, ['remote', 'get-url', 'origin']))?.trim()
    const first = origin ? null : ((await git(root, ['remote']))?.split('\n').find(Boolean) ?? null)
    const remote =
      origin || (first ? ((await git(root, ['remote', 'get-url', first]))?.trim() ?? null) : null)
    kept.push({ name, root, remote: remote || null })
  }
  return kept
}

/** Work a backup does not hold: a checkout or worktree with commits on no remote, or changes not committed. */
export interface NotPushed {
  project: string
  path: string
  branch: string | null
  /** Commits on no remote; null where git could not say. */
  ahead: number | null
  /** Changes to tracked files that are not committed. */
  changed: boolean
}

/**
 * Every checkout and worktree of every project whose work is on this machine
 * alone — the one thing a backup cannot give back, said where it is taken.
 * Read out of git (`worktree list`, `rev-list --not --remotes`, `status`),
 * never out of Tade's records of which task is where.
 */
export async function notPushed(config: Config): Promise<NotPushed[]> {
  const out: NotPushed[] = []
  for (const [name, project] of Object.entries(config.projects).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const root = expandHome(project.root)
    const listed = await git(root, ['worktree', 'list', '--porcelain', '-z'])
    if (listed === null) continue
    const trees: { path: string; branch: string | null }[] = []
    for (const block of listed.split('\0\0')) {
      const lines = block.split('\0')
      const path = lines.find((line) => line.startsWith('worktree '))?.slice(9)
      if (!path || lines.includes('bare') || lines.includes('prunable')) continue
      const ref = lines.find((line) => line.startsWith('branch '))?.slice(7) ?? null
      trees.push({ path, branch: ref ? ref.replace(/^refs\/heads\//, '') : null })
    }
    for (const tree of trees) {
      if (!existsSync(tree.path)) continue
      const count = await git(tree.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
      const status = await git(tree.path, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=no',
      ])
      const ahead = count === null ? null : Number.parseInt(count.trim(), 10)
      const changed = status !== null && status.length > 0
      if ((ahead ?? 0) > 0 || changed) out.push({ project: name, ...tree, ahead, changed })
    }
  }
  return out
}

/** Where the repository is and how to open it, or why a backup cannot be taken. */
function repositoryOf(
  place: BackupPlace,
): { env: Record<string, string>; repository: string; from: string } | string {
  const repository = place.config.backup.repository.trim()
  if (repository === '') {
    return 'There is nowhere to back up to: `tade host backup --init <repository>` names one — a folder, `sftp:user@host:/path`, `s3:…` — and makes its password.'
  }
  const password = passwordFor(place.env ?? process.env, place.config.backup.password)
  if (password === null) {
    return `${repository} has no password here: backup.password in the config, or $RESTIC_PASSWORD.`
  }
  return {
    repository,
    from: password.from,
    env: { RESTIC_REPOSITORY: repository, ...password.env },
  }
}

/** restic's own last words, for a failure: the end of what it said on standard error. */
function lastSaid(ran: RunResult): string {
  if (ran.missing) return 'restic is not installed here — `tade update` says how to install it'
  const lines = ran.stderr.trim().split('\n').filter(Boolean)
  return lines.slice(-3).join(' ') || `restic exited ${ran.code}`
}

/** Make the repository, once, with the password the config or the environment holds. */
export async function initRepository(place: BackupPlace): Promise<{ ok: boolean; said: string }> {
  const repo = repositoryOf(place)
  if (typeof repo === 'string') return { ok: false, said: repo }
  const ran = await (place.restic ?? restic)(['init'], repo.env)
  return ran.code === 0 ? { ok: true, said: '' } : { ok: false, said: lastSaid(ran) }
}

/** What one backup came to. */
export interface BackupTaken {
  /** Whether a snapshot was made: restic's 0, or its 3 — made, with files it could not read. */
  ok: boolean
  summary: BackupSummary | null
  /** Files it could not read, by restic's own words. */
  errors: BackupError[]
  /** Why there is no snapshot, where there is none. */
  said: string
  manifest: BackupManifest | null
}

/**
 * Write the manifest into the home, then hand restic the home and every
 * records folder, less what `LEFT_OUT` names. The manifest is renamed into
 * place, so a window reading the home never meets half of one.
 */
export async function backUp(place: BackupPlace, now = Date.now()): Promise<BackupTaken> {
  const repo = repositoryOf(place)
  if (typeof repo === 'string') {
    return { ok: false, summary: null, errors: [], said: repo, manifest: null }
  }
  const records = await recordsHere(place)
  const manifest: BackupManifest = {
    version: 1,
    home: place.home,
    records,
    projects: await projectsKept(place.config),
    tade: runningVersion(),
    machine: hostname(),
    at: new Date(now).toISOString(),
  }
  const path = join(place.home, MANIFEST)
  const temporary = `${path}.${randomBytes(4).toString('hex')}`
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  const ran = await (place.restic ?? restic)(resticBackup(place.home, records), repo.env)
  const { summary, errors } = backupSaid(ran.stdout)
  const ok = (ran.code === 0 || ran.code === 3) && summary !== null
  return { ok, summary, errors, said: ok ? '' : lastSaid(ran), manifest }
}

/** The snapshots Tade made in the repository, newest first. */
export async function snapshotsIn(
  place: BackupPlace,
): Promise<{ ok: true; snapshots: SnapshotKept[] } | { ok: false; said: string }> {
  const repo = repositoryOf(place)
  if (typeof repo === 'string') return { ok: false, said: repo }
  const ran = await (place.restic ?? restic)(['snapshots', '--json', '--tag', BACKUP_TAG], repo.env)
  if (ran.code !== 0) return { ok: false, said: lastSaid(ran) }
  return { ok: true, snapshots: snapshotsSaid(ran.stdout) }
}

/** How far into a file a torn tail is looked for at a time. */
const TAIL_CHUNK = 64 * 1024

/**
 * Cut an append-only file back to its last whole line, answering how many
 * bytes went. The next line written onto a torn one would be torn too, and a
 * journal line that does not parse is a line no index holds.
 */
export async function cutTornTail(path: string): Promise<number> {
  const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW)
  try {
    const { size } = await handle.stat()
    if (size === 0) return 0
    const last = Buffer.alloc(1)
    await handle.read(last, 0, 1, size - 1)
    if (last[0] === 0x0a) return 0
    let end = size
    while (end > 0) {
      const from = Math.max(0, end - TAIL_CHUNK)
      const chunk = Buffer.alloc(end - from)
      await handle.read(chunk, 0, chunk.length, from)
      const at = chunk.lastIndexOf(0x0a)
      if (at !== -1) {
        await handle.truncate(from + at + 1)
        return size - (from + at + 1)
      }
      end = from
    }
    await handle.truncate(0)
    return size
  } finally {
    await handle.close()
  }
}

/** Every `.jsonl` file under a folder, the folder's own and every one below. */
async function linesFiles(folder: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(orIfNothing([]))) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) out.push(...(await linesFiles(path)))
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

/**
 * Move what is under `from` into `to`, never over anything and never as a
 * whole: a folder is made where there is none and each entry goes the same
 * way, a file is renamed into place (copied where the two are on different
 * disks), and a symbolic link is never moved — nor followed where this
 * machine has one in the way. Renaming a folder whole would carry every link
 * inside it along, and a link restored from a snapshot points wherever its
 * writer chose. Answers how many entries were left: a file of the same name
 * already here, a link, or something in the way that is not a folder.
 */
async function moveInto(from: string, to: string): Promise<number> {
  const source = await lstat(from)
  if (source.isSymbolicLink()) return 1
  const target = await lstat(to).catch(orIfNothing(null))
  if (source.isDirectory()) {
    if (target === null) await mkdir(to, { recursive: true })
    else if (!target.isDirectory()) return 1
    let left = 0
    for (const name of await readdir(from)) left += await moveInto(join(from, name), join(to, name))
    await rmdirIfEmpty(from)
    return left
  }
  if (target !== null || !source.isFile()) return 1
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await copyFile(from, to, constants.COPYFILE_EXCL)
    await rm(from)
  }
  return 0
}

/**
 * Take every symbolic link out of a restored home before it is put in place,
 * each moved to the same place under `aside` — still inside the restore's own
 * folder — so a link a snapshot held is never one Tade then writes through.
 * Answers each one's path as it would have been in the home.
 */
async function linksAside(home: string, aside: string, placed: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isSymbolicLink()) {
        const kept = join(aside, relative(home, path))
        await mkdir(dirname(kept), { recursive: true })
        await rename(path, kept)
        found.push(join(placed, relative(home, path)))
      } else if (entry.isDirectory()) await walk(path)
    }
  }
  await walk(home)
  return found
}

/** A records folder the backup held, and where it went here — or why it stayed where it was restored. */
export interface RecordsPut {
  harness: string
  user: string | null
  from: string
  /** Where it is now; null where it was not placed, and `why` says why. */
  to: string | null
  /** What stayed in the restored copy: a file this machine already had, or a link. */
  left: number
  /** Why it was not placed, where it was not. */
  why: string | null
}

/** What a restore came to. */
export interface Restored {
  ok: boolean
  /** Why it did not, where it did not: refused before anything moved, or restic's words. */
  said: string
  /** Where the home that was here went, where there was one. */
  movedAside: string | null
  manifest: BackupManifest | null
  records: RecordsPut[]
  /** Whatever of the snapshot is still where restic put it: records nothing here took. */
  staging: string | null
  /** Bytes cut off torn last lines, by file. */
  cut: { path: string; bytes: number }[]
  /** Projects whose checkout is not on this machine. */
  missing: ProjectKept[]
  /** Symbolic links the restored home held, left in the restore's own folder rather than placed. */
  links: string[]
}

/** A restore that did nothing, and why. */
function refused(said: string): Restored {
  return {
    ok: false,
    said,
    movedAside: null,
    manifest: null,
    records: [],
    staging: null,
    cut: [],
    missing: [],
    links: [],
  }
}

/** Where a restore may put the home back, or why not: nothing may hold it, and nothing may be in it yet. */
export interface RestoreGuard {
  /** The pid holding the home, where something does (`heldBy`). */
  held: number | null
}

/**
 * Put a snapshot back as this machine's Tade: the home where `place.home` is,
 * and each harness's conversations where this machine's harness keeps them
 * for the same user — so a box rebuilt under another user or another home is
 * restored as readily as the same one.
 *
 * **Nothing is written over.** A home with a journal in it is refused, since
 * a backup is older than whatever is there; one without (a config `tade setup`
 * just wrote) is moved aside and said. A records folder is merged in, and a
 * file of the same name that is already here stays, as does any link.
 *
 * **A backup is outside input**: anybody who can write to the repository can
 * write a snapshot. So restic restores into a fresh folder of Tade's own
 * beside the home (`--target`), which also leaves the home as it was where a
 * restore fails half-way, and only what is expected is moved out of it — the
 * home, found by walking real folders down to its manifest, and each records
 * folder the manifest names, looked for inside that folder by a plain path
 * (`placeable`) and reached through no link. Where each goes is decided here
 * and never by the snapshot: `place.home`, and the folders this machine's
 * harnesses keep for each user by `place.config` — this machine's config as
 * it was before the restore, not the one restored.
 */
export async function restoreInto(
  place: BackupPlace,
  snapshot: string,
  guard: RestoreGuard,
  now = Date.now(),
): Promise<Restored> {
  const repo = repositoryOf(place)
  if (typeof repo === 'string') return refused(repo)
  if (guard.held !== null) {
    return refused(
      `Tade has ${place.home} open (pid ${guard.held}): quit it, or \`systemctl --user stop tade.service\`, then restore`,
    )
  }
  const journal = join(place.home, 'events.jsonl')
  const kept = await lstat(journal).catch(orIfNothing(null))
  if (kept && kept.size > 0) {
    return refused(
      `${place.home} has a journal already, and a backup is older than it: move ${place.home} away first, or \`--to <folder>\` puts the snapshot there to look at`,
    )
  }
  const staging = join(dirname(place.home), `.tade-restore-${randomBytes(4).toString('hex')}`)
  const ran = await (place.restic ?? restic)(['restore', snapshot, '--target', staging], repo.env)
  if (ran.code !== 0) {
    await rm(staging, { recursive: true, force: true })
    return refused(lastSaid(ran))
  }
  // Everything placed from here on is looked for inside this folder, by its
  // real path, and nothing a snapshot says decides where anything lands.
  const inside = await realpath(staging)
  const manifest = await findManifest(inside)
  if (manifest === null) {
    return {
      ...refused(
        `${snapshot} holds no ${MANIFEST}, so it is not a backup Tade took: what it held is in ${staging}`,
      ),
      staging,
    }
  }
  let movedAside: string | null = null
  if (await there(place.home)) {
    movedAside = `${place.home}.before-restore-${new Date(now).toISOString().replace(/[:.]/g, '-')}`
    await rename(place.home, movedAside)
  }
  // Found by walking real folders down from `inside` (`findManifest`), so a
  // folder of the restore's own, whatever the manifest's path says.
  const source = join(inside, manifest.home)
  const links = await linksAside(
    source,
    join(inside, `.links-${randomBytes(4).toString('hex')}`),
    place.home,
  )
  await mkdir(dirname(place.home), { recursive: true })
  await rename(source, place.home)

  const cut: { path: string; bytes: number }[] = []
  for (const path of await linesFiles(place.home)) {
    const bytes = await cutTornTail(path)
    if (bytes > 0) cut.push({ path, bytes })
  }

  // Where each harness keeps its conversations here, by this machine's own
  // config as it was before the restore — never the one just put back, which
  // is the snapshot's word: it would choose whose home they go into.
  const here = await recordsFolders(place)
  const records: RecordsPut[] = []
  for (const one of manifest.records) {
    const from = join(inside, one.path)
    if (!(await there(from))) continue
    const put = { ...one, from: one.path, left: 0 }
    const why = await notPlaceable(inside, from)
    const to =
      here.find((mine) => mine.harness === one.harness && mine.user === one.user)?.path ?? null
    if (why !== null || to === null) {
      records.push({
        ...put,
        to: null,
        why: why ?? `nothing here keeps ${one.harness}’s conversations for ${one.user ?? 'you'}`,
      })
      continue
    }
    records.push({ ...put, to, left: await moveInto(from, to), why: null })
  }
  const empty = await emptied(staging)
  const missing = manifest.projects.filter((project) => !existsSync(expandHome(project.root)))
  return {
    ok: true,
    said: '',
    movedAside,
    manifest,
    records,
    staging: empty ? null : staging,
    cut,
    missing,
    links,
  }
}

/**
 * Why `from` may not be moved out of the restore's folder, or null where it
 * may: it must be a real folder inside `inside`, reached through no link — a
 * snapshot may hold a link where a folder was, and a path through it is
 * somewhere else on this machine.
 */
async function notPlaceable(inside: string, from: string): Promise<string | null> {
  if (!from.startsWith(`${inside}/`)) return 'its path leads out of what was restored'
  const real = await realpath(from)
  if (real !== from) return 'its path goes through a link'
  if (!(await lstat(from)).isDirectory()) return 'it is not a folder'
  return null
}

/** The manifest of what restic restored into `staging`: found by walking down to the home. */
async function findManifest(staging: string): Promise<BackupManifest | null> {
  const walk = async (folder: string, depth: number): Promise<BackupManifest | null> => {
    const read = await readFile(join(folder, MANIFEST), 'utf8').catch(orIfNothing(null))
    if (read !== null) {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(read)
      } catch (err) {
        // A file of that name that is not JSON is not a manifest: keep looking.
        if (!(err instanceof SyntaxError)) throw err
      }
      const manifest = manifestOf(parsed)
      // Its own word for where it was must be where it was found.
      if (manifest && join(staging, manifest.home) === folder) return manifest
    }
    if (depth === 0) return null
    for (const entry of await readdir(folder, { withFileTypes: true }).catch(orIfNothing([]))) {
      if (!entry.isDirectory()) continue
      const found = await walk(join(folder, entry.name), depth - 1)
      if (found) return found
    }
    return null
  }
  return walk(staging, 12)
}

/**
 * Take away the folders a restore left empty, deepest first, and answer
 * whether nothing at all is left. Only empty folders go: a file that is still
 * there is something the restore did not place, and stays to be said.
 */
async function emptied(folder: string): Promise<boolean> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(orIfNothing(null))
  if (entries === null) return true
  let empty = true
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (!entry.isDirectory() || !(await emptied(path))) empty = false
  }
  if (empty) await rmdirIfEmpty(folder)
  return empty
}

/** Put a snapshot under a folder as restic lays it out, to look at: nothing here moves. */
export async function restoreTo(
  place: BackupPlace,
  snapshot: string,
  folder: string,
): Promise<{ ok: boolean; said: string }> {
  const repo = repositoryOf(place)
  if (typeof repo === 'string') return { ok: false, said: repo }
  const ran = await (place.restic ?? restic)(['restore', snapshot, '--target', folder], repo.env)
  return ran.code === 0 ? { ok: true, said: '' } : { ok: false, said: lastSaid(ran) }
}
