import { join } from 'node:path'
import type { Ui } from '@tade/app'
import {
  AGENT_USER,
  AGENT_USER_MEANS,
  type AgentsHere,
  type AgentUserSeen,
  agentCommands,
  agentUsers,
  agentUserTrouble,
  appArmorCommands,
  BUBBLEWRAP,
  BWRAP_PROFILE,
  bubblewrapWanted,
  bwrapProfile,
  type Config,
  defaultConfigPath,
  groupFromLogin,
  type InstallersHere,
  installWith,
  type LaneProof,
  loadConfig,
  runProgram,
  type ServiceGroup,
  serviceGroupTrouble,
} from '@tade/core'
import {
  lookAtAgentUser,
  lookAtReach,
  ownUser,
  rootsOf,
  sandboxProofs,
} from '@tade/workbench/agent-user'
import { lookAtAppArmor } from '@tade/workbench/apparmor'
import { installersHere } from '@tade/workbench/installers'
import { serviceGroups } from '@tade/workbench/machine'
import { proveALane } from '@tade/workbench/prove'
import { writeFromShell } from '../config-write.ts'
import { setUpReach } from './setup-agent-reach.ts'
import { offerInstall } from './setup-machine.ts'

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
  // Each user, and what its agents need beyond it: their sign-ins and a key to push with.
  const seen = await Promise.all(
    users.map(async (user) => {
      const one = await lookAtAgentUser(user, self, rootsOf(config, user, self), home, proofs)
      return { ...one, ...(await lookAtReach(one, config, self)) }
    }),
  )
  const apparmor = proofs.length > 0 ? await lookAtAppArmor(proofs.map((one) => one.harness)) : null
  return { self, seen, apparmor, service: await serviceGroups(users) }
}

/**
 * The agent users `tade setup --check` proves with a lane opened as each:
 * those with nothing left to do to the user itself — a sign-in or a key has
 * nothing to do with what the lane proves — and never one whose group Tade's
 * running service lacks, since a lane setup opens proves setup's own groups,
 * not the service's, and the step already says the restart.
 */
export function usersToProve(here: AgentsHere): AgentUserSeen[] {
  const lacking = new Set(
    (here.service ?? [])
      .filter((one) => serviceGroupTrouble(one, here.self) !== null)
      .map((one) => one.user),
  )
  return here.seen.filter(
    (seen) =>
      !lacking.has(seen.user) &&
      agentUserTrouble({ ...seen, signIns: [], push: null }, here.self).length === 0,
  )
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

/** What the step reads of the machine besides the user: a test stands one in. */
export interface AgentsLook {
  platform?: NodeJS.Platform
  /** Whether Tade's running service holds each user's group (`serviceGroups`). */
  service?: (users: readonly string[]) => Promise<ServiceGroup[]>
  /** Signing each user in and giving it a key (`setUpReach`), which a test of something else stands in. */
  reach?: typeof setUpReach
  /** What this machine installs with (`installersHere`), and AppArmor looked at again after an install. */
  installers?: InstallersHere
  apparmor?: typeof lookAtAppArmor
}

/**
 * Give bwrap the AppArmor profile Claude Code's sandbox page gives, on a
 * press, where the kernel refuses it the namespaces its sandbox needs
 * (`core/src/apparmor.ts`): bubblewrap first where it is not installed, since
 * a profile attaches to an installed bwrap, then what is written and where,
 * shown whole, and the two commands. Answers whether anything ran that the
 * sandboxes should be tried again for.
 */
async function offerProfile(ui: Ui, here: AgentsHere, look: AgentsLook): Promise<boolean> {
  let seen = here.apparmor
  if (!seen) return false
  let installed = false
  if (bubblewrapWanted(seen)) {
    ui.say(
      `This kernel keeps bwrap, which ${seen.harnesses.join(' and ')} sandbox commands in here, from the namespaces it needs unless it has an AppArmor profile, and bubblewrap is not installed — so there is no bwrap for a profile to attach to, and every command those agents run is refused.`,
    )
    const how = installWith(BUBBLEWRAP, look.installers ?? installersHere())
    if (!(await offerInstall(ui, 'bubblewrap', how))) return false
    seen = await (look.apparmor ?? lookAtAppArmor)(seen.harnesses)
    installed = true
  }
  const commands = appArmorCommands(seen)
  if (!seen.bwrap || commands.length === 0) return installed
  ui.say(
    `This kernel keeps bwrap, which ${seen.harnesses.join(' and ')} sandbox commands in here, from the namespaces it needs, so every command those agents run is refused.`,
  )
  ui.say(
    `Claude Code's sandbox page gives bwrap an AppArmor profile of its own, which applies to bwrap and not to what it runs. As root, this goes in ${BWRAP_PROFILE}:`,
  )
  for (const line of bwrapProfile(seen.bwrap)) ui.say(`    ${line}`)
  for (const command of commands) {
    ui.say(`  ${command.says}:`)
    ui.say(`    ${command.line}`)
  }
  if (!(await ui.confirm('write it and load it now?', true))) {
    ui.say(
      '  skipped — until it is there the sandbox refuses every command: each line above, when you want it, and `tade setup` again',
    )
    return false
  }
  for (const command of commands) {
    if ((await ui.run(command.says, '/bin/sh', ['-c', command.line])) !== 0) {
      ui.say(`  that did not work — run it yourself and try again: ${command.line}`)
      return false
    }
  }
  return true
}

/** The setup step: make the user, give it what it needs, write it down, prove it. */
export async function setUpAgents(
  ui: Ui,
  here: AgentsHere,
  home: string,
  driver: string,
  look: AgentsLook = {},
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
  const profiled = await offerProfile(ui, here, look)
  if (writes) {
    await writeFromShell(defaultConfigPath(), [{ key: 'agents.user', value: writes }], (said) =>
      ui.say(`  ${said}`),
    )
    ui.say(`  agents.user: ${writes} — new agents run as ${writes} from now on`)
  }
  const proofs = sandboxProofs(loaded.config, home, look.platform)
  const service = look.service ?? ((users) => serviceGroups(users))
  for (const one of seen) {
    const again = await lookAtAgentUser(one.user, here.self, one.roots, home, proofs)
    // The profile is proved the way it was found wanting: each sandbox, tried as that user.
    if (profiled && !again.sudo) {
      ui.say(
        `  whether a sandbox starts as ${one.user} is tried once ${here.self} can run things as it`,
      )
    }
    for (const box of profiled ? again.sandboxes : []) {
      ui.say(
        box.needs
          ? `  ${box.harness}'s own sandbox still will not start as ${one.user}: it needs ${box.needs}`
          : `  ${box.harness}'s own sandbox starts as ${one.user} now`,
      )
    }
    // Its sign-ins and its key, as it: nothing of yours, which is in a home it cannot open.
    await (look.reach ?? setUpReach)(ui, again, here.self)
    // Looked at after the commands, since one of them may just have made the group.
    const lacking = (await service([one.user])).flatMap(
      (held) => serviceGroupTrouble(held, here.self) ?? [],
    )
    for (const trouble of lacking) ui.say(`  ${trouble}`)
    // A lane setup opens proves setup's own groups, not the service's.
    if (lacking.length > 0) continue
    if (!again.groupHeld) {
      ui.say(`  ${groupFromLogin(here.self, one.user)}, before an agent starts`)
      continue
    }
    ui.say(`Opening a lane as ${one.user}…`)
    ui.say(`  ${(await proveAgentUser(driver, home, again)).says}`)
  }
}
