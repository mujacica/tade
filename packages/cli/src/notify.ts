import { runProgram, stringEnv } from '@tade/core'

// Telling the service manager how `tade serve` stands: `sd_notify`.
//
// Under a unit of `Type=notify` systemd hands the process the address of a
// datagram socket in `NOTIFY_SOCKET`, and counts the service started only once
// `READY=1` arrives there — so `systemctl start`, a unit ordered after this one
// and `tade setup` all mean "it holds the home and its away view listens", not
// "a process exists". Node has no datagram socket of that kind, so the line is
// sent by systemd's own `systemd-notify`, which since systemd 246 waits until
// the manager has read it: a sender that has exited by then is a pid the
// manager can no longer place in the unit, and its message is dropped. Being
// a child rather than the main process, it is heard only under
// `NotifyAccess=all`, which the unit says (`serviceUnit`).
//
// The address is taken out of the environment before anything is started, so
// the orchestrator, the servers it brokers and every agent never inherit it —
// what `sd_notify`'s `unset_environment` does.

/** A manager that answers in milliseconds; one that has not in this long is not reading. */
const SAY_MS = 5_000

/** What `tade serve` tells its service manager. */
export interface Notifier {
  /** It holds the home and is listening: the unit is started. */
  ready(status: string): Promise<void>
  /** It is closing, however it was asked to. */
  stopping(): Promise<void>
}

/**
 * The socket systemd handed this process to say it is ready on, or null where
 * none was — a terminal, a test — taken out of `env` so nothing started from
 * here inherits it.
 */
export function takeNotifySocket(env: NodeJS.ProcessEnv = process.env): string | null {
  const socket = env.NOTIFY_SOCKET
  delete env.NOTIFY_SOCKET
  return socket ? socket : null
}

/**
 * Tells the manager at `socket`, or nobody where there is none. What could
 * not be told is said through `trouble`: a unit that never hears `READY=1` is
 * stopped when its start times out and started again, so it is not quiet.
 */
export function notifier(
  socket: string | null,
  trouble: (message: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Notifier {
  const say = async (lines: string[], what: string, then = ''): Promise<void> => {
    if (socket === null) return
    const ran = await runProgram('systemd-notify', lines, {
      env: { ...stringEnv(env), NOTIFY_SOCKET: socket },
      timeoutMs: SAY_MS,
    })
    if (ran.code === 0) return
    const why = ran.missing
      ? 'there is no systemd-notify on its PATH'
      : ran.timedOut
        ? 'systemd-notify did not finish'
        : ran.stderr.trim().split('\n')[0] || `systemd-notify exited ${ran.code}`
    trouble(`systemd was not told ${what} (${why})${then}`)
  }
  return {
    ready: (status) =>
      say(
        ['READY=1', `STATUS=${oneLine(status)}`],
        'this is ready',
        ', so it will stop the unit when its start times out',
      ),
    stopping: () => say(['STOPPING=1'], 'this is stopping'),
  }
}

/** A status systemd shows on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200)
}
