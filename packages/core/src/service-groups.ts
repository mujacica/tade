import { START } from './service.ts'

// Whether the running `tade serve` holds the group of each user its agents run
// as (`agents.user`). `usermod` puts Tade's user in that group, and a process
// already running keeps the groups it began with — so a service started before
// it refuses every start ("share is not there for Tade to write in") while the
// user, and setup's own shell after a login, have the group. So it is read off
// the running process, never the user. A user service takes its groups from
// the user's service manager, which with linger on runs from boot and keeps
// its own: where that lacks the group too, restarting the service alone
// changes nothing, and that is what is said.
//
// Pure: what `/proc` said comes in, the sentence goes out. Reading `/proc` is
// `serviceGroups` (`workbench/src/machine.ts`).

/** A running process's credentials, out of its `/proc/<pid>/status`. */
export interface ProcessGroups {
  /** Who started it: for a service, the user's service manager. */
  parent: number | null
  /** Its real user. */
  uid: number | null
  /** Every group it holds: its own and its supplementary ones. */
  groups: readonly number[]
}

/** What `/proc/<pid>/status` says of a process's groups, or null where it says none. */
export function processGroupsOf(status: string): ProcessGroups | null {
  const said = new Map<string, number[]>()
  for (const line of status.split('\n')) {
    const at = line.indexOf(':')
    if (at <= 0) continue
    const numbers = line
      .slice(at + 1)
      .trim()
      .split(/\s+/)
      .filter((one) => /^\d+$/.test(one))
      .map(Number)
    said.set(line.slice(0, at), numbers)
  }
  const groups = said.get('Groups')
  if (!groups) return null
  // `Gid:` is real, effective, saved and filesystem: the effective one counts too.
  const effective = said.get('Gid')?.[1]
  return {
    parent: said.get('PPid')?.[0] ?? null,
    uid: said.get('Uid')?.[0] ?? null,
    groups: [...new Set([...(effective === undefined ? [] : [effective]), ...groups])],
  }
}

/**
 * Whether the running `tade serve` holds an agent user's group, read off the
 * process itself — never off the user, whom `usermod` changed under it.
 */
export interface ServiceGroup {
  user: string
  pid: number
  held: boolean
  /**
   * Whether the user's service manager that started it holds the group, or
   * null where it could not be read. A user service has its groups from that
   * manager, which keeps the ones it began with — with linger on, from boot.
   */
  manager: boolean | null
  /** Whose services they are: the manager's unit is `user@<uid>.service`. */
  uid: number | null
}

/**
 * Why no agent can start as `one.user` while Tade's service runs as it is, in
 * one sentence with the exact command, or null where it holds the group.
 * Restarting the service gives it the group only where its manager has it;
 * where not, it is the manager that has to start again, and every service of
 * the user's with it — the agents' tmux among them — which is said.
 */
export function serviceGroupTrouble(one: ServiceGroup, self: string): string | null {
  if (one.held) return null
  const lacks = `Tade's service (pid ${one.pid}) started before ${self} was put in ${one.user}'s group and does not have it, so no agent can start as ${one.user}`
  if (one.manager === true) return `${lacks}: restart it — \`${START}\``
  const manager = `user@${one.uid ?? '$(id -u)'}.service`
  return `${lacks}, and restarting it alone changes nothing, since its groups are your service manager's: restart that — \`sudo systemctl restart ${manager}\`, which stops every service of yours with it, the agents' tmux among them`
}
