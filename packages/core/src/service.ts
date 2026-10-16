// Tade kept running by the person's own service manager, on a Linux box.
//
// Tade starts no daemon of its own. On a server the person runs it under
// systemd, as a unit of their own user, and this is the unit: written only
// when they press for it (`tade host service`), shown before it is written,
// and doing nothing a person could not read in it.
//
// What it runs is the window, inside tmux on a server of its own, so anybody
// can attach to it over SSH and see exactly what they would have seen at the
// keyboard. Its main process is Tade itself — the tmux pane's — so systemd
// restarts the window when Tade fails and not when somebody quits it, and a
// stop signals Tade first (`KillMode=mixed`) so it closes the way it does when
// you press q. The agents are not in this unit at all: the tmux driver starts
// their server in a scope of its own (`drivers/tmux/src/scope.ts`), which is
// what makes restarting this service harmless.
//
// Pure: the facts come in, the text goes out. Where it is written, and whether
// systemd and linger are here, is the workbench's to look at.

/** The unit's name, under `~/.config/systemd/user/`. */
export const SERVICE = 'tade.service'

/** The tmux server the window runs on: its own, so attaching never finds somebody else's. */
export const WINDOW_SOCKET = 'tade-window'

/** The window's session on it. */
export const WINDOW_SESSION = 'tade'

/** How to look at the window the unit runs, from any terminal on the box. */
export const ATTACH = `tmux -L ${WINDOW_SOCKET} attach -t ${WINDOW_SESSION}`

/** Closing the window as a signal does, and waiting until it has: `$MAINPID` is systemd's. */
const STOP = 'kill -TERM "$MAINPID" && while kill -0 "$MAINPID" 2>/dev/null; do sleep 0.2; done'

/** Where the unit says Tade's pid is, under the user's runtime directory (`%t`). */
const PID_FILE = '%t/tade-window.pid'

export interface ServiceFacts {
  /** How to run Tade, absolute, as far as `app`: `['/home/you/.local/bin/tade']`. */
  tade: readonly string[]
  /** The tmux to run the window in, absolute. */
  tmux: string
  /**
   * The PATH everything it starts will have. A service's own is the system's
   * bare one, which has none of Node, the harnesses or a user's npm prefix.
   */
  path: string
  /** `TADE_HOME`, where it is not the default. */
  home: string | null
  /** A UTF-8 locale for the window to draw in. */
  lang: string
}

/** The unit, as it is written to the file. */
export function serviceUnit(facts: ServiceFacts): string {
  const env = [
    `Environment=${quoted(`PATH=${facts.path}`, false)}`,
    `Environment=${quoted(`LANG=${facts.lang}`, false)}`,
    ...(facts.home ? [`Environment=${quoted(`TADE_HOME=${facts.home}`, false)}`] : []),
  ]
  const start = [
    facts.tmux,
    '-u',
    '-L',
    WINDOW_SOCKET,
    'new-session',
    '-d',
    '-s',
    WINDOW_SESSION,
    '-x',
    '200',
    '-y',
    '50',
    '-P',
    '-F',
    '#{pane_pid}',
    ...facts.tade,
    'app',
  ]
  return [
    '# Tade, kept running by your own service manager. `tade host service` wrote this.',
    '#',
    '# The window runs in tmux, so you can look at it from any terminal, over SSH too:',
    `#   ${ATTACH}        (ctrl+b d leaves it running)`,
    '# Agents run on a tmux server of their own, in a scope of their own, so stopping or',
    '# restarting this service never ends one: the window that comes back adopts them.',
    '# Keys exported in your shell do not reach a service: put them in Tade’s config',
    '# (Settings in the window), or in an EnvironmentFile= of your own.',
    '',
    '[Unit]',
    'Description=Tade, the control room for coding agents',
    'Documentation=https://tade.sh',
    // A window that cannot open — another one holds this home — fails at
    // once, and five of those in five minutes is a reason to stop trying.
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    // tmux puts the window in the background and prints the pane's pid, which
    // is Tade's: so Tade is the main process, the one whose failing restarts it.
    'Type=forking',
    `PIDFile=${PID_FILE}`,
    ...env,
    `ExecStart=${start.map((word) => quoted(word, true)).join(' ')}`,
    // Tade is not systemd's own child — it is tmux's — and systemd does not
    // wait for a process it did not start: a stop with no ExecStop signals it
    // and kills everything in the same breath, so Tade never closes. This asks
    // it to close the way q does, and waits for it.
    `ExecStop=${['/bin/sh', '-c', STOP].map((word) => quoted(word, true)).join(' ')}`,
    'TimeoutStopSec=30',
    // `truncate:` is systemd 248 — Debian 12, Ubuntu 22.04 and everything
    // since — and `file:` would leave the end of a longer pid behind.
    `StandardOutput=truncate:${PID_FILE}`,
    'StandardError=journal',
    'KillMode=mixed',
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
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
