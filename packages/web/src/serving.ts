import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HookRung } from '@tade/core'
import type { WebActing } from './acting.ts'
import type { WebAsking } from './asking.ts'
import type { WebAttaching } from './attached.ts'
import type { WebCarrying } from './carried.ts'
import type { WebConfiguring } from './configuring.ts'
import type { WebDocument } from './document.ts'
import type { WebDrafting } from './drafting.ts'
import type { WebHooks } from './hooked.ts'
import type { WebMachine } from './machine.ts'
import type { WebOpening } from './opened.ts'
import type { Streams } from './peers.ts'
import type { WebPushing } from './pushing.ts'
import type { Grant, Reach } from './reach.ts'
import type { WebReading } from './reading.ts'
import type { WebRecords } from './records.ts'
import type { WebRepositories } from './repositories.ts'
import type { WebNotes } from './shared-notes.ts'
import type { WebSince } from './since.ts'
import type { Listener, Scope, Surface } from './surface.ts'
import type { WebTaking } from './taken.ts'
import type { Tickets } from './tickets.ts'
import type { WebToolRead } from './tool-read.ts'

// What the window hands the away view, and what it hands back.
//
// **The contract, in its own file**, for the reason `input.ts` and
// `reading.ts` are: it is the thing a reader checks this subsystem against,
// and a listener and the shape of what it is given are different subjects.
// Twelve fields, five of them optional, and every one of them is something
// only the process holding `tade.lock` can answer — which is why the away view is
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
  | {
      let: true
      projects: readonly string[] | null
      granted: readonly Grant[]
      /** What it may do; `read` alone when unsaid. The origin's ceiling still holds (`scopesOn`). */
      scopes?: readonly Scope[]
    }
  | { let: false; why: 'refused' | 'nobody answered' }

/**
 * One line for the journal. The server never writes the file itself.
 *
 * `web_enabled` is in the list although nothing in this package writes one:
 * the window does, when the listener comes up and when it goes, and it goes
 * through the same `tell` so there is one path from this subsystem to the
 * journal rather than two.
 *
 * A `warning` says what went wrong in `message`, as every warning in the
 * journal does (`EventInput`).
 */
export type Told = (
  | {
      type:
        | 'web_enabled'
        | 'web_paired'
        | 'web_denied'
        | 'web_revoked'
        | 'web_refused'
        | 'web_did'
        | 'web_asked'
        | 'web_subscribed'
        | 'web_pushed'
        | 'web_proved'
      detail: Record<string, string | number | boolean>
    }
  | { type: 'warning'; detail: { message: string } & Record<string, string | number | boolean> }
  // A delivery's line has a list in it (`woke`), which no other line here has.
  | { type: 'hook_rung'; detail: HookRung & Record<string, unknown> }
) & {
  /**
   * The task the line is about, where it is about one.
   *
   * On the event itself and not only in its detail, because that is the field
   * the journal's index and `historyFrom` read: an act a device took has to
   * show up on the task it changed, or "every act one takes is in the journal
   * under its id" is true of a search nobody would run.
   */
  task?: string
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
   * Watch the page's own files and tell open pages when they change
   * (`reloading.ts`). The window's own listener asks for it; a test or the
   * browser harness does not, so a file somebody else saves mid-run reloads
   * nothing under them. Even asked, it is only ever on from the repository.
   */
  liveReload?: boolean
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
  /**
   * What a paired device may *save*, where a person turned drafting on.
   *
   * **Optional, and its absence is the guarantee**, exactly as `acting` and
   * `asking` are: a window that was not given this serves no saving route, so
   * a crafted call is the `404` of a path nobody built rather than a `403`
   * naming a setting. `drafting.unlocked()` is read again at every save, so
   * turning the setting off takes authority away now.
   */
  drafting?: WebDrafting
  /**
   * What a paired device may *say to Tade*, where a person turned talking on.
   *
   * **Optional, and its absence is the guarantee**, exactly as `acting` is: a
   * window that was not given this serves no asking route, so a crafted call
   * is the `404` of a path nobody built rather than a `403` naming a setting.
   * `asking.unlocked()` is read again at every turn, so turning the setting
   * off takes effect now.
   *
   * It is a **second** optional and not a field on `acting`, because the two
   * are different decisions with different settings: bounded verbs, and
   * free text to a model that holds tools.
   */
  asking?: WebAsking
  /**
   * What a paired device may *ask about being told*, where a person turned
   * notifications on.
   *
   * **Optional, and its absence is the guarantee**, exactly as `acting`,
   * `asking` and `drafting` are: a window that was not given this serves no
   * notification route, so a crafted call is the `404` of a path nobody built
   * rather than a `403` naming a setting. `pushing.unlocked()` is read again
   * at every call, and the window reads the setting again on every beat before
   * it sends anything — so turning it off stops delivery within a beat.
   */
  pushing?: WebPushing
  /**
   * What a paired device may *do to a setting*, where a person turned that on.
   *
   * **Optional, and its absence is the guarantee**, exactly as the four above
   * are: a window that was not given this serves no changing route, so a
   * crafted call is the `404` of a path nobody built. `configuring.unlocked()`
   * is read again at every change, so turning the setting off takes authority
   * away now. Reading the settings is not this: it is `WebReading.settings`,
   * behind a per-device grant.
   */
  configuring?: WebConfiguring
  /**
   * The VAPID public key, where there is one.
   *
   * An accessor and not a value, because the key is generated the first time a
   * notification is needed: a listener that read it once at start-up would
   * answer *no key* for the whole of its life on a machine that had just
   * turned notifications on. The **public** half only — nothing in this
   * package ever holds the private one, which is the window's and is read out
   * of the config where every other key lives.
   */
  vapid?: () => string
  /**
   * Somebody is at another of their screens: an owner's link said when a key
   * was last pressed there, as a moment in this machine's clock
   * (`presence.ts`). Absent, the route is the `404` of a path nobody wired.
   */
  present?: (device: string, at: number) => void
  /**
   * A paired device saying its own page is in front of somebody, as a moment
   * in this machine's clock (`looking.ts`): only ever about what that device
   * is sent. Absent, the route is the `404` of a path nobody wired.
   */
  looking?: (device: string, at: number) => void
  /**
   * Another machine's Tade carrying its setup here, as an owner (`carried.ts`):
   * the config as written, the one write path, the files and the sign-ins.
   * Absent, the route is the `404` of a path nobody wired.
   */
  carrying?: WebCarrying
  /**
   * What to run here to be shown one task's agent, for an owner's window on
   * another machine (`attached.ts`). Absent, the route is the `404` of a path
   * nobody wired.
   */
  attaching?: WebAttaching
  /**
   * What the person missed while away, for an owner's window coming back
   * (`since.ts`). Absent, the route is the `404` of a path nobody wired.
   */
  since?: WebSince
  /**
   * The person's notes shared with an owner's window on another machine
   * (`shared-notes.ts`). Absent, the route is the `404` of a path nobody wired.
   */
  notes?: WebNotes
  /**
   * Where each project is checked out here and the branches its work is on,
   * for an owner's window on another machine to fetch (`repositories.ts`).
   * Absent, the route is the `404` of a path nobody wired.
   */
  repositories?: WebRepositories
  /**
   * What this machine is, one of its documents, and one of its tools that only
   * reads, for an owner's window on another machine (`machine.ts`,
   * `document.ts`, `tool-read.ts`). Each absent is the `404` of a path nobody wired.
   */
  machine?: WebMachine
  document?: WebDocument
  tool?: WebToolRead
  /**
   * This machine's public name's records, looked at now, for an owner's window
   * on another machine whose Settings › Remotes is open on it (`records.ts`).
   * Absent, the route is the `404` of a path nobody wired.
   */
  records?: WebRecords
  /**
   * Work an owner's window on another machine hands this one, made queued
   * work here (`taken.ts`). Absent, the route is the `404` of a path nobody wired.
   */
  taking?: WebTaking
  /**
   * A project an owner's window on another machine is moving here, opened —
   * cloned first with this machine's own credentials where it is not checked
   * out here (`opened.ts`). Absent, the route is the `404` of a path nobody wired.
   */
  opening?: WebOpening
  /**
   * The doorbells, where this machine has a public name (`hooked.ts`): the
   * secret each source signs with, which schedules a delivery is for, and
   * waking them. Absent, every delivery is the `404` of a path nobody wired.
   */
  hooks?: WebHooks
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
  /**
   * Where the public listener's socket goes, where a public name is set:
   * `publicSocket()` unless a test says otherwise, because `/run/tade` is
   * root's to make and no test may need root.
   */
  publicSocket?: string
}

/** The away view, as the window holds it. */
export interface WebServer {
  /** Start listening. The addresses actually bound come back. */
  listen(): Promise<readonly string[]>
  /** Stop listening. Safe twice, and safe before `listen`. */
  close(): Promise<void>
  /**
   * The handler itself, for a test that would rather not bind anything — told
   * which listener it is answering for, because a request cannot say.
   */
  handle(req: IncomingMessage, res: ServerResponse, listener: Listener): Promise<void>
  /** What is bound, as `host:port`. Empty before `listen`. */
  readonly bound: readonly string[]
  /** The socket Caddy connects to, while the public listener is up; null otherwise. */
  readonly public: string | null
  /** Why there is no public listener where a public name is set: the warning's own words. */
  readonly publicTrouble: string | null
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
