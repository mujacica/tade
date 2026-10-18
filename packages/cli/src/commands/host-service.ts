import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  agentUsers,
  defaultConfigPath,
  LOG,
  lingerCommand,
  loadConfig,
  SERVICE,
  type ServiceGroup,
  type ServiceState,
  START,
  serviceGroupTrouble,
  serviceTrouble,
  serviceUnit,
  tadeHome,
  type Unattended,
} from '@tade/core'
import { ownUser } from '@tade/workbench/agent-user'
import { heldBy } from '@tade/workbench/lock'
import { lookAtService, serviceGroups, serviceUnitPath } from '@tade/workbench/machine'
import { drivers } from '@tade/workbench/registry'

// Tade on a machine of its own: a Linux server, kept running by the person's
// own service manager.
//
// Tade starts no daemon of its own and installs nothing that was not pressed
// for. So what is here builds the systemd user unit that would keep it running
// — `tade serve`, the window with no screen — writes it only when somebody
// says so, and offers to start it the same way. `tade host service`
// (`host.ts`) asks in a terminal and `tade setup` on its own screen, through
// these same functions, with linger first.

/** Where to look at it once it runs: its log here, and the window on the Mac. */
const LOOK = `read what it says with \`${LOG}\`, and from your Mac \`tade remote add\` shows it all`

/** What asking needs: the setup screen, or this terminal. */
export interface Asker {
  say(text: string): void
  confirm(question: string, fallback: boolean): Promise<boolean>
  /** Run a command where the person can see it, and answer with how it ended. */
  run(title: string, command: string, args: string[]): Promise<number>
}

/** The unit for this machine, and where it goes. */
export interface UnitHere {
  text: string
  path: string
}

/**
 * The unit, for the Tade running now: this Node and this CLI, so what the
 * service starts is what was just run, and the PATH of the shell it was run
 * from, because a service's own has none of Node, the harnesses or an npm
 * prefix.
 */
export function unitHere(env: NodeJS.ProcessEnv = process.env): UnitHere {
  const lang = env.LANG && /utf-?8/i.test(env.LANG) ? env.LANG : 'C.UTF-8'
  return {
    text: serviceUnit({
      tade: [process.execPath, fileURLToPath(new URL('../bin.ts', import.meta.url))],
      path: env.PATH ?? '',
      home: env.TADE_HOME ?? null,
      lang,
    }),
    path: serviceUnitPath(env),
  }
}

/**
 * Why the agents would not outlive the service, in the configured driver's
 * own terms, or null when they would. Read off `capabilities.detach`, never
 * the driver's name: a driver whose lanes are Tade's children ends them with
 * every restart.
 */
export async function lanesWouldStop(): Promise<string | null> {
  const loaded = await loadConfig(defaultConfigPath())
  // A config that does not read is not one that says pty: which driver runs
  // the agents is then something nobody can tell, and that is what is said.
  if (!loaded.ok) {
    return `${loaded.path} does not read (\`tade config --check\` says why), so whether agents outlive the service cannot be told`
  }
  const name = loaded.config.workspace.driver
  const made = drivers[name]?.(tadeHome())
  if (!made) return `workspace.driver is ${name}, which is not a driver here`
  const detach = made.capabilities.detach
  await made.detach()
  return detach
    ? null
    : `agents run under the ${name} driver, so they stop whenever the service does — set workspace.driver: tmux (\`tade setup\` asks)`
}

/**
 * Why no agent of its own user can start under the service running now, one
 * sentence each with the command that restarts what has to restart — read off
 * the running process's groups, never the user's (`serviceGroups`), since a
 * service started before `usermod` keeps the groups it began with. Nothing
 * where no agent runs as another user, or nothing is running; a config that
 * does not read is said by `lanesWouldStop`.
 */
export async function serviceLacksGroups(
  groups: (users: readonly string[]) => Promise<ServiceGroup[]> = (users) => serviceGroups(users),
): Promise<string[]> {
  const loaded = await loadConfig(defaultConfigPath())
  if (!loaded.ok) return []
  const self = ownUser()
  const held = await groups(agentUsers(loaded.config, self))
  return held.flatMap((one) => serviceGroupTrouble(one, self) ?? [])
}

/**
 * Write the unit on a press, then — with `start` — offer to start it on
 * another. Answers whether it is written.
 *
 * Starting is not offered while a window holds this home: the service would
 * be refused the home, and a unit that fails at once is a unit systemd stops
 * trying after five. The service holding it is not such a window — restarting
 * is how it takes the unit just written, an older Tade's window in tmux
 * included — so the holder is told apart by the service's own pid
 * (`service`). Nor from `tade setup`, which a window may be waiting on to open
 * this very home.
 */
export async function offerUnit(
  ask: Asker,
  unit: UnitHere,
  opts: { write: boolean; start: boolean },
  service: () => Promise<ServiceState> = () => lookAtService(),
): Promise<boolean> {
  const write = opts.write
  const same = existsSync(unit.path) && readFileSync(unit.path, 'utf8') === unit.text
  if (!same) {
    const there = existsSync(unit.path) ? ', in place of the one there' : ''
    if (!(write || (await ask.confirm(`write it to ${unit.path}${there}?`, true)))) {
      ask.say(`  not written — \`tade host service\` again when you want it`)
      return false
    }
    mkdirSync(dirname(unit.path), { recursive: true })
    writeFileSync(unit.path, unit.text)
    ask.say(`  written to ${unit.path}`)
  } else {
    ask.say(`  ${unit.path} already says this`)
  }
  if (!opts.start) {
    ask.say(`  once setup is done, start it now and at every boot: \`${START}\``)
    ask.say(`  then ${LOOK}`)
    return true
  }
  const holder = await heldBy(tadeHome())
  if (holder !== null && holder !== pidOf(await service())) {
    ask.say(`  a window has this home open (pid ${holder}): quit it, then \`${START}\``)
    return true
  }
  const again = holder === null ? 'start it now' : 'restart the service on it now'
  if (write || !(await ask.confirm(`${again}, and at every boot?`, true))) {
    ask.say(`  to ${again}, and at every boot: \`${START}\``)
  } else if ((await ask.run(START, '/bin/sh', ['-c', START])) !== 0) {
    ask.say(`  that did not work — \`journalctl --user -u ${SERVICE}\` says why`)
  } else {
    ask.say(`  started — ${LOOK}`)
  }
  return true
}

/** The service's own pid, where it is running. */
function pidOf(state: ServiceState): number | null {
  return state.kind === 'ready' || state.kind === 'starting' || state.kind === 'stopping'
    ? state.pid
    : null
}

/**
 * Linger, on a press: the user's services stop at the last logout without it.
 * Run in a terminal the person sees, because `sudo` may ask for a password.
 */
export async function offerLinger(ask: Asker, box: Unattended): Promise<void> {
  const command = lingerCommand(box)
  ask.say(`Your services stop when you log out, unless linger is on: \`${command}\``)
  if (!(await ask.confirm('turn linger on?', true))) {
    ask.say(`  skipped — \`${command}\` when you want it`)
    return
  }
  const code = await ask.run(command, '/bin/sh', ['-c', command])
  ask.say(code === 0 ? '  linger is on' : `  that did not work — run \`${command}\` yourself`)
}

/**
 * `tade setup`'s step on a server: linger, then the unit, then whether it runs.
 * Each is offered, none is run unpressed, a unit is shown whole before it is
 * written, and one that is there and wrong — an older Tade's, or one whose
 * Node has moved — is offered again in its place. Never started from here
 * (`offerUnit`): what is said is how.
 */
export async function setUpUnattended(ask: Asker, box: Unattended): Promise<void> {
  ask.say('This is a server: Tade can keep working here with nobody logged in, kept running')
  ask.say('by your own service manager as `tade serve`, and seen from your Mac over SSH.')
  ask.say('')
  if (!box.linger) await offerLinger(ask, box)
  if (box.unit && !box.unitTrouble) {
    const trouble = box.service ? serviceTrouble(box.service) : null
    if (trouble) ask.say(`  ${SERVICE}: ${trouble}`)
    return
  }
  if (box.unitTrouble) ask.say(`  the unit at ${box.unit} ${box.unitTrouble}`)
  const stops = await lanesWouldStop()
  if (stops) ask.say(`  ${stops}`)
  const unit = unitHere()
  ask.say(`The unit (${SERVICE}):`)
  for (const line of unit.text.trimEnd().split('\n')) ask.say(`  ${line}`)
  await offerUnit(ask, unit, { write: false, start: false })
}
