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
  /** Where there is nothing to run: what to do instead, as a clause. */
  instead?: string
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
    install: {
      brew: 'git',
      apt: 'git',
      dnf: 'git',
      // Every Mac has one behind the command line tools, which is a download
      // Apple runs rather than a package anybody installs.
      instead: 'macOS: `xcode-select --install`, which is where its git comes from',
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
          ...(program.at ? { at: program.at } : {}),
          ...(program.install ? { install: program.install } : {}),
          needed: [reason],
          inUse: declaration.inUse,
        })
        continue
      }
      byCommand.set(program.command, {
        ...had,
        // Whoever declared one first says how it installs, and anybody
        // declaring one after fills in a row that had none: two ports needing
        // the same program is one row, and a row with no way to install it is
        // the one thing this fold could lose.
        ...((had.install ?? program.install) ? { install: had.install ?? program.install } : {}),
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
 */
export function updateWith(install: Install): UpdateCommand {
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
      return {
        cannot: `the system updates it — macOS: \`xcode-select --install\``,
      }
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
  if (how.brew && has('brew')) {
    return { command: `brew install ${how.cask ? '--cask ' : ''}${how.brew}` }
  }
  if (how.apt && has('apt-get')) return { command: `sudo apt-get install -y ${how.apt}` }
  if (how.dnf && has('dnf')) return { command: `sudo dnf install -y ${how.dnf}` }
  if (how.npm && has('npm')) return { command: `npm install --global ${how.npm}` }
  if (how.instead) return { cannot: how.instead }
  const offered = [
    how.brew ? 'Homebrew' : '',
    how.apt ? 'apt' : '',
    how.dnf ? 'dnf' : '',
    how.npm ? 'npm' : '',
  ].filter(Boolean)
  return offered.length === 0
    ? { cannot: 'nothing here says how to install it' }
    : { cannot: `it installs with ${offered.join(', ')}, and this machine has none of them` }
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
    // An install nobody can run and that says nothing instead is the one
    // shape that reads as an offer and is not one.
    const how = program.install
    if (how && !(how.brew || how.apt || how.dnf || how.npm || how.instead)) {
      problems.push(`${said}: says how to install it and names nothing to install`)
    }
    if (how?.cask && !how.brew) {
      problems.push(`${said}: a Homebrew cask with no name`)
    }
  }
  return problems
}
