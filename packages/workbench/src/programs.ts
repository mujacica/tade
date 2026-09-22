import { execFile } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  type Config,
  type Declared,
  type Install,
  installOf,
  isBehind,
  neededPrograms,
  type ProgramNeed,
  parseVersion,
  resolveCommand,
  stringEnv,
  TADE_PROGRAMS,
  type UpdateCommand,
  updateWith,
} from '@tade/core'
import { FORGES, forgeExec } from '@tade/status'
import { HARNESS_ADAPTERS } from './harnesses.ts'
import { drivers } from './registry.ts'

// Keeping what Tade runs current: the programs it shells out to, and Tade
// itself.
//
// Which programs those are is nobody's list here. Every driver, harness and
// forge declares what it needs and how to ask it its version, and this walks
// the three registries and folds the declarations together — so a new harness
// arrives with its own requirement and this file does not change.
//
// Two halves, deliberately: what is on this machine is read from the machine
// (`lookAtPrograms` — PATH, a `--version`, the path a binary sits on), and
// what is current is asked of a registry over the network
// (`askWhatIsCurrent`). Only the second touches the network, only when
// somebody asks for it, and it answers `null` — cannot tell — rather than
// guessing when nobody will say.

/** Running a probe the way the rest of Tade does: detached, timed out, never throwing. */
export type Exec = typeof forgeExec

export interface LookOptions {
  env?: NodeJS.ProcessEnv
  exec?: Exec
  /** Where Tade's own files are; only for saying where a driver's lanes live. */
  home?: string
}

export interface AskOptions extends LookOptions {
  fetch?: typeof fetch
  /** The registry to ask about packages. Its own so a test can answer for it. */
  npmRegistry?: string
}

/** One program, as this machine has it and as the world has it. */
export interface ProgramLook {
  need: ProgramNeed
  /** How it got here, or null when nothing on PATH answers to the command. */
  install: Install | null
  /** What it says its version is, or null when it would not say. */
  version: string | null
  /** The newest there is, or null when nobody was asked or nobody would say. */
  latest: string | null
  /** Why `latest` is null, in words. Null when it is known. */
  cannotTell: string | null
  /** What to run to bring it forward, or why there is nothing to run. */
  update: UpdateCommand
  behind: boolean
}

/** Tade itself: which one is running, whether there is a newer, and how to get it. */
export interface TadeLook {
  /** Its version, as its own package.json says. */
  version: string
  /** A checkout of the repository, or something installed. */
  from: 'checkout' | 'install'
  /** Where it is. */
  where: string
  branch: string | null
  commit: string | null
  /** How it was installed, when it was installed rather than cloned. */
  install: Install | null
  /** What is newer, in a clause a person reads. Null when nothing is, or nobody was asked. */
  newer: string | null
  cannotTell: string | null
  update: UpdateCommand
}

export interface UpdateLook {
  /** When it was read, so a page can say how old it is. */
  at: number
  tade: TadeLook
  programs: readonly ProgramLook[]
  /** Whether anything current was asked for: false until somebody asks. */
  asked: boolean
}

/**
 * What every driver, harness and forge says it needs, folded into one row per
 * program.
 *
 * Every registered implementation is asked, not only the ones in use: knowing
 * whether tmux is installed is what somebody wants *before* they switch to
 * it, and a row that says nothing here needs it yet is a better answer than
 * no row. Constructing one to ask is what the registries are for — the
 * alternative is a list of names at this call site, which is the thing the
 * ports were given a declaration to avoid.
 */
export async function programsNeeded(config: Config, home: string): Promise<ProgramNeed[]> {
  const declarations: Declared[] = [{ what: 'Tade', inUse: true, programs: TADE_PROGRAMS }]

  const workspace = config.workspace
  for (const [id, make] of Object.entries(drivers)) {
    const driver = make(home)
    declarations.push({
      what: `the ${id} driver`,
      inUse: workspace.driver === id || workspace.fallback === id,
      programs: driver.programs ?? [],
    })
    // Made only to be asked, so it is let go of again: a driver may take a
    // scratch folder to hold its lanes' output, and asking a question must
    // not leave one behind every time somebody asks.
    await driver.detach()
  }

  const harnessesInUse = new Set<string>([config.orchestrator.harness])
  for (const route of Object.values(config.workers.routes)) {
    harnessesInUse.add(route.harness)
    for (const named of Object.keys(route.harnesses ?? {})) harnessesInUse.add(named)
  }
  for (const [id, make] of Object.entries(HARNESS_ADAPTERS)) {
    // Only the declaration is read, and a constructor does no I/O — the
    // directories are what a launch would use, and nothing is launched.
    const adapter = make({
      runDir: join(home, 'runs'),
      socketDir: join(home, 'runs'),
      approvals: 'bypass',
    })
    declarations.push({
      what: id,
      inUse: harnessesInUse.has(id),
      programs: adapter.programs ?? [],
    })
  }

  // Every registered forge is one `forgeFor` may pick for a remote — it asks
  // each in turn which remotes are its own — unless somebody has sent a host
  // to a named forge, which is what `extensions.review.hosts` is.
  const sentTo = Object.values(
    (config.extensions.review as { hosts?: Record<string, string> } | undefined)?.hosts ?? {},
  )
  for (const [id, make] of Object.entries(FORGES)) {
    const forge = make({ exec: forgeExec })
    declarations.push({
      what: id,
      inUse: sentTo.length === 0 || sentTo.includes(id),
      programs: forge.programs ?? [],
    })
  }

  return neededPrograms(declarations)
}

/** A path with every link followed, or the path itself where it cannot be. */
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    // A link to nowhere: what we were given is all there is to go on.
    return path
  }
}

/** The nearest package above a file, when it sits inside one. */
function packageAbove(path: string): { name: string; version?: string; dir: string } | null {
  let dir = dirname(path)
  for (let up = 0; up < 8; up++) {
    try {
      const read = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown
        version?: unknown
      }
      if (typeof read.name === 'string' && read.name !== '') {
        return {
          name: read.name,
          dir,
          ...(typeof read.version === 'string' ? { version: read.version } : {}),
        }
      }
    } catch {
      // Not a package here, or not one we can read: keep going up.
    }
    const parent = dirname(dir)
    // Above the package folder is the store it lives in, whose own
    // package.json would be somebody else's.
    if (parent === dir || dir.endsWith('node_modules')) return null
    dir = parent
  }
  return null
}

/**
 * Where a program actually is, and what installed it. No network, one PATH walk.
 *
 * `at` is for what is not looked up on PATH at all — a harness that ships
 * with Tade — and anything found inside Tade's own tree is reported as
 * Tade's, because that is what moving it forward means.
 */
export function whereIs(
  command: string,
  env: NodeJS.ProcessEnv,
  opts: { at?: string; within?: string | null } = {},
): Install | null {
  const path = opts.at ?? resolveCommand(command, stringEnv(env))
  if (!path || !existsSync(path)) return null
  const realPath = real(path)
  // Both sides followed, or a home under a symlinked folder — /tmp on a Mac,
  // most obviously — makes everything look like somebody else's.
  //
  // `within: null` is for the one program nothing can be inside the tree of:
  // `tade` itself, which lives in its own package and would otherwise report
  // as shipped with Tade, which is a sentence about a harness rather than an
  // answer to how Tade got here.
  const within = opts.within === null ? null : real(opts.within ?? tadeRoot())
  return installOf({
    path,
    realPath,
    package: packageAbove(realPath),
    withinTade: within !== null && realPath.startsWith(`${within}/`),
  })
}

/**
 * What this machine has, program by program: where each is, how it got there
 * and what it says its version is.
 *
 * Nothing here touches the network, and nothing here is ever on a timer — it
 * runs a `--version` per program, which is a handful of processes and belongs
 * to somebody opening the page.
 */
export async function lookAtPrograms(
  needs: readonly ProgramNeed[],
  options: LookOptions = {},
): Promise<ProgramLook[]> {
  const env = options.env ?? process.env
  const exec = options.exec ?? forgeExec
  return Promise.all(
    needs.map(async (need): Promise<ProgramLook> => {
      const install = whereIs(need.command, env, need.at ? { at: need.at } : {})
      if (!install) {
        return {
          need,
          install: null,
          version: null,
          latest: null,
          cannotTell: 'it is not on your PATH, so there is nothing here to read a version from',
          update: { cannot: `nothing on your PATH answers to \`${need.command}\`` },
          behind: false,
        }
      }
      // Asked of the one that will actually run: for something that ships
      // with Tade, the copy in Tade's own folder, never whatever else on the
      // machine happens to answer to the same name.
      const said = await exec(need.at ?? need.command, need.versionArgs, { timeoutMs: 10_000 })
      // Some say it on stdout, some on stderr, and one that failed may still
      // have said it before it did.
      const version = parseVersion(`${said.stdout}\n${said.stderr}`)
      return {
        need,
        install,
        version,
        latest: null,
        cannotTell: 'nobody has been asked what is current',
        update: updateWith(install),
        behind: false,
      }
    }),
  )
}

/** The newest an npm registry has of a package. Null when it will not say. */
async function npmLatest(
  name: string,
  options: AskOptions,
): Promise<{ version: string } | { cannot: string }> {
  const registry = (options.npmRegistry ?? 'https://registry.npmjs.org').replace(/\/+$/, '')
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  try {
    const answer = await doFetch(`${registry}/${name.replace(/\//g, '%2F')}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!answer.ok) return { cannot: `${registry} answered ${answer.status} for ${name}` }
    const said = (await answer.json()) as { version?: unknown }
    if (typeof said.version !== 'string')
      return { cannot: `${registry} said nothing about ${name}` }
    return { version: said.version }
  } catch (err) {
    return { cannot: `${registry} could not be reached: ${(err as Error).message}` }
  }
}

/** The newest Homebrew has of a formula or cask. Null when it will not say. */
async function brewLatest(
  install: Install,
  options: AskOptions,
): Promise<{ version: string } | { cannot: string }> {
  const exec = options.exec ?? forgeExec
  const name = install.name
  // Formulae and casks are two namespaces, and Homebrew answers about
  // whichever it finds first: `claude` is the desktop app and `claude-code`
  // is the agent, so which one is being asked about is said outright.
  const which =
    install.brew === 'cask' ? ['--cask'] : install.brew === 'formula' ? ['--formula'] : []
  const said = await exec('brew', ['info', '--json=v2', ...which, name], { timeoutMs: 30_000 })
  if (said.code !== 0) {
    return {
      cannot:
        `brew would not say what is current: ${said.stderr.trim().split('\n')[0] ?? ''}`.trim(),
    }
  }
  try {
    const read = JSON.parse(said.stdout) as {
      formulae?: { versions?: { stable?: unknown } }[]
      casks?: { version?: unknown }[]
    }
    const stable = read.formulae?.[0]?.versions?.stable
    if (typeof stable === 'string') return { version: stable }
    const cask = read.casks?.[0]?.version
    // A cask's version is `2.1.236,c38127e2…`: the version, then the build it
    // was cut from, which is not part of any comparison.
    if (typeof cask === 'string') return { version: cask.split(',')[0] ?? cask }
    return { cannot: `brew knows ${name} but did not say a version` }
  } catch {
    return { cannot: 'brew answered in a shape Tade does not recognise' }
  }
}

/**
 * What is current, asked of whoever publishes it.
 *
 * This is the half that touches the network, and it only ever runs because
 * somebody asked. A manager that cannot be asked — a binary somebody dropped
 * on their PATH — comes back as cannot tell, which is an answer.
 */
export async function askWhatIsCurrent(
  looks: readonly ProgramLook[],
  options: AskOptions = {},
): Promise<ProgramLook[]> {
  return Promise.all(
    looks.map(async (look): Promise<ProgramLook> => {
      const install = look.install
      if (!install) return look
      const answer =
        install.manager === 'homebrew'
          ? await brewLatest(install, options)
          : install.manager === 'tade'
            ? // Asking npm what is newest would answer about a package
              // nothing here would ever run: this one moves with Tade.
              { cannot: 'it comes with Tade, and moves when Tade does' }
            : ['npm', 'pnpm', 'yarn', 'bun', 'volta'].includes(install.manager)
              ? await npmLatest(install.name, options)
              : {
                  cannot: `cannot ask what is current for ${install.said}`,
                }
      if ('cannot' in answer) return { ...look, latest: null, cannotTell: answer.cannot }
      // What the package says about itself beats what the program prints:
      // `claude --version` and the package version are the same number, but a
      // program that will not say its version still has a package that does.
      const have = look.version ?? install.version ?? null
      return {
        ...look,
        latest: answer.version,
        cannotTell: null,
        behind: isBehind(have, answer.version),
      }
    }),
  )
}

/**
 * The repository or package Tade itself is running out of.
 *
 * Recognised by what is under it rather than by what it is called, because it
 * is called two things: the checkout is `tade`, and the published package is
 * `tade-sh`, which is the name npm had free. Both hold the CLI at the same
 * path, and the tarball keeps this file at the same depth below it, so one
 * rule answers for both and a rename of either cannot quietly break it.
 */
const CLI = join('packages', 'cli', 'src')

function tadeRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let up = 0; up < 8; up++) {
    if (existsSync(join(dir, '.git'))) return dir
    if (existsSync(join(dir, CLI, 'bin.ts')) || existsSync(join(dir, CLI, 'bin.js'))) return dir
    try {
      const read = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: unknown }
      if (read.name === 'tade') return dir
    } catch {
      // Keep going up.
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dir
}

function versionAt(root: string): string {
  try {
    const read = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version?: unknown
    }
    return typeof read.version === 'string' ? read.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const run = promisify(execFile)

/** git, in Tade's own checkout. Empty when it would not answer. */
async function inRepo(root: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', root, ...args], {
      timeout: 15_000,
      windowsHide: true,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

/**
 * Which Tade is running, and whether there is a newer one.
 *
 * A checkout is the ordinary case and it is answered with git: what the
 * upstream branch points at now (`ls-remote`, which fetches nothing), against
 * what this checkout is on. Where the remote commit is one this checkout
 * already contains, there is nothing to pull and it says so, rather than
 * offering a `git pull` that would do nothing.
 */
export async function lookAtTade(options: AskOptions & { ask?: boolean } = {}): Promise<TadeLook> {
  const root = tadeRoot()
  const version = versionAt(root)
  const env = options.env ?? process.env
  if (!existsSync(join(root, '.git'))) {
    const install = whereIs('tade', env, { within: null })
    const base: TadeLook = {
      version,
      from: 'install',
      where: install?.where ?? root,
      branch: null,
      commit: null,
      install,
      newer: null,
      cannotTell: install
        ? 'nobody has been asked what is current'
        : 'Tade is not on your PATH, so Tade cannot tell how it was installed',
      update: install ? updateWith(install) : { cannot: 'Tade cannot tell how it was installed' },
    }
    if (!options.ask || !install) return base
    const answer =
      install.manager === 'homebrew'
        ? await brewLatest(install, options)
        : await npmLatest(install.name, options)
    if ('cannot' in answer) return { ...base, cannotTell: answer.cannot }
    const have = version === '0.0.0' ? (install.version ?? null) : version
    return {
      ...base,
      cannotTell: null,
      newer: isBehind(have, answer.version) ? `${answer.version} is out` : null,
    }
  }

  const commit = (await inRepo(root, ['rev-parse', '--short', 'HEAD'])) || null
  const branch = (await inRepo(root, ['rev-parse', '--abbrev-ref', 'HEAD'])) || null
  const base: TadeLook = {
    version,
    from: 'checkout',
    where: root,
    branch,
    commit,
    install: null,
    newer: null,
    cannotTell: 'nobody has been asked what is current',
    update: { command: `git -C ${root} pull --ff-only && pnpm install` },
  }
  if (!options.ask) return base

  const upstream = await inRepo(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (!upstream.includes('/')) {
    return {
      ...base,
      cannotTell: `${branch ?? 'this branch'} is not following a remote branch, so there is nothing to compare it to`,
      update: { cannot: 'this checkout follows no remote branch' },
    }
  }
  const [remote = 'origin', ...rest] = upstream.split('/')
  const remoteBranch = rest.join('/')
  const listed = await inRepo(root, ['ls-remote', remote, `refs/heads/${remoteBranch}`])
  const theirs = listed.split(/\s+/)[0] ?? ''
  if (!/^[0-9a-f]{7,40}$/.test(theirs)) {
    return { ...base, cannotTell: `${remote} could not be reached, so Tade cannot tell` }
  }
  const mine = await inRepo(root, ['rev-parse', 'HEAD'])
  if (theirs === mine) return { ...base, cannotTell: null, newer: null }
  const known = await inRepo(root, ['cat-file', '-t', theirs])
  if (known === 'commit') {
    const contains = await run('git', ['-C', root, 'merge-base', '--is-ancestor', theirs, 'HEAD'], {
      timeout: 15_000,
      windowsHide: true,
    }).then(
      () => true,
      () => false,
    )
    if (contains) {
      return {
        ...base,
        cannotTell: null,
        newer: null,
        update: { cannot: `this checkout is ahead of ${upstream}: there is nothing to pull` },
      }
    }
  }
  return {
    ...base,
    cannotTell: null,
    newer: `${upstream} is at ${theirs.slice(0, 7)} and this checkout is on ${commit ?? 'something else'}`,
  }
}

/**
 * Everything at once: what is installed here, and — only when asked — what is
 * current. This is what the Updates page and `tade update` both read.
 */
export async function lookAtUpdates(
  config: Config,
  home: string,
  options: AskOptions & { ask?: boolean } = {},
): Promise<UpdateLook> {
  const needs = await programsNeeded(config, home)
  const here = await lookAtPrograms(needs, options)
  const [programs, tade] = await Promise.all([
    options.ask ? askWhatIsCurrent(here, options) : Promise.resolve(here),
    lookAtTade(options),
  ])
  return { at: Date.now(), tade, programs, asked: options.ask === true }
}
