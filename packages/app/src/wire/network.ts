import { promises as dns } from 'node:dns'
import { networkInterfaces } from 'node:os'
import {
  anyRoute,
  type NetworkReach,
  REACHING,
  reached,
  reachedResolver,
  reachSaid,
  type ScheduleDoes,
  shouldLook,
} from '@tade/core'
import { Unreachable, type WatchOffer } from '@tade/extensions-core'
import { withTranscript } from '../model.ts'
import { tadeDid } from '../transcript.ts'
import type { Wiring } from './context.ts'

// The scheduler's own reach for a network: one answer, for every watch.
//
// Four watches on four timers each discovered last night's outage by making a
// request and waiting for it to fail — which is how one machine being offline
// became a window full of red lines against four different endpoints until
// morning. Connectivity is a fact about the machine, so it is held here, in
// one place, and the watches read it instead of finding it out.
//
// The rule it is built around is that **one endpoint being down is never the
// machine being offline**. Nothing a service said can put this offline: a 404,
// a 500, a rate limit and an auth failure are all answers, and they keep the
// behaviour they have. Only two things can, and both are about this machine —
// no way off it at all, or a host a watch actually needed that could not be
// resolved through a resolver that could not be reached either.
//
// What it costs while everything is fine is one `os.networkInterfaces()` per
// due look, which reaches nothing and asks nobody. The name lookups happen
// only once something has already failed, only about hosts a watch itself
// needed, and at most once a minute while the outage lasts.

/** How this machine is asked whether it can reach anything. */
export interface MachineNetwork {
  /** Whether there is any way off this machine. Free, and reaches nothing. */
  route(): boolean
  /**
   * Whether any of these hosts can be reached as far as a resolver that knows
   * about it. Asked only about hosts a watch needed and could not reach.
   */
  reaches(hosts: readonly string[]): Promise<boolean>
}

/** A name lookup is meant to be quick; past this, nothing came back. */
const RESOLVE_MS = 5_000

/** The machine's own answer, which is what a window uses unless it is given another. */
export const thisMachine: MachineNetwork = {
  route: () => anyRoute(networkInterfaces()),
  reaches: async (hosts) => {
    for (const host of hosts) {
      if (await resolves(host)) return true
    }
    // Nothing to ask about: the interfaces are the whole of the answer, and
    // they already said there is a way out.
    return hosts.length === 0
  },
}

/**
 * Whether a name reaches a resolver — not whether it resolves.
 *
 * `dns.resolve` and not `dns.lookup`: `lookup` is `getaddrinfo`, which answers
 * from the machine's own cache, and a cached address is exactly the wrong
 * answer to "can this machine reach anything right now". This asks the
 * resolver, and a resolver that answers at all — even to say there is no such
 * name — is proof of a network.
 */
async function resolves(host: string): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      dns.resolve(host),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), RESOLVE_MS)
        timer.unref?.()
      }),
    ])
    return true
  } catch (err) {
    return reachedResolver((err as NodeJS.ErrnoException).code)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * What the window knows about its reach for a network, and the only thing
 * allowed to have an opinion about it.
 *
 * Its whole job is to turn many watches' failures into one fact and one
 * sentence. The sentence is said on the edge and only on the edge — going
 * offline once, coming back once — because a window that has quietly stopped
 * looking must be legible, and a window that says so every ten minutes is the
 * thing this replaces.
 */
export class Network {
  private readonly machine: MachineNetwork
  private readonly say: (said: string) => void
  private reach: NetworkReach = REACHING
  /** A look for a network under way, so several watches failing at once ask once. */
  private looking: Promise<void> | null = null

  constructor(machine: MachineNetwork, say: (said: string) => void) {
    this.machine = machine
    this.say = say
  }

  /** Whether the machine is reachable as far as anyone here knows. */
  get online(): boolean {
    return this.reach.online
  }

  /**
   * Whether a watch that reaches the network may look now.
   *
   * Online, this is the free question and nothing else: a machine with no way
   * off itself is offline with certainty, before any watch spends a request
   * finding that out. Offline, the full look is taken at most once a minute,
   * and every look in between costs nothing at all.
   */
  async looks(now: number): Promise<boolean> {
    if (this.reach.online) {
      if (!this.machine.route()) this.settle(false, now)
      return this.reach.online
    }
    if (shouldLook(this.reach, now)) await this.probe(now)
    return this.reach.online
  }

  /**
   * A watch could not reach a host it needed: whether that is this machine.
   *
   * The failure is never the evidence — it is only the prompt. What decides is
   * a look at the machine, about that host, which is what keeps a forge having
   * a bad afternoon from reading as an outage. True means the watch's failure
   * is nothing happening: it wrote nothing, and nobody needs a red line.
   */
  async couldNotReach(host: string, now: number): Promise<boolean> {
    if (!this.reach.online) return true
    await this.probe(now, host)
    return !this.reach.online
  }

  private async probe(now: number, host?: string): Promise<void> {
    this.looking ??= this.look(now, host).finally(() => {
      this.looking = null
    })
    await this.looking
  }

  private async look(now: number, host?: string): Promise<void> {
    const hosts = host ? [host, ...this.reach.hosts] : this.reach.hosts
    // A look that threw is not a machine that is offline: erring the other way
    // would pause every watch on a bug in here, which is the one failure worse
    // than the noise this exists to stop.
    const online = this.machine.route() && (await this.machine.reaches(hosts).catch(() => true))
    this.settle(online, now, host)
  }

  private settle(online: boolean, now: number, host?: string): void {
    const was = this.reach
    this.reach = reached(was, { online, ...(host ? { host } : {}) }, now)
    const said = reachSaid(was, this.reach)
    if (said) this.say(said)
  }
}

/**
 * The window's reach for a network, saying what it finds where a person reads
 * it: in Tade's own voice, because being offline is nothing going wrong with
 * Tade, and to the orchestrator with the next thing anybody says.
 */
export function networkOf(wire: Wiring, news: (said: string) => void): Network {
  return new Network(wire.opts.network ?? thisMachine, (said) => {
    news(said)
    wire.put(withTranscript(wire.state, tadeDid(wire.state.transcript, said, wire.now())))
    wire.draw()
  })
}

/**
 * Whether a schedule that is due may run now.
 *
 * Everything but a watch that reaches the network always may — an agent on a
 * clock is not this file's business, and neither is a watch that reads this
 * machine, which is still worth running with the wifi off. One that does
 * reach asks the reach, and being told no is not a failure: nothing is
 * written, nothing is spent, and where its last look left off is untouched,
 * so the first look once the network is back finds everything since and the
 * runs it missed catch up the way any schedule's do.
 */
export async function mayRun(
  network: Network,
  does: ScheduleDoes,
  watches: readonly WatchOffer[],
  now: number,
): Promise<boolean> {
  if (does.kind !== 'watch') return true
  const offer = watches.find((one) => one.id === does.watch)
  return offer?.network === true ? await network.looks(now) : true
}

/**
 * Whether a look's failure was this machine having no network rather than
 * that host having nothing to say.
 *
 * The failure alone never answers it — only a watch that names what it could
 * not reach even gets the question asked, and the reach is what answers. True
 * means there is nothing to report: not a failed look, and not a red line.
 */
export async function wasOffline(network: Network, err: unknown, now: number): Promise<boolean> {
  return err instanceof Unreachable && (await network.couldNotReach(err.host, now))
}
