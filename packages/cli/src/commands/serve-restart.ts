import { readFileSync } from 'node:fs'
import { type RunResult, runProgram, SERVICE } from '@tade/core'

// `tade serve` started again from the person's own phone: the away view's
// restart bar and `tade_reload` end in `AppOptions.reloadWindow`, which a
// window answers by re-execing itself — and a Tade with no screen answers by
// asking the service that keeps it to restart it, as `tade host upgrade` does
// from a shell.
//
// **Only the unit `tade host service` wrote**, read out of this process's own
// cgroup, never `INVOCATION_ID` alone: that says some unit started it, and a
// restart asked of `tade.service` from inside another would start a second
// Tade on the same home. Anything else — started by hand, under a unit of
// somebody's own — has nobody to start it again, and the bar says so.
//
// **`--no-block`**, because the restart stops this very process, and the
// `systemctl` it runs with it: the job is queued in systemd and the client
// answers at once, so what the restart did not take is said before it goes.

/** How long `systemctl` is given to take the job. */
const QUEUED_MS = 10_000

/** The unit a process runs in, out of its `/proc/<pid>/cgroup`: the last `.service` on its path. */
export function unitOf(cgroup: string): string | null {
  for (const line of cgroup.split('\n').reverse()) {
    // `hierarchy:controllers:path` — v2 is `0::/…`, v1 has the systemd one named.
    const path = line.split(':').slice(2).join(':')
    const last = path.split('/').at(-1) ?? ''
    if (last.endsWith('.service')) return last
  }
  return null
}

/** The unit this process runs in, or null where it cannot be read (not Linux, no systemd). */
export function ownUnit(
  read: () => string = () => readFileSync('/proc/self/cgroup', 'utf8'),
): string | null {
  try {
    return unitOf(read())
  } catch {
    return null
  }
}

/**
 * What starts this `tade serve` again, or undefined where nothing would: the
 * service's restart, under the unit Tade wrote.
 */
export function restartAsService(
  unit: string | null,
  run: (command: string, args: readonly string[]) => Promise<RunResult> = (command, args) =>
    runProgram(command, args, { timeoutMs: QUEUED_MS }),
): (() => Promise<void>) | undefined {
  if (unit !== SERVICE) return undefined
  return async () => {
    const ran = await run('systemctl', ['--user', 'restart', '--no-block', SERVICE])
    if (ran.code !== 0) {
      const said = ran.stderr.trim().split('\n')[0] || `systemctl exited ${ran.code}`
      throw new Error(`systemd would not restart ${SERVICE}: ${said}`)
    }
  }
}
