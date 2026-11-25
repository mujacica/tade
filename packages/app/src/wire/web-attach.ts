import type { LaneId } from '@tade/core'
import type { WebAttaching } from '@tade/web'
import type { Workbench } from '@tade/workbench'

// This machine's half of an agent on it opened from another machine's window
// (`@tade/web`'s `attached.ts`): the line its driver writes for showing that
// task's agent as a pane — or another of the task's lanes, its shell — or why
// there is none.
//
// **Asked of the driver, never guessed there**: which tmux server and session,
// which window — the other machine knows none of it, and a line it built for
// itself would be a line that works until somebody here changes a socket.

/** A task whose agent is not running here: nothing to attach to, and nothing opened. */
export const NOT_RUNNING = 'its agent is not running there'

/** Another lane of a task's that is not running here. */
export const LANE_GONE = 'that terminal of its is not running there'

/** What lanes that live inside this window are, for somebody on another machine. */
export function insideTheWindow(driver: string): string {
  return `agents there live inside its window (${driver}), where no terminal of yours can reach them — read and steer it from here, or give that machine workspace.driver: tmux`
}

export function attachingFor(
  client: Pick<Workbench, 'info' | 'lane' | 'attachCommand'>,
): WebAttaching {
  return (task, asked) => {
    const info = client.info()
    if (!info.capabilities.remoteAttach) return { command: null, why: insideTheWindow(info.driver) }
    // Another of its lanes — the shell its pane has a tab for — is that
    // lane's own line, read the same way; the route has held it to the task's.
    const lane = (asked ?? `${task}/agent`) as LaneId
    if (client.lane(lane)?.alive !== true) {
      return { command: null, why: asked === undefined ? NOT_RUNNING : LANE_GONE }
    }
    return { command: client.attachCommand(lane, { embedded: true }) }
  }
}
