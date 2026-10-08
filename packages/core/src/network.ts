// Whether this machine can reach a network at all, and what a watch may do
// about it.
//
// Connectivity is a fact about the machine, not about any one watch. A laptop
// that is offline overnight has every watch discover that independently, on
// its own timer, against its own endpoint — "could not reach github.com",
// "could not reach Sentry", "took longer than 60s and was given up on", twelve
// times between 20:26 and 06:18 from one watch alone — because each of them
// finds out by making a request and waiting for it to fail. One outage, one
// answer: the scheduler holds it, the watches read it, and nobody asks the
// world twice.
//
// The rule that keeps it honest is that **one endpoint being down is never the
// machine being offline**. A 404, a 500, an auth failure or a provider saying
// no is an answer — something was reached — and keeps exactly the behaviour it
// has. Only two things put the machine offline: no way off it at all
// (`anyRoute`), or a host a watch needed that nothing here could reach, with a
// name lookup that could not reach a resolver either (`reachedResolver`).
// Both are about this machine; neither is about what any service said.
//
// Offline, a look does not happen. That is the other half: a look that finds no
// network is not a failed look, so it writes nothing, says nothing and costs
// nothing — the same shape as a process scan that could not look degrading to
// the last scan it could (`problemWith`, `packages/status/src/processes.ts`)
// rather than to an empty list that everything above reads as "nothing is
// running". Where the watch left off is untouched, so when the network is back
// the next look finds everything since, and the missed runs catch up the way
// any schedule's do.
//
// Pure: what was observed in, what the reach is out. Nothing here dials
// anything — the probe is the caller's.

/** One address of one interface, as `os.networkInterfaces()` gives it. */
export interface NetworkAddress {
  address: string
  /** Loopback. */
  internal: boolean
}

/**
 * Whether this machine has any way off itself.
 *
 * Free, exact and reaches nothing: it is the one question about connectivity
 * that can be answered without asking anybody. Loopback is not a way out, and
 * neither is a link-local address — `169.254.x.x` and `fe80::` are what an
 * interface has when it came up and got no configuration, which is the state a
 * machine with the wifi off is in.
 */
export function anyRoute(
  interfaces: Readonly<Record<string, readonly NetworkAddress[] | undefined>>,
): boolean {
  return routesOf(interfaces).length > 0
}

/**
 * The addresses that are a way off this machine, which is also the set worth
 * printing.
 *
 * `anyRoute`'s rule, as the list rather than the boolean, because the away
 * view's pairing panel has to print an address a phone can actually reach: a
 * code for `127.0.0.1` or for `fe80::1%en0` is a code that scans perfectly and
 * goes nowhere, which is worse than a panel that says there is no network.
 * One rule, so the panel can never print an address `anyRoute` would have
 * called no route at all.
 *
 * In the order the machine lists them, which is near enough to "the one that
 * came up last is the one you are on" to be useful and is never claimed to be
 * more than that.
 */
export function routesOf(
  interfaces: Readonly<Record<string, readonly NetworkAddress[] | undefined>>,
): string[] {
  const out: string[] = []
  for (const addresses of Object.values(interfaces)) {
    for (const one of addresses ?? []) {
      if (one.internal) continue
      if (one.address.startsWith('169.254.')) continue
      if (one.address.toLowerCase().startsWith('fe80:')) continue
      out.push(one.address)
    }
  }
  return out
}

/**
 * Whether a failed name lookup got as far as a resolver.
 *
 * A resolver that answers "there is no such name" is a resolver that was
 * reached, and a machine that reached one is not offline however wrong the
 * name was. What counts as offline is nothing coming back — a timeout, a
 * refusal to connect, no route — and `SERVFAIL`, which is the resolver saying
 * it could not do its job and is what a router answers with its own uplink
 * down. That last one is the judgement call in here: it costs a false pause on
 * a domain that is genuinely broken, and it buys the commonest real outage
 * there is, a machine on a network that is on a network that is not.
 *
 * Only ever read about a host a watch has already failed to reach, never on its
 * own — so a machine whose resolver answers oddly stays online until something
 * has actually gone wrong.
 */
export function reachedResolver(code: string | undefined): boolean {
  return code !== undefined && (ANSWERED as readonly string[]).includes(code)
}

/** Codes that are a resolver's own answer rather than silence from the network. */
const ANSWERED = [
  /** No such name: the resolver knows, and said. */
  'ENOTFOUND',
  'NOTFOUND',
  'NXDOMAIN',
  /** The name exists and has no record of that kind. Still an answer. */
  'ENODATA',
  /** We asked badly, which says nothing about the network. */
  'EBADNAME',
  'EFORMERR',
] as const satisfies readonly string[]

/**
 * What the scheduler knows about the machine's reach for a network.
 *
 * `NetworkReach` and not `Reach`, which is how far the orchestrator's arm
 * stretches into a setting (`reach.ts`) — two different questions that would
 * be one word in the one place both are imported.
 */
export interface NetworkReach {
  online: boolean
  /** When it went offline, as a moment; null while online. */
  since: number | null
  /** When it last looked for a network. */
  looked: number
  /**
   * Hosts a watch needed and could not reach, newest first — what the next
   * look for a network asks about.
   *
   * The hosts the watches themselves use, never one invented here: a probe
   * that dials a third party to find out whether the machine is online is a
   * third party told something, every minute, for as long as the outage lasts.
   */
  hosts: readonly string[]
}

/** Online, having looked at nothing: what a window starts with. */
export const REACHING: NetworkReach = { online: true, since: null, looked: 0, hosts: [] }

/**
 * How long an answer about the network is worth reusing while offline.
 *
 * The watches themselves look every ten minutes or every hour, so this only
 * has to be shorter than they are to cost them nothing: a minute means the
 * first watch due after the network comes back looks, rather than waiting out
 * its own interval again.
 */
export const REACH_EVERY_MS = 60_000

/** How many hosts to remember. More than a few is a list of every watch there is. */
const HOSTS = 4

/** Whether the reach should look for a network again before it is believed. */
export function shouldLook(reach: NetworkReach, now: number): boolean {
  return !reach.online && now - reach.looked >= REACH_EVERY_MS
}

/**
 * The reach, having looked: online or not, when, and about which host.
 *
 * `host` is the one a watch could not reach, where a watch is what prompted
 * the look. Kept whether or not this look says offline — a host that failed
 * once is the right thing to ask about next time, and the list is short.
 */
export function reached(
  was: NetworkReach,
  found: { online: boolean; host?: string },
  now: number,
): NetworkReach {
  const hosts = found.host
    ? [found.host, ...was.hosts.filter((one) => one !== found.host)].slice(0, HOSTS)
    : was.hosts
  return {
    online: found.online,
    since: found.online ? null : (was.since ?? now),
    looked: now,
    hosts,
  }
}

/**
 * What going from one reach to another is worth saying, or null for nothing.
 *
 * Said on the edge and only on the edge, which is the whole of "said once": a
 * window that stays offline for ten hours says this once, and a window that
 * never goes offline never says it. Silence would be the other bug — a person
 * whose watches quietly stopped looking has no way to tell that from watches
 * that are looking and finding nothing.
 */
export function reachSaid(was: NetworkReach, now: NetworkReach): string | null {
  if (was.online === now.online) return null
  return now.online ? WATCHES_LOOKING : WATCHES_PAUSED
}

/**
 * The one line a window says when the network has gone.
 *
 * Stable wording with no host, no count and no clock in it: a sentence that
 * changes is a sentence that gets said again, which is what this is for.
 */
export const WATCHES_PAUSED =
  'offline — the watches that reach the network are paused until it is back'

/** And when it is back. They catch up by themselves: nothing was lost, only not looked at. */
export const WATCHES_LOOKING = 'back online — the watches are looking again'
