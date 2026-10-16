import type { Told } from '@tade/web'
import type { Wiring } from './context.ts'

/**
 * One line in the journal, and **said in the strip if it would not go in**.
 *
 * A journal that will not take a line is not a reason a request fails — a
 * phone must not get a `500` because a disk is full — but it may not be
 * swallowed either: `web_paired` and `web_did` are the audit, and "every act
 * one takes is in the journal under its id" is half of what stands against a
 * device somebody else let in. A line that silently did not land would make
 * that sentence quietly untrue, so the failure goes where a person reading
 * the window will see it.
 */
export function toldTo(wire: Wiring, news: (said: string) => void): (told: Told) => Promise<void> {
  return async (told) => {
    try {
      await wire.opts.client.log.append(told)
    } catch (err) {
      news(
        `the away view could not write ${told.type} down: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

/**
 * What the listener tells the journal, and the one line of it the window says
 * as well: a device that a code from `tade web pair` let in.
 *
 * Nobody at this window was asked — running the command was the yes
 * (`@tade/web`'s `pending.ts`) — so the strip is where somebody watching it
 * hears that a device got in, and the list is read again now rather than on
 * the next beat a stream happens to be open for.
 */
export function heard(
  log: (told: Told) => Promise<void>,
  news: (said: string) => void,
  reread: () => Promise<void>,
): (told: Told) => void {
  return (told) => {
    void log(told)
    if (told.type !== 'web_paired' || told.detail.code !== 'terminal') return
    news(`a device paired with a code from \`tade web pair\`: ${String(told.detail.device)}`)
    void reread()
  }
}
