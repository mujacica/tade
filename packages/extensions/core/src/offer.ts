import type { WatchDoorbell } from '@tade/core'
import type { JsonSchema } from './port.ts'

// A watch as the host offers it to whoever turns one on — the window, the
// watch tool, `tade_schedule` — read off what the watch declares and never
// worked out from what it does. Its own file because it is what everybody
// outside the host reads, and the host is a thousand lines of loading and
// running that none of them needs to read to find it.

/** A watch an extension offers, as a schedule is turned on with it. */
export interface WatchOffer {
  /** `<extension>.<id>`, which is what a schedule names it by. */
  id: string
  extension: string
  title: string
  means: string
  /** How often it looks unless told otherwise. */
  every: string
  /** What it can be turned on with; null when nothing. */
  input: JsonSchema | null
  /** What it is for when nobody says: work started on each finding, or somebody told. */
  offers: 'ask' | 'agent'
  /** Whether it is on without anybody turning it on, once its extension can look. */
  standing: boolean
  /** Whether its look reaches off this machine, so an offline machine may hold it. */
  network: boolean
  /** What it looks at: the repository's outside services (`watchWhere`), or this machine's. */
  about: 'repository' | 'machine'
  /** How many of one look's findings to act on, where the watch says two is wrong for it. */
  most: number | null
  /**
   * The input keys it requires, read off `input`. Empty for a watch that can be turned on with
   * nothing — most of them. Here as well as in the schema because whoever reads it is deciding
   * whether it may offer the watch *at all*, and digging a list out of a schema is not their job.
   */
  needs: readonly string[]
  /**
   * Which intake source this is, where it is one; null for an ordinary watch. Offered rather
   * than discovered, so whoever is about to turn one on — the window, the watch tool,
   * `tade_schedule` — can read what it would start reading before it has read anything.
   */
  intake: string | null
  /** Whether it can say, at the moment work would start, that a finding still stands. */
  rechecks: boolean
  /** Whether it has a path back to its source at all. Absent is no reply path, not a disabled one. */
  replies: boolean
  /** Why it cannot look now — its extension needs setting up, is off, is broken — or null. */
  problem: string | null
  /** What delivery wakes it now (`WatchDoorbell`), where it says; nothing rings one that does not. */
  doorbell?: WatchDoorbell
}
