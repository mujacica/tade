import { constants } from 'node:fs'
import { access, chmod, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  type AgentUserSeen,
  agentShare,
  agentUserOf,
  type Config,
  expandHome,
  runProgram,
  shareTask,
  taskDir,
  taskFolder,
} from '@tade/core'
import type { SandboxProof } from '@tade/harnesses-core'
import { git } from '@tade/status'
import { HARNESS_ADAPTERS } from './harnesses.ts'
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
      `agents here run as ${user.name}, and ${user.share} is not there for Tade to write in: tade setup makes it, and a new login (or restarting Tade's service) gives Tade ${user.name}'s group`,
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
 * Where a task's setup log is written, where its agent runs as a user of its
 * own: in the share, since the setup runs in the agent's lane as that user.
 */
export function shareSetupLog(task: string, user: AgentUser): string {
  return join(shareTask(user.share, taskFolder(task)), 'setup.log')
}

/**
 * What else an agent's sandbox has to let it write besides its working
 * folder (`WorkerSpec.sandbox`): the repository's own git folder, where the
 * worktree's is elsewhere — a commit writes objects and refs there — and the
 * package caches in its user's home, so an install inside the sandbox works.
 */
export async function sandboxWrites(cwd: string, user: AgentUser): Promise<string[]> {
  const said = await git(cwd, ['rev-parse', '--git-common-dir'])
  const common = said.ok ? resolve(cwd, said.stdout.trim()) : null
  const inside = common !== null && !relative(cwd, common).startsWith('..')
  return [
    ...(common && !inside ? [common] : []),
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
function asUser(user: string, args: readonly string[]) {
  return runProgram('sudo', ['-n', '-H', '-u', user, '--', ...args], { timeoutMs: ASK_MS })
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
  const open: string[] = []
  for (const root of roots) {
    const info = await stat(root).catch(orNo(null))
    if (!info || group === null || info.gid !== group || (info.mode & 0o2070) !== 0o2070) {
      open.push(root)
    }
  }
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
    sandboxes,
  }
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
  const used = new Set<string>()
  for (const route of Object.values(config.workers.routes)) {
    used.add(route.harness)
    for (const named of Object.keys(route.harnesses ?? {})) used.add(named)
  }
  return [...used].flatMap((id) => {
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

/** The roots of the projects whose agents run as `user`, as folders on this machine. */
export function rootsOf(config: Config, user: string, self: string): string[] {
  return Object.entries(config.projects)
    .filter(([name]) => agentUserOf(config, name, self) === user)
    .map(([, project]) => expandHome(project.root))
    .filter((root) => isAbsolute(root))
}
