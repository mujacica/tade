import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  type AgentPush,
  type AgentRemote,
  type AgentSignIn,
  type AgentUserSeen,
  agentAccountDir,
  agentShare,
  agentUserOf,
  asAgent,
  type Config,
  expandHome,
  groupFromLogin,
  PUSH_KEY,
  producesPath,
  producesProblem,
  pushTry,
  resolveCommand,
  runProgram,
  type SignInLaunch,
  shareRuns,
  shareSockets,
  shareTask,
  taskDir,
  taskFolder,
} from '@tade/core'
import type { SandboxProof, SignInProof, WorkerAdapter } from '@tade/harnesses-core'
import { git, repositoryNamed } from '@tade/status'
import { documentsFolder } from './documents.ts'
import { HARNESS_ADAPTERS, type HarnessOptions } from './harnesses.ts'
import { taskContextPath } from './tasks.ts'

// Running agents as a user of their own, the half that touches the machine.
// What the user, the launch line and the commands are is `core/src/agent-user.ts`.

/** An agent user as a launch needs it: who, where its home is, and its share. */
export interface AgentUser {
  name: string
  home: string
  share: string
}

/** Tade's own user, which `agents.user` is compared with. */
export function ownUser(): string {
  return userInfo().username
}

/**
 * Whether a failed look is the answer "no" — not there, or not this user's to
 * open — rather than a look that could not be made, which is thrown.
 */
function answersNo(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code
  return code === 'ENOENT' || code === 'EACCES' || code === 'EPERM' || code === 'ENOTDIR'
}

/** What `fs` answered, or `no` where the answer is that it is not there or not ours. */
function orNo<N>(no: N): (err: unknown) => N {
  return (err: unknown) => {
    if (answersNo(err)) return no
    throw err
  }
}

/** Long enough for `getent` or `sudo -n` on a box under load, short enough for a window. */
const ASK_MS = 10_000

/**
 * A user's home, from the password file — and from `getent` where the user
 * is in a directory the file does not hold — or null where there is no such
 * user. Thrown only where the file is there and cannot be read.
 */
export async function homeOf(user: string, passwd = '/etc/passwd'): Promise<string | null> {
  const lines = await readFile(passwd, 'utf8').catch(orNo(''))
  for (const line of lines.split('\n')) {
    const fields = line.split(':')
    if (fields[0] === user && fields[5]) return fields[5]
  }
  const said = await runProgram('getent', ['passwd', user], { timeoutMs: ASK_MS })
  const home = said.code === 0 ? said.stdout.trim().split(':')[5] : undefined
  return home ? home : null
}

/**
 * Who a task's agents run as, where it is not Tade's own user, with that
 * user's home and share — or null. Throws where the config names a user this
 * machine does not have, since starting the agent as Tade instead would be
 * the one answer the config said no to.
 */
export async function agentUserFor(
  config: Config,
  project: string,
  self: string,
): Promise<AgentUser | null> {
  const name = agentUserOf(config, project, self)
  if (!name) return null
  const home = await homeOf(name)
  if (!home) {
    throw new Error(
      `${project}'s agents run as ${name}, and there is no user ${name} here: tade setup makes one, each command shown first`,
    )
  }
  return { name, home, share: agentShare(home) }
}

/**
 * Refuse a launch whose share Tade cannot write in, with what to do — rather
 * than a lane that ends on a socket nobody could make.
 */
export async function shareReady(user: AgentUser): Promise<void> {
  const ok = await access(user.share, constants.W_OK | constants.X_OK)
    .then(() => true)
    .catch(orNo(false))
  if (!ok) {
    throw new Error(
      `agents here run as ${user.name}, and ${user.share} is not there for Tade to write in: tade setup makes it, and ${groupFromLogin(ownUser(), user.name)}`,
    )
  }
}

/**
 * Close Tade's home to everybody else, where agents run as another user:
 * `0700`, so nothing in it — the journal, the device list, every task's file,
 * `config.yaml` — can be opened by them, whatever its own mode. Narrowed and
 * never widened, like `config.yaml`'s `0600`; says whether it changed anything.
 */
export async function closeHome(home: string): Promise<boolean> {
  const mode = await stat(home)
    .then((info) => info.mode & 0o777)
    .catch(orNo(null))
  if (mode === null || (mode & 0o077) === 0) return false
  await chmod(home, mode & 0o700)
  return true
}

/**
 * A task's context file, copied into its agent's share where the agent runs
 * as a user Tade's home is closed to, and the path it is told instead — or
 * null where there is none. Its attachments come with it, and a path inside
 * the task's own folder is rewritten to the copy's, so a screenshot the
 * context names is one the agent can open. Copied at every start, so what the
 * agent reads is what the task says now.
 */
export async function contextFor(
  home: string,
  task: string,
  user: AgentUser,
): Promise<string | null> {
  const context = taskContextPath(home, task)
  const text = await readFile(context, 'utf8').catch(orNo(null))
  if (text === null) return null
  const from = taskDir(home, task)
  const to = shareTask(user.share, taskFolder(task))
  await mkdir(to, { recursive: true, mode: 0o770 })
  const attachments = join(from, 'attachments')
  await rm(join(to, 'attachments'), { recursive: true, force: true })
  if (await exists(attachments)) await cp(attachments, join(to, 'attachments'), { recursive: true })
  const copy = join(to, 'context.md')
  await writeFile(copy, text.replaceAll(from, to), { mode: 0o640 })
  return copy
}

/**
 * Where a task's agent writes the document it produces, as a user Tade's home
 * is closed to: its folder in the share, under the name the task gives it.
 */
export function sharedDocument(task: string, user: AgentUser, produces: string): string {
  return join(shareTask(user.share, taskFolder(task)), produces.trim())
}

/**
 * Bring the document an agent of its own user wrote in its share into Tade's
 * home, where every other document is read from — copied, never moved, since
 * the agent may go on writing it — and say whether there was one. A name Tade
 * would not have written is never joined onto a path (`producesProblem`).
 */
export async function bringDocumentHome(
  home: string,
  task: string,
  user: AgentUser,
  produces: string,
): Promise<boolean> {
  if (producesProblem(produces)) return false
  const from = sharedDocument(task, user, produces)
  if (!(await exists(from))) return false
  const to = producesPath(home, task, produces)
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to)
  return true
}

/**
 * The project's documents folder as an agent of its own user reads it, and
 * the path it is told — or null where the project has none yet.
 *
 * Tade's home is closed to that user, so the folder is copied into its share
 * at every start, read-only through the group: Tade's files, the group's to
 * read — `0640`, folders `2750` — which the agent can neither change nor add
 * to. Only what changed is copied again, each file under a name of its own
 * and renamed into place, so another agent of the project reading it
 * meanwhile never reads half a file; what went from the folder goes from the
 * copy. Links are not followed: a document is a file Tade wrote, and a link
 * would hand the agent whatever it points at.
 */
export async function documentsFor(
  home: string,
  project: string,
  user: AgentUser,
): Promise<string | null> {
  const from = documentsFolder(home, project)
  if (!from) return null
  const shared = join(user.share, 'documents')
  const to = join(shared, project)
  // One copy at a time into one place: two agents of a project starting
  // together would otherwise sweep away each other's half-written files.
  // The one before's failure is its own caller's: this copy goes ahead either way.
  const before = mirroring.get(to) ?? Promise.resolve()
  const copy = async () => {
    await readOnlyFolder(shared)
    await mirror(from, to)
  }
  const now = before.then(copy, copy)
  mirroring.set(to, now)
  try {
    await now
  } finally {
    if (mirroring.get(to) === now) mirroring.delete(to)
  }
  return to
}

const mirroring = new Map<string, Promise<void>>()

/** A folder the group can read and not write: made where it is not, narrowed where it is ours. */
async function readOnlyFolder(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await chmod(dir, 0o2750).catch(orNo(undefined))
}

/** `from` made again at `to`, copying only what changed (`documentsFor`). */
async function mirror(from: string, to: string): Promise<void> {
  await readOnlyFolder(to)
  const kept = new Set<string>()
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      kept.add(entry.name)
      await mirror(source, target)
      continue
    }
    if (!entry.isFile()) continue
    kept.add(entry.name)
    const [was, copy] = await Promise.all([stat(source), stat(target).catch(orNo(null))])
    if (copy?.isFile() && copy.size === was.size && copy.mtimeMs === was.mtimeMs) continue
    const writing = `${target}.tade-${randomUUID()}`
    await copyFile(source, writing)
    await chmod(writing, 0o640)
    await utimes(writing, was.atime, was.mtime)
    await rename(writing, target)
  }
  for (const entry of await readdir(to)) {
    if (!kept.has(entry)) await rm(join(to, entry), { recursive: true, force: true })
  }
}

/**
 * Why a conversation is not carried into an agent of its own user, in words:
 * carrying is a file Tade writes beside that user's own, and one Tade wrote is
 * one that user's harness cannot open.
 */
export function carryRefused(user: string): string {
  return `carrying a conversation into an agent that runs as ${user} is not available: it would be a copy Tade wrote among ${user}'s own, which ${user}'s harness cannot open, so it would start over while looking as though it had carried on`
}

/**
 * Where a task's setup log is written, where its agent runs as a user of its
 * own: in the share, since the setup runs in the agent's lane as that user.
 */
export function shareSetupLog(task: string, user: AgentUser): string {
  return join(shareTask(user.share, taskFolder(task)), 'setup.log')
}

/**
 * What else an agent's sandbox has to let it write besides its working
 * folder (`WorkerSpec.sandbox`): the repository's own git folder — a commit
 * writes objects and refs there — and the package caches in its user's home,
 * so an install inside the sandbox works.
 *
 * The git folder even where it is inside the working folder, as a checkout's
 * is: Codex's `workspace-write` keeps a `.git` in a writable folder read-only
 * unless it is named itself, so a Codex agent in a checkout could not commit
 * (`.git/index.lock: Read-only file system`, found on Ubuntu 24.04 and the
 * same under Seatbelt).
 */
export async function sandboxWrites(cwd: string, user: AgentUser): Promise<string[]> {
  const said = await git(cwd, ['rev-parse', '--git-common-dir'])
  const common = said.ok ? resolve(cwd, said.stdout.trim()) : null
  return [
    ...(common ? [common] : []),
    join(user.home, '.cache'),
    join(user.home, '.npm'),
    join(user.home, '.local', 'share', 'pnpm'),
  ]
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(orNo(false))
}

/** `sudo -n -u <user>`, run with a deadline: never asks, never waits on a person. */
function asUser(user: string, args: readonly string[], timeoutMs = ASK_MS) {
  return runProgram('sudo', ['-n', '-H', '-u', user, '--', ...args], { timeoutMs })
}

/**
 * What setup knows of one agent user, looked at: the password file, the
 * group file through `id`, one `sudo -n` that runs `true`, its share, its git
 * and its projects' roots. Something not there or not Tade's to open is a
 * `false` the step says how to fix; a look that could not be made at all is
 * thrown, and setup says that instead (`AgentsHere.problem`).
 */
export async function lookAtAgentUser(
  user: string,
  self: string,
  roots: readonly string[],
  tadeHome: string,
  /** The harnesses in use whose sandbox to try as that user (`WorkerAdapter.sandboxProof`). */
  proofs: readonly { harness: string; proof: SandboxProof }[] = [],
): Promise<AgentUserSeen> {
  const home = await homeOf(user)
  const configured = await runProgram('id', ['-nG', self], { timeoutMs: ASK_MS })
  const inGroup = configured.code === 0 && configured.stdout.trim().split(/\s+/).includes(user)
  const held = await runProgram('id', ['-nG'], { timeoutMs: ASK_MS })
  const groupHeld = held.code === 0 && held.stdout.trim().split(/\s+/).includes(user)
  const sudo = home ? (await asUser(user, ['true'])).code === 0 : false
  const share = home
    ? await access(agentShare(home), constants.W_OK | constants.X_OK)
        .then(() => true)
        .catch(orNo(false))
    : false
  const gitOk =
    sudo &&
    (await asUser(user, ['git', 'config', '--global', '--get', 'user.email'])).code === 0 &&
    (await asUser(user, ['git', 'config', '--global', '--get-all', 'safe.directory'])).stdout
      .split('\n')
      .includes('*')
  const homeClosed = await stat(tadeHome)
    .then((info) => (info.mode & 0o077) === 0)
    .catch(orNo(false))
  const gid = await runProgram('id', ['-g', user], { timeoutMs: ASK_MS })
  const group = gid.code === 0 ? Number(gid.stdout.trim()) : null
  const uid = await runProgram('id', ['-u', user], { timeoutMs: ASK_MS })
  const own = uid.code === 0 ? Number(uid.stdout.trim()) : null
  // Its group's alone: its group writes there, and nobody else may so much as
  // open it — or one project's agents read another's, which is the point of a
  // user each.
  const open: string[] = []
  for (const root of roots) {
    const info = await stat(root).catch(orNo(null))
    if (
      !info ||
      group === null ||
      info.gid !== group ||
      (info.mode & 0o2070) !== 0o2070 ||
      (info.mode & 0o007) !== 0
    ) {
      open.push(root)
    }
  }
  const closed = await closedAbove(roots, { uid: own, gid: group }, sudo ? user : null)
  // Only where Tade can become it: a sandbox tried as Tade proves nothing.
  const sandboxes = sudo
    ? await Promise.all(
        proofs.map(async ({ harness, proof }) => ({
          harness,
          needs:
            (await asUser(user, [proof.command, ...proof.args])).code === 0 ? null : proof.needs,
        })),
      )
    : []
  return {
    user,
    home,
    inGroup,
    groupHeld,
    sudo,
    share,
    git: gitOk,
    homeClosed,
    roots: open,
    closed,
    sandboxes,
  }
}

/**
 * The folders above `roots` an agent user cannot pass through, top first, so
 * cannot reach its projects at all: a home is `0750` on Ubuntu 24.04, and a
 * project cloned into Tade's user's is behind it. Read off the modes, which is
 * all there is before the user exists; where Tade can already become it
 * (`as`), the user is asked about the ones the modes close, since a group or
 * an ACL may let it through.
 */
export async function closedAbove(
  roots: readonly string[],
  ids: { uid: number | null; gid: number | null },
  as: string | null,
): Promise<string[]> {
  const above = new Set<string>()
  for (const root of roots) {
    for (let dir = dirname(root); ; dir = dirname(dir)) {
      above.add(dir)
      if (dirname(dir) === dir) break
    }
  }
  const shut: string[] = []
  // A folder's name is longer than any above it, so the shortest come first.
  for (const dir of [...above].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    const info = await stat(dir).catch(orNo(null))
    if (!info) continue
    const passes =
      (info.mode & 0o001) !== 0 ||
      (info.uid === ids.uid && (info.mode & 0o100) !== 0) ||
      (info.gid === ids.gid && (info.mode & 0o010) !== 0)
    if (!passes) shut.push(dir)
  }
  if (!as || shut.length === 0) return shut
  const asked = await asUser(as, [
    '/bin/sh',
    '-c',
    'for d; do test -x "$d" || printf "%s\\n" "$d"; done',
    'sh',
    ...shut,
  ])
  if (asked.code !== 0) return shut
  const still = new Set(asked.stdout.split('\n').filter(Boolean))
  return shut.filter((dir) => still.has(dir))
}

/**
 * The sandboxes to try as an agent user: each harness a route starts agents
 * in that has one, with its proof on this platform. The orchestrator's is not
 * among them — it runs as Tade, headless, and is not an agent.
 */
export function sandboxProofs(
  config: Config,
  home: string,
  platform: NodeJS.Platform = process.platform,
): { harness: string; proof: SandboxProof }[] {
  return harnessesInUse(config).flatMap((id) => {
    const make = HARNESS_ADAPTERS[id]
    if (!make) return []
    // The directories a launch would use, and nothing is launched: a
    // constructor does no I/O.
    const adapter = make({
      runDir: join(home, 'runs'),
      socketDir: join(home, 'runs'),
      approvals: 'bypass',
    })
    const proof = adapter.capabilities.sandbox ? (adapter.sandboxProof?.(platform) ?? null) : null
    return proof ? [{ harness: id, proof }] : []
  })
}

/** Each harness a route starts agents in, once: what an agent user has to be signed in to. */
export function harnessesInUse(config: Config): string[] {
  const used = new Set<string>()
  for (const route of Object.values(config.workers.routes)) {
    used.add(route.harness)
    for (const named of Object.keys(route.harnesses ?? {})) used.add(named)
  }
  return [...used]
}

/**
 * A harness's adapter as it runs for an agent user: that user's home, its
 * share, and an account's folder in that home where one is named
 * (`agentAccountDir`). What the workbench starts agents with, and what setup
 * asks about sign-ins — one making, so the two can never disagree about where
 * a sign-in is. A constructor does no I/O.
 */
export function adapterOfUser(
  harness: string,
  user: AgentUser,
  account: string | null,
  options: Partial<HarnessOptions> = {},
): WorkerAdapter | null {
  const make = HARNESS_ADAPTERS[harness]
  if (!make) return null
  // Where Tade's own pi keeps its sessions is not where that user's does.
  const { sessionsRoot: _, ...own } = options
  return make({
    approvals: 'bypass',
    ...own,
    runDir: shareRuns(user.share),
    socketDir: shareSockets(user.share),
    home: user.home,
    user: user.name,
    // Where another user's harness keeps its things is that user's to say,
    // never something in this process's environment.
    env: { PATH: process.env.PATH ?? '' },
    ...(account
      ? {
          account: {
            name: account,
            dir: agentAccountDir(user.home, account),
            kind: 'subscription' as const,
          },
        }
      : {}),
  })
}

/**
 * The folder an agent user's sign-in of an account is kept in
 * (`agentAccountDir`) — refused, with the setup line, where setup has not
 * made it, since an agent started there would stop at its harness's sign-in
 * in a lane nobody is looking at. Looked at through the group, which keeps
 * the user's home and that folder's parent open to Tade, never inside it.
 */
export async function accountFolderOf(
  user: AgentUser,
  account: string,
  task: string,
): Promise<string> {
  const folder = agentAccountDir(user.home, account)
  const made = await stat(folder)
    .then((info) => info.isDirectory())
    .catch(orNo(false))
  if (!made) {
    throw new Error(
      `${task}'s agent runs as ${user.name}, which has no sign-in of the account ${account} yet: tade setup makes ${folder} and signs it in there, as ${user.name}`,
    )
  }
  return folder
}

/** One sign-in setup asks about for an agent user, before anything is asked. */
export interface SignInAsk {
  harness: string
  account: string | null
  /** An account's folder in that user's home; null for the harness's own sign-in. */
  folder: string | null
  proof: SignInProof | null
  launch: SignInLaunch | null
  how: string
}

/**
 * Each sign-in an agent user's agents run on: every harness in use, and every
 * account of one paid for by a subscription — each signed in as that user, in
 * that user's home, by the person. An API-key account is not among them: its
 * key is in Tade's config, which that user cannot read, and it is never copied
 * to it (`startAgent` says so where one is chosen).
 */
export function signInsFor(config: Config, user: AgentUser): SignInAsk[] {
  const out: SignInAsk[] = []
  for (const harness of harnessesInUse(config)) {
    const accounts = Object.entries(config.accounts)
      .filter(([, one]) => one.harness === harness && one.kind === 'subscription')
      .map(([name]) => name)
    for (const account of [null, ...accounts]) {
      const adapter = adapterOfUser(harness, user, account)
      // A server has no browser the person sees, and that user none at all.
      const sign = adapter?.signIn({ browser: false }) ?? null
      if (!adapter || !sign) continue
      out.push({
        harness,
        account,
        folder: account ? agentAccountDir(user.home, account) : null,
        proof: adapter.signInProof?.() ?? null,
        launch: {
          // The very program agents run, found as they find it on Tade's PATH
          // (`asAgent`), rather than whatever that user's login finds first.
          command:
            resolveCommand(sign.launch.command, { PATH: process.env.PATH ?? '' }) ??
            sign.launch.command,
          args: sign.launch.args,
          env: sign.launch.env,
        },
        how: sign.how,
      })
    }
  }
  return out
}

/** A network question's deadline: a dry-run push reaching a forge from a box under load. */
const REACH_MS = 20_000

/**
 * Whether a harness is signed in as `user`, asked the way an agent is
 * launched (`asAgent`, Tade's PATH and the folder named): the exit code is
 * the whole answer, and nothing the harness keeps is read here. A program
 * that user cannot run is said as that, never as "signed out".
 */
export async function signedInAs(
  user: string,
  proof: SignInProof | null,
): Promise<{ signedIn: boolean | null; problem: string | null }> {
  if (!proof) return { signedIn: null, problem: 'its harness has no way to say' }
  const line = asAgent(
    { command: proof.command, args: proof.args },
    user,
    Object.keys(proof.env),
    process.env.PATH ?? '',
  )
  const ran = await runProgram(line.command, line.args, {
    env: { ...process.env, ...proof.env },
    timeoutMs: ASK_MS,
  })
  if (ran.timedOut) {
    return { signedIn: null, problem: `it did not answer within ${ASK_MS / 1000} s` }
  }
  if (ran.code === 126 || ran.code === 127) {
    return {
      signedIn: null,
      problem: `${proof.command} cannot be run as ${user}: it has to be installed where every user can run it`,
    }
  }
  return { signedIn: ran.code === 0, problem: null }
}

/**
 * What an agent user's agents need beyond the user itself, looked at as it:
 * each sign-in (`signInsFor`, asked by `signedInAs`), and whether it can push
 * — the public half of its key, and each of its projects' remotes as its own
 * git pushes to it, tried with a dry-run push in batch mode (`pushTry`), so an
 * unknown host key, a missing key or one that may only read is a refusal with
 * its reason, never a prompt.
 * Nothing where Tade cannot become it yet: that is said by the step already.
 */
export async function lookAtReach(
  seen: AgentUserSeen,
  config: Config,
  self: string,
): Promise<{ signIns: AgentSignIn[]; push: AgentPush | null }> {
  if (!seen.sudo || !seen.home) return { signIns: [], push: null }
  const user: AgentUser = { name: seen.user, home: seen.home, share: agentShare(seen.home) }
  const signIns = await Promise.all(
    signInsFor(config, user).map(
      async (ask): Promise<AgentSignIn> => ({
        harness: ask.harness,
        account: ask.account,
        folder: ask.folder
          ? {
              path: ask.folder,
              made: (await asUser(user.name, ['test', '-d', ask.folder])).code === 0,
            }
          : null,
        ...(await signedInAs(user.name, ask.proof)),
        launch: ask.launch,
        how: ask.how,
      }),
    ),
  )
  const key = await asUser(user.name, ['cat', join(user.home, `${PUSH_KEY}.pub`)])
  const remotes = await Promise.all(
    rootsOf(config, user.name, self).map((root) => remoteAs(user.name, root)),
  )
  return {
    signIns,
    push: {
      key: key.code === 0 && key.stdout.trim() ? key.stdout.trim() : null,
      remotes: remotes.filter((one): one is AgentRemote => one !== null),
    },
  }
}

/**
 * One project's remote as an agent user pushes to it, tried as it — or null
 * where the project has none, which is nothing to push to rather than
 * something wrong.
 */
async function remoteAs(user: string, root: string): Promise<AgentRemote | null> {
  const ours = await git(root, ['config', '--get', 'remote.origin.url'])
  const origin = ours.ok ? ours.stdout.trim() : ''
  if (!origin) return null
  const theirs = await asUser(user, ['git', '-C', root, 'remote', 'get-url', '--push', 'origin'])
  if (theirs.code !== 0) {
    return {
      root,
      url: origin,
      repository: repositoryNamed(origin),
      reached: null,
      problem: `${user} cannot read ${root} yet: ${lastLine(theirs.stderr)}`,
    }
  }
  const url = theirs.stdout.trim()
  const remote = { root, url, repository: repositoryNamed(url) }
  const tried = await asUser(
    user,
    ['env', 'GIT_SSH_COMMAND=ssh -o BatchMode=yes', 'GIT_TERMINAL_PROMPT=0', ...pushTry(remote)],
    REACH_MS,
  )
  if (tried.timedOut) {
    return { ...remote, reached: null, problem: `it did not answer within ${REACH_MS / 1000} s` }
  }
  return {
    ...remote,
    reached: tried.code === 0,
    problem: tried.code === 0 ? null : lastLine(tried.stderr) || `it exited ${tried.code}`,
  }
}

function lastLine(text: string): string {
  return text.trim().split('\n').pop()?.trim() ?? ''
}

/** The roots of the projects whose agents run as `user`, as folders on this machine. */
export function rootsOf(config: Config, user: string, self: string): string[] {
  return Object.entries(config.projects)
    .filter(([name]) => agentUserOf(config, name, self) === user)
    .map(([, project]) => expandHome(project.root))
    .filter((root) => isAbsolute(root))
}
