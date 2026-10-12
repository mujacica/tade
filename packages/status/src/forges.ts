import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { located } from '@tade/core'
import { makeGithubForge } from '@tade/forge-github'
import { makeScriptedForge } from '@tade/forge-scripted'
import type { CredentialCache, ExecResult, Forge, ForgeOptions } from '@tade/forges-core'
import { CREDENTIAL_KEEP_MS, credentialCache, hostOf, repoOf } from '@tade/forges-core'
import { execa } from 'execa'

// The forges there are, by name: the one registry every call site goes
// through, so adding GitLab is an implementation and a line here — never a
// `new` somewhere that assumed there was only ever GitHub.
//
// It lives here rather than beside the port because the port must not import
// its own implementations, and `packages/status` is the lowest thing that
// needs one: a task's `merged` state is decided by what the forge says, and
// status answers with the window closed. Everything above — the review
// extension, the window, the CLI — reaches a forge through this.
//
// `scripted` is registered and never chosen for anybody: a forge that answers
// from a table is what tests and demos use, so whoever wants it names it.

export const FORGES: Readonly<Record<string, (opts: ForgeOptions) => Forge>> = {
  github: makeGithubForge,
  scripted: makeScriptedForge,
}

export interface ForgeChoice extends ForgeOptions {
  /** Which forge serves a host, for an enterprise install: `git.acme.com=github`. */
  hostForges?: Readonly<Record<string, string>>
}

/**
 * The forge for a remote: the one the config names for its host, else the
 * first registered one that says it serves it. Null when nothing does — a
 * remote with no forge is not an error, it is a repository Tade only reads
 * git from.
 *
 * Whichever it is, it comes back **already asking as the account the remote
 * names** (`placeOf`). This is the one place that binding is done, so the
 * branch watch, the review watches, `checksOn` and every tool get one answer
 * rather than each working it out — and none of them has to be handed a remote
 * to get it right.
 */
export function forgeFor(remote: string, choice: ForgeChoice): Forge | null {
  const host = hostOf(remote)
  if (!host) return null
  const options = { ...choice, credentials: choice.credentials ?? credentialsOf(choice.exec) }
  const named = options.hostForges?.[host]
  if (named) {
    const make = FORGES[named]
    // A host pointed at a forge nobody registered is a config mistake, and a
    // silent fall back to GitHub would be the wrong kind of helpful.
    if (!make) return null
    return asItsAccount(make, remote, { ...options, hosts: [host, ...(options.hosts ?? [])] })
  }
  for (const make of Object.values(FORGES)) {
    const forge = asItsAccount(make, remote, options)
    if (forge) return forge
  }
  return null
}

/**
 * A forge made to ask as whoever the remote says the repository belongs to.
 *
 * The project's own word beats the machine's: `accounts` in the config is
 * about a host and cannot know that one repository on it is a second
 * account's, while an SSH alias in the remote is exactly that statement. Null
 * where this forge does not serve the remote at all.
 */
function asItsAccount(
  make: (opts: ForgeOptions) => Forge,
  remote: string,
  options: ForgeChoice,
): Forge | null {
  const forge = make(options)
  const place = forge.placeOf(remote)
  if (!place) return null
  if (!place.account || options.accounts?.[place.host] === place.account) return forge
  return make({ ...options, accounts: { ...options.accounts, [place.host]: place.account } })
}

/**
 * Where what a forge had to run a program to find is kept between looks: one
 * cache per way of running programs, because the `gh` one runs is the `gh` that
 * answered. In memory only — `credentialCache` says what is kept and for how long.
 */
const credentials = new WeakMap<ForgeOptions['exec'], CredentialCache>()

function credentialsOf(exec: ForgeOptions['exec']): CredentialCache {
  let kept = credentials.get(exec)
  if (!kept) {
    kept = credentialCache()
    credentials.set(exec, kept)
  }
  return kept
}

/**
 * Running a program the way the rest of status does: detached and from its
 * absolute path, so the terminal Tade runs in is never retitled after `gh`,
 * and never throwing.
 */
export async function forgeExec(
  command: string,
  args: readonly string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const r = await execa(located(command), [...args], {
    reject: false,
    detached: true,
    timeout: options.timeoutMs ?? 10_000,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  })
  return {
    code: typeof r.exitCode === 'number' ? r.exitCode : 1,
    stdout: typeof r.stdout === 'string' ? r.stdout : '',
    stderr: typeof r.stderr === 'string' ? r.stderr : '',
  }
}

// --- the narrow seam: which forge serves a checkout, and as whom
//
// Here rather than in the review extension because two extensions now need the
// same two answers — where a project's work goes, and which sign-in reaches it
// — and the second one must not import the first to get them. What the review
// extension has around this (the shared poll, the filters, the tools, the
// snapshot) is *its* and stays there; this is the part that is nobody's.
//
// It takes the pieces rather than an `ExtensionContext` on purpose: `status`
// answers with the window closed and must not depend on the extension port to
// do it. Credentials are read where they live, used, and never written down.

/** Where a checkout's work goes, and whose sign-in reaches it. */
export interface ForgePlace {
  /** The repository as its forge names it: `owner/name`. */
  repo: string
  remote: string
  /** The forge's own host, with any SSH alias in the remote resolved away. */
  host: string
  /**
   * The sign-in the remote names, when it names one. The forge is already
   * asking as it; this is here for the sentences, so "no access" can say whose
   * access it is talking about.
   */
  account: string | null
  forge: Forge
}

/**
 * A checkout's `origin`, as git has it. Empty when it has none — not an error.
 *
 * Asked of git once and kept while the file it is written in has not changed:
 * every look at a project asks this first, and it was a process a minute per
 * project for an answer that changes when somebody runs `git remote`. Git
 * rewrites its config by renaming a new file over it, so a changed remote is a
 * changed inode however coarse the clock. What the stamp cannot see — an
 * included file, the global config — is read again after `CREDENTIAL_KEEP_MS`.
 *
 * Only a remote found is kept. "Not set" and "git did not answer in time" are
 * one exit code through some runners, and a look that could not look must not
 * be kept as nothing there.
 */
export async function remoteAt(
  exec: ForgeOptions['exec'],
  root: string,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<string> {
  const at = (options.now ?? Date.now)()
  const stamp = await configStamp(root)
  const remembered = stamp ? remotes.get(exec)?.get(root) : undefined
  if (remembered?.stamp === stamp && at - remembered.at < CREDENTIAL_KEEP_MS) {
    return remembered.remote
  }
  const got = await exec('git', ['-C', root, 'config', '--get', 'remote.origin.url'], {
    timeoutMs: options.timeoutMs ?? 5_000,
  })
  const remote = got.code === 0 ? got.stdout.trim() : ''
  if (stamp && remote) {
    let known = remotes.get(exec)
    if (!known) {
      known = new Map()
      remotes.set(exec, known)
    }
    known.set(root, { remote, stamp, at })
  }
  return remote
}

/** What `remoteAt` found, per way of running git and per checkout. */
const remotes = new WeakMap<
  ForgeOptions['exec'],
  Map<string, { remote: string; stamp: string; at: number }>
>()

/**
 * Which version of a checkout's git config is on disk, without running git:
 * `.git/config` for a repository, and for a worktree or a submodule — whose
 * `.git` is a file naming its own git directory — the config of the repository
 * that directory's `commondir` names. Null where there is no such file to look
 * at, and then nothing is kept.
 */
async function configStamp(root: string): Promise<string | null> {
  try {
    const dotGit = join(root, '.git')
    const found = await stat(dotGit)
    let dir = dotGit
    if (!found.isDirectory()) {
      // Only a regular file is read, as git does: anything else here — a fifo
      // somebody made — would be a read that never comes back.
      if (!found.isFile()) return null
      const named = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim()
      if (!named) return null
      const own = resolve(root, named)
      const common = await readFile(join(own, 'commondir'), 'utf8').then(
        (text) => text.trim(),
        () => '',
      )
      dir = common ? resolve(own, common) : own
    }
    const config = await stat(join(dir, 'config'))
    return `${config.dev}:${config.ino}:${config.size}:${config.mtimeMs}`
  } catch {
    return null
  }
}

/**
 * The forge a checkout's work goes to, or why there is none. Never throws: a
 * checkout with no remote is one Tade only reads git from.
 *
 * **Nothing here asks the machine whose repository this is.** The remote is the
 * declaration (`placeOf`), `forgeFor` binds the account it names, and that is
 * the whole of it — no sign-in is tried in turn, no active login is read and
 * none is changed. A caller wanting a second account's repository writes it in
 * the remote, which is what an SSH host alias already is.
 */
export async function forgeAt(
  root: string,
  options: ForgeChoice,
): Promise<ForgePlace | { problem: string }> {
  const remote = await remoteAt(options.exec, root, options.now ? { now: options.now } : {})
  if (!remote) return { problem: `${root} has no remote: there is nothing to push to` }
  const repo = repoOf(remote)
  const forge = forgeFor(remote, { ...options, cwd: options.cwd ?? root })
  if (!repo || !forge) return { problem: `no forge serves ${remote}` }
  // Where it goes and whose it is, read out of the remote once: everything
  // after this says `host` rather than reading the URL again, because an SSH
  // alias is a name for this machine and never a host to build a URL from.
  const place = forge.placeOf(remote)
  return {
    repo,
    remote,
    host: place?.host ?? hostOf(remote) ?? '',
    account: place?.account ?? null,
    forge,
  }
}
