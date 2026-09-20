import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

// Keeping a worker inside its own worktree.
//
// This exists because the harness has no permission system of its own: it runs
// with the permissions of whatever launched it. The orchestrator stays on the
// host because it has to drive your terminal; workers are the ones editing
// code on instructions from a model, and they are the ones contained.
//
// What it protects: writes. Your other repositories, your dotfiles, your keys
// and Tade's own state are read-only to a sandboxed worker.
//
// What it does not protect: reads. A worker can still read anything you can,
// because a toolchain that cannot read `~/.npmrc` or a global git config is a
// toolchain that does not work. Credential *reads* are a policy concern and
// are classified by the approval tiers, not by this.

export type SandboxKind = 'none' | 'bwrap' | 'seatbelt'

export interface Launch {
  command: string
  args: string[]
}

export interface SandboxSpec {
  kind: SandboxKind
  /** The one directory the worker may write to. */
  worktree: string
  /** Extra writable paths, for a toolchain with a cache somewhere unusual. */
  writable?: string[]
  /**
   * Files that are written by replacing them, whose temporary siblings start
   * with the same path: a harness's own config file, usually. A directory rule
   * cannot cover them without opening the whole directory they sit in.
   */
  writablePrefixes?: string[]
  platform?: NodeJS.Platform
  home?: string
  tmp?: string
}

export class SandboxUnavailableError extends Error {
  readonly code = 'SANDBOX_UNAVAILABLE'
  constructor(kind: SandboxKind, reason: string) {
    super(`cannot sandbox with ${kind}: ${reason}`)
    this.name = 'SandboxUnavailableError'
  }
}

/**
 * Caches a normal build needs to write. They are not secrets, and a sandbox
 * that breaks `npm install` is one everybody turns off.
 */
const CACHES = [
  'Library/Caches',
  '.cache',
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.bun',
  '.cargo',
  '.rustup',
  '.gradle',
  '.m2',
  '.deno',
]

/** Device nodes that every program writes to without thinking about it. */
const DEVICES = ['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/tty', '/dev/fd']

/**
 * Wrap a launch so it runs contained. `none` hands it back untouched.
 *
 * Asking for a sandbox that cannot be applied here throws rather than running
 * the worker unconfined: silently ignoring it would be worse than not offering
 * it, because the config would say one thing and the machine do another.
 */
export function sandboxed(launch: Launch, spec: SandboxSpec): Launch {
  const platform = spec.platform ?? process.platform
  switch (spec.kind) {
    case 'none':
      return launch
    case 'seatbelt':
      if (platform !== 'darwin') {
        throw new SandboxUnavailableError('seatbelt', `it is macOS only, and this is ${platform}`)
      }
      return {
        command: 'sandbox-exec',
        args: ['-p', seatbeltProfile(spec), launch.command, ...launch.args],
      }
    case 'bwrap':
      if (platform !== 'linux') {
        throw new SandboxUnavailableError('bwrap', `it is Linux only, and this is ${platform}`)
      }
      return { command: 'bwrap', args: [...bwrapArgs(spec), '--', launch.command, ...launch.args] }
    default:
      throw new SandboxUnavailableError(spec.kind, 'no such sandbox')
  }
}

/** Everywhere a contained worker is allowed to write. */
export function writablePaths(spec: SandboxSpec): string[] {
  const home = spec.home ?? homedir()
  const tmp = spec.tmp ?? tmpdir()
  return [
    spec.worktree,
    tmp,
    '/tmp',
    ...CACHES.map((cache) => join(home, cache)),
    ...(spec.writable ?? []),
  ]
}

/** The macOS profile, as SBPL. */
export function seatbeltProfile(spec: SandboxSpec): string {
  const writable = withPrivate(writablePaths(spec))
  return [
    '(version 1)',
    // Reads, network and exec stay as they were; only writes are narrowed.
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((path) => `(subpath ${quote(path)})`).join(' ')})`,
    ...(spec.writablePrefixes?.length
      ? [
          `(allow file-write* ${withPrivate(spec.writablePrefixes)
            .map((prefix) => `(regex ${quote(`^${escapeRegex(prefix)}`)})`)
            .join(' ')})`,
        ]
      : []),
    `(allow file-write-data ${DEVICES.map((path) => `(literal ${quote(path)})`).join(' ')})`,
    '(allow file-ioctl (literal "/dev/tty") (literal "/dev/dtracehelper"))',
  ].join('\n')
}

/** The Linux arguments. */
export function bwrapArgs(spec: SandboxSpec): string[] {
  // bwrap binds paths that exist; a file replaced through a temporary sibling
  // cannot be let through without its whole directory, and saying yes to a
  // prefix while binding the directory would be a sandbox that says one thing
  // and does another.
  if (spec.writablePrefixes?.length) {
    throw new SandboxUnavailableError(
      'bwrap',
      `it cannot let an agent write ${spec.writablePrefixes.join(', ')} without its whole folder`,
    )
  }
  const home = spec.home ?? homedir()
  const args = ['--die-with-parent', '--dev-bind', '/', '/', '--ro-bind', home, home]
  for (const path of writablePaths(spec)) args.push('--bind-try', path, path)
  return args
}

/**
 * On macOS `/tmp` and `/var` are symlinks into `/private`, and a profile that
 * names only one of the two forms silently fails to match the other.
 */
function withPrivate(paths: string[]): string[] {
  const out = new Set<string>()
  for (const path of paths) {
    out.add(path)
    if (path.startsWith('/tmp') || path.startsWith('/var')) out.add(`/private${path}`)
    if (path.startsWith('/private/')) out.add(path.slice('/private'.length))
  }
  return [...out]
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function quote(path: string): string {
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}
