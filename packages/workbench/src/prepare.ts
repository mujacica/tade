import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, realpath, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  type Config,
  CURSOR_WORKTREES,
  DEVCONTAINER_PATHS,
  expandHome,
  LOCKFILES,
  type PrepareConfig,
  type PrepareSources,
  readingOf,
  type Setup,
  TaskFile,
  taskDir,
  WORKTREE_INCLUDE,
} from '@tade/core'
import { git } from '@tade/status'
import { parse as parseYaml } from 'yaml'

// Preparing a new worktree: the I/O half of `@tade/core`'s `prepare.ts`, which
// says what is read and why. Two moments, because they are two different acts:
//
// - when the worktree is made (`prepareWorktree`, from `createTask`), the
//   ignored files the project lists are brought across from its checkout and
//   the setup command is read and written into the task file, so a task keeps
//   what it was made with whatever the config says tomorrow;
// - when its first agent starts (`setupBefore`, from `startAgent`), the setup
//   runs in that agent's lane — shown, with a deadline — before the agent does.
//   Only a *new* agent: one coming back to its conversation is past all this.

/** The most ignored files one worktree is given; past it, none are, and that is said. */
export const MOST_FILES = 200

/** What preparing a worktree came to. */
export interface Prepared {
  /** The ignored files brought across, relative to the worktree. */
  files: string[]
  setup: Setup | null
  /** What could not be read or brought, each in a sentence. Never thrown. */
  said: string[]
}

/** Where the setup's output and its ending are written: the task's own folder, never the worktree. */
export function setupLogPath(home: string, task: string): string {
  return join(taskDir(home, task), 'setup.log')
}

async function readOr(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** The files a reading looks at, as they are in `dir` — the new worktree, so at its base commit. */
export async function sourcesIn(dir: string, root: string): Promise<PrepareSources> {
  let devcontainer: PrepareSources['devcontainer'] = null
  for (const path of DEVCONTAINER_PATHS) {
    const text = await readOr(join(dir, path))
    if (text !== null) {
      devcontainer = { path, text }
      break
    }
  }
  const lockfiles: string[] = []
  for (const name of Object.keys(LOCKFILES)) {
    if ((await readOr(join(dir, name))) !== null) lockfiles.push(name)
  }
  return {
    // The list may be one somebody keeps in their checkout and never committed.
    worktreeinclude:
      (await readOr(join(dir, WORKTREE_INCLUDE))) ?? (await readOr(join(root, WORKTREE_INCLUDE))),
    cursor: await readOr(join(dir, CURSOR_WORKTREES)),
    devcontainer,
    packageJson: await readOr(join(dir, 'package.json')),
    lockfiles,
  }
}

/**
 * The ignored files in the checkout that the patterns name, brought into the
 * worktree. Only files git **ignores** in the checkout: a tracked file is
 * already in the worktree, and an untracked one that is not ignored is
 * somebody's work in progress, which is not the project's to hand out. Never
 * over a file the worktree already has.
 */
export async function bringFiles(opts: {
  root: string
  worktree: string
  patterns: readonly string[]
  link: boolean
}): Promise<{ brought: string[]; said: string[] }> {
  if (opts.patterns.length === 0) return { brought: [], said: [] }
  const named = await git(
    opts.root,
    ['ls-files', '-z', '--others', '--ignored', ...opts.patterns.flatMap((p) => ['-x', p])],
    30_000,
  )
  if (!named.ok) {
    return {
      brought: [],
      said: [`the files to bring could not be listed: ${firstLine(named.stderr)}`],
    }
  }
  const candidates = named.stdout.split('\0').filter((path) => path !== '')
  if (candidates.length === 0) return { brought: [], said: [] }
  if (candidates.length > MOST_FILES) {
    return {
      brought: [],
      said: [
        `the files to bring match more than ${MOST_FILES} files, so none were brought: name them more narrowly`,
      ],
    }
  }
  // Exit 1 is "none of them is ignored", which is an answer and not a failure.
  // `-z` needs `--stdin`, so it is a line each, unquoted — and only a line
  // that is exactly one of the candidates counts, which a path git had to
  // quote never is: it is left behind rather than guessed at.
  const ignored = await git(
    opts.root,
    ['-c', 'core.quotePath=false', 'check-ignore', '--', ...candidates],
    30_000,
  )
  if (!ignored.ok && ignored.stderr.trim() !== '') {
    return {
      brought: [],
      said: [`which files git ignores could not be asked: ${firstLine(ignored.stderr)}`],
    }
  }
  const brought: string[] = []
  const said: string[] = []
  const asked = new Set(candidates)
  for (const path of ignored.stdout
    .split('\n')
    .filter((one) => asked.has(one))
    .sort()) {
    const from = resolve(opts.root, path)
    const to = resolve(opts.worktree, path)
    // `git` hands back paths inside the checkout; this is the belt to that.
    if (!from.startsWith(`${resolve(opts.root)}/`) || !to.startsWith(`${resolve(opts.worktree)}/`))
      continue
    try {
      if (
        await lstat(to).then(
          () => true,
          () => false,
        )
      ) {
        said.push(`${path} is already in the worktree, so it was left as it is`)
        continue
      }
      if (!(await landsInside(dirname(to), opts.worktree))) {
        said.push(
          `${path} would land outside the worktree through a link in it, so it was not brought`,
        )
        continue
      }
      await mkdir(dirname(to), { recursive: true })
      if (opts.link) await symlink(from, to)
      else await copyFile(from, to, constants.COPYFILE_EXCL)
      brought.push(path)
    } catch (err) {
      said.push(`${path} could not be brought: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { brought, said }
}

/**
 * Whether a folder in the worktree is really in it: the nearest part of the
 * path that exists, with every link followed. The worktree is the base commit,
 * not the checkout, so a folder the checkout has may be a tracked link there —
 * and writing through it would put the checkout's secrets wherever it points.
 */
async function landsInside(dir: string, worktree: string): Promise<boolean> {
  const home = await realpath(worktree)
  let at = dir
  for (;;) {
    try {
      const real = await realpath(at)
      return real === home || real.startsWith(`${home}/`)
    } catch {
      const up = dirname(at)
      if (up === at) return false
      at = up
    }
  }
}

/** Give a new worktree what its project says it needs. Never throws: what went wrong is `said`. */
export async function prepareWorktree(opts: {
  root: string
  worktree: string
  configured?: PrepareConfig | undefined
}): Promise<Prepared> {
  try {
    const reading = readingOf(await sourcesIn(opts.worktree, opts.root), opts.configured)
    const { brought, said } = await bringFiles({
      root: opts.root,
      worktree: opts.worktree,
      patterns: reading.files,
      link: reading.link,
    })
    return { files: brought, setup: reading.setup, said: [...reading.unread, ...said] }
  } catch (err) {
    // A worktree that could not be prepared is still a worktree an agent can work in.
    return {
      files: [],
      setup: null,
      said: [`preparing it went wrong: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
}

/** What the journal's `task_created` says about preparing, where there was anything to say. */
export function preparedDetail(prepared: Prepared | undefined): Record<string, unknown> {
  if (!prepared) return {}
  return {
    ...(prepared.files.length > 0 ? { brought: prepared.files } : {}),
    ...(prepared.setup ? { setup: prepared.setup.command, setup_from: prepared.setup.from } : {}),
    ...(prepared.said.length > 0 ? { prepare_said: prepared.said } : {}),
  }
}

/** The setup a task's file keeps, or null: a task with none, or a file that will not read. */
async function setupOf(home: string, task: string): Promise<Setup | null> {
  const text = await readOr(join(taskDir(home, task), 'task.yaml'))
  if (text === null) return null
  try {
    const file = TaskFile.safeParse(parseYaml(text))
    if (!file.success || file.data.workspace === 'checkout') return null
    return file.data.setup ?? null
  } catch {
    return null
  }
}

/**
 * What runs in an agent's lane before it starts: the task's setup, for a
 * *new* agent only. `first` is the caller's to say — an opening instruction
 * and no conversation to come back to — because coming back to an agent must
 * never run its setup over the work it has done.
 */
export async function setupBefore(
  home: string,
  config: Config,
  task: string,
  first: boolean,
  /** Where its log goes, when not the task's own folder: an agent user's share (`shareSetupLog`). */
  log = setupLogPath(home, task),
): Promise<{ before?: { setup: Setup; log: string; root: string } }> {
  const project = config.projects[task.split('/')[0] ?? '']
  if (!first || !project) return {}
  const setup = await setupOf(home, task)
  const root = expandHome(project.root)
  return setup ? { before: { setup, log, root } } : {}
}

/** What an agent is told about its worktree's setup, where it has one. */
export async function setupTold(
  home: string,
  task: string,
  /** Where its log went, as `setupBefore` was told. */
  log = setupLogPath(home, task),
): Promise<{ setup?: { command: string; log: string } }> {
  const setup = await setupOf(home, task)
  return setup ? { setup: { command: setup.command, log } } : {}
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}
