// The programs Tade runs, and what it takes to keep them current.
//
// Tade shells out to other people's software — tmux to hold a lane, pi or
// Claude Code to be an agent, gh to open a review, git for everything. Which
// of them are needed is never a list written at a call site: each port
// declares what it needs and how to ask it its version (`programs` on
// WorkspaceDriver, WorkerAdapter and Forge), and this is where those
// declarations are folded together, read and compared.
//
// Everything here is pure. Looking a program up on PATH, asking it its
// version and asking a registry what is current are all I/O, and they live in
// the workbench, which does them once somebody asks. Nothing here is ever on
// a timer and nothing here touches the network.

/** A program something Tade runs needs on this machine, and how to see its version. */
export interface RequiredProgram {
  /** As it is run: `tmux`, `gh`, `pi`. */
  command: string
  /** What to call it where a person reads it: `GitHub CLI`. */
  title: string
  /** What it is needed for, as a clause: `keeping agents alive after Tade closes`. */
  why: string
  /** What makes it print its version, and nothing else: `['--version']`. */
  versionArgs: readonly string[]
  /** Whether Tade works without it. */
  optional?: boolean
  /**
   * The oldest version that works, where an older one does not: `3.2`. The
   * floor whoever needs it already holds itself to — the tmux driver's
   * `available()` refuses below the same one — said here too, so a list of
   * programs never ticks one that the step beside it calls too old.
   */
  oldest?: string
  /**
   * Where it actually is, for something that is not looked up on PATH: a
   * harness that ships with Tade runs the copy in Tade's own node_modules,
   * and reporting it missing because nothing on PATH answers to its name
   * would be a lie about the one it is actually running.
   */
  at?: string
  /**
   * How to put it on a machine that has not got it. Optional: a program
   * nobody knows how to install is said by name, which is better than a
   * command that installs the wrong thing.
   */
  install?: HowToInstall
}

/**
 * How a program gets onto a machine that has not got it, declared by whoever
 * needs it.
 *
 * It lives beside the declaration of needing it for the same reason
 * `versionArgs` does: a table of install commands in the setup wizard is a
 * table that goes stale the day somebody adds a harness, and the wizard is the
 * one place nobody would notice. Declaring it runs nothing — `installWith`
 * picks the command, a person reads it, and only then is it run in a terminal
 * they are watching.
 *
 * Only offer what you are sure of. A command that installs something else
 * under the same name is worse than no command at all, so a program whose
 * package Tade cannot vouch for declares `instead` and says where to get it.
 */
export interface HowToInstall {
  /** A Homebrew formula — or a cask, when `cask` says so. */
  brew?: string
  /** Whether the Homebrew name is a cask: two namespaces, and two different installs. */
  cask?: boolean
  /** A Debian or Ubuntu package. */
  apt?: string
  /** A Fedora package. */
  dnf?: string
  /** A package installed globally with npm, which is the same on every platform. */
  npm?: string
  /**
   * Where there is nothing to run: what to do instead, as a clause. One clause
   * where it is true everywhere (`cli.github.com has the package for your
   * system`), one per platform where it is not: a Mac's git comes from
   * `xcode-select --install`, which is no answer on Linux, and whisper.cpp is
   * built from source there. A platform nothing answers for is told plainly
   * that it cannot be installed here, never another platform's line.
   */
  instead?: string | PerPlatform
}

/** A clause for each platform it is true on, named as `process.platform` names them. */
export interface PerPlatform {
  darwin?: string
  linux?: string
}

/** A platform as a person calls it: `macOS`, `Linux`. */
export function platformSaid(platform: string): string {
  return platform === 'darwin' ? 'macOS' : platform === 'linux' ? 'Linux' : platform
}

/** What `instead` says on this platform, where it says anything. */
function insteadOn(how: HowToInstall, platform: string): string | undefined {
  const instead = how.instead
  if (typeof instead === 'string') return instead.trim() ? instead : undefined
  return instead?.[platform as keyof PerPlatform]?.trim() || undefined
}

/**
 * Whether a sentence names an installer — `brew install`, `apt-get install`.
 * A port says what is wrong and never which installer fixes it: it cannot know
 * whether this is a Mac with Homebrew or a server with apt, and setup says
 * this machine's line out of the port's `install` beside it.
 */
export function namesAnInstaller(text: string): boolean {
  return /\b(?:brew|apt|apt-get|dnf|yum|pacman) (?:install|upgrade)\b/.test(text)
}

/**
 * What Tade itself runs, whichever driver, harness and forge are in use.
 *
 * It is declared here rather than beside the check because it is a fact about
 * Tade, not about the page that shows it — the same reason every port
 * declares its own.
 */
export const TADE_PROGRAMS: readonly RequiredProgram[] = [
  {
    command: 'git',
    title: 'git',
    why: 'every reading of a project’s state, and every commit an agent makes',
    versionArgs: ['--version'],
    // `merge-tree --write-tree` (with `--name-only`, `--no-messages`, `-z`),
    // which forecasts conflicts, is 2.38's, and `worktree list -z`, which
    // finds every task's worktree, is 2.36's. Below them a project reads as
    // having no tasks: Ubuntu 22.04's own 2.34 answers `unknown switch 'z'`.
    oldest: '2.38',
    install: {
      brew: 'git',
      apt: 'git',
      dnf: 'git',
      // Every Mac has one behind the command line tools, which is a download
      // Apple runs rather than a package anybody installs — and a sentence
      // that is no answer anywhere else.
      instead: { darwin: '`xcode-select --install`, which is where a Mac’s git comes from' },
    },
  },
  {
    command: 'node',
    title: 'Node',
    why: 'Tade runs on it, and so does everything it starts',
    versionArgs: ['--version'],
    // The one that is running, never whatever else on PATH answers to the
    // name: Tade is running on this file, so reporting a different Node
    // — or none — would be a lie about the thing doing the reporting.
    at: process.execPath,
    install: { instead: 'nodejs.org, or a version manager: mise, nvm, volta' },
  },
]

/** One program, and everything that says it needs it. */
export interface ProgramNeed {
  command: string
  title: string
  versionArgs: readonly string[]
  /** Only when nothing that needs it needs it to work. */
  optional: boolean
  /** The oldest that works for everything that needs it: the latest of their floors. */
  oldest?: string
  /** Where it is, for what is not looked up on PATH. */
  at?: string
  /** How to install it, as whoever needs it declared. */
  install?: HowToInstall
  /** What needs it, what for, and whether that is what Tade is set up to use. */
  needed: readonly { what: string; why: string; inUse: boolean }[]
  /** Whether anything Tade is actually set up to use needs it. */
  inUse: boolean
}

/** What a port says it needs, with the words for who is saying it. */
export interface Declared {
  /** What is declaring: `the tmux driver`, `pi`, `GitHub`. */
  what: string
  /** Whether it is what Tade is set up to use, or merely something it could. */
  inUse: boolean
  programs: readonly RequiredProgram[]
}

/**
 * Every program the declarations add up to, each said once.
 *
 * Two ports needing `git` is one row with two reasons under it, and a program
 * only something unused needs is still listed — saying so — because a person
 * switching to tmux wants to know whether tmux is there before they switch,
 * not after. A program is required if anything requires it; one that
 * everything calls optional stays optional.
 */
export function neededPrograms(declarations: readonly Declared[]): ProgramNeed[] {
  const byCommand = new Map<string, ProgramNeed>()
  for (const declaration of declarations) {
    for (const program of declaration.programs) {
      const had = byCommand.get(program.command)
      const reason = { what: declaration.what, why: program.why, inUse: declaration.inUse }
      if (!had) {
        byCommand.set(program.command, {
          command: program.command,
          title: program.title,
          versionArgs: program.versionArgs,
          optional: program.optional === true,
          ...(program.oldest ? { oldest: program.oldest } : {}),
          ...(program.at ? { at: program.at } : {}),
          ...(program.install ? { install: program.install } : {}),
          needed: [reason],
          inUse: declaration.inUse,
        })
        continue
      }
      const floor = later(had.oldest, program.oldest)
      byCommand.set(program.command, {
        ...had,
        // Whoever declared one first says how it installs, and anybody
        // declaring one after fills in a row that had none: two ports needing
        // the same program is one row, and a row with no way to install it is
        // the one thing this fold could lose.
        ...((had.install ?? program.install) ? { install: had.install ?? program.install } : {}),
        // One version has to satisfy everything that needs it, so the floor
        // is the highest any of them declared.
        ...(floor ? { oldest: floor } : {}),
        // What actually asks it its version is whichever declaration wins the
        // row, and they must agree: two ports asking `git` two different ways
        // would be two versions of one program.
        optional: had.optional && program.optional === true,
        needed: [...had.needed, reason],
        inUse: had.inUse || declaration.inUse,
      })
    }
  }
  return [...byCommand.values()]
}

/** The later of two floors, either of which may be missing. */
function later(one: string | undefined, other: string | undefined): string | undefined {
  if (!one || !other) return one ?? other
  return compareVersions(one, other) >= 0 ? one : other
}

/** How a program got onto this machine, which is what decides how it moves forward. */
export type InstallManager =
  /** It ships with Tade, so Tade is what moves it forward. */
  | 'tade'
  | 'homebrew'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'volta'
  | 'mise'
  | 'asdf'
  | 'nvm'
  | 'system'
  | 'path'

export interface Install {
  manager: InstallManager
  /** What the manager calls it: a formula, a package. The command itself when it has no other name. */
  name: string
  /**
   * For Homebrew: which of the two it is. They are upgraded differently and
   * they are different namespaces — the cask `claude` is the desktop app and
   * the cask `claude-code` is the agent, so asking about the wrong one
   * answers confidently about something else entirely.
   */
  brew?: 'formula' | 'cask'
  /** Where it actually is, after following the links: what a person would recognise. */
  where: string
  /** How to say it: `Homebrew`, `a global npm package`, `a binary on PATH`. */
  said: string
  /** What the package says its version is, where the package says one. */
  version?: string
}

/** Where a program was found, as the machine answered. The I/O is the caller's. */
export interface ProgramPlace {
  /** What PATH resolved the command to. */
  path: string
  /** The same after following every link: where the bytes are. */
  realPath: string
  /**
   * The package the real path sits inside, when it sits inside one: the
   * nearest `package.json` above it with a name.
   */
  package?: { name: string; version?: string; dir: string } | null
  /** Whether it lives inside Tade's own tree, and so comes with Tade. */
  withinTade?: boolean
}

const BREW_PREFIXES = ['/opt/homebrew/', '/usr/local/Homebrew/', '/home/linuxbrew/.linuxbrew/']
const SYSTEM_DIRS = ['/usr/bin/', '/bin/', '/usr/sbin/', '/sbin/']

/** The manager a global package's path belongs to, read off the path itself. */
function packageManagerOf(path: string): InstallManager {
  if (/[/\\](?:\.)?pnpm(?:[/\\]|-global)/.test(path)) return 'pnpm'
  if (path.includes('/.bun/')) return 'bun'
  if (path.includes('/.yarn/') || path.includes('/yarn/global')) return 'yarn'
  if (path.includes('/.volta/')) return 'volta'
  return 'npm'
}

/**
 * How a program was installed, from where it is.
 *
 * Read off the path rather than asked of every package manager on the
 * machine: asking would mean running four programs to answer one question,
 * and the path is what actually decides which of them owns the file.
 */
export function installOf(place: ProgramPlace): Install {
  const { path, realPath } = place
  const both = `${path}\n${realPath}`
  // First, because it beats everything else: something inside Tade's own
  // tree came with Tade however Tade got here, and `npm install --global` on
  // it would install a second copy that nothing would ever run.
  if (place.withinTade) {
    return {
      manager: 'tade',
      name: place.package?.name ?? basename(path),
      where: realPath,
      said: 'shipped with Tade',
      ...(place.package?.version ? { version: place.package.version } : {}),
    }
  }
  const cellar = /[/\\]Cellar[/\\]([^/\\]+)[/\\]/.exec(realPath)
  const caskroom = /[/\\]Caskroom[/\\]([^/\\]+)[/\\]/.exec(realPath)
  if (cellar?.[1] || caskroom?.[1] || BREW_PREFIXES.some((prefix) => both.includes(prefix))) {
    const kind = cellar?.[1] ? 'formula' : caskroom?.[1] ? 'cask' : null
    return {
      manager: 'homebrew',
      name: cellar?.[1] ?? caskroom?.[1] ?? basename(path),
      where: realPath,
      said: kind === 'cask' ? 'a Homebrew cask' : 'Homebrew',
      ...(kind ? { brew: kind } : {}),
    }
  }
  const pkg = place.package
  if (pkg) {
    // Either side may be the one that names the manager: what PATH holds is
    // often a link in the manager's own folder, and what it points at is
    // often not.
    const manager = packageManagerOf(both)
    const said = manager === 'volta' ? 'a package Volta installed' : `a global ${manager} package`
    return {
      manager,
      name: pkg.name,
      where: realPath,
      said,
      ...(pkg.version ? { version: pkg.version } : {}),
    }
  }
  if (both.includes('/.asdf/')) {
    return { manager: 'asdf', name: basename(path), where: realPath, said: 'asdf' }
  }
  if (both.includes('/mise/') || both.includes('/.mise/')) {
    return { manager: 'mise', name: basename(path), where: realPath, said: 'mise' }
  }
  if (both.includes('/.nvm/')) {
    return { manager: 'nvm', name: basename(path), where: realPath, said: 'nvm' }
  }
  if (both.includes('/.volta/')) {
    return { manager: 'volta', name: basename(path), where: realPath, said: 'Volta' }
  }
  if (SYSTEM_DIRS.some((dir) => realPath.startsWith(dir))) {
    return {
      manager: 'system',
      name: basename(path),
      where: realPath,
      said: 'the system’s own',
    }
  }
  return { manager: 'path', name: basename(path), where: realPath, said: 'a binary on PATH' }
}

function basename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path
}

/** What to run to bring a program forward, or why Tade has nothing to say. */
export type UpdateCommand = { command: string } | { cannot: string }

/**
 * The exact command, so a person reads what will run before it runs.
 *
 * Where Tade cannot tell, it says so rather than guessing: a wrong `brew
 * upgrade` on something Homebrew does not own is a confusing failure, and a
 * right-looking one on something two managers both have is worse.
 *
 * The system's own copy is the one answer that depends on the machine rather
 * than on the program, so the declaration (`how`) and the machine are asked
 * for it: on a Mac it came with macOS, and on Linux it is the distribution's
 * package, which that distribution's package manager moves forward.
 */
export function updateWith(
  install: Install,
  how: HowToInstall | undefined,
  machine: InstallersHere,
): UpdateCommand {
  switch (install.manager) {
    case 'tade':
      return { cannot: 'it comes with Tade, so updating Tade is what moves it forward' }
    case 'homebrew':
      return {
        command: `brew upgrade ${install.brew === 'cask' ? '--cask ' : ''}${install.name}`,
      }
    case 'npm':
      return { command: `npm install --global ${install.name}@latest` }
    case 'pnpm':
      return { command: `pnpm add --global ${install.name}@latest` }
    case 'yarn':
      return { command: `yarn global add ${install.name}@latest` }
    case 'bun':
      return { command: `bun add --global ${install.name}@latest` }
    case 'volta':
      return { command: `volta install ${install.name}@latest` }
    case 'mise':
      return { command: `mise upgrade ${install.name}` }
    case 'asdf':
      return {
        cannot: `asdf installed it — \`asdf list\` says from which plugin`,
      }
    case 'nvm':
      return {
        cannot: `nvm installed it — \`nvm install --lts\` moves it and everything with it`,
      }
    case 'system':
      if (machine.platform === 'darwin') {
        return { cannot: 'macOS updates it with its command line tools, in Software Update' }
      }
      return (
        (how && systemUpgrade(how, machine)) ?? {
          cannot:
            machine.platform === 'linux'
              ? 'the distribution’s package manager updates it, with everything else it installed'
              : `${platformSaid(machine.platform)} updates it`,
        }
      )
    default:
      return {
        cannot: `a binary on PATH that nothing here claims`,
      }
  }
}

/** What to run to install a program, or why there is nothing to run. */
export type InstallCommand = { command: string } | { cannot: string }

/** What a machine can install with: what it is, and which managers are on it. */
export interface InstallersHere {
  platform: string
  /**
   * The package managers found on this machine, as they are run: `brew`,
   * `apt-get`, `dnf`, `npm`. Looking for them is I/O and the caller's.
   */
  managers: readonly string[]
  /**
   * Whether this runs as root, where the system's own manager needs no `sudo`
   * — and where, in a container most often, there is no `sudo` to ask.
   */
  root?: boolean
}

/**
 * The exact command that would install a program here, or why there is none.
 *
 * The machine's own package manager comes before a global npm install, because
 * something the system manages moves forward with everything else on it; npm
 * is the fallback and the only one that is the same on every platform. Only a
 * manager this machine actually has is offered — a `brew install` on a machine
 * with no Homebrew is a command that fails in a terminal somebody is watching,
 * which is a worse answer than saying where to get it.
 */
export function installWith(
  how: HowToInstall | undefined,
  machine: InstallersHere,
): InstallCommand {
  if (!how) return { cannot: 'nothing here says how to install it' }
  const has = (command: string) => machine.managers.includes(command)
  const mac = machine.platform === 'darwin'
  // A cask is a macOS application, and Homebrew on Linux has none to install.
  if (how.brew && has('brew') && (mac || !how.cask)) {
    return { command: `brew install ${how.cask ? '--cask ' : ''}${how.brew}` }
  }
  const sudo = machine.root ? '' : 'sudo '
  if (how.apt && has('apt-get')) return { command: aptInstall(how.apt, sudo) }
  if (how.dnf && has('dnf')) return { command: `${sudo}dnf install -y ${how.dnf}` }
  if (how.npm && has('npm')) return { command: `npm install --global ${how.npm}` }
  const instead = insteadOn(how, machine.platform)
  if (instead) return { cannot: instead }
  // Only what installs on this platform is named: Homebrew is no answer to a
  // Linux box that has not got it, and apt none to a Mac.
  const linux = machine.platform === 'linux'
  const offered = [
    how.brew && mac ? 'Homebrew' : '',
    how.apt && linux ? 'apt' : '',
    how.dnf && linux ? 'dnf' : '',
    how.npm ? 'npm' : '',
  ].filter(Boolean)
  if (offered.length === 0) {
    return {
      cannot: `cannot be installed here: nothing says how on ${platformSaid(machine.platform)}`,
    }
  }
  return {
    cannot: `it installs with ${offered.join(' or ')}, and this machine has ${offered.length === 1 ? 'not got it' : 'none of them'}`,
  }
}

/**
 * The line that brings the distribution's own copy of a package up to date,
 * where the declaration names one for a manager this machine has. apt's is
 * its install line, since installing a package that is there moves it to the
 * newest the lists have; dnf's install leaves one that is there alone, so its
 * is `upgrade`.
 */
function systemUpgrade(how: HowToInstall, machine: InstallersHere): InstallCommand | null {
  const has = (command: string) => machine.managers.includes(command)
  const sudo = machine.root ? '' : 'sudo '
  if (how.apt && has('apt-get')) return { command: aptInstall(how.apt, sudo) }
  if (how.dnf && has('dnf')) return { command: `${sudo}dnf upgrade -y ${how.dnf}` }
  return null
}

/**
 * The package lists first: a fresh server's are stale or, in a container,
 * absent, and `apt-get install` then fails to find a package that is there.
 * dnf refreshes its own.
 */
function aptInstall(name: string, sudo: string): string {
  return `${sudo}apt-get update && ${sudo}apt-get install -y ${name}`
}

/**
 * Whether a program here is older than the oldest that works. False whenever
 * nothing declared a floor or its version could not be read: a version
 * nobody can read is one nobody can call too old.
 */
export function belowOldest(have: string | null | undefined, oldest: string | undefined): boolean {
  return oldest !== undefined && isBehind(have ?? null, oldest)
}

/**
 * The exact command that would bring a program that is here but too old up
 * to date, or why there is none.
 *
 * Its own manager's update wherever it has one — `brew upgrade tmux`, and on
 * Linux the distribution's for the system's own copy. A Mac's own copy moves
 * only with macOS, so there a newer one is installed beside it: the same line
 * `installWith` offers where it is missing.
 */
export function upgradeWith(
  install: Install,
  how: HowToInstall | undefined,
  machine: InstallersHere,
): InstallCommand {
  const update = updateWith(install, how, machine)
  if ('command' in update || install.manager !== 'system' || !how) return update
  return installWith(how, machine)
}

/**
 * A version out of whatever a program prints: `git version 2.39.5 (Apple
 * Git-154)`, `v22.18.0`, `tmux 3.4`. Null when there is no version in it,
 * which is an answer — never a guess at one.
 */
export function parseVersion(text: string): string | null {
  // Not a word boundary: `v22.18.0` has one between the `.` and the `18`,
  // and half a version is worse than none.
  const found = /(?<![\d.])(\d+\.\d+(?:\.\d+)*(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)/.exec(text)
  return found?.[1] ?? null
}

/** -1, 0 or 1: `2.39.5` against `2.40.0`, with `1.0.0-rc1` before `1.0.0`. */
export function compareVersions(a: string, b: string): number {
  const split = (text: string) => {
    const [numbers = '', pre = ''] = text.split(/[-+]/, 2)
    return {
      parts: numbers.split('.').map((part) => Number.parseInt(part, 10) || 0),
      pre,
    }
  }
  const left = split(a)
  const right = split(b)
  const width = Math.max(left.parts.length, right.parts.length)
  for (let i = 0; i < width; i++) {
    const one = left.parts[i] ?? 0
    const other = right.parts[i] ?? 0
    if (one !== other) return one < other ? -1 : 1
  }
  if (left.pre === right.pre) return 0
  // A release is ahead of every prerelease of itself: 1.0.0 beats 1.0.0-rc1.
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

/** Whether `have` is older than `latest`. False whenever either is unreadable. */
export function isBehind(have: string | null, latest: string | null): boolean {
  if (!have || !latest) return false
  return compareVersions(have, latest) < 0
}

/**
 * What is wrong with a port's declaration, in words: the conformance suites
 * hold every driver, harness and forge to this one rule, so a new
 * implementation cannot declare a program nobody can look up or ask.
 * Empty when nothing is wrong, and empty for declaring nothing at all.
 */
export function declarationProblems(programs: readonly RequiredProgram[] | undefined): string[] {
  const problems: string[] = []
  for (const program of programs ?? []) {
    const said = program.command || '(no command)'
    if (!program.command.trim()) problems.push('a program with no command to run')
    if (program.command.includes('/')) {
      problems.push(`${said}: a path, not a command — it is looked up on PATH`)
    }
    if (!program.title.trim()) problems.push(`${said}: no title for a person to read`)
    if (!program.why.trim()) problems.push(`${said}: no reason it is needed`)
    if (program.versionArgs.length === 0) {
      problems.push(`${said}: no arguments that make it say its version`)
    }
    // A floor that reads as half a version would compare as something else.
    if (program.oldest !== undefined && parseVersion(program.oldest) !== program.oldest) {
      problems.push(`${said}: an oldest version that is not a version (${program.oldest})`)
    }
    // An install nobody can run and that says nothing instead is the one
    // shape that reads as an offer and is not one.
    const how = program.install
    const instead = how && (insteadOn(how, 'darwin') ?? insteadOn(how, 'linux'))
    if (how && !(how.brew || how.apt || how.dnf || how.npm || instead)) {
      problems.push(`${said}: says how to install it and names nothing to install`)
    }
    if (how?.cask && !how.brew) {
      problems.push(`${said}: a Homebrew cask with no name`)
    }
    // A Homebrew line and nothing else is a Mac's answer said to every
    // machine: a Linux box is owed its own line, its own steps, or a plain
    // word that there is none.
    if (how?.brew && !(how.apt || how.dnf || how.npm || insteadOn(how, 'linux'))) {
      problems.push(`${said}: says how to install it with Homebrew and nothing for Linux`)
    }
  }
  return problems
}
