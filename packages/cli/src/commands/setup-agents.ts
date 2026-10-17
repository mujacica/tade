import { join } from 'node:path'
import type { Ui } from '@tade/app'
import {
  AGENT_USER,
  AGENT_USER_MEANS,
  type AgentsHere,
  type AgentUserSeen,
  agentCommands,
  agentUsers,
  type Config,
  defaultConfigPath,
  type LaneProof,
  loadConfig,
  runProgram,
} from '@tade/core'
import { lookAtAgentUser, ownUser, rootsOf, sandboxProofs } from '@tade/workbench/agent-user'
import { proveALane } from '@tade/workbench/prove'
import { writeFromShell } from '../config-write.ts'

// Setting up agents as a user of their own (`agents.user`, `agent-user.ts`).
//
// Everything here is root's, so nothing here runs it: each command is said
// first, with what it is for, and run on a press in a terminal the person can
// see, as every install is (`offerInstall`). The user is written into the
// config only once every command has run, so a half-made user is never one
// agents are started as — and then a lane is opened as it, which is the one
// act that proves the rule, the share, Node and the closed home together.

/**
 * What this machine's agents run as, and what is left to do about it — on a
 * Linux server, and wherever the config names a user. Null anywhere else.
 */
export async function agentsLooked(
  config: Config | null,
  home: string,
  server: boolean,
  platform: NodeJS.Platform = process.platform,
): Promise<AgentsHere | null> {
  if (platform !== 'linux' || !config) return null
  const self = ownUser()
  const users = agentUsers(config, self)
  if (users.length === 0 && !server) return null
  const proofs = sandboxProofs(config, home, platform)
  const seen = await Promise.all(
    users.map((user) => lookAtAgentUser(user, self, rootsOf(config, user, self), home, proofs)),
  )
  return { self, seen }
}

/** Your git's name and address, for the agent user's commits to carry. */
async function gitIdentity(): Promise<{ name: string | null; email: string | null }> {
  const read = async (key: string) => {
    const said = await runProgram('git', ['config', '--global', '--get', key], {
      timeoutMs: 10_000,
    })
    return said.code === 0 && said.stdout.trim() ? said.stdout.trim() : null
  }
  return { name: await read('user.name'), email: await read('user.email') }
}

/**
 * Open a lane as `user` and have it try to read Tade's config: the proof,
 * started where that user can stand — its own home — since a lane begun in a
 * folder it cannot enter is Node refusing to start, not an answer.
 */
export function proveAgentUser(
  driver: string,
  home: string,
  seen: AgentUserSeen,
): Promise<LaneProof> {
  return proveALane({
    driver,
    home,
    cwd: seen.home ?? '/',
    as: { user: seen.user, config: join(home, 'config.yaml') },
  })
}

/** The setup step: make the user, give it what it needs, write it down, prove it. */
export async function setUpAgents(
  ui: Ui,
  here: AgentsHere,
  home: string,
  driver: string,
): Promise<void> {
  const loaded = await loadConfig(defaultConfigPath())
  if (!loaded.ok) {
    ui.say('  config.yaml does not load, so there is nothing to say agents run as yet')
    return
  }
  ui.say(`Agents here run as ${here.self} unless you say otherwise. Run as a user of their own,`)
  ui.say(`${AGENT_USER_MEANS}.`)
  ui.say('')
  let seen = here.seen
  let writes: string | null = null
  if (seen.length === 0) {
    if (!(await ui.confirm(`run agents as ${AGENT_USER}?`, true))) {
      ui.say('  skipped — agents go on running as you, and can read every key Tade keeps')
      return
    }
    // The projects whose agents would follow the machine's answer once it is written.
    const after = { ...loaded.config, agents: { ...loaded.config.agents, user: AGENT_USER } }
    seen = [
      await lookAtAgentUser(AGENT_USER, here.self, rootsOf(after, AGENT_USER, here.self), home),
    ]
    writes = AGENT_USER
  }
  const identity = await gitIdentity()
  for (const one of seen) {
    const commands = agentCommands(one, here.self, identity)
    if (commands.length === 0) continue
    ui.say(`To run agents as ${one.user}, as root:`)
    for (const command of commands) {
      ui.say(`  ${command.says}:`)
      ui.say(`    ${command.line}`)
    }
    if (!(await ui.confirm(`run ${commands.length === 1 ? 'it' : 'these'} now?`, true))) {
      ui.say('  skipped — each line above, when you want it, and `tade setup` again')
      return
    }
    for (const command of commands) {
      // Through a shell, so the line that runs is the line that was shown.
      const code = await ui.run(command.says, '/bin/sh', ['-c', command.line])
      if (code !== 0) {
        ui.say(`  that did not work — run it yourself and try again: ${command.line}`)
        return
      }
    }
  }
  if (writes) {
    await writeFromShell(defaultConfigPath(), [{ key: 'agents.user', value: writes }], (said) =>
      ui.say(`  ${said}`),
    )
    ui.say(`  agents.user: ${writes} — new agents run as ${writes} from now on`)
  }
  // Said, because nothing here can do it: pushing is a credential, and yours
  // is in a home that user cannot open — which is the point.
  for (const one of seen) {
    ui.say(
      `  ${one.user} signs in to its harness and pushes with its own credentials, never yours: \`sudo -iu ${one.user}\` and sign in there, and give it a key of its own for git`,
    )
  }
  for (const one of seen) {
    const again = await lookAtAgentUser(
      one.user,
      here.self,
      one.roots,
      home,
      sandboxProofs(loaded.config, home),
    )
    if (!again.groupHeld) {
      ui.say(
        `  ${here.self} is in ${one.user}'s group from your next login: log in again, or restart Tade's service, before an agent starts`,
      )
      continue
    }
    ui.say(`Opening a lane as ${one.user}…`)
    ui.say(`  ${(await proveAgentUser(driver, home, again)).says}`)
  }
}
