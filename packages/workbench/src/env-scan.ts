import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  assignmentsIn,
  type EnvFormat,
  isCredentialName,
  keyDigest,
  runProgram,
  SERVICE,
  unitIn,
} from '@tade/core'

// Where each key a person's environment sets is set, on this machine: the
// shell's own files, `environment.d`, the `tade.service` unit and the files it
// reads, `launchctl` on a Mac, and each open project's `.envrc` and `.env*` —
// read for names, lines and digests (`@tade/core`'s `env-files.ts` parses).
//
// **The value is dropped as soon as the line is parsed**: each literal is
// digested where it is read and the scan holds the digest, never the value, so
// nothing that reads a scan — the inventory, `/api/machine`, Settings — can
// write one down, log one or send one. `~/.npmrc` and `~/.aws/credentials`
// are named and left alone: their tools read them as they are.
//
// **Who reads each file is what matters most**, because it is what tells a key
// that works in a terminal from one `tade serve` never sees: systemd starts the
// service with the unit's own `Environment=`, its `EnvironmentFile=`s and
// `environment.d`, and none of `~/.zshenv`, `~/.zshrc` or `~/.bashrc`. A scan
// says which reader each place is for (`EnvPlace.read`), and the inventory
// says by name what the service misses.
//
// Nothing here waits without a deadline: every file is read with a cap, and
// `launchctl` is asked with a timeout, all at once.

/** Who reads a place. */
export type Reader =
  /** Every shell of that kind, login or not: `~/.zshenv`. */
  | 'shell'
  /** A login or interactive shell: `~/.zprofile`, `~/.zshrc`, `~/.bashrc`, `~/.profile`. */
  | 'login'
  /** `tade serve` under its unit: the unit, its environment files, `environment.d`. */
  | 'service'
  /** What a Mac's launchd hands the programs it starts: `launchctl setenv`. */
  | 'launchd'
  /** A project's own, read by direnv or by its tools in that project. */
  | 'project'

/** One place a name is set. */
export interface EnvPlace {
  /** Where, as a person reads it: `~/.zshenv`, `tade/.envrc`, `launchctl`. */
  file: string
  /** 1-based; null for `launchctl`, which has no lines. */
  line: number | null
  state: 'literal' | 'empty' | 'computed'
  /** SHA-256 of a literal's value; null otherwise. The value itself is never kept. */
  digest: string | null
  /** Whether consolidating could move it (`EnvAssignment.movable`). */
  movable: boolean
  why: string | null
  read: Reader
}

/** A file that holds credentials of its own tool's, named and left alone. */
export interface ToolCredentials {
  file: string
  /** What it holds, by the names its own lines use: `_authToken`, `aws_secret_access_key`. */
  holds: string[]
}

/** What one scan found. */
export interface EnvScan {
  /** Each name that matters, and every place it is set. */
  places: Map<string, EnvPlace[]>
  /** Whether a `tade.service` unit is here, so `tade serve` runs under systemd. */
  unit: boolean
  others: ToolCredentials[]
  /** What could not be read, in words: a file that is there and would not open. */
  problems: string[]
}

export interface EnvScanOpts {
  /** The person's home directory, where the shell's files are. */
  homeDir: string
  /** The open projects, whose `.envrc` and `.env*` are read. */
  projects: readonly { name: string; root: string }[]
  /** Names that matter whatever they are called; anything named like a credential matters too. */
  names: ReadonlySet<string>
  platform: NodeJS.Platform
  env: Readonly<Record<string, string | undefined>>
  /** How long `launchctl` is given for each name. */
  deadlineMs?: number
}

/** The most of any one file that is read: past it, the rest is not looked at. */
const FILE_MOST = 1024 * 1024

/** The shell files, with who reads each and how. */
export function shellFiles(
  homeDir: string,
): { path: string; said: string; format: EnvFormat; read: Reader }[] {
  const at = (rel: string) => ({ path: join(homeDir, rel), said: `~/${rel}` })
  return [
    { ...at('.zshenv'), format: 'sh', read: 'shell' },
    { ...at('.zprofile'), format: 'sh', read: 'login' },
    { ...at('.zshrc'), format: 'sh', read: 'login' },
    { ...at('.bash_profile'), format: 'sh', read: 'login' },
    { ...at('.bashrc'), format: 'sh', read: 'login' },
    { ...at('.profile'), format: 'sh', read: 'login' },
    { ...at('.config/fish/config.fish'), format: 'fish', read: 'login' },
  ]
}

/** Where the unit that runs `tade serve` is written (`tade host service`). */
export function unitPath(homeDir: string): string {
  return join(homeDir, '.config', 'systemd', 'user', SERVICE)
}

/** Every place each name that matters is set here. Never throws: what it could not read is a problem. */
export async function scanEnv(opts: EnvScanOpts): Promise<EnvScan> {
  const places = new Map<string, EnvPlace[]>()
  const problems: string[] = []
  const matters = (name: string) => opts.names.has(name) || isCredentialName(name)
  const add = (name: string, place: EnvPlace) => {
    if (!matters(name)) return
    const list = places.get(name) ?? []
    list.push(place)
    places.set(name, list)
  }
  const readAll = async (
    files: readonly { path: string; said: string; format: EnvFormat; read: Reader }[],
  ) => {
    const texts = await Promise.all(files.map((one) => capped(one.path, one.said, problems)))
    files.forEach((one, at) => {
      const text = texts[at]
      if (text === null || text === undefined) return
      for (const found of assignmentsIn(text, one.format)) {
        add(found.name, {
          file: one.said,
          line: found.line,
          state: found.state,
          digest: found.state === 'literal' ? keyDigest(found.value ?? '') : null,
          movable: found.movable,
          why: found.why,
          read: one.read,
        })
      }
    })
  }

  await readAll(shellFiles(opts.homeDir))

  // `environment.d`: what systemd's user manager hands every service it starts.
  const environmentD = join(opts.homeDir, '.config', 'environment.d')
  const confs = (await listed(environmentD, '~/.config/environment.d', problems))
    .filter((name) => name.endsWith('.conf'))
    .sort()
  await readAll(
    confs.map((name) => ({
      path: join(environmentD, name),
      said: `~/.config/environment.d/${name}`,
      format: 'envfile' as const,
      read: 'service' as const,
    })),
  )

  // The unit, and the files its `EnvironmentFile=` lines name.
  const unitText = await capped(
    unitPath(opts.homeDir),
    `~/.config/systemd/user/${SERVICE}`,
    problems,
  )
  const unit = unitText !== null
  if (unitText !== null) {
    const read = unitIn(unitText)
    for (const found of read.assignments) {
      add(found.name, {
        file: `~/.config/systemd/user/${SERVICE}`,
        line: found.line,
        state: found.state,
        digest: found.state === 'literal' ? keyDigest(found.value ?? '') : null,
        movable: false,
        why: found.why,
        read: 'service',
      })
    }
    await readAll(
      read.files.map((written) => {
        const path = written.replace(/^-/, '').replace(/^%h(?=\/)/, opts.homeDir)
        return {
          path,
          said: path.startsWith(`${opts.homeDir}/`) ? `~${path.slice(opts.homeDir.length)}` : path,
          format: 'envfile' as const,
          read: 'service' as const,
        }
      }),
    )
  }

  // Each open project's own: direnv's `.envrc`, and the `.env` files its tools read.
  for (const project of opts.projects) {
    const names = (await listed(project.root, project.name, problems)).filter(
      (name) =>
        name === '.envrc' ||
        (/^\.env(?:\..+)?$/.test(name) && !/\.(?:example|sample|template|dist)$/.test(name)),
    )
    await readAll(
      names.sort().map((name) => ({
        path: join(project.root, name),
        said: `${project.name}/${name}`,
        format: name === '.envrc' ? ('sh' as const) : ('envfile' as const),
        read: 'project' as const,
      })),
    )
  }

  // launchd's own, on a Mac: what `launchctl setenv` gave the programs it starts.
  if (opts.platform === 'darwin') {
    const asked = [...new Set([...opts.names, ...places.keys()])].sort()
    const said = await Promise.all(
      asked.map((name) =>
        runProgram('launchctl', ['getenv', name], {
          timeoutMs: opts.deadlineMs ?? 3_000,
          env: opts.env,
          maxBuffer: 64 * 1024,
        }),
      ),
    )
    asked.forEach((name, at) => {
      const ran = said[at]
      const value = ran && ran.code === 0 && !ran.timedOut ? ran.stdout.replace(/\n$/, '') : ''
      if (value === '') return
      add(name, {
        file: 'launchctl',
        line: null,
        state: 'literal',
        digest: keyDigest(value),
        movable: false,
        why: 'launchd keeps it, not a file',
        read: 'launchd',
      })
    })
  }

  return { places, unit, others: await toolCredentials(opts.homeDir, problems), problems }
}

/** `~/.npmrc` and `~/.aws/credentials`: what each holds, by its own names, and nothing else. */
async function toolCredentials(homeDir: string, problems: string[]): Promise<ToolCredentials[]> {
  const out: ToolCredentials[] = []
  const npm = await capped(join(homeDir, '.npmrc'), '~/.npmrc', problems)
  if (npm !== null) {
    const holds = new Set<string>()
    for (const line of npm.split(/\r?\n/)) {
      const found = /(?:^|:)(_authToken|_auth|_password)\s*=/.exec(line.trim())
      if (found?.[1]) holds.add(found[1])
    }
    if (holds.size > 0) out.push({ file: '~/.npmrc', holds: [...holds] })
  }
  const aws = await capped(join(homeDir, '.aws', 'credentials'), '~/.aws/credentials', problems)
  if (aws !== null) {
    const holds = new Set<string>()
    for (const line of aws.split(/\r?\n/)) {
      const found = /^\s*(aws_access_key_id|aws_secret_access_key|aws_session_token)\s*=/.exec(line)
      if (found?.[1]) holds.add(found[1])
    }
    if (holds.size > 0) out.push({ file: '~/.aws/credentials', holds: [...holds] })
  }
  return out
}

/** A file's text, at most `FILE_MOST` of it; null for none. A file that would not open is a problem. */
async function capped(path: string, said: string, problems: string[]): Promise<string | null> {
  try {
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(FILE_MOST)
      const { bytesRead } = await file.read(buffer, 0, FILE_MOST, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    problems.push(`${said} could not be read (${code ?? String(err)})`)
    return null
  }
}

/** A folder's entries, or none where it is not there; one that would not open is a problem. */
async function listed(dir: string, said: string, problems: string[]): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      problems.push(`${said} could not be listed (${code ?? String(err)})`)
    }
    return []
  }
}
