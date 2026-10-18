import {
  compareVersions,
  execOf,
  SERVICE,
  type ServiceState,
  START,
  serviceTrouble,
} from '@tade/core'
import type { TadeLook } from '@tade/workbench/programs'
import type { Opened } from '@tade/workbench/upgrade'
import { Exit } from '../io.ts'
import type { Asker } from './host-service.ts'

// `tade host upgrade`: this machine's Tade moved forward in place, without
// ending an agent (REMOTE-TADE.md §7.8).
//
// The install's own command — the one Settings › Updates and `tade update`
// show, read off how Tade got here — run on a press where somebody can watch
// it; then the Tade now on disk asked to start (`--version`) before anything
// is restarted onto it; then the service, where one holds the home, restarted
// — only where the driver's lanes outlive it, which under tmux they do, in a
// scope of their own — and the journal read for what came back: the version
// and lanes the new Tade said it opened with. A window someone has open is
// never restarted from here: it reloads on its own press.

/** What the upgrade asks of the machine, each a function so a test hands its own. */
export interface UpgradePlace {
  /** Tade here, and — with `ask` — what is current (`lookAtTade`). */
  look(ask: boolean): Promise<TadeLook>
  /** Why the agents would not outlive a restart, in the driver's words, or null (`lanesWouldStop`). */
  lanesWouldStop(): Promise<string | null>
  /** The pid holding the home, where something does. */
  held(): Promise<number | null>
  /** How the service stands where systemd runs this machine and the unit is written; null otherwise. */
  service(): Promise<ServiceState | null>
  /** What the Tade with this pid said as it opened (`openedAs`). */
  opened(pid: number): Promise<Opened | null>
  /** Whether the Tade a start would run starts, and which (`startsAs`). */
  starts(): Promise<{ version: string; said: null } | { version: null; said: string }>
  /** Take a backup first, where one is set up; null where none is. */
  backup(): Promise<{ ok: boolean; said: string } | null>
  /** Wait, between looks at a service coming back. */
  wait(ms: number): Promise<void>
}

export interface UpgradeOptions {
  /** Every press given ahead: install, and restart. */
  yes: boolean
  /** Somebody is there to press. */
  asking: boolean
  /** Take a backup first where one is set up. */
  backup: boolean
}

/** How long a restarted service is given to say it is ready and write that it opened. */
const BACK_MS = 120_000
const LOOK_MS = 2_000

/**
 * What a start of the unit runs, as far as `serve`: its `ExecStart=` read back
 * (`execOf`), or null where it runs something else — then this CLI is asked.
 */
export function unitStarts(unit: string | null): string[] | null {
  const words = unit === null ? null : execOf(unit)
  const at = words?.indexOf('serve') ?? -1
  return words && at > 0 ? words.slice(0, at) : null
}

/** The service's own pid, where it is running. */
function pidOf(state: ServiceState | null): number | null {
  return state?.kind === 'ready' || state?.kind === 'starting' ? state.pid : null
}

/**
 * The line that puts back the Tade that was here, where the install's own
 * command names a version — `npm install --global tade-sh@latest` with the old
 * one in its place — or null where it does not (Homebrew, a checkout).
 */
export function goingBack(command: string, version: string): string | null {
  return /@latest\b/.test(command) ? command.replace(/@latest\b/, `@${version}`) : null
}

/** Ask, unless the press was given ahead; never where nobody can answer. */
async function pressed(
  ask: Asker,
  opts: UpgradeOptions,
  question: string,
  otherwise: string,
  fallback = true,
): Promise<boolean> {
  if (opts.yes) return true
  if (!opts.asking) {
    ask.say(otherwise)
    return false
  }
  return ask.confirm(question, fallback)
}

/** Upgrade Tade on this machine in place. Answers the exit code. */
export async function upgradeHere(
  ask: Asker,
  place: UpgradePlace,
  opts: UpgradeOptions,
): Promise<number> {
  const look = await place.look(true)
  const where =
    look.from === 'checkout' ? `a checkout at ${look.where}` : (look.install?.said ?? look.where)
  ask.say(`Tade ${look.version}, ${where}`)
  const holder = await place.held()
  const service = holder === null ? null : await place.service()
  const byService = holder !== null && holder === pidOf(service)
  const running = holder === null ? null : await place.opened(holder)
  // On disk already newer than what holds the home: an upgrade that was never restarted onto.
  const was = running?.version ?? null
  const behindDisk = was !== null && compareVersions(was, look.version) < 0
  const wanted = look.newer !== null || look.cannotTell !== null
  if (!wanted && !behindDisk) {
    ask.say('  it is current: nothing to do')
    return Exit.ok
  }
  // Nothing to run is a refusal only where something was wanted of it.
  const command = 'command' in look.update ? look.update.command : null
  if (wanted && command === null) {
    ask.say(`  ${look.newer ?? look.cannotTell}`)
    ask.say(
      `  Tade cannot move itself forward here: ${'cannot' in look.update ? look.update.cannot : ''}`,
    )
    return Exit.error
  }
  let installed = false
  if (wanted && command !== null) {
    ask.say(`  ${look.newer ?? `whether a newer one is out cannot be told: ${look.cannotTell}`}`)
    if (opts.backup) {
      const backed = await place.backup()
      if (backed !== null) {
        ask.say(backed.ok ? '  backed up first' : `  the backup first did not work: ${backed.said}`)
        const anyway =
          backed.ok ||
          (await pressed(
            ask,
            { ...opts, yes: false },
            'upgrade anyway?',
            '  not upgraded: `--no-backup` upgrades without one',
            false,
          ))
        if (!anyway) return Exit.error
      }
    }
    if (
      !(await pressed(
        ask,
        opts,
        `run \`${command}\`?`,
        `  \`tade host upgrade --yes\` runs \`${command}\``,
      ))
    ) {
      if (opts.asking) ask.say('  not upgraded')
      return opts.asking ? Exit.ok : Exit.invalidInput
    }
    if ((await ask.run(command, '/bin/sh', ['-c', command])) !== 0) {
      ask.say(`  that did not work, and nothing was restarted: \`${command}\` says why above`)
      return Exit.error
    }
    installed = true
  } else {
    ask.say(`  ${look.version} is installed, and the Tade holding this home still runs ${was}`)
  }
  // What a start would run now, asked before anything is restarted onto it.
  const after = await place.starts()
  const back = command === null ? null : goingBack(command, was ?? look.version)
  if (after.version === null) {
    ask.say(`  the Tade now here does not start (${after.said}), so nothing was restarted`)
    if (back) ask.say(`  to go back to ${was ?? look.version}: \`${back}\``)
    return Exit.error
  }
  if (installed && after.version === look.version && look.newer !== null) {
    ask.say(`  ${command} moved nothing: this is still ${after.version}`)
  } else if (installed) {
    ask.say(`  ${after.version} is installed`)
  }
  if (holder === null) {
    ask.say(`  nothing has this home open: the next \`tade\` runs ${after.version}`)
    return Exit.ok
  }
  if (!byService) {
    ask.say(
      `  a window has this home open (pid ${holder}) and runs ${was ?? 'the Tade it opened on'} until it reloads: its strip says \`reload Tade\``,
    )
    return Exit.ok
  }
  if (was === after.version) {
    ask.say(`  ${SERVICE} runs ${after.version} already`)
    return Exit.ok
  }
  const stops = await place.lanesWouldStop()
  if (stops) {
    ask.say(`  not restarted, because ${stops}`)
    ask.say(`  restart it when nothing is working: \`${START}\``)
    return Exit.ok
  }
  if (
    !(await pressed(
      ask,
      opts,
      `restart ${SERVICE} onto ${after.version}? Agents keep working`,
      `  restart it onto ${after.version}: \`${START}\` — agents keep working`,
    ))
  ) {
    if (opts.asking) ask.say(`  not restarted: \`${START}\` when you want it`)
    return Exit.ok
  }
  if ((await ask.run(START, '/bin/sh', ['-c', START])) !== 0) {
    ask.say(`  the restart did not work — \`journalctl --user -u ${SERVICE}\` says why`)
    return Exit.error
  }
  return said(ask, place, after.version, back)
}

/** Look until the service has said it is ready and the journal says which Tade opened. */
async function said(
  ask: Asker,
  place: UpgradePlace,
  version: string,
  back: string | null,
): Promise<number> {
  for (let waited = 0; waited <= BACK_MS; waited += LOOK_MS) {
    const state = await place.service()
    const pid = pidOf(state)
    const opened = state?.kind === 'ready' && pid !== null ? await place.opened(pid) : null
    if (opened !== null) {
      if (opened.version !== version) {
        ask.say(
          `  ${SERVICE} came back as ${opened.version ?? 'a Tade that says no version'}, not ${version}`,
        )
        return Exit.error
      }
      const lanes = opened.lanes === null ? '' : `, and took up its ${opened.lanes} lanes again`
      ask.say(`  ${SERVICE} runs ${version} now${lanes}`)
      return Exit.ok
    }
    const trouble = state === null ? null : serviceTrouble(state)
    if (state?.kind === 'failed' || state?.kind === 'restarting') {
      ask.say(`  ${SERVICE}: ${trouble}`)
      if (back) ask.say(`  to go back: \`${back} && ${START}\``)
      return Exit.error
    }
    await place.wait(LOOK_MS)
  }
  ask.say(
    `  ${SERVICE} has not said which Tade it is after two minutes — \`journalctl --user -u ${SERVICE}\``,
  )
  return Exit.error
}
