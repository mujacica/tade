import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ATTACH,
  defaultConfigPath,
  installWith,
  lingerCommand,
  loadConfig,
  resolveCommand,
  SERVICE,
  serviceUnit,
  stringEnv,
  tadeHome,
  type Unattended,
} from '@tade/core'
import { heldBy } from '@tade/workbench/lock'
import { installersHere, serviceUnitPath } from '@tade/workbench/machine'
import { drivers } from '@tade/workbench/registry'

// Tade on a machine of its own: a Linux server, kept running by the person's
// own service manager.
//
// Tade starts no daemon of its own and installs nothing that was not pressed
// for. So what is here builds the systemd user unit that would keep it running
// — the window in tmux, which anybody can attach to — writes it only when
// somebody says so, and offers to start it the same way. `tade host service`
// (`host.ts`) asks in a terminal and `tade setup` on its own screen, through
// these same functions, with linger first.

/**
 * What starting the unit is, as the person would type it: `restart` rather
 * than `--now`, which leaves a running one on the unit it started with — and
 * restarting is harmless, because the agents are not in it.
 */
export const START = `systemctl --user daemon-reload && systemctl --user enable ${SERVICE} && systemctl --user restart ${SERVICE}`

/** What asking needs: the setup screen, or this terminal. */
export interface Asker {
  say(text: string): void
  confirm(question: string, fallback: boolean): Promise<boolean>
  /** Run a command where the person can see it, and answer with how it ended. */
  run(title: string, command: string, args: string[]): Promise<number>
}

/** The unit for this machine, and where it goes — or why there is none. */
export type UnitHere = { text: string; path: string } | { cannot: string }

/**
 * The unit, for the Tade running now: this Node and this CLI, so what the
 * service starts is what was just run; the PATH of the shell it was run from,
 * because a service's own has none of Node, the harnesses or an npm prefix;
 * and the tmux on that PATH, which the window runs in.
 */
export async function unitHere(env: NodeJS.ProcessEnv = process.env): Promise<UnitHere> {
  const tmux = resolveCommand('tmux', stringEnv(env))
  if (!tmux) {
    const made = drivers.tmux?.(tadeHome(env))
    const declared = made?.programs?.find((one) => one.command === 'tmux')
    await made?.detach()
    const how = installWith(declared?.install, installersHere(env))
    const install = 'command' in how ? `\`${how.command}\`` : how.cannot
    return { cannot: `tmux is not here, and the window runs in it: ${install}` }
  }
  const lang = env.LANG && /utf-?8/i.test(env.LANG) ? env.LANG : 'C.UTF-8'
  return {
    text: serviceUnit({
      tade: [process.execPath, fileURLToPath(new URL('../bin.ts', import.meta.url))],
      tmux,
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
 * Write the unit on a press, then — with `start` — offer to start it on
 * another. Answers whether it is written.
 *
 * Starting is not offered while a window holds this home: the service's window
 * would be refused the home, and a unit that fails at once is a unit systemd
 * stops trying after five. Nor from `tade setup`, which a window may be
 * waiting on to open this very home.
 */
export async function offerUnit(
  ask: Asker,
  unit: { text: string; path: string },
  opts: { write: boolean; start: boolean },
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
    ask.say(`  and look at it with \`${ATTACH}\``)
    return true
  }
  const holder = await heldBy(tadeHome())
  if (holder !== null) {
    ask.say(`  a window has this home open (pid ${holder}): quit it, then \`${START}\``)
    return true
  }
  if (write || !(await ask.confirm('start it now, and at every boot?', true))) {
    ask.say(`  to start it now, and at every boot: \`${START}\``)
  } else if ((await ask.run(START, '/bin/sh', ['-c', START])) !== 0) {
    ask.say(`  that did not work — \`journalctl --user -u ${SERVICE}\` says why`)
  } else {
    ask.say(`  started — look at it with \`${ATTACH}\``)
  }
  return true
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
 * `tade setup`'s step on a server: linger, then the unit. Each is offered,
 * neither is run unpressed, and the unit is shown whole before it is written.
 */
export async function setUpUnattended(ask: Asker, box: Unattended): Promise<void> {
  ask.say('This is a server: Tade can keep working here with nobody logged in, kept running')
  ask.say('by your own service manager, in tmux, where you can attach to it over SSH.')
  ask.say('')
  if (!box.linger) await offerLinger(ask, box)
  if (box.unit) return
  const stops = await lanesWouldStop()
  if (stops) ask.say(`  ${stops}`)
  const unit = await unitHere()
  if ('cannot' in unit) {
    ask.say(`  ${unit.cannot}`)
    return
  }
  ask.say(`The unit (${SERVICE}):`)
  for (const line of unit.text.trimEnd().split('\n')) ask.say(`  ${line}`)
  await offerUnit(ask, unit, { write: false, start: false })
}
