import type { SettingConflict } from './carry.ts'
import { TALKING_IS_NOT_YOU_SHORT } from './origin.ts'
import { IN_CONFIG, SEEN_BY_AGENTS } from './secrets.ts'

// What carrying says, where the window draws it — Settings › Remotes, in a
// browser too (`pure.ts`). Apart from `carry.ts`, which compares keys by their
// `node:crypto` digest; it hands these on, so nothing that imports them from
// there changes.

/**
 * The conflict as said, once, on each machine: "approvals.mode: vps set ask
 * at 14:02, this machine set auto at 14:05; this machine’s kept". Each side
 * is named as the person names it — this machine, and the other by `there`,
 * what this one calls it (the remote's name) — never by two host names, which
 * may be one. `hm` is the clock face of a stamp, the caller's, so this stays pure.
 */
export function conflictSays(
  c: SettingConflict,
  hm: (wall: number) => string,
  there: string,
): string {
  const who = (side: 'kept' | 'lost') => (side === c.mine ? 'this machine' : there)
  const one = (side: 'kept' | 'lost') => {
    const { value, at } = c[side]
    return `${who(side)} set ${value === '' ? 'nothing' : value} ${at === null ? 'before anything wrote it down' : `at ${hm(at.wall)}`}`
  }
  return `${c.path}: ${one('lost')}, ${one('kept')}; ${who('kept')}’s kept.`
}

/**
 * What is said where somebody is about to send keys to another machine.
 *
 * `KEYS_AND_AGENTS` again, one machine further — its clause, never a second
 * wording of it: on that machine too the file is read by every agent, and that
 * machine may be on the internet. The way out in the same breath, because that
 * is the rule for every sentence of this kind.
 */
export const KEYS_TO_REMOTE =
  `Sends these to that machine’s ${IN_CONFIG}, written 0600 there and replacing any of the same ` +
  `name — and there too ${SEEN_BY_AGENTS}: agents run as you, and nothing sandboxes them. That ` +
  'they were sent, and by whom, is written down on both machines; a key never is. To keep one off ' +
  'that machine, export its variable there instead, or leave it unsent.'

/** What is said where somebody is about to turn `TALK_THERE` on over there. */
export const TALK_TO_REMOTE =
  'Turns on Talk to Tade on that machine: what you type in its tab here goes to its orchestrator as ' +
  `you at its keyboard, and a device paired there may send one too — ${TALKING_IS_NOT_YOU_SHORT}. ` +
  'Its Settings › Away view turns it off again.'
