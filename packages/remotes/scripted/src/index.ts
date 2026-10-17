import { connect } from 'node:net'
import {
  type Identity,
  LinkError,
  type LinkOptions,
  linkOver,
  type OwnerSession,
  type Reaching,
  type Remote,
  type RemoteLink,
  type TerminalThere,
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
  /**
   * How it proves what it is, where a test says: the fingerprints it offers,
   * and whether this machine has met it. Absent, it is a machine met before.
   */
  identity?: { fingerprints: readonly string[]; known: 'known' | 'new' | 'changed' }
  /** What `tade web pair --owner` would print there. */
  pair(label: string): Promise<OwnerSession>
  /** What `tade web revoke <device>` would do there. */
  revoke(device: string): Promise<void>
}

export interface ScriptedOptions extends LinkOptions {
  /** The remotes it reaches, by the address a `Remote` names. Read at every dial. */
  remotes?: ReadonlyMap<string, ScriptedRemote>
  /**
   * Open terminals there by running them in a shell here: the far ends are
   * this machine, so a line one gives for showing an agent is a line this
   * machine can run. Off, there is nothing to open a terminal in. A line that
   * exits 255 is a connection lost, as ssh's own exit is (`lost`).
   */
  terminals?: boolean
  /**
   * Where a test says, a way there tried before the plain one that may sit
   * waiting rather than get through, as mosh does with its UDP closed: the
   * line it runs instead of the far end's, what it is called, how long it is
   * given and the words that say it is still waiting. Told it did not get
   * through to a remote (`attached`), the plain way is answered for that
   * remote until it is told one did.
   */
  hesitant?: { by: string; line: string; within: number; waiting: string }
}

/** The exit a line run here gives to say its connection was lost: ssh's own. */
const LOST = 255

export function makeScriptedLink(options: ScriptedOptions): RemoteLink {
  const remotes = options.remotes ?? new Map<string, ScriptedRemote>()
  const find = (address: string): ScriptedRemote => {
    const found = remotes.get(address)
    if (found === undefined)
      throw new LinkError('missing', `there is no scripted remote called ${address}`)
    return found
  }
  // The remotes a hesitant way did not get through to, by name.
  const refused = new Set<string>()
  const hesitant = options.hesitant
  return linkOver(
    {
      id: 'scripted',
      // A far end here is a listener, not a shell: a terminal there is one
      // here, where a test asked for one.
      capabilities: { pairs: true, identifies: true, terminals: options.terminals === true },
      // Nothing to run: the far end is a listener in this process.
      programs: [],
      pair: async (at) => find(at.address).pair(at.label),
      unpair: async (remote) => find(remote.address).revoke(remote.session.device),
      reaching: (remote: Remote): Reaching => ({
        reach: async () => ({ host: '127.0.0.1', port: find(remote.address).port }),
        drop: async () => {},
      }),
      connect: (remote) =>
        new Promise((done, failed) => {
          const socket = connect({ host: '127.0.0.1', port: find(remote.address).port })
          socket.once('connect', () => done(socket))
          socket.once('error', (err) => failed(new LinkError('failed', err.message)))
        }),
      ...(options.terminals === true
        ? {
            terminal: (remote: Remote, words: readonly string[]) =>
              here(`${remote.tade} ${words.join(' ')}`),
            attach: async (remote: Remote, line: string): Promise<TerminalThere> => {
              if (hesitant === undefined || refused.has(remote.name)) return here(line)
              const waiting = hesitant.waiting
              return {
                command: '/bin/sh',
                args: ['-c', hesitant.line],
                by: hesitant.by,
                proving: {
                  within: hesitant.within,
                  waiting: (rows) => rows.some((row) => row.includes(waiting)),
                },
              }
            },
            attached: async (remote: Remote, by: string, through: boolean) => {
              if (by !== hesitant?.by) return
              if (through) refused.delete(remote.name)
              else refused.add(remote.name)
            },
          }
        : {}),
      identify: async (address) => identityOf(address, find(address)),
      trust: async (address, fingerprints) => {
        const far = find(address)
        const was = identityOf(address, far)
        if (was.state === 'changed') {
          throw new LinkError('failed', `${address} is not what this machine met before`)
        }
        if (was.fingerprints.join('\n') !== fingerprints.join('\n')) {
          throw new LinkError('failed', `${address} offers something other than what was shown`)
        }
        if (far.identity !== undefined) far.identity.known = 'known'
        return identityOf(address, far)
      },
    },
    options,
  )
}

/** A terminal here running a line, which is a terminal there when there is here. */
function here(line: string): TerminalThere {
  return { command: '/bin/sh', args: ['-c', line], by: 'scripted', lost: LOST }
}

function identityOf(address: string, far: ScriptedRemote): Identity {
  return {
    state: far.identity?.known ?? 'known',
    fingerprints: far.identity?.fingerprints ?? [],
    name: address,
    where: 'the scripted table',
    said: far.identity?.known === 'changed' ? `${address} is not what this machine met before` : '',
  }
}
