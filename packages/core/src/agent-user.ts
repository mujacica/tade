import { join } from 'node:path'
import type { Config } from './config.ts'
import type { Launched } from './priority.ts'
import { IN_CONFIG } from './secrets.ts'

// Agents as a Unix user of their own (`agents.user`, `projects.<name>.user`).
//
// Everywhere else Tade says an agent runs as you and can read every key it
// keeps (`KEYS_AND_AGENTS`), and that is still the truth on a laptop. On a box
// on the internet it is the wrong trade: the machine holds an App's key,
// webhook secrets and the device list, and its agents read strangers' comments
// unattended. So there, agents run as another user — `tade-agent`, or one per
// project — with their harness's own sandbox on, and Tade's home is closed to
// them. Containment is still the operating system's and the harness's, used
// through things they already have, never something Tade builds: a user, a
// group, one `sudo` rule, a umask.
//
// What it does not fix is said where it is decided (`AGENT_USER_MEANS`): an
// agent can still read its own harness's sign-in, which it needs to run, its
// project's code, and anything every user on the box can.
//
// Pure: the config, the user names and the paths in; the launch line, the
// commands setup shows and the sentences out. Running any of it is
// `workbench/src/agent-user.ts` and `cli/src/commands/setup-agents.ts`.

/** The user setup offers when nobody has named one. */
export const AGENT_USER = 'tade-agent'

/**
 * A user name as `useradd` takes it on every distribution Tade is set up on —
 * and, because the name goes into a sudoers line and a command line, a name
 * that can never be anything but one word.
 */
export const USER_NAME = /^[a-z_][a-z0-9_-]{0,31}$/

/**
 * The user a project's agents run as on this machine, or null for Tade's own.
 *
 * The project's answer over the machine's. A name that is Tade's own user is
 * the same as none: wrapping a launch in `sudo` to become who it already is
 * would need a rule nobody wrote, and change nothing.
 */
export function agentUserOf(config: Config, project: string, self: string): string | null {
  const named = config.projects[project]?.user ?? config.agents.user ?? null
  return named && named !== self ? named : null
}

/** Every user this machine's agents run as other than Tade's own, each once, in order. */
export function agentUsers(config: Config, self: string): string[] {
  const named = [config.agents.user, ...Object.values(config.projects).map((p) => p.user)]
  return [...new Set(named.filter((u): u is string => !!u && u !== self))].sort()
}

/**
 * Whether no agent on this machine runs as Tade's own user, and so none can
 * read what Tade keeps: the machine's answer is another user, and no project
 * says Tade's own. A project that names no user follows the machine's.
 */
export function agentsKeptOut(config: Config, self = ''): boolean {
  const machine = config.agents.user
  if (!machine || machine === self) return false
  return Object.values(config.projects).every((p) => p.user !== self)
}

/**
 * Who every agent here runs as, where none runs as Tade's own user — the user,
 * or `users of their own` where projects name different ones — and null where
 * any agent can read what Tade keeps. What `keysAndAgents` is told.
 */
export function agentsKeptAs(config: Config, self = ''): string | null {
  if (!agentsKeptOut(config, self)) return null
  const users = agentUsers(config, self)
  return users.length === 1 ? (users[0] ?? null) : 'users of their own'
}

/**
 * What an agent running as another user is allowed of Tade, in one folder:
 * its supervision sockets, the files a launch hands its harness, a copy of its
 * task's context. In that user's home, because Tade's own is closed to it;
 * that user's and its group's, set-group-id, so whatever Tade writes there is
 * the group's to read — and Tade is in the group, so whatever the agent writes
 * there is Tade's. Made by setup (`agentCommands`), never by Tade, which cannot
 * write in another user's home.
 */
export function agentShare(home: string): string {
  return join(home, 'tade-share')
}

/** The sockets an agent's hooks reach Tade on, in its share: short, because a socket path is. */
export function shareSockets(share: string): string {
  return join(share, 's')
}

/** The files a launch hands an agent's harness, in its share. */
export function shareRuns(share: string): string {
  return join(share, 'runs')
}

/** One task's folder in an agent's share: the copy of its context, its setup's log. */
export function shareTask(share: string, folder: string): string {
  return join(share, 'tasks', folder)
}

/**
 * The script that becomes the agent's user does once it has: a umask that
 * keeps what it writes its group's — Tade's — and nobody else's, and the PATH
 * Tade has, since `sudo` hands it `secure_path` instead and a harness or Node
 * installed for every user under `/opt` would not be found. Then the agent's
 * own line, `exec`'d, so the lane's process is the agent exactly as before.
 */
const BECOME = 'umask 007; PATH=$1; export PATH; shift; exec "$@"'

/**
 * A launch, run as `user`.
 *
 * Through `sudo -n`, which never asks: a rule that is missing is a lane that
 * says so and ends, never one holding a password prompt nobody is looking at.
 * `-H` gives it its own home, so its harness finds its own sign-in. The
 * environment is `sudo`'s reset one — which is the point: a key exported in
 * Tade's shell, the way out `KEYS_AND_AGENTS` offers, must not reach an agent
 * kept apart from Tade's keys — and only what the launch itself named is
 * carried across, by name (`--preserve-env`), so no value of it is ever on a
 * command line somebody else's `ps` can read.
 *
 * Pure, and re-decided at every launch as `niced` is: what is stored is the
 * agent's own line, so a lane put back is put back as whoever the config says
 * now.
 */
export function asAgent<T extends Launched>(
  launch: T,
  user: string,
  carried: readonly string[],
  path: string,
): T & { args: string[] } {
  if (!USER_NAME.test(user)) throw new Error(`not a user name: ${user}`)
  const names = [...new Set(carried)].filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  return {
    ...launch,
    command: SUDO,
    args: [
      '-n',
      '-H',
      '-u',
      user,
      ...(names.length > 0 ? [`--preserve-env=${names.join(',')}`] : []),
      '--',
      '/bin/sh',
      '-c',
      BECOME,
      'tade-agent',
      path,
      launch.command,
      ...launch.args,
    ],
  }
}

/** What crosses users: the program, so a test can stand one in. */
export const SUDO = 'sudo'

/**
 * What else an agent's environment keeps from the lane's, besides what its
 * launch named: the words it speaks in. `TERM` is kept by `sudo` itself.
 */
export const CARRIED = ['LANG', 'LC_ALL', 'LC_CTYPE', 'COLORTERM'] as const

/**
 * The one rule that lets Tade become its agents' user, and nothing else.
 *
 * `SETENV` is what lets `--preserve-env` carry the launch's own variables;
 * it widens nothing, because whoever may run anything as that user may
 * already set anything in what they run. The other way round — the agent
 * becoming Tade, or anybody else — is exactly what is not written.
 */
export function sudoersRule(self: string, user: string): string {
  return `${self} ALL=(${user}) NOPASSWD:SETENV: ALL`
}

/** Where that rule is written: a file of its own, so taking it away is one `rm`. */
export function sudoersFile(user: string): string {
  return `/etc/sudoers.d/tade-${user}`
}

/** What setup knows about one agent user, looked at on the machine (`lookAtAgentUser`). */
export interface AgentUserSeen {
  user: string
  /** Its home, where it exists. */
  home: string | null
  /** Whether Tade's user is written into its group, and whether this process has that group yet. */
  inGroup: boolean
  groupHeld: boolean
  /** Whether `sudo -n -u <user>` runs without asking. */
  sudo: boolean
  /** Whether its share is there and this process can write in it. */
  share: boolean
  /** Whether its git can commit: a name, an address, and every repository trusted. */
  git: boolean
  /** Tade's home is closed to everybody else (`0700`). */
  homeClosed: boolean
  /** The project roots its agents work in that its group cannot write. */
  roots: readonly string[]
  /**
   * Each harness in use whose own sandbox was tried as this user, and what it
   * needs where it would not start (`WorkerAdapter.sandboxProof`), else null.
   */
  sandboxes: readonly { harness: string; needs: string | null }[]
}

/** One command setup shows and runs on a press, and what it is for. */
export interface AgentCommand {
  says: string
  line: string
}

/** A word as a shell reads it, quoted only where it has to be. */
function word(text: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * The commands that make `seen.user` an agent user here, each said before it
 * runs, and only the ones still to do — in the order they have to be done.
 *
 * Every one is root's, and is run by a person pressing a key in a terminal
 * they can see (`offerInstall`'s rule): nothing installs anything, and nothing
 * makes a user either. The sudoers line is checked by `visudo` before it is
 * put where `sudo` reads it, because a broken file there is a `sudo` that
 * refuses everybody, root's way back included.
 */
export function agentCommands(
  seen: AgentUserSeen,
  self: string,
  git: { name: string | null; email: string | null },
): AgentCommand[] {
  const u = seen.user
  const home = seen.home ?? `/home/${u}`
  const share = agentShare(home)
  const out: AgentCommand[] = []
  if (!seen.home) {
    out.push({
      says: `make the user ${u}, with a group of its own and a home Tade can read`,
      line: `sudo useradd --create-home --user-group --shell /bin/bash ${u} && sudo chmod 0750 ${word(home)}`,
    })
  }
  if (!seen.inGroup) {
    out.push({
      says: `put ${self} in ${u}'s group, so Tade can read and write what its agents do`,
      line: `sudo usermod --append --groups ${u} ${self}`,
    })
  }
  if (!seen.sudo) {
    const file = sudoersFile(u)
    out.push({
      says: `let ${self} run things as ${u}, and nothing else — checked by visudo before sudo reads it`,
      line:
        `t=$(mktemp) && printf '%s\\n' ${word(sudoersRule(self, u))} > "$t" && ` +
        `sudo visudo -cf "$t" && sudo install -m 0440 -o root -g root "$t" ${file}; rm -f "$t"`,
    })
  }
  if (!seen.share) {
    out.push({
      says: `make the folder Tade hands ${u}'s agents their sockets and files in`,
      line: `sudo install -d -o ${u} -g ${u} -m 2770 ${word(share)}`,
    })
  }
  if (!seen.git) {
    // From its own home: run from Tade's, which it cannot enter, git fails
    // looking for a repository above a folder it may not read.
    const parts = [
      'cd',
      git.name ? `git config --global user.name ${word(git.name)}` : null,
      git.email ? `git config --global user.email ${word(git.email)}` : null,
      `git config --global --add safe.directory '*'`,
    ].filter((p): p is string => p !== null)
    out.push({
      says: `give ${u}'s git your name and trust the repositories Tade hands it, which ${self} owns`,
      line: `sudo -u ${u} -H sh -c ${word(parts.join(' && '))}`,
    })
  }
  for (const root of seen.roots) {
    out.push({
      says: `let ${u}'s group work in ${root}, and keep what is made there the group's`,
      line:
        `sudo chgrp -R ${u} ${word(root)} && sudo chmod -R g+rwX ${word(root)} && ` +
        `sudo find ${word(root)} -type d -exec chmod g+s {} + && git -C ${word(root)} config core.sharedRepository group`,
    })
  }
  return out
}

/**
 * What is still in the way, one clause each, or nothing: the step's line in
 * setup and `--check`. Tade's home is not here — Tade closes it itself
 * (`closeHome`), and only the group taking effect needs a person.
 */
export function agentUserTrouble(seen: AgentUserSeen, self: string): string[] {
  const u = seen.user
  const out: string[] = []
  if (!seen.home) out.push(`there is no user ${u}`)
  if (!seen.inGroup) out.push(`${self} is not in ${u}'s group`)
  else if (!seen.groupHeld) {
    out.push(
      `${self} is in ${u}'s group from your next login: log in again, or restart Tade's service`,
    )
  }
  if (seen.home && !seen.sudo) out.push(`${self} cannot run things as ${u} without a password`)
  if (seen.home && !seen.share)
    out.push(`${agentShare(seen.home)} is not there for Tade to write in`)
  if (seen.home && !seen.git)
    out.push(`${u}'s git has no name, or does not trust your repositories`)
  for (const root of seen.roots) out.push(`${u}'s group cannot write in ${root}`)
  for (const box of seen.sandboxes) {
    if (box.needs)
      out.push(`${box.harness}'s own sandbox will not start as ${u} here: it needs ${box.needs}`)
  }
  return out
}

/**
 * What running agents as their own user means, said where somebody turns it
 * on: the Settings row, and setup's step. `KEYS_AND_AGENTS`'s second sentence
 * is the same fact said about a key (`KEYS_KEPT_FROM_AGENTS`).
 */
export const AGENT_USER_MEANS =
  'the Unix user agents run as here, with their harness’s own sandbox on: none of them can then ' +
  `open Tade’s home, ${IN_CONFIG} or any key in it — though each can still read its own harness’s ` +
  'sign-in, its project’s code and whatever every user here can. Unset, agents run as you. ' +
  '`tade setup` makes the user, each command shown first'
