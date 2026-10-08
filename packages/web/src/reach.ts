// How far one device's reading reaches: which projects, and which content.
//
// **Why a projection has to be able to withhold.** A projection that always
// carries everything can only be turned on or off, and the decision "this
// phone may see what I am working on, but not what I pay and not what I typed"
// cannot be expressed in it at all. Adding the ability afterwards is the worse
// half of the same work: it changes what every already-paired device sees, and
// it changes it silently.
//
// So the shape is: **names and counts are what a paired device gets.**
// Everything a person wrote, every figure of money, every forge url and every
// sign-in's name is a grant, made at the machine, per device.
//
// This **narrows** DESIGN.md §10.3, which decided `intent_spoken` and notes are
// "shown" in Phase 1. That decision stands and is the right default for the
// owner's own phone — but it is expressed here as a grant rather than as a
// constant, for the reason the repository already gives about reading a
// project's checks: *reading may only ever narrow what Tade claims*. A contract
// with no way to say no has already said yes.
//
// Nothing here reads a config key. Which grants a device has is decided where
// the config is read, by the slice that reads it; this file is only the
// vocabulary and the two questions asked of it.

/**
 * Content a projection carries only where the person at the machine granted it.
 *
 * Each one is a thing whose *absence* is still a usable page: with none of
 * them you get the names of your projects, the names and states of their
 * tasks, the counts, and how fresh it all is — which is the whole of "is
 * anything waiting for me".
 */
export const GRANTS = [
  'titles',
  'intent',
  'notes',
  'findings',
  'spend',
  'reviews',
  'accounts',
] as const
export type Grant = (typeof GRANTS)[number]

/** What each grant lets through, in the words it is offered in. */
export const GRANT_MEANS: Readonly<Record<Grant, string>> = {
  titles: 'what each piece of work is called',
  intent: 'what you asked for, in your own words',
  notes: 'the notes you have taken, as you took them',
  findings: 'what a judge asked about a change, and what the agent said back',
  spend: 'what the work has cost, in money and tokens',
  reviews: 'the link to each review on its forge',
  accounts: 'which sign-in each agent runs as',
}

/**
 * Which projects a device may read.
 *
 * Explicit, with no spelling for "whatever is there": a scope arrived at by
 * forgetting is the one that is wrong. `every` is a choice somebody made and
 * reads as one.
 */
export type Projects = { kind: 'every' } | { kind: 'listed'; names: readonly string[] }

/** One device's reading reach. */
export interface Reach {
  /**
   * The device, by the id the machine gave it when it was paired. Never its
   * label, never its address: a label is a person's own words about their own
   * phone, and an address is a fact about a network that goes stale in a
   * minute.
   */
  device: string
  projects: Projects
  granted: readonly Grant[]
}

/** A device that may read names and counts, in every project, and nothing else. */
export function namesOnly(device: string): Reach {
  return { device, projects: { kind: 'every' }, granted: [] }
}

/** Whether this device was granted that content. */
export function has(reach: Reach, grant: Grant): boolean {
  return reach.granted.includes(grant)
}

/** Whether this device may read that project at all. */
export function sees(reach: Reach, project: string): boolean {
  return reach.projects.kind === 'every' || reach.projects.names.includes(project)
}

/**
 * What this device may read, as the page is told it.
 *
 * Sorted the way `GRANTS` is declared and with anything unrecognised dropped,
 * so a hand-written grant list cannot put a word the page does not understand
 * in front of somebody as though it meant something.
 */
export function readsOf(reach: Reach): Grant[] {
  return GRANTS.filter((grant) => reach.granted.includes(grant))
}
