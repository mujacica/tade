// Keeping the lanes out of the way of a service that is being stopped.
//
// Tade on a server runs as a unit of the person's own service manager, and a
// unit's default `KillMode=control-group` ends *everything in its cgroup* when
// it stops — whatever process group, session or `setsid` a child used. The tmux
// server that holds the lanes is started by Tade, so it would be in Tade's
// cgroup, and restarting `tade.service` would end every agent on the machine:
// the one thing running lanes in tmux is for. A unit file that says
// `KillMode=process` fixes it only for the person who wrote that unit, so the
// fix is here instead: under a service of the user's manager, the server is
// started in a scope of its own (`systemd-run --user --scope`), where stopping
// the service cannot reach it. Everywhere else — a login shell, a Mac, a
// system service with no user manager to ask — it starts as it always has.
//
// What to do is read off `/proc/self/cgroup`, by two pure functions and the one
// act that uses them.

import { readFile } from 'node:fs/promises'
import { runProgram, stringEnv } from '@tade/core'

/** A command that starts a server answers in milliseconds; one that has not in this long is stuck. */
const START_MS = 10_000

/**
 * The unit this process runs in, when that is a service of the user's own
 * service manager — `tade.service` — and null otherwise.
 *
 * Read off the cgroup path, which is where systemd puts a unit's processes:
 * `0::/user.slice/user-1000.slice/user@1000.service/app.slice/tade.service`
 * under cgroup v2, the `name=systemd` hierarchy's line under v1. A login
 * session is a `.scope` and is null, and so is a system service — a CI
 * runner's, most often — because there is no user manager under it to start a
 * scope in.
 */
export function userServiceOf(cgroup: string): string | null {
  for (const line of cgroup.split('\n')) {
    const found = /^\d+:(?:name=systemd)?:(\/.*)$/.exec(line.trim())
    if (!found?.[1]) continue
    const parts = found[1].split('/').filter(Boolean)
    const unit = parts.at(-1) ?? ''
    const manager = parts.findIndex((part) => /^user@\d+\.service$/.test(part))
    if (manager >= 0 && manager < parts.length - 1 && unit.endsWith('.service')) return unit
  }
  return null
}

/**
 * The line that starts a tmux server in a scope of its own: `systemd-run`'s
 * arguments, then tmux's.
 *
 * Named after the socket, so `systemctl --user status 'tade-lanes-*'` finds it,
 * and made unique, because a name that is taken refuses the start — and the
 * server this would have been is still running in the scope that has it.
 * `--collect` lets the scope go once the server ends, however it ended.
 */
export function scopedStart(socket: string, tmux: readonly string[], unique: string): string[] {
  const name = `tade-lanes-${socket}-${unique}`.replace(/[^A-Za-z0-9:_.-]+/g, '-')
  return [
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    `--unit=${name}`,
    `--description=Tade's lanes (tmux -L ${socket})`,
    'tmux',
    '-L',
    socket,
    ...tmux,
  ]
}

/**
 * Start the tmux server where whatever stops this process cannot reach it:
 * under a service of the user's service manager, in a scope of its own, and
 * with `plain` — the driver's own way of running tmux — everywhere else.
 *
 * A scope that could not be made is said, and the server started plainly,
 * because agents a restart of the service would end are still better than no
 * agents — and whoever reads the journal has to be told which they got. Where
 * the server was already running, the scope holds only the tmux that asked it
 * for a session, and is gone when that has.
 */
export async function startServer(
  opts: {
    socket: string
    cgroup: string
    env: NodeJS.ProcessEnv
    trouble: (problem: Error) => void
  },
  plain: (args: string[]) => Promise<unknown>,
  args: string[],
): Promise<void> {
  const cgroup = await readFile(opts.cgroup, 'utf8').catch((err: NodeJS.ErrnoException) => {
    // No such file is a machine with no cgroups to be in — a Mac — and that is
    // an answer. Anything else is a look that failed, and is said.
    if (err.code !== 'ENOENT') {
      opts.trouble(
        new Error(
          `could not read ${opts.cgroup}, so the lanes' tmux started plainly: ${err.message}`,
        ),
      )
    }
    return ''
  })
  const service = userServiceOf(cgroup)
  if (service) {
    const unique = `${process.pid}-${Date.now().toString(36)}`
    const ran = await runProgram('systemd-run', scopedStart(opts.socket, args, unique), {
      env: stringEnv(opts.env),
      timeoutMs: START_MS,
    })
    if (ran.code === 0) return
    const said = ran.missing ? 'systemd-run is not here' : ran.stderr.trim() || `exit ${ran.code}`
    opts.trouble(
      new Error(
        `the lanes' tmux could not be started in a scope of its own (${said}), so stopping ${service} will end every agent in it`,
      ),
    )
  }
  await plain(args)
}
