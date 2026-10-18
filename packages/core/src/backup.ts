import { z } from 'zod'
import type { RequiredProgram } from './programs.ts'
import { IN_CONFIG } from './secrets.ts'

// A backup of this machine's Tade: what is kept, what is left out and why, and
// the words said around it. Pure — paths in, arguments and sentences out; the
// running of restic, the look at what is not pushed and the moves of a restore
// are the workbench's (`@tade/workbench/backup`).
//
// **What is kept is the whole home, less a named list** (`LEFT_OUT`), never a
// list of what to keep: a file Tade starts writing next month is in the next
// backup without anybody remembering to add it, and each thing left out is
// left out for a reason said beside it. Beside the home go the folders each
// harness keeps its conversations in (`WorkerAdapter.records`), which are what
// let an agent restored on another machine pick its conversation back up.
//
// **restic does the keeping**, and Tade wraps it rather than owning an archive
// format, as it leaves sandboxing to what does it properly. Encrypted, because
// the config holds every key Tade keeps; deduplicated, because the journal is
// an append-only file of tens of megabytes and the harnesses' conversations are
// gigabytes, and an hourly backup of either costs only what changed since; and
// it already speaks every target a person might name — a folder, SFTP to a
// storage box, S3, a REST server.

/** The program a backup runs, declared by what needs it and folded in under Tade. */
export const RESTIC: RequiredProgram = {
  command: 'restic',
  title: 'restic',
  why: 'backing up Tade’s home, encrypted, to a place you name (`tade host backup`)',
  versionArgs: ['version'],
  optional: true,
  install: { brew: 'restic', apt: 'restic', dnf: 'restic' },
}

export const BACKUP_PROGRAMS: readonly RequiredProgram[] = [RESTIC]

/**
 * `backup` in the config: where `tade host backup` keeps this machine's Tade,
 * and the password restic encrypts it with. Nothing is backed up anywhere
 * until `repository` is set, which `tade host backup --init <repository>`
 * does. Both are where Tade sends something and a credential, so the whole
 * section is a person's (`settingReach`), and each machine's own (`carryOf`).
 */
export const BackupConfigSchema = z
  .strictObject({
    /**
     * A restic repository as restic names one: a folder, `sftp:user@host:/path`,
     * `s3:…`, `rest:…`. Handed to restic in its environment, never on a
     * command line, so a URL with a password in it is not in the process table.
     */
    repository: z
      .string()
      .max(2_000)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: a control character is what it refuses.
      .regex(/^[^\0-\x1f\x7f]*$/, 'a repository is one line, as restic names one')
      .default(''),
    /** The password it is encrypted with; restic's own variables win (`passwordFor`). */
    password: z.string().default(''),
  })
  .prefault({})

/** What a backup is tagged with, so `tade host restore` lists Tade's own snapshots alone. */
export const BACKUP_TAG = 'tade'

/**
 * What a backup leaves out of the home, each with why — everything else in it
 * is kept. A path relative to the home; `*` is one folder's name, as in
 * `projects/*` — any project.
 */
export const LEFT_OUT: readonly { path: string; why: string }[] = [
  {
    path: 'events.jsonl.db',
    // The journal is the truth and this is built from it on open, which also
    // steps round every hazard of copying a SQLite database while it is written.
    why: 'the journal’s index, built again from the journal when Tade opens',
  },
  { path: 'events.jsonl.db-wal', why: 'the index’s write-ahead log' },
  { path: 'events.jsonl.db-shm', why: 'the index’s shared memory' },
  {
    path: 'events.jsonl.compacting',
    why: 'a compaction half-written; the journal is the whole of it',
  },
  {
    path: 'events.jsonl.survey',
    why: 'what the journal weighed, weighed again when it is compacted',
  },
  {
    path: 'worktrees',
    why: 'agents’ worktrees, made again from their branches — what an agent has not pushed is on this machine alone',
  },
  {
    path: 'runs',
    why: 'running agents’ sockets and run files, which mean nothing after a restart',
  },
  { path: 'checks', why: 'which check runs hold this machine now' },
  { path: 'tade.lock', why: 'which process holds the home now' },
  { path: 'updates.json', why: 'what was current when somebody last asked, asked again' },
  { path: 'models', why: 'the speech model, downloaded again when speech is turned on' },
  { path: 'mcp', why: 'what MCP servers said they offer, and their scratch folders' },
  { path: 'projects/*/mirror.git', why: 'another machine’s branches, fetched again over the link' },
  {
    path: 'remotes/*/documents',
    why: 'copies of another machine’s documents, read again from there',
  },
]

/** The file a backup writes into the home first, so a restore knows what each path was. */
export const MANIFEST = 'backup.json'

/** A folder a harness keeps its conversations in, and whose agents' they are. */
export interface RecordsFolder {
  /** The harness's id: `claude-code`, `pi`. */
  harness: string
  /**
   * Null: whoever runs Tade. A name only in a snapshot taken while agents
   * could run as a user of their own, which a restore says it cannot place.
   */
  user: string | null
  /** Where, absolute. */
  path: string
}

/** A project, as a restore on another machine needs it: where it was, and where it is cloned from. */
export interface ProjectKept {
  name: string
  root: string
  /** Its `origin`, or the first remote it has; null for a repository with none. */
  remote: string | null
}

/** What a backup says about itself, in the home it keeps (`MANIFEST`). */
export interface BackupManifest {
  /** The shape of this file, so a later Tade reads an older one's. */
  version: 1
  /** Where the home was, absolute. */
  home: string
  records: readonly RecordsFolder[]
  projects: readonly ProjectKept[]
  /** The Tade that wrote it. */
  tade: string
  /** This machine, as its host name says. */
  machine: string
  /** When, as an ISO moment. */
  at: string
  /** Read back only: records rows it held whose path is not one to look for (`placeable`). */
  unplaceable?: number
}

/**
 * Whether a path a snapshot names is one a restore may look for inside the
 * folder restic restored into: absolute, already in its plain form, with no
 * `..` in it and no NUL. **A backup is outside input** — a repository is
 * somewhere else, and anybody who can write to it can write a manifest — so
 * a path in one only ever says what to look for under the restore's own
 * folder, never where anything lands (`restoreInto`).
 */
export function placeable(path: string): boolean {
  return (
    path.startsWith('/') &&
    !path.includes('\0') &&
    !path.split('/').some((part) => part === '..' || part === '.') &&
    !/\/\//.test(path)
  )
}

/** A manifest read back, or null where it is not one: never thrown, because a restore says it. */
export function manifestOf(value: unknown): BackupManifest | null {
  if (typeof value !== 'object' || value === null) return null
  const read = value as Record<string, unknown>
  const text = (one: unknown): one is string => typeof one === 'string' && one !== ''
  if (read.version !== 1 || !text(read.home) || !placeable(read.home)) return null
  const records = Array.isArray(read.records) ? read.records : []
  const projects = Array.isArray(read.projects) ? read.projects : []
  let unplaceable = 0
  const kept = records.flatMap((one: unknown) => {
    const row = (one ?? {}) as Record<string, unknown>
    if (!text(row.harness) || !text(row.path)) return []
    if (!placeable(row.path)) {
      unplaceable++
      return []
    }
    return [{ harness: row.harness, user: text(row.user) ? row.user : null, path: row.path }]
  })
  return {
    version: 1,
    home: read.home,
    records: kept,
    projects: projects.flatMap((one: unknown) => {
      const row = (one ?? {}) as Record<string, unknown>
      if (!text(row.name) || !text(row.root)) return []
      return [{ name: row.name, root: row.root, remote: text(row.remote) ? row.remote : null }]
    }),
    tade: text(read.tade) ? read.tade : 'an unknown Tade',
    machine: text(read.machine) ? read.machine : 'an unknown machine',
    at: text(read.at) ? read.at : '',
    ...(unplaceable > 0 ? { unplaceable } : {}),
  }
}

/** Whether `path` is `folder` or inside it. */
function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith('/') ? folder : `${folder}/`)
}

/**
 * What a backup reads: the home, then each records folder that is not already
 * inside it or inside another — an account's own folder is in the home, and
 * two harnesses may name one folder.
 */
export function backupPaths(home: string, records: readonly RecordsFolder[]): string[] {
  const kept = [home]
  const paths = [...new Set(records.map((one) => one.path))]
  for (const path of paths) {
    if (kept.some((one) => within(path, one))) continue
    if (paths.some((other) => other !== path && within(path, other))) continue
    kept.push(path)
  }
  return kept
}

/** A path as a restic pattern matches it: its own glob characters taken literally. */
function literal(path: string): string {
  return path.replace(/[\\*?[]/g, (char) => `\\${char}`)
}

/** What restic is told to leave out of the home: `LEFT_OUT`, absolute. */
export function backupExcludes(home: string): string[] {
  const base = literal(home.replace(/\/+$/, ''))
  return LEFT_OUT.map((one) => `${base}/${one.path}`)
}

/** The arguments of one backup: Tade's tag, `--json` to read its summary, and what is left out. */
export function resticBackup(home: string, records: readonly RecordsFolder[]): string[] {
  return [
    'backup',
    '--json',
    '--tag',
    BACKUP_TAG,
    ...backupExcludes(home).flatMap((one) => ['--exclude', one]),
    ...backupPaths(home, records),
  ]
}

/** What one backup came to, out of restic's `--json` summary line. */
export interface BackupSummary {
  /** The snapshot it made, short, as `restic snapshots` names it. */
  snapshot: string
  filesNew: number
  filesChanged: number
  filesUnmodified: number
  /** Bytes sent to the repository, after deduplication and compression. */
  bytesAdded: number
  /** Bytes it read. */
  bytesProcessed: number
  seconds: number
}

/** A file restic could not read, and its own words for why. */
export interface BackupError {
  item: string
  said: string
}

/** What restic's `--json` lines said: the summary, and every file it could not read. */
export function backupSaid(stdout: string): {
  summary: BackupSummary | null
  errors: BackupError[]
} {
  let summary: BackupSummary | null = null
  const errors: BackupError[] = []
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    let read: Record<string, unknown>
    try {
      read = JSON.parse(line) as Record<string, unknown>
    } catch (err) {
      // A line restic printed that is not JSON is not one of its messages.
      if (err instanceof SyntaxError) continue
      throw err
    }
    const number = (key: string) => (typeof read[key] === 'number' ? (read[key] as number) : 0)
    if (read.message_type === 'summary' && typeof read.snapshot_id === 'string') {
      summary = {
        snapshot: read.snapshot_id.slice(0, 8),
        filesNew: number('files_new'),
        filesChanged: number('files_changed'),
        filesUnmodified: number('files_unmodified'),
        bytesAdded: number('data_added_packed') || number('data_added'),
        bytesProcessed: number('total_bytes_processed'),
        seconds: number('total_duration'),
      }
    } else if (read.message_type === 'error') {
      // `{"error": {"message": …}}` from 0.17, `{"error": "…"}` before it.
      const error = read.error
      const said =
        typeof error === 'string'
          ? error
          : typeof (error as { message?: unknown } | null)?.message === 'string'
            ? (error as { message: string }).message
            : 'could not be read'
      errors.push({ item: typeof read.item === 'string' ? read.item : '', said })
    }
  }
  return { summary, errors }
}

/** A snapshot Tade made, as `restic snapshots --json` lists it. */
export interface SnapshotKept {
  id: string
  /** When, as an ISO moment. */
  at: string
  machine: string
  paths: readonly string[]
}

/** The snapshots, newest first, out of `restic snapshots --json`; none where it is not a list. */
export function snapshotsSaid(stdout: string): SnapshotKept[] {
  let read: unknown
  try {
    read = JSON.parse(stdout)
  } catch (err) {
    // Not the list it prints: no snapshots can be read out of it, which the caller says.
    if (err instanceof SyntaxError) return []
    throw err
  }
  if (!Array.isArray(read)) return []
  return read
    .flatMap((one: unknown) => {
      const row = (one ?? {}) as Record<string, unknown>
      const id = typeof row.short_id === 'string' ? row.short_id : String(row.id ?? '').slice(0, 8)
      if (id === '' || typeof row.time !== 'string') return []
      return [
        {
          id,
          at: row.time,
          machine: typeof row.hostname === 'string' ? row.hostname : '',
          paths: Array.isArray(row.paths) ? row.paths.filter((p) => typeof p === 'string') : [],
        },
      ]
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/**
 * A repository as it may be said: a password inside a URL's userinfo
 * (`rest:https://me:secret@host/`) taken out, because it is said on every
 * backup and goes to a service's log. Tade hands restic the repository in its
 * environment, never on a command line anybody on the machine can read.
 */
export function shownRepository(repository: string): string {
  return repository.replace(/(\/\/[^/:@\s]*):[^/@\s]*@/, '$1:…@')
}

/** The variables restic reads its password from, any of which wins over Tade's config. */
export const PASSWORD_VARIABLES = [
  'RESTIC_PASSWORD',
  'RESTIC_PASSWORD_FILE',
  'RESTIC_PASSWORD_COMMAND',
] as const

/**
 * Where the backup's password comes from, and what restic is handed for it.
 * **The environment always wins**: restic's own variables, read by restic
 * itself, and only otherwise `backup.password`, handed over as
 * `RESTIC_PASSWORD` in the child's environment. Null where there is none.
 */
export function passwordFor(
  env: Readonly<Record<string, string | undefined>>,
  written: string,
): { from: string; env: Record<string, string> } | null {
  for (const variable of PASSWORD_VARIABLES) {
    if (env[variable]?.trim()) return { from: `$${variable}`, env: {} }
  }
  const value = written.trim()
  return value === '' ? null : { from: IN_CONFIG, env: { RESTIC_PASSWORD: value } }
}

/** What is said wherever a backup is set up: it carries every key, so its password is the lock. */
export const BACKUP_HOLDS_KEYS =
  `A backup holds ${IN_CONFIG}, and with it every key Tade keeps: restic encrypts all of it with ` +
  'the backup’s password before it leaves this machine.'

/** Said where the password is made: the one thing a restore cannot do without. */
export const KEEP_THE_PASSWORD =
  'Keep this password somewhere off this machine. Without it nothing in the backup can be read, ' +
  'and this machine is the one a backup is for losing.'

/** What a backup does not hold, said once at the end of each: the work that lives in git. */
export const BRANCHES_ARE_THE_WORK =
  'Not in it: your projects’ checkouts and agents’ worktrees, which are git’s — what is pushed is ' +
  'made again from its branch, and what is not is on this machine alone.'

/** How much a byte count is, as a person reads one. */
export function bytesSaid(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
