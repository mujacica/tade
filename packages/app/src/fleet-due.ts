import { printable } from '@tade/core'
import type { MachineAnswer, OrchestratorStanding } from '@tade/web'

// When a reload of every machine would bring the orchestrators together, and
// what one came to — the rules, pure, for `wire/fleet-reload.ts`.
//
// **Together** is read from both ends and never assumed: this window's
// conversation is one with the hub (`FleetConversation.oneWith`), and each
// other machine says of its own orchestrator that it came up and that its
// conversation is one across the machines (`/api/machine`'s `orchestrator`).
// A Tade too old to say is never together, because nothing says it is.
//
// **A reload is due** only where the two are apart *and* something moved on
// that machine since this window last heard it that a restart there would put
// to use: a sign-in it did not have, a model its orchestrator was not given,
// or a Tade that says how its orchestrator stands where the one before said
// nothing. Each is a cause with a key of its own, so it is said once — a
// machine apart for a reason nothing here can see is not nagged about.

/** What one machine said that a reload is judged on. */
export interface FleetFacts {
  name: string
  /** The Tade it runs, as it said; null before it answered. */
  version: string | null
  /** The sign-ins it has set, by the id every machine gives them and as a person reads them. */
  signIns: readonly { id: string; label: string }[]
  /** How its orchestrator stands; null from a Tade too old to say. */
  orchestrator: OrchestratorStanding | null
}

/** One reason a reload is due: said once, by its key. */
export interface Cause {
  machine: string
  key: string
  said: string
}

/** What one machine's answer says, for the rules here; null before it answered. */
export function factsOf(name: string, answer: MachineAnswer | null): FleetFacts | null {
  if (answer === null) return null
  return {
    name,
    version: printable(answer.version).trim() || null,
    signIns: (answer.inventory?.items ?? [])
      .filter((item) => item.kind === 'sign-in' && item.state === 'set')
      .map((item) => ({ id: item.id, label: printable(item.label).trim() || item.id })),
    orchestrator: answer.orchestrator ?? null,
  }
}

/**
 * Whether that machine's orchestrator and this window's are one conversation:
 * up, sharing, and — the hub — the one this window's last exchange was with,
 * or — any other — one with a hub of its own.
 */
export function together(facts: FleetFacts, hub: string | null, oneWith: string | null): boolean {
  const there = facts.orchestrator
  if (there === null || there.state !== 'up' || !there.shares) return false
  return facts.name === hub ? oneWith === hub : there.joined !== null
}

/** The sentence every cause ends in: what it will fix, and the one action. */
function fixes(name: string): string {
  return `so ${name}’s orchestrator can now share this conversation — Reload to bring the two together`
}

/** What moved on one machine between two of its answers that a reload there would put to use. */
export function causesOf(was: FleetFacts, now: FleetFacts): Cause[] {
  const name = now.name
  const causes: Cause[] = []
  const had = new Set(was.signIns.map((one) => one.id))
  for (const one of now.signIns) {
    if (had.has(one.id)) continue
    causes.push({
      machine: name,
      key: `${name}|sign-in|${one.id}`,
      said: `${one.label} is newly signed in on ${name}, ${fixes(name)}`,
    })
  }
  const model = now.orchestrator?.model ?? null
  if (model !== null && model !== (was.orchestrator?.model ?? null)) {
    causes.push({
      machine: name,
      key: `${name}|model|${model}`,
      said: `${name}’s orchestrator now has a model (${printable(model)}), ${fixes(name)}`,
    })
  }
  if (was.orchestrator === null && now.orchestrator !== null) {
    causes.push({
      machine: name,
      key: `${name}|version|${now.version ?? ''}`,
      said: `${name} now runs Tade ${now.version ?? 'a newer one'}, which can share the conversation, ${fixes(name)}`,
    })
  }
  return causes
}

/** How one machine came back from a reload, as the check after it found it. */
export interface Checked {
  name: string
  /** Its answer since the reload; null where it gave none in time. */
  facts: FleetFacts | null
  /** Why it could not be asked, where it could not; null otherwise. */
  unreached: string | null
}

/** One orchestrator's trouble in a clause, or null where it reports none. */
function troubleOf(who: string, standing: OrchestratorStanding | null): string | null {
  if (standing === null) return `${who} runs a Tade that does not say how its orchestrator stands`
  if (standing.state === 'failed') {
    return `${who}’s orchestrator did not start: ${printable(standing.said ?? 'it gave no reason')}`
  }
  if (standing.state === 'starting') return `${who}’s orchestrator is still starting`
  if (!standing.shares) return `${who}’s orchestrator runs a conversation of its own`
  return null
}

/**
 * What the check after a reload says: that the conversation is one with each
 * machine and its orchestrator reports no sign-in or model problem, or what
 * stands in the way, machine by machine — one sentence, never silence.
 */
export function checkedSaid(
  here: { name: string; standing: OrchestratorStanding | null },
  machines: readonly Checked[],
  hub: string | null,
  oneWith: string | null,
): string {
  const troubles: string[] = []
  const fine: string[] = []
  const mine = troubleOf(here.name, here.standing)
  if (mine !== null) troubles.push(mine)
  for (const one of machines) {
    if (one.unreached !== null) {
      troubles.push(`${one.name} did not answer after it: ${one.unreached}`)
      continue
    }
    const facts = one.facts
    const trouble =
      facts === null
        ? `${one.name} did not answer in time`
        : troubleOf(one.name, facts.orchestrator)
    if (trouble !== null) troubles.push(trouble)
    else if (facts !== null && !together(facts, hub, oneWith)) {
      troubles.push(
        one.name === hub
          ? `this conversation is not one with ${one.name} yet: the last exchange with it did not go through`
          : `${one.name}’s conversation is not one with its hub`,
      )
    } else fine.push(one.name)
  }
  if (hub === null && machines.length > 0) {
    troubles.push(
      'no hub is named, so each machine keeps a conversation of its own: set machine.hub',
    )
  }
  if (troubles.length === 0) {
    const names = machines.map((one) => one.name).join(' and ')
    return `After the reload: the conversation is one across ${here.name} and ${names}, and no orchestrator reports a sign-in or model problem.`
  }
  const good = fine.length === 0 ? '' : ` ${fine.join(' and ')} came back as one conversation.`
  return `After the reload: ${troubles.join('; ')}.${good}`
}
