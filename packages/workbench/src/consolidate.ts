import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  assignmentsIn,
  ENV_FILE_HEAD,
  ENV_FILE_SAID,
  type EnvAssignment,
  envLine,
  hiddenLine,
  isCredentialName,
  namesSystemdReads,
  runProgram,
  SOURCE_LINE,
} from '@tade/core'
import { shellFiles } from './env-scan.ts'
import { placeSaid } from './inventory.ts'

// Keys moved out of a person's shell files into one file, `~/.config/tade/env`,
// which their login shell and `tade serve` both read — on their press, or when
// they ask, and never by itself.
//
// **The riskiest thing Tade does to somebody's machine**, so it is done the
// way a careful person would do it by hand, every step said:
//
// 1. **A diff first** (`planConsolidation`): which lines leave which file,
//    the one line each file gets instead (`SOURCE_LINE`), and what the one
//    file gains — every value shown as `‹hidden›`, so the diff can be read
//    aloud, pasted or put on a screen somebody else can see.
// 2. **Only a literal moves**, set the same everywhere it is set, outside any
//    block (`env-files.ts`): anything a shell works out at login stays where
//    it is, named, with why.
// 3. **The files are looked at again** before anything is written, and a file
//    that changed since the diff was shown stops it: what was agreed to is
//    exactly what is written.
// 4. **A fresh login shell is asked which variables are set** — never what
//    they are — before and after (`loginShellHas`). One that could not be
//    asked stops it before anything is written.
// 5. **Each file is copied beside itself first** (`.zshenv.tade-before`).
// 6. **Anything different after is rolled back**: every file is put back
//    byte for byte from what was read, the one file is put back as it was or
//    taken away, the copies made for this are removed, and the bytes are read
//    back to prove it. Said either way.
//
// The one file is `0600` and in plain sight. It is read by every agent, like
// `config.yaml` (`KEYS_AND_AGENTS`), which is said where somebody decides.

/** One shell file a consolidation changes. */
export interface FileChange {
  path: string
  /** As a person reads it: `~/.zshenv`. */
  said: string
  /** Exactly what was read. */
  before: Buffer
  after: string
  mode: number
}

/** What moving the keys would do, before anything is written. */
export interface ConsolidationPlan {
  files: FileChange[]
  envPath: string
  /** What the one file holds now, byte for byte; null where it is not there. */
  envBefore: Buffer | null
  envAfter: string
  /** Each variable moved, from where. */
  moved: { name: string; from: string[] }[]
  /** Each one left where it is, and why. */
  left: { name: string; where: string; why: string }[]
  /** Every variable a login shell is asked about before and after. */
  checked: string[]
  /** What a person is shown: the lines that change, values hidden. */
  diff: string[]
}

/** Where the one file is, for a home directory. */
export function envFilePath(homeDir: string): string {
  return join(homeDir, '.config', 'tade', 'env')
}

/**
 * What moving every key the shell files set into one file would do. Reads, and
 * writes nothing. `names` are the variables that matter whatever they are
 * called; any named like a credential matters too.
 */
export async function planConsolidation(opts: {
  homeDir: string
  names: ReadonlySet<string>
}): Promise<ConsolidationPlan> {
  const matters = (name: string) => opts.names.has(name) || isCredentialName(name)
  const files = shellFiles(opts.homeDir).filter((one) => one.format === 'sh')
  const read = await Promise.all(files.map((one) => bytesOf(one.path)))
  const envPath = envFilePath(opts.homeDir)
  const envBefore = await bytesOf(envPath)
  const envText = envBefore?.toString('utf8') ?? null
  const inEnv = new Map(
    assignmentsIn(envText ?? '', 'envfile').map((one) => [one.name, one.value ?? null]),
  )

  // Every assignment of every name that matters, file by file.
  const found = new Map<string, { file: number; one: EnvAssignment }[]>()
  read.forEach((bytes, file) => {
    if (bytes === null) return
    for (const one of assignmentsIn(bytes.toString('utf8'), 'sh')) {
      if (!matters(one.name)) continue
      found.set(one.name, [...(found.get(one.name) ?? []), { file, one }])
    }
  })

  const moved: ConsolidationPlan['moved'] = []
  const left: ConsolidationPlan['left'] = []
  const leaving = new Map<number, Set<number>>()
  const newLines: string[] = []
  for (const [name, all] of [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const where = (at: { file: number; one: EnvAssignment }) =>
      placeSaid({ file: files[at.file]?.said ?? '', line: at.one.line })
    const stuck = all.find((at) => !at.one.movable || at.one.state !== 'literal')
    const values = new Set(all.map((at) => at.one.value))
    const already = inEnv.get(name)
    let why: string | null = null
    if (stuck) why = stuck.one.why ?? 'its value is worked out by the shell'
    else if (values.size > 1) why = 'it is set to different values in different places'
    else if (already !== undefined && already !== all[0]?.one.value)
      why = `${ENV_FILE_SAID} already sets it to something else`
    if (why !== null) {
      for (const at of all) left.push({ name, where: where(at), why })
      continue
    }
    moved.push({ name, from: all.map(where) })
    for (const at of all) {
      const lines = leaving.get(at.file) ?? new Set<number>()
      lines.add(at.one.line)
      leaving.set(at.file, lines)
    }
    if (already === undefined) newLines.push(envLine(name, all[0]?.one.value ?? ''))
  }

  const changes: FileChange[] = []
  const diff: string[] = []
  for (const [file, lines] of [...leaving].sort(([a], [b]) => a - b)) {
    const bytes = read[file]
    const spec = files[file]
    if (!bytes || !spec) continue
    const text = bytes.toString('utf8')
    const rows = text.split('\n')
    const sourced = rows.some((row) => row.replace(/\r$/, '').trim() === SOURCE_LINE)
    const out: string[] = []
    const shown: string[] = [spec.said]
    let placed = sourced
    rows.forEach((row, at) => {
      const line = at + 1
      if (!lines.has(line)) {
        out.push(row)
        return
      }
      shown.push(`  ${String(line).padStart(4)} - ${hiddenLine(row.replace(/\r$/, '').trim())}`)
      if (!placed) {
        out.push(`${SOURCE_LINE}${row.endsWith('\r') ? '\r' : ''}`)
        shown.push(`  ${String(line).padStart(4)} + ${SOURCE_LINE}`)
        placed = true
      }
    })
    diff.push(...shown)
    changes.push({
      path: spec.path,
      said: spec.said,
      before: bytes,
      after: out.join('\n'),
      mode: (await stat(spec.path)).mode & 0o777,
    })
  }

  const head = envText ?? ENV_FILE_HEAD.join('\n')
  const joined = head === '' || head.endsWith('\n') ? head : `${head}\n`
  const envAfter = newLines.length === 0 ? (envText ?? '') : `${joined}${newLines.join('\n')}\n`
  if (newLines.length > 0) {
    diff.push(envBefore === null ? `${ENV_FILE_SAID} (new, 0600)` : ENV_FILE_SAID)
    for (const line of newLines) diff.push(`       + ${hiddenLine(line)}`)
  }
  return {
    files: changes,
    envPath,
    envBefore,
    envAfter,
    moved,
    left,
    checked: [...found.keys()].sort(),
    diff,
  }
}

/** Which of `names` a fresh login shell sets; null where it could not be asked. */
export type Verifier = (names: readonly string[]) => Promise<Set<string> | null>

/** What came of a consolidation. */
export interface Consolidated {
  outcome: 'moved' | 'rolled back' | 'refused' | 'nothing'
  /** Why it was refused or rolled back; null where it moved. */
  why: string | null
  /** The copies made beside each file, kept where it moved. */
  backups: string[]
  /** What is said, whatever happened. */
  said: string
}

/**
 * Move the keys as `plan` says, verified by a fresh login shell before and
 * after, and rolled back byte for byte if anything differs. Never throws for
 * anything the plan could meet: a refusal or a rollback is an answer, said.
 */
export async function applyConsolidation(
  plan: ConsolidationPlan,
  opts: { verify: Verifier },
): Promise<Consolidated> {
  if (plan.moved.length === 0) {
    return {
      outcome: 'nothing',
      why: null,
      backups: [],
      said: `Nothing to move: no key in your shell files can be moved into ${ENV_FILE_SAID} as it is.`,
    }
  }
  const refused = (why: string): Consolidated => ({
    outcome: 'refused',
    why,
    backups: [],
    said: `Nothing was moved: ${why}.`,
  })
  for (const file of plan.files) {
    const now = await bytesOf(file.path)
    if (now === null || !now.equals(file.before))
      return refused(`${file.said} changed since the diff was made`)
  }
  const envNow = await bytesOf(plan.envPath)
  if (!sameBytes(envNow, plan.envBefore))
    return refused(`${ENV_FILE_SAID} changed since the diff was made`)
  const missing = plan.moved.filter((one) => !namesSystemdReads(plan.envAfter).includes(one.name))
  if (missing.length > 0) {
    return refused(
      `${ENV_FILE_SAID} would not set ${missing.map((one) => one.name).join(', ')} for the service`,
    )
  }
  const before = await opts.verify(plan.checked)
  if (before === null)
    return refused('a fresh login shell could not be asked which variables it sets')

  const backups: string[] = []
  try {
    for (const file of plan.files) backups.push(await backUp(file))
    await mkdir(dirname(plan.envPath), { recursive: true, mode: 0o700 })
    await replace(plan.envPath, plan.envAfter, 0o600)
    for (const file of plan.files) await replace(file.path, file.after, file.mode)
  } catch (err) {
    const why = `writing failed (${err instanceof Error ? err.message : String(err)})`
    return rollBack(plan, backups, why)
  }

  const after = await opts.verify(plan.checked)
  if (after === null)
    return rollBack(plan, backups, 'a fresh login shell could not be asked again afterwards')
  const lost = [...before].filter((name) => !after.has(name))
  const gained = [...after].filter((name) => !before.has(name))
  if (lost.length > 0 || gained.length > 0) {
    const parts = [
      ...(lost.length > 0 ? [`no longer set: ${lost.join(', ')}`] : []),
      ...(gained.length > 0 ? [`newly set: ${gained.join(', ')}`] : []),
    ]
    return rollBack(
      plan,
      backups,
      `a fresh login shell sets something else afterwards (${parts.join('; ')})`,
    )
  }
  const names = plan.moved.map((one) => one.name)
  return {
    outcome: 'moved',
    why: null,
    backups,
    said:
      `Moved ${names.join(', ')} into ${ENV_FILE_SAID} (0600), and a fresh login shell sets the same ` +
      `variables as before. Each file changed was copied beside itself first: ${backups.map(said).join(', ')}.`,
  }
}

/** Every file put back as it was read, the one file as it was or gone, and this run's copies removed. */
async function rollBack(
  plan: ConsolidationPlan,
  backups: readonly string[],
  why: string,
): Promise<Consolidated> {
  const failures: string[] = []
  for (const file of plan.files) {
    try {
      await replace(file.path, file.before, file.mode)
      const back = await bytesOf(file.path)
      if (back === null || !back.equals(file.before)) failures.push(file.said)
    } catch (err) {
      failures.push(`${file.said} (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  try {
    if (plan.envBefore === null) await unlink(plan.envPath).catch(unlessGone)
    else await replace(plan.envPath, plan.envBefore, 0o600)
    if (!sameBytes(await bytesOf(plan.envPath), plan.envBefore)) failures.push(ENV_FILE_SAID)
  } catch (err) {
    failures.push(`${ENV_FILE_SAID} (${err instanceof Error ? err.message : String(err)})`)
  }
  // The copies made for this go once everything is back; one that will not is
  // left, harmless, and named.
  const stayed: string[] = []
  if (failures.length === 0) {
    for (const one of backups) {
      await unlink(one).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') stayed.push(one)
      })
    }
  }
  return {
    outcome: 'rolled back',
    why,
    backups: failures.length === 0 ? stayed : [...backups],
    said:
      failures.length === 0
        ? `Put everything back as it was, byte for byte: ${why}.${stayed.length > 0 ? ` The copy made first is still there, and can go: ${stayed.map(said).join(', ')}.` : ''}`
        : `Tried to put everything back (${why}) and could not for ${failures.join(', ')}: its copy is ${backups.map(said).join(', ')}.`,
  }
}

/** A removal that found nothing to remove is done; anything else is thrown on. */
function unlessGone(err: NodeJS.ErrnoException): void {
  if (err.code !== 'ENOENT') throw err
}

/** A copy of one file beside itself, never over an earlier one: its path. */
async function backUp(file: FileChange): Promise<string> {
  for (let n = 0; n < 100; n++) {
    const path = `${file.path}.tade-before${n === 0 ? '' : `.${n}`}`
    try {
      const handle = await open(path, 'wx', file.mode)
      try {
        await handle.writeFile(file.before)
      } finally {
        await handle.close()
      }
      return path
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
  }
  throw new Error(`${file.said} has a hundred copies beside it already`)
}

/** A file's content replaced whole: written beside it and renamed over, keeping its mode. */
async function replace(path: string, content: string | Buffer, mode: number): Promise<void> {
  const temp = `${path}.tade-${process.pid}.tmp`
  await writeFile(temp, content, { mode })
  await rename(temp, path)
}

async function bytesOf(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

function sameBytes(a: Buffer | null, b: Buffer | null): boolean {
  return a === null || b === null ? a === b : a.equals(b)
}

/** A path as a person reads it, under their home. */
function said(path: string): string {
  const home = process.env.HOME
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** What a login shell is started with: a fresh one, not Tade's environment. */
function freshEnv(
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
  shell: string,
) {
  return {
    HOME: homeDir,
    USER: env.USER ?? '',
    LOGNAME: env.LOGNAME ?? env.USER ?? '',
    SHELL: shell,
    PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TERM: 'dumb',
    LANG: env.LANG ?? 'C.UTF-8',
  }
}

/** The marker each set variable's name is printed after, so nothing a login says is read as one. */
const MARK = '__tade_set__'

/**
 * Which of `names` a fresh login shell sets — asked of an interactive login
 * shell, which reads every file a terminal does, with nothing of Tade's
 * environment, and printing names and never values. Null for a shell it
 * cannot ask that way, one that did not answer in time, or one that failed.
 */
export async function loginShellHas(
  names: readonly string[],
  opts: {
    shell: string
    homeDir: string
    env: Readonly<Record<string, string | undefined>>
    timeoutMs?: number
  },
): Promise<Set<string> | null> {
  const kind = opts.shell.split('/').at(-1) ?? ''
  if (!['zsh', 'bash', 'sh', 'dash', 'ksh'].includes(kind)) return null
  const asked = names.filter((one) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(one))
  const script =
    `for n in ${asked.join(' ')}; do eval "v=\\\${$n-}"; ` +
    `[ -n "$v" ] && printf '%s %s\\n' ${MARK} "$n"; done; exit 0`
  const ran = await runProgram(opts.shell, ['-l', '-i', '-c', script], {
    env: freshEnv(opts.env, opts.homeDir, opts.shell),
    cwd: opts.homeDir,
    timeoutMs: opts.timeoutMs ?? 20_000,
    maxBuffer: 1024 * 1024,
  })
  if (ran.missing || ran.timedOut || ran.code !== 0) return null
  return setNamesIn(ran.stdout, asked)
}

/** The names a login printed after the marker, of those asked: never anything else it said. */
export function setNamesIn(stdout: string, asked: readonly string[]): Set<string> {
  const set = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const found = new RegExp(`^${MARK} ([A-Za-z_][A-Za-z0-9_]*)$`).exec(line.trim())
    if (found?.[1] && asked.includes(found[1])) set.add(found[1])
  }
  return set
}
