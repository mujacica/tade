import { z } from 'zod'

// What a new worktree needs before an agent can work in it, read out of what
// the project already says.
//
// A worktree is the files git tracks and nothing else: no `.env`, no local
// certificate, no `node_modules`. An agent started in one bare spends its
// first minutes rediscovering that and the person's first minutes answering
// it, which is the setup complaint everybody who runs agents in worktrees
// makes. So a worktree is *prepared*: the ignored files the project lists are
// brought across from its checkout, and its setup command is shown and run in
// the agent's own lane, with a deadline, before the agent starts.
//
// Read the way the checks are read (`@tade/checks-core`'s `readChecks`): only
// what a file states about itself, and what cannot be placed is **named** in
// `unread` rather than run — so the failure is "Tade prepared less than the
// project would", never "Tade ran something the project never asked a
// worktree to run". Nothing here writes a file into the repository; what a
// person wants instead is `projects.<name>.prepare` in Tade's own config.
//
// Running the project's own install in its own worktree is not installing a
// program on the machine ("nothing installs anything", `set-up-the-machine`):
// it is the project's code, run where the agent will run it anyway, in a lane
// somebody can watch. What *would* install a program — a devcontainer's
// `sudo apt-get` — is refused by `INSTALLS_A_PROGRAM` and said.

/** How long a setup command may run before it is stopped, unless a project says. */
export const PREPARE_DEADLINE_MINUTES = 10

/** `projects.<name>.prepare`: a project's own answer, over what is read. */
export const PrepareConfigSchema = z.strictObject({
  /**
   * Ignored files to bring into a new worktree from the checkout, as
   * gitignore-style patterns, instead of the project's `.worktreeinclude`.
   * Only files git ignores are ever brought; `[]` brings none.
   */
  files: z.array(z.string().min(1)).optional(),
  /** Link them rather than copy them, so a change in one is a change in both. */
  link: z.boolean().optional(),
  /**
   * The command a new worktree runs before its agent starts, instead of what
   * is read. Empty runs nothing.
   */
  command: z.string().optional(),
  /** How long it may run, in minutes. */
  deadline_minutes: z.int().positive().optional(),
})
export type PrepareConfig = z.infer<typeof PrepareConfigSchema>

/** A setup command, as a task file keeps it: what runs, where it was read from, for how long. */
export const Setup = z.object({
  command: z.string().min(1),
  from: z.string(),
  /** Seconds, so what was decided when the task was made is what the lane is held to. */
  deadline_s: z.int().positive(),
})
export type Setup = z.infer<typeof Setup>

/** What a project says a new worktree needs. */
export interface PrepareReading {
  /** Patterns naming the ignored files to bring across. */
  files: string[]
  /** Where that list came from; null where nothing named any. */
  filesFrom: string | null
  /** Link rather than copy. */
  link: boolean
  setup: Setup | null
  /** What was there and could not be taken as setup, each with why. */
  unread: string[]
}

/** The files a reading looks at, as they were found in the worktree; null where absent. */
export interface PrepareSources {
  worktreeinclude: string | null
  cursor: string | null
  /** The devcontainer file, by the path it was found at. */
  devcontainer: { path: string; text: string } | null
  packageJson: string | null
  /** Which of the lockfiles `LOCKFILES` names are there. */
  lockfiles: readonly string[]
}

/** Where a devcontainer is declared, in the order the spec looks. */
export const DEVCONTAINER_PATHS = ['.devcontainer/devcontainer.json', '.devcontainer.json']

export const CURSOR_WORKTREES = '.cursor/worktrees.json'
export const WORKTREE_INCLUDE = '.worktreeinclude'

/** A lockfile, and how its package manager installs from it without changing it. */
export const LOCKFILES: Readonly<Record<string, { manager: string; install: string }>> = {
  'pnpm-lock.yaml': { manager: 'pnpm', install: 'pnpm install --frozen-lockfile' },
  'package-lock.json': { manager: 'npm', install: 'npm ci' },
  'npm-shrinkwrap.json': { manager: 'npm', install: 'npm ci' },
  'yarn.lock': { manager: 'yarn', install: 'yarn install' },
  'bun.lock': { manager: 'bun', install: 'bun install --frozen-lockfile' },
  'bun.lockb': { manager: 'bun', install: 'bun install --frozen-lockfile' },
}

/**
 * A command that puts a program on the machine rather than preparing the
 * project: a container may, and this machine is not asked to. Exclusion only —
 * a list of verbs is safe here because all it can do is take a command away.
 */
const INSTALLS_A_PROGRAM =
  /(^|[\s;&|(])(sudo|apt|apt-get|apk|yum|dnf|pacman|brew|nix-env|snap)(\s|$)|\|\s*(ba|z|da)?sh(\s|$)/

/** What a project says, and what Tade's own config says over it, as one answer. */
export function readingOf(found: PrepareSources, configured?: PrepareConfig): PrepareReading {
  const unread: string[] = []
  const deadline = (configured?.deadline_minutes ?? PREPARE_DEADLINE_MINUTES) * 60
  const listed = found.worktreeinclude === null ? null : includeList(found.worktreeinclude)
  const files = configured?.files ?? listed ?? []
  const filesFrom =
    files.length === 0 ? null : configured?.files !== undefined ? 'Tade’s config' : WORKTREE_INCLUDE

  let setup: Setup | null = null
  if (configured?.command !== undefined) {
    const command = configured.command.trim()
    setup = command ? { command, from: 'Tade’s config', deadline_s: deadline } : null
  } else {
    for (const read of [
      () => fromCursor(found.cursor, unread),
      () => fromDevcontainer(found.devcontainer, unread),
      () => fromLockfiles(found.packageJson, found.lockfiles, unread),
    ]) {
      const one = read()
      if (one) {
        setup = { ...one, deadline_s: deadline }
        break
      }
    }
  }
  return {
    files,
    filesFrom,
    link: configured?.link ?? false,
    setup,
    unread,
  }
}

/** A gitignore-style list: one pattern a line, `#` comments and blank lines skipped. */
export function includeList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

type Found = { command: string; from: string } | null

/**
 * Cursor's `.cursor/worktrees.json`: `setup-worktree-unix`, else
 * `setup-worktree`, as a list of commands run in order with
 * `$ROOT_WORKTREE_PATH` naming the checkout. A string there is a script's
 * path, which says nothing about itself, so it is named rather than run.
 */
export function fromCursor(text: string | null, unread: string[]): Found {
  if (text === null) return null
  const json = parseJsonc(text)
  if (!isRecord(json)) {
    unread.push(`${CURSOR_WORKTREES}: not JSON this can read`)
    return null
  }
  const key = 'setup-worktree-unix' in json ? 'setup-worktree-unix' : 'setup-worktree'
  const value = json[key]
  if (value === undefined) return null
  if (typeof value === 'string') {
    unread.push(
      `${CURSOR_WORKTREES}: ${key} names a script (${value}), which says nothing about what it runs`,
    )
    return null
  }
  if (!Array.isArray(value) || !value.every((one) => typeof one === 'string')) {
    unread.push(`${CURSOR_WORKTREES}: ${key} is not a list of commands`)
    return null
  }
  const lines = value.map((one) => one.trim()).filter((one) => one !== '')
  return lines.length > 0
    ? { command: lines.join(' && '), from: `${CURSOR_WORKTREES} ${key}` }
    : null
}

/**
 * A devcontainer's `postCreateCommand`, where it is a command this machine can
 * run as written. It was written for a container, so three shapes are named
 * rather than run: one that interpolates `${…}` (only the container's tooling
 * can answer it), an object of named commands (they are meant to run side by
 * side, and running them in a row is a different program), and one that
 * installs a program on the machine.
 */
export function fromDevcontainer(
  found: { path: string; text: string } | null,
  unread: string[],
): Found {
  if (found === null) return null
  const json = parseJsonc(found.text)
  if (!isRecord(json)) {
    unread.push(`${found.path}: not JSON this can read`)
    return null
  }
  for (const key of ['onCreateCommand', 'updateContentCommand']) {
    if (json[key] !== undefined) {
      unread.push(`${found.path}: ${key} runs while a container is built, which this is not`)
    }
  }
  const value = json.postCreateCommand
  if (value === undefined) return null
  let command: string | null = null
  if (typeof value === 'string') command = value.trim()
  else if (Array.isArray(value) && value.every((one) => typeof one === 'string')) {
    command = value.map(shellQuote).join(' ')
  } else {
    unread.push(`${found.path}: postCreateCommand runs several commands side by side`)
    return null
  }
  if (!command) return null
  if (command.includes('${')) {
    unread.push(
      `${found.path}: postCreateCommand interpolates \${…}, which only a container’s tooling can fill in`,
    )
    return null
  }
  if (INSTALLS_A_PROGRAM.test(command)) {
    unread.push(
      `${found.path}: postCreateCommand installs a program on the machine, which a container may do and this machine is not asked to`,
    )
    return null
  }
  return { command, from: `${found.path} postCreateCommand` }
}

/**
 * The project's package manager, installing from its lockfile without
 * changing it. `packageManager` in `package.json` is what the project
 * declared, so it is believed over the lockfiles; two lockfiles of different
 * managers and no declaration is a question this cannot answer.
 */
export function fromLockfiles(
  packageJson: string | null,
  lockfiles: readonly string[],
  unread: string[],
): Found {
  if (packageJson === null) return null
  const json = parseJsonc(packageJson)
  const declared =
    isRecord(json) && typeof json.packageManager === 'string'
      ? (json.packageManager.split('@')[0] ?? '')
      : ''
  const known = lockfiles.filter((name) => LOCKFILES[name])
  if (declared) {
    const lock = known.find((name) => LOCKFILES[name]?.manager === declared)
    if (lock)
      return { command: LOCKFILES[lock]!.install, from: `package.json packageManager and ${lock}` }
    if (known.length === 0) return null
    unread.push(
      `package.json declares ${declared}, and there is no ${declared} lockfile to install from`,
    )
    return null
  }
  const managers = [...new Set(known.map((name) => LOCKFILES[name]!.manager))].sort()
  if (managers.length > 1) {
    unread.push(`lockfiles for ${managers.join(' and ')} and no packageManager to say which`)
    return null
  }
  const lock = known[0]
  return lock ? { command: LOCKFILES[lock]!.install, from: lock } : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * JSON with comments and trailing commas, which is what devcontainer and
 * Cursor files are. Never throws: what will not parse is `undefined`.
 */
export function parseJsonc(text: string): unknown {
  let out = ''
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '"') {
      // A string, copied whole, escapes and all.
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j + 1
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
    } else {
      out += c
      i++
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
  } catch {
    return undefined
  }
}

/** One argument for `sh`, quoted so it means exactly itself. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`
}

/**
 * What runs the setup, in Node, between the lane's shell and the agent.
 *
 * Node rather than `sh` because a deadline has to stop the whole of what the
 * command started — an install is a tree of processes — and the only portable
 * way to give it a group of its own is `setsid`, which a shell without job
 * control cannot do and macOS has no command for. The command runs detached,
 * so the group is its own and `kill(-pid)` reaches all of it; ctrl+c in the
 * lane stops it and the agent starts anyway. Everything it prints goes to the
 * lane and to the log, so the agent can read afterwards what the person saw.
 * It always exits 0: a setup that failed is a fact the agent is told, never a
 * reason the agent does not start.
 */
const SETUP_JS = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const [command, from, secs, log, root] = process.argv.slice(1)
const out = fs.createWriteStream(log)
const say = (s) => { process.stdout.write(s); out.write(s) }
say('\\x1b[1mPreparing this worktree before the agent starts\\x1b[0m, as ' + from + ' says (up to ' + (secs >= 120 ? Math.round(secs / 60) + ' min' : secs + 's') + ', ctrl+c skips it):\\n$ ' + command + '\\n\\n')
let why = ''
let ended = false
const finish = (end) => {
  if (ended) return
  ended = true
  clearTimeout(timer)
  say('\\n' + end + '; the agent starts now.\\n')
  out.end(() => process.exit(0))
}
const child = spawn('/bin/sh', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ROOT_WORKTREE_PATH: root } })
for (const stream of [child.stdout, child.stderr]) stream.on('data', (b) => { process.stdout.write(b); out.write(b) })
const stop = (reason) => {
  if (why || ended) return
  why = reason
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 5000).unref()
}
const timer = setTimeout(() => stop('stopped: it ran past ' + secs + 's'), secs * 1000)
process.on('SIGINT', () => stop('skipped with ctrl+c'))
process.on('SIGHUP', () => stop('stopped: the lane closed'))
child.on('error', (err) => finish('could not start it: ' + err.message))
child.on('exit', (code, signal) =>
  finish(why || (code === 0 ? 'done' : 'failed: ' + (signal ? 'killed by ' + signal : 'exit ' + code))))
`

/**
 * The line an agent's lane is launched with when its worktree has a setup
 * command to run first: the setup, under `SETUP_JS`, and then the agent's own
 * line by `exec`, so the agent is the lane's process exactly as it would have
 * been. Said once, like an opening instruction, and written down nowhere —
 * the lane's spec stays the agent's own line, so putting it back never
 * prepares the worktree twice.
 */
export function setupLine(opts: {
  setup: Setup
  /** Where what it printed, and how it ended, is written. */
  log: string
  /** The project's checkout, as `$ROOT_WORKTREE_PATH`. */
  root: string
  /** The Node that runs Tade. */
  node: string
  line: { command: string; args: readonly string[] }
}): { command: string; args: string[] } {
  // `trap : INT` so ctrl+c reaches the setup and not the shell that will become
  // the agent; a handler rather than an ignore, because an ignored signal stays
  // ignored across `exec` and the agent would never hear ctrl+c again.
  const script = 'trap : INT; "$1" -e "$2" "$3" "$4" "$5" "$6" "$7"; trap - INT; shift 7; exec "$@"'
  return {
    command: '/bin/sh',
    args: [
      '-c',
      script,
      'tade-prepare',
      opts.node,
      SETUP_JS,
      opts.setup.command,
      opts.setup.from,
      String(opts.setup.deadline_s),
      opts.log,
      opts.root,
      opts.line.command,
      ...opts.line.args,
    ],
  }
}
