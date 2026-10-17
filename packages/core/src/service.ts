// Tade kept running by the person's own service manager, on a Linux box.
//
// Tade starts no daemon of its own. On a server the person runs it under
// systemd, as a unit of their own user, and this is the unit: written only
// when they press for it (`tade host service`), shown before it is written,
// and doing nothing a person could not read in it.
//
// What it runs is `tade serve`, the window with no screen: the beat, the queue,
// schedules and watches, intake, the orchestrator and the away view, holding
// the home as `tade app` does. Node is the unit's main process, so systemd
// restarts it when it fails and waits for it when it stops, and it says it is
// ready (`Type=notify`) once it holds the home and its away view listens — so
// "active" means a Mac's link can reach it, not that a process exists. What it
// says is the unit's log; from a Mac, the window there shows all of it over the
// link. The agents are not in this unit at all: the tmux driver starts their
// server in a scope of its own (`drivers/tmux/src/scope.ts`), which is what
// makes restarting this service harmless.
//
// Pure: the facts come in, the text goes out. Where it is written, and whether
// systemd and linger are here, is the workbench's to look at.

/** The unit's name, under `~/.config/systemd/user/`. */
export const SERVICE = 'tade.service'

/** How to read what the service says, from any terminal on the box. */
export const LOG = `journalctl --user -u ${SERVICE} -f`

/**
 * Starting the unit, as the person would type it: `restart` rather than
 * `--now`, which leaves a running one on the unit it started with — and
 * restarting is harmless, because the agents are not in it. `reset-failed`
 * first, because the start limit below counts every start, a person's
 * restarts included: six in five minutes and `restart` is refused, and
 * somebody starting it means now.
 */
export const START = `systemctl --user daemon-reload && systemctl --user enable ${SERVICE} && systemctl --user reset-failed ${SERVICE} && systemctl --user restart ${SERVICE}`

/** The subcommand the unit runs, and the one an older Tade's ran in tmux. */
const SERVE = 'serve'
const WINDOW = 'app'

export interface ServiceFacts {
  /** How to run Tade, absolute, as far as `serve`: `['/usr/bin/node', '/home/you/…/bin.ts']`. */
  tade: readonly string[]
  /**
   * The PATH everything it starts will have. A service's own is the system's
   * bare one, which has none of Node, the harnesses or a user's npm prefix.
   */
  path: string
  /** `TADE_HOME`, where it is not the default. */
  home: string | null
  /** A UTF-8 locale for the agents' terminals to draw in. */
  lang: string
}

/** The unit, as it is written to the file. */
export function serviceUnit(facts: ServiceFacts): string {
  const env = [
    `Environment=${quoted(`PATH=${facts.path}`, false)}`,
    `Environment=${quoted(`LANG=${facts.lang}`, false)}`,
    ...(facts.home ? [`Environment=${quoted(`TADE_HOME=${facts.home}`, false)}`] : []),
  ]
  return [
    '# Tade, kept running by your own service manager. `tade host service` wrote this.',
    '#',
    '# It runs `tade serve`: the queue, schedules, watches, intake, the orchestrator and the',
    '# away view, with no screen. From your Mac, `tade remote add` links this machine to the',
    '# window there, which shows all of it. What it says is its log:',
    `#   ${LOG}`,
    '# Agents run on a tmux server of their own, in a scope of their own, so stopping or',
    '# restarting this service never ends one: the Tade that comes back adopts them.',
    '# Keys exported in your shell do not reach a service: put them in Tade’s config',
    '# (`tade config`, or sent from your Mac), or in an EnvironmentFile= of your own.',
    '',
    '[Unit]',
    'Description=Tade, the control room for coding agents',
    'Documentation=https://tade.sh',
    // A Tade that cannot open — another one holds this home — fails at once,
    // and five starts in five minutes is a reason to stop trying (`START`
    // clears it).
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    // Started only once it says so: it holds the home and its away view listens.
    'Type=notify',
    // It says so through `systemd-notify`, a child of its own, which a unit
    // hears only from its main process unless told otherwise. Only Tade is
    // handed the socket: it takes it out of what everything it starts inherits.
    'NotifyAccess=all',
    ...env,
    `ExecStart=${[...facts.tade, SERVE].map((word) => quoted(word, true)).join(' ')}`,
    // Its log reads `tade:` rather than `node:`.
    'SyslogIdentifier=tade',
    // A stop signals Tade alone, which closes what it started — the
    // orchestrator, the servers it brokers — as quitting does; whatever is
    // left once it has gone is killed.
    'KillMode=mixed',
    'TimeoutStopSec=30',
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** The backup's two units: the one run, and the timer that runs it hourly. */
export const BACKUP_SERVICE = 'tade-backup.service'
export const BACKUP_TIMER = 'tade-backup.timer'

/** Starting the timer, now and at every boot, as the person would type it. */
export const BACKUP_START = `systemctl --user daemon-reload && systemctl --user enable --now ${BACKUP_TIMER}`

/**
 * `tade host backup`, hourly, by the person's own service manager: a oneshot
 * that runs it with the same Node, CLI, PATH and home as the service, and a
 * timer that starts it. `Persistent=` catches up one run missed while the box
 * was off, never one per hour missed, and the spread keeps every box on a
 * storage service from arriving on the hour at once. Idle for the disk and
 * nice for the processor, because agents work on this machine while it reads.
 */
export function backupUnits(facts: ServiceFacts): { service: string; timer: string } {
  const env = [
    `Environment=${quoted(`PATH=${facts.path}`, false)}`,
    `Environment=${quoted(`LANG=${facts.lang}`, false)}`,
    ...(facts.home ? [`Environment=${quoted(`TADE_HOME=${facts.home}`, false)}`] : []),
  ]
  const service = [
    '# Tade’s backup, run by tade-backup.timer. `tade host backup --timer` wrote this.',
    '#',
    '# It runs `tade host backup`: Tade’s home and the harnesses’ conversations, encrypted',
    '# by restic, to the repository in backup.repository. What it said, each time:',
    `#   journalctl --user -u ${BACKUP_SERVICE}`,
    '',
    '[Unit]',
    'Description=Tade’s backup',
    'Documentation=https://tade.sh',
    '',
    '[Service]',
    'Type=oneshot',
    ...env,
    `ExecStart=${[...facts.tade, 'host', 'backup'].map((word) => quoted(word, true)).join(' ')}`,
    'SyslogIdentifier=tade-backup',
    'Nice=10',
    'IOSchedulingClass=idle',
    '',
  ].join('\n')
  const timer = [
    '# Runs tade-backup.service hourly. `tade host backup --timer` wrote this.',
    '',
    '[Unit]',
    'Description=Tade’s backup, hourly',
    '',
    '[Timer]',
    'OnCalendar=hourly',
    'RandomizedDelaySec=10min',
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n')
  return { service, timer }
}

/**
 * The command a unit runs, word by word, as systemd reads its `ExecStart=`
 * back: quoted words joined, `%%` and `$$` single again, a prefix systemd
 * reads (`-`, `@`, `+`, `!`, `:`) taken off. Null where it has none.
 */
export function execOf(unit: string): string[] | null {
  const line = unit
    .split('\n')
    .map((one) => one.trim())
    .findLast((one) => one.startsWith('ExecStart='))
  const value = line?.slice('ExecStart='.length).replace(/^[-@+!:]+/, '') ?? ''
  const words: string[] = []
  for (const found of value.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)) {
    const word = found[1] !== undefined ? found[1].replace(/\\(.)/g, '$1') : (found[2] ?? '')
    words.push(word.replaceAll('%%', '%').replaceAll('$$', '$'))
  }
  return words.length > 0 ? words : null
}

/**
 * What is wrong with the unit that is there, as a clause that follows "the
 * unit", or null where it runs `tade serve` from files that are there.
 *
 * A unit is the text a person was shown, and nothing here refuses one somebody
 * changed — it is said what it does, and how to have this Tade's instead. An
 * older Tade's ran the window in tmux; one whose Node or Tade has moved — a
 * Node upgraded under a version manager — fails at every start with nothing
 * but systemd's word for it, `exit-code`.
 */
export function unitTrouble(unit: string, here: (path: string) => boolean): string | null {
  const exec = execOf(unit)
  const again = '`tade host service --write` writes the one that runs `tade serve`'
  if (exec === null) return `starts nothing: ${again}`
  if (!exec.includes(SERVE)) {
    return exec.includes(WINDOW)
      ? `is an older Tade’s, which runs the window in tmux: ${again}`
      : `does not run \`tade serve\`: ${again}`
  }
  const gone = exec
    .slice(0, exec.indexOf(SERVE))
    .find((word) => word.startsWith('/') && !here(word))
  if (gone)
    return `runs ${gone}, which is not there any more: \`tade host service --write\` writes it for this Tade`
  return null
}

/** How the unit stands, as its service manager answered. */
export type ServiceState =
  /** Running, and it said it was ready: it holds the home. */
  | { kind: 'ready'; pid: number | null; status: string }
  /** Started, and it has not said it is ready yet. */
  | { kind: 'starting'; pid: number | null }
  /** It failed, and systemd will start it again: how many times so far. */
  | { kind: 'restarting'; restarts: number }
  /** It failed and is not being started again: systemd's word for why. */
  | { kind: 'failed'; result: string }
  /** Being stopped. */
  | { kind: 'stopping'; pid: number | null }
  /** Not running. */
  | { kind: 'stopped' }
  /** Its manager has not read the unit: written since the last `daemon-reload`, or never. */
  | { kind: 'unread' }
  /** Nobody could ask: no `systemctl`, no user manager, or it did not answer. */
  | { kind: 'cannot'; why: string }

/** What `serviceStateOf` reads: `systemctl --user show` with these, as `Key=value` lines. */
export const SHOWN = [
  'LoadState',
  'ActiveState',
  'SubState',
  'Result',
  'MainPID',
  'NRestarts',
  'StatusText',
]

/** The unit's state out of what `systemctl --user show --property=…` printed (`SHOWN`). */
export function serviceStateOf(shown: string): ServiceState {
  const said = new Map<string, string>()
  for (const line of shown.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) said.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
  }
  const pid = Number(said.get('MainPID') ?? '0')
  const main = Number.isInteger(pid) && pid > 0 ? pid : null
  const active = said.get('ActiveState')
  const sub = said.get('SubState') ?? ''
  if (active === undefined) return { kind: 'cannot', why: 'systemctl answered nothing about it' }
  if (said.get('LoadState') === 'not-found') return { kind: 'unread' }
  if (sub === 'auto-restart')
    return { kind: 'restarting', restarts: Number(said.get('NRestarts')) || 0 }
  switch (active) {
    case 'active':
    case 'reloading':
      return { kind: 'ready', pid: main, status: said.get('StatusText') ?? '' }
    case 'activating':
      return { kind: 'starting', pid: main }
    case 'deactivating':
      return { kind: 'stopping', pid: main }
    case 'failed':
      return { kind: 'failed', result: said.get('Result') || 'failed' }
    default:
      return { kind: 'stopped' }
  }
}

/**
 * What is wrong with how the service stands, as a clause, or null where it is
 * ready. Each with the one thing to do about it.
 */
export function serviceTrouble(state: ServiceState): string | null {
  const why = `\`journalctl --user -u ${SERVICE}\` says why`
  switch (state.kind) {
    case 'ready':
      return null
    case 'starting':
      return 'it has started and not yet said it is ready — it does once it holds the home'
    case 'restarting':
      return `it keeps failing, and systemd is starting it again (${state.restarts} so far): ${why}`
    case 'failed':
      if (state.result === 'start-limit-hit') {
        return `it was started five times in five minutes, so systemd stopped trying — ${why}, and \`${START}\` starts it again`
      }
      return state.result === 'timeout'
        ? `it never said it was ready, so systemd stopped it: ${why}`
        : `it failed (${state.result}): ${why}`
    case 'stopping':
      return 'it is stopping'
    case 'stopped':
    case 'unread':
      return `it is not running: \`${START}\``
    case 'cannot':
      return `whether it is running cannot be told: ${state.why}`
  }
}

/**
 * The service manager keeping this window open, or null where a person opened
 * it — the always-on box, where "while this window is open" means always.
 *
 * systemd sets `INVOCATION_ID` in every unit it starts, `tade serve` among
 * them. Linux with no screen, as `unattendedHere` asks, because a desktop's
 * own terminal may be started by systemd too and is not a window that never
 * closes. Read
 * once, as the window opens, and handed down (`keptBy`), never read out of the
 * environment by whatever needs it.
 */
export function keptByService(
  env: Readonly<Record<string, string | undefined>>,
  platform: string,
): 'systemd' | null {
  if (platform !== 'linux' || !env.INVOCATION_ID) return null
  if (env.DISPLAY || env.WAYLAND_DISPLAY) return null
  return 'systemd'
}

/**
 * A word as systemd reads it back: quoted where it has to be, `%` doubled so
 * it is not a specifier, and — on an `Exec` line — `$` doubled so it is not a
 * variable.
 */
function quoted(word: string, exec: boolean): string {
  let text = word.replaceAll('%', '%%')
  // A function, because `'$$'` as a replacement string is one `$`.
  if (exec) text = text.replaceAll('$', () => '$$')
  if (/^[A-Za-z0-9_@%+=:,./{}#-]+$/.test(text)) return text
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
