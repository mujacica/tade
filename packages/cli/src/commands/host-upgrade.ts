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
// ending an agent.
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
  /**
   * The version to move to, where somebody named one: another machine's
   * reload moving this one to the Tade it runs (`fleet-reload.ts`). Wanted
   * only while this one is older, and pinned where the install's command
   * names `@latest`; elsewhere the command moves to its newest. Absent, the newest.
   */
  to?: string
  /**
   * The commit to move a checkout to: another machine's reload handing this
   * one its own HEAD, which it pushed here first (`fleet-reload.ts`), because
   * a checkout's version says nothing of where it is and its upstream may not
   * have those commits yet. Fast-forward only; dependencies installed where
   * the lockfile moved. Refused for an install.
   */
  commit?: string
}

/** A version as `--to` takes it: digits and dots, a pre-release after — never anything a shell reads. */
export const VERSION_SHAPE = /^\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?$/

/** A commit as `--commit` takes it: the whole id, and nothing a shell reads. */
export const COMMIT_SHAPE = /^[0-9a-f]{40}$/

/**
 * The line that moves the checkout at `root` to `commit`: fetched from its
 * upstream where it is not here already (nobody pushed it), fast-forward only
 * so nothing anybody committed there is ever thrown away, then installed with
 * the lockfile as it is, only where the lockfile moved.
 */
export function forwardTo(root: string, commit: string): string {
  const at = `'${root.replace(/'/g, `'\\''`)}'`
  return [
    `cd ${at}`,
    `{ git cat-file -e '${commit}^{commit}' 2>/dev/null || git fetch --quiet; }`,
    'was=$(git rev-parse HEAD)',
    `git merge --ff-only --quiet ${commit}`,
    `{ git diff --quiet "$was" ${commit} -- pnpm-lock.yaml || pnpm install --frozen-lockfile; }`,
  ].join(' && ')
}

/** The install's command moved to one version, where it names `@latest`; as it is otherwise. */
export function pinnedTo(command: string, version: string): string {
  return command.replace(/@latest\b/, `@${version}`)
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
  // It goes into the command a shell runs: refused unless it is a version and nothing else.
  if (opts.to !== undefined && !VERSION_SHAPE.test(opts.to)) {
    ask.say(`  ${JSON.stringify(opts.to)} is not a version: --to takes one like 0.4.3`)
    return Exit.invalidInput
  }
  const commit = opts.commit
  if (commit !== undefined && !COMMIT_SHAPE.test(commit)) {
    ask.say(`  ${JSON.stringify(commit)} is not a commit: --commit takes one's whole id`)
    return Exit.invalidInput
  }
  // Moving to a commit asks nobody what is newest: it is told.
  const look = await place.look(commit === undefined)
  const where =
    look.from === 'checkout' ? `a checkout at ${look.where}` : (look.install?.said ?? look.where)
  ask.say(`Tade ${look.version}, ${where}`)
  if (commit !== undefined && look.from !== 'checkout') {
    ask.say('  --commit moves a checkout, and this Tade is an install: `--to` takes a version')
    return Exit.invalidInput
  }
  const holder = await place.held()
  const service = holder === null ? null : await place.service()
  const byService = holder !== null && holder === pidOf(service)
  const running = holder === null ? null : await place.opened(holder)
  // On disk already newer than what holds the home: an upgrade that was never restarted onto.
  const was = running?.version ?? null
  // By commit, a checkout is behind what holds the home where that started on another one.
  const ranOn = running?.commit ?? null
  const behindDisk =
    commit === undefined
      ? was !== null && compareVersions(was, look.version) < 0
      : running !== null && ranOn !== commit
  const target = opts.to
  const wanted =
    commit !== undefined
      ? look.commit === null || !commit.startsWith(look.commit)
      : target === undefined
        ? look.newer !== null || look.cannotTell !== null
        : compareVersions(look.version, target) < 0
  if (!wanted && !behindDisk) {
    ask.say('  it is current: nothing to do')
    return Exit.ok
  }
  // Nothing to run is a refusal only where something was wanted of it.
  const given = 'command' in look.update ? look.update.command : null
  const command =
    commit !== undefined
      ? forwardTo(look.where, commit)
      : given !== null && target !== undefined
        ? pinnedTo(given, target)
        : given
  if (wanted && command === null) {
    ask.say(
      `  ${target === undefined ? (look.newer ?? look.cannotTell) : `${target} was asked for`}`,
    )
    ask.say(
      `  Tade cannot move itself forward here: ${'cannot' in look.update ? look.update.cannot : ''}`,
    )
    return Exit.error
  }
  let installed = false
  if (wanted && command !== null) {
    ask.say(
      commit !== undefined
        ? `  ${commit.slice(0, 9)} was asked for, and this checkout is on ${look.commit ?? 'no commit git names'}`
        : target === undefined
          ? `  ${look.newer ?? `whether a newer one is out cannot be told: ${look.cannotTell}`}`
          : `  ${target} was asked for, and this is ${look.version}`,
    )
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
  } else if (commit !== undefined) {
    ask.say(
      `  this checkout is on ${commit.slice(0, 9)}, and the Tade holding this home started on ${ranOn?.slice(0, 9) ?? 'a commit it did not write down'}`,
    )
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
  if (installed && commit !== undefined) {
    ask.say(`  moved to ${commit.slice(0, 9)}: Tade ${after.version}`)
  } else if (
    installed &&
    after.version === look.version &&
    (look.newer !== null || target !== undefined)
  ) {
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
  if (commit === undefined ? was === after.version : ranOn === commit) {
    ask.say(`  ${SERVICE} runs ${commit?.slice(0, 9) ?? after.version} already`)
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
  return said(ask, place, after.version, back, commit ?? null)
}

/** Look until the service has said it is ready and the journal says which Tade opened. */
async function said(
  ask: Asker,
  place: UpgradePlace,
  version: string,
  back: string | null,
  commit: string | null,
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
      // One that wrote no commit is an older Tade, which cannot have been this one.
      if (commit !== null && opened.commit !== commit) {
        ask.say(
          `  ${SERVICE} came back on ${opened.commit?.slice(0, 9) ?? 'a Tade that says no commit'}, not ${commit.slice(0, 9)}`,
        )
        return Exit.error
      }
      const lanes = opened.lanes === null ? '' : `, and took up its ${opened.lanes} lanes again`
      const on = commit === null ? version : `${version} at ${commit.slice(0, 9)}`
      ask.say(`  ${SERVICE} runs ${on} now${lanes}`)
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
