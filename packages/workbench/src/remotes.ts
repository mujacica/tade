import { printable, type RemoteConfig, type TadeEvent } from '@tade/core'
import type { Held, MakeRemoteLink, Remote } from '@tade/remotes-core'
import { makeScriptedLink } from '@tade/remotes-scripted'
import { makeSshLink } from '@tade/remotes-ssh'

// The remote links there are, by name: the one registry every call site goes
// through (R1), so another way of reaching a machine — a relay, a tailnet name
// with no shell behind it — is an implementation and a line here, never a
// `new` somewhere that assumed every remote was over SSH.
//
// Here rather than beside the port because a port must not import its own
// implementations, and this is the lowest package both things that need one
// already depend on: the window, which holds the links, and the CLI, which
// pairs and signs out through them without opening anything.
//
// `scripted` is registered and chosen for nobody, as the scripted forge is:
// with no table of far ends it reaches no remote at all.

export const REMOTE_LINKS: Readonly<Record<string, MakeRemoteLink>> = {
  ssh: makeSshLink,
  scripted: makeScriptedLink,
}

/**
 * Which link a configured remote is reached by.
 *
 * Every `remotes.<name>` is reached over SSH today — its destination is the
 * block's `ssh` key — so this is one answer; a block for another kind of link
 * will name its own key, and this is where that is read.
 */
export function linkOf(_remote: RemoteConfig): string {
  return 'ssh'
}

/** A `remotes.<name>` block as a link is told about it. */
export function remoteOf(name: string, config: RemoteConfig): Remote {
  return {
    name,
    address: config.ssh,
    tade: config.tade,
    session: {
      device: config.device,
      cookie: config.session,
      csrf: config.csrf,
      host: config.host,
    },
  }
}

/**
 * What a held link is called in the journal: up, down, ended — or nothing,
 * while it is between two of those.
 *
 * A dial is not a word: a link that redials after a wake goes live → dialling
 * → live, and the journal hears nothing, because nothing a person would ask
 * about happened.
 */
export type LinkWord = 'up' | 'down' | 'ended'

export function wordOf(held: Held): LinkWord | null {
  // Up once it holds where it is — a snapshot, or a cursor it resumed from —
  // and not at the status line before either has arrived.
  if (held.link.kind === 'live') return held.cursor === null ? null : 'up'
  if (held.link.kind === 'down') return 'down'
  if (held.link.kind === 'ended') return 'ended'
  return null
}

/** The journal line a link's new word is: written only when the word changed. */
export function lineFor(
  held: Held,
  word: LinkWord,
): { type: 'remote_linked' | 'remote_unlinked'; detail: Record<string, string> } {
  // The epoch and why it went are the remote's words — a `notice` frame's, or a
  // parser quoting what it was sent — and `tade remote status` and `tade logs`
  // print them, so they are written down as text (`printable`).
  if (word === 'up') {
    return {
      type: 'remote_linked',
      detail: { remote: held.remote, epoch: printable(held.cursor?.epoch ?? '') },
    }
  }
  const link = held.link
  return {
    type: 'remote_unlinked',
    detail: {
      remote: held.remote,
      state: word,
      ...(link.kind === 'down' ? { problem: link.problem, said: printable(link.said) } : {}),
      ...(link.kind === 'ended' ? { said: printable(link.said) } : {}),
    },
  }
}

/** How one remote's link last stood, as the journal says: what `tade remote status` reads. */
export interface LinkSeen {
  word: LinkWord
  at: string
  said: string
  problem: string
}

/**
 * The newest word per remote, out of the journal's lines — a fold, never a
 * memory, so `tade remote status` answers from the file with the window open
 * or closed, and two answers from two places cannot disagree.
 */
export function linksSeen(events: readonly TadeEvent[]): Map<string, LinkSeen> {
  const seen = new Map<string, LinkSeen>()
  for (const event of events) {
    if (event.type !== 'remote_linked' && event.type !== 'remote_unlinked') continue
    const detail = event.detail as Record<string, unknown>
    const remote = typeof detail.remote === 'string' ? detail.remote : ''
    if (remote === '') continue
    const state =
      event.type === 'remote_linked' ? 'up' : detail.state === 'ended' ? 'ended' : 'down'
    seen.set(remote, {
      word: state,
      at: event.ts,
      said: typeof detail.said === 'string' ? detail.said : '',
      problem: typeof detail.problem === 'string' ? detail.problem : '',
    })
  }
  return seen
}
