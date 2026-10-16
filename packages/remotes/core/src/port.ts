import type { RequiredProgram, Unsubscribe } from '@tade/core'
import type { Snapshot } from '@tade/web'

// The RemoteLink port: how this machine's Tade reaches another machine's Tade
// as one of its owner devices, and holds what that machine says about itself.
//
// **One Tade per machine, federated** (REMOTE-TADE.md §2.5). The other machine
// is a whole Tade with its own home, journal and agents; this one is a paired
// owner device of its away view, and what crosses is the away protocol — the
// projection as a snapshot and then deltas, the `(epoch, rev)` cursor, the
// verbs — carried over whatever this implementation is. Nothing here is a
// second protocol and nothing is merged.
//
// It is shaped like a `WorkspaceDriver` on purpose (`add-workspace-driver`):
// one object holds any number of links the way a driver holds any number of
// lanes, call sites never `new` one (the registry is `REMOTE_LINKS` in
// `@tade/workbench`), what it can do is declared (`capabilities`), and the
// conformance suite beside this file is what every implementation must pass.
//
// **Vocabulary rule (R2).** Nothing here says SSH, ControlMaster, a forward or
// a tunnel: those are `remotes/ssh`'s words, in its own file. A link is
// *paired*, *opened*, *held*, *beaten*, *woken* and *closed*; what it reaches
// is a *remote*, at an *address* in whatever form that implementation reads.
//
// **Nothing a frame draws waits on the network** (§3.2). A link answers into a
// held value on its own schedule, every wait has a deadline, and a remote that
// is not answering is held with its last projection and its age — never as an
// empty world, because an empty one reads as "nothing is running" on a
// machine whose agents are working perfectly well.

/** The owner session a remote minted for this machine: what `tade web pair --owner` printed. */
export interface OwnerSession {
  /** The device this machine is there. */
  device: string
  /** `<device>.<secret>`: the cookie value. A credential. */
  cookie: string
  /** The token a request that changes something carries. */
  csrf: string
  /** The `Host` it is bound to there, exactly: `localhost:7654`. */
  host: string
}

/** One remote, as a link is told about it: a `remotes.<name>` block. */
export interface Remote {
  /** What it is called here: `vps`. */
  name: string
  /** Where it is, in the form this implementation reads: an SSH destination for `ssh`. */
  address: string
  /** The command that is Tade there, for the implementations that run one. */
  tade: string
  session: OwnerSession
}

/** What pairing is asked for: where, what to run there, and what to be called. */
export interface PairAt {
  address: string
  tade: string
  /** What this machine is called in that machine's device list. */
  label: string
}

/** What an implementation can do. Call sites branch on these, never on `id`. */
export interface LinkCapabilities {
  /**
   * It can make this machine an owner of a remote by itself, and sign it out
   * again — it can run a command there. Without it, a remote is paired by hand
   * and `pair`/`unpair` throw `LinkError` with `unsupported`.
   */
  pairs: boolean
}

/**
 * Why a link is not up, in the three answers a look that could not look has
 * (`problemWith`), because a machine is a thing that can fail to answer the
 * way a program can:
 *
 * - `missing`: what reaches it is not on this machine (no `ssh`), or what
 *   answers there is not Tade.
 * - `failed`: something answered and said no, or said why it could not — the
 *   sentence is the one to act on.
 * - `timed out`: nothing answered in time, which is a sleeping laptop or a
 *   dead network rather than a broken remote.
 */
export type LinkProblem = 'missing' | 'failed' | 'timed out'

/** How one link stands. */
export type LinkState =
  /** Opened and not yet dialled. */
  | { kind: 'idle' }
  /** A dial is under way: since when, and how many in a row have failed before it. */
  | { kind: 'dialling'; since: number; tries: number }
  /** The stream is open and has been heard from inside its deadline. */
  | { kind: 'live'; since: number }
  /** It is not up, and will be dialled again: why, since when, and how many tries have failed. */
  | { kind: 'down'; since: number; tries: number; problem: LinkProblem; said: string }
  /**
   * The remote said this machine's session is over — signed out there, run
   * out, never known — and dialling again cannot change that. Only pairing
   * again can, so nothing redials an ended link.
   */
  | { kind: 'ended'; since: number; said: string }

/** Where a client of the away stream got to: the remote's server lifetime, and how far. */
export interface LinkCursor {
  epoch: string
  rev: number
}

/**
 * What a link holds about one remote: the value a frame reads, and never waits
 * for.
 */
export interface Held {
  /** The remote's name here. */
  remote: string
  link: LinkState
  /**
   * The remote's projection as last applied, or null before the first.
   *
   * **Kept when the link goes down**, which is the whole of "as of 14:02": a
   * remote that stopped answering is drawn from what it last said, with its
   * age, never as nothing.
   */
  projection: Snapshot | null
  /**
   * When the projection was last known to be current, in **this** machine's
   * clock: the last frame or heartbeat. Null before the first. The remote's
   * own `fresh.at` is its clock, which is a different machine's.
   */
  heardAt: number | null
  /** What the next dial resumes from. Null starts over with a snapshot. */
  cursor: LinkCursor | null
  /**
   * Why the person's presence was last not taken there, or null where it was
   * or nothing needed carrying. A remote that cannot tell you are at this
   * keyboard buzzes your phone while you watch the same thing here, so that is
   * said rather than left to be noticed.
   */
  presence: string | null
}

/** Every way an implementation refuses, with a sentence somebody can act on. */
export class LinkError extends Error {
  readonly problem: LinkProblem | 'unsupported'
  constructor(problem: LinkProblem | 'unsupported', message: string) {
    super(message)
    this.name = 'LinkError'
    this.problem = problem
  }
}

/**
 * The port. One object for any number of remotes of one kind.
 *
 * Everything that waits does so in the background and answers into `held`;
 * `beat`, `wake` and `present` return at once, because the window calls them
 * on the thread that draws.
 */
export interface RemoteLink {
  /** The implementation's name, as the registry has it. */
  readonly id: string
  readonly capabilities: LinkCapabilities
  /** What it needs of this machine (`set-up-the-machine`). */
  readonly programs: readonly RequiredProgram[]
  /**
   * Make this machine an owner of the Tade at `address`: run its pairing there
   * and hand back the session it printed. Throws `LinkError`.
   */
  pair(at: PairAt): Promise<OwnerSession>
  /** Sign this machine out there: the remote forgets the device. Throws `LinkError`. */
  unpair(remote: Remote): Promise<void>
  /**
   * Hold a link to this remote from now on, dialling it on the next beat.
   * Opening one already held with another spec closes the old one first.
   */
  open(remote: Remote): void
  /** Stop holding it, and let go of whatever reaches it. Safe twice. */
  close(name: string): Promise<void>
  /** What is held for one remote, or null for one not opened. */
  held(name: string): Held | null
  /** The remotes held, in the order they were opened. */
  names(): readonly string[]
  /** Called with a remote's name whenever what is held for it changed. */
  watch(listener: (name: string) => void): Unsubscribe
  /**
   * The window's beat: dial what is due, drop a stream that has gone quiet past
   * its deadline, and carry the person's presence. Returns at once.
   */
  beat(now: number): void
  /**
   * The machine was away — a lid closed — so whatever is open may be dead
   * without having said so: let go of it and dial again at once, rather than
   * waiting out a timeout. Holds every projection meanwhile.
   */
  wake(now: number): void
  /**
   * The person last pressed a key here at this moment, in this machine's
   * clock, or null for never. Carried to each remote on a beat, as an age.
   */
  present(at: number | null): void
  /** Close every link. Safe twice. */
  shutdown(): Promise<void>
}

/** How an implementation is made: for a home, with a clock a test may move. */
export type MakeRemoteLink = (options: LinkOptions) => RemoteLink

export interface LinkOptions {
  /** The home this machine's Tade is, for the runtime files a link keeps. */
  home: string
  /** The clock frames are timed by. `Date.now` unless a test moves it. */
  now?: () => number
}
