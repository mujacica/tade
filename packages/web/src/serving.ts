import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebActing } from './acting.ts'
import type { Streams } from './peers.ts'
import type { Grant, Reach } from './reach.ts'
import type { WebReading } from './reading.ts'
import type { Surface } from './surface.ts'
import type { Tickets } from './tickets.ts'

// What the window hands the away view, and what it hands back.
//
// **The contract, in its own file**, for the reason `input.ts` and
// `reading.ts` are: it is the thing a reader checks this subsystem against,
// and a listener and the shape of what it is given are different subjects. Ten
// fields, three of them optional, and every one of them is something only the
// process holding `tade.lock` can answer — which is why the away view is
// handed them rather than going and looking.
//
// Nothing here does anything. `server.ts` is the listener.

/** How long a pairing request waits for somebody at the machine. */
export const CONFIRM_MS = 60_000

/** What the window is asked when a device wants in. */
export interface PairingAsk {
  /** The label the device suggested. Attacker-controlled: never in a path. */
  label: string
  /** The address it came from, as the socket gives it. */
  from: string
  /** The host it reached Tade on. */
  host: string
}

/**
 * What the person at the machine answered.
 *
 * `granted` is what this device may read beyond names and counts, and
 * `projects` is which of them it may read at all — `null` for every one. Both
 * are decided at the machine, per device, and neither is a config key: a read
 * scope is a grant somebody made about one phone, and a setting would make it
 * one answer for all of them.
 */
export type Confirmed =
  | { let: true; projects: readonly string[] | null; granted: readonly Grant[] }
  | { let: false; why: 'refused' | 'nobody answered' }

/**
 * One line for the journal. The server never writes the file itself.
 *
 * `web_enabled` is in the list although nothing in this package writes one:
 * the window does, when the listener comes up and when it goes, and it goes
 * through the same `tell` so there is one path from this subsystem to the
 * journal rather than two.
 */
export interface Told {
  type:
    | 'web_enabled'
    | 'web_paired'
    | 'web_denied'
    | 'web_revoked'
    | 'web_refused'
    | 'web_did'
    | 'warning'
  /**
   * The task the line is about, where it is about one.
   *
   * On the event itself and not only in its detail, because that is the field
   * the journal's index and `historyFrom` read: an act a device took has to
   * show up on the task it changed, or "every act one takes is in the journal
   * under its id" is true of a search nobody would run.
   */
  task?: string
  detail: Record<string, string | number | boolean>
}

export interface ServerOptions {
  /** Where `web-devices.jsonl` lives. Tade's home, never a project. */
  home: string
  surface: Surface
  /**
   * The projection for one device's reach.
   *
   * A factory and not one reading, because **a read scope is per device**: two
   * phones granted different projects are two projections, and filtering one
   * after the fact is how a field that should have been withheld rides along.
   * The window implements this and keeps a projector per reach.
   */
  readingFor: (reach: Reach) => WebReading
  /**
   * Ask the person at the machine. The one authorisation nothing remote can
   * obtain, and the reason a stolen ticket is worth nothing.
   */
  confirm: (ask: PairingAsk) => Promise<Confirmed>
  /**
   * What a paired device may *do*, where a person turned acting on.
   *
   * **Optional, and its absence is the guarantee.** With no `acting` handed
   * over there is no verb to reach: `routesFor` is asked about the surface
   * too, so with `surfaces.web.acting` off there is neither a route nor a
   * method — read-only enforced by absence, which is stronger than a flag a
   * bug could get past. A window that hands one over while the setting is off
   * still serves no acting route, and `acting.unlocked()` is read again at
   * every act so that turning the setting off takes effect now.
   */
  acting?: WebActing
  /** The tickets the pairing panel minted. */
  tickets: Tickets
  /**
   * The live streams, if the window keeps its own.
   *
   * Handed in rather than only made here, because the window is what pushes a
   * delta onto them: it has the beat and it has the projectors. One is made if
   * nothing hands one over, so a test — or anything that only wants the
   * routes — gets a working stream with no ceremony, and `server.streams` is
   * how whoever did not make it reaches it.
   */
  streams?: Streams
  /** Where a line goes. Never throws, and never blocks an answer. */
  tell?: (told: Told) => void
  now?: () => number
  /** How long to wait for a keypress. Shorter in tests, and only there. */
  confirmMs?: number
}

/** The away view, as the window holds it. */
export interface WebServer {
  /** Start listening. The addresses actually bound come back. */
  listen(): Promise<readonly string[]>
  /** Stop listening. Safe twice, and safe before `listen`. */
  close(): Promise<void>
  /** The handler itself, for a test that would rather not bind anything. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>
  /** What is bound, as `host:port`. Empty before `listen`. */
  readonly bound: readonly string[]
  /** The live streams, for the window's beat and for closing them. */
  readonly streams: Streams
  /**
   * The server lifetime every frame of every stream belongs to.
   *
   * Minted here because an epoch is *per server start*, and this is the thing
   * that starts. The window reads it for `lifetime.epoch`, so a snapshot's
   * freshness and a delta's `id` carry the same string — two sources for one
   * value would make every reconnection look like a restart, which is a whole
   * projection down a phone's connection every two seconds and no test would
   * notice, because resnapshotting is *correct*.
   */
  readonly epoch: string
}
