import {
  LinkError,
  type LinkOptions,
  linkOver,
  type OwnerSession,
  type Reaching,
  type Remote,
  type RemoteLink,
} from '@tade/remotes-core'

// A RemoteLink to remotes on this machine, by name out of a table it is
// handed: what the conformance suite, the window's own tests and a demo link
// to, and what nobody's config is ever pointed at.
//
// It carries nothing — a remote here is a listener on loopback — so what it
// exercises is everything above the carrying: the stream, the cursor, the
// deadlines, the presence, and holding several at once. Registered as
// `scripted` and chosen for nobody, as the scripted forge is: with no table it
// reaches no remote at all, and says so.

/** A remote this link can reach: where it listens, and the two things its shell would do. */
export interface ScriptedRemote {
  /** The loopback port its away view listens on. */
  readonly port: number
  /** What `tade web pair --owner` would print there. */
  pair(label: string): Promise<OwnerSession>
  /** What `tade web revoke <device>` would do there. */
  revoke(device: string): Promise<void>
}

export interface ScriptedOptions extends LinkOptions {
  /** The remotes it reaches, by the address a `Remote` names. Read at every dial. */
  remotes?: ReadonlyMap<string, ScriptedRemote>
}

export function makeScriptedLink(options: ScriptedOptions): RemoteLink {
  const remotes = options.remotes ?? new Map<string, ScriptedRemote>()
  const find = (address: string): ScriptedRemote => {
    const found = remotes.get(address)
    if (found === undefined)
      throw new LinkError('missing', `there is no scripted remote called ${address}`)
    return found
  }
  return linkOver(
    {
      id: 'scripted',
      capabilities: { pairs: true },
      // Nothing to run: the far end is a listener in this process.
      programs: [],
      pair: async (at) => find(at.address).pair(at.label),
      unpair: async (remote) => find(remote.address).revoke(remote.session.device),
      reaching: (remote: Remote): Reaching => ({
        reach: async () => ({ host: '127.0.0.1', port: find(remote.address).port }),
        drop: async () => {},
      }),
    },
    options,
  )
}
