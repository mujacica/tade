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
  'talk',
  // The three the factory floor needs, and all three are **off** with every
  // other grant off, which is the whole point: a phone can be told *four
  // requests are waiting, two of them for you* without one word anybody
  // outside this machine wrote.
  'requests',
  'material',
  'workflows',
  // **What an agent's own screen shows**, and the one grant that is a fourth
  // kind of value: not Tade's words, not the owner's and not a stranger's, but
  // whatever an agent printed — a file it read, a command's answer, an
  // environment it dumped. So it is off with every other grant off, it is read
  // only while somebody is looking (`screen.ts` has the bounds and the
  // scrubbing), and what it says about itself is in `GRANT_MEANS` below.
  'lanes',
  // **What Tade is set up with**, as the Settings page lists it. Off with
  // every other grant off: a config is the owner's own decisions about their
  // machine, and *what my phone may see* is not *what my settings are*. A key
  // is never in it under any grant — said as set or not set, by the same
  // rule `tade_settings` follows (`configuring.ts`, `settingsFor`) — and it
  // is also what changing one from away needs: a device may not change what
  // it was not allowed to see, or the value it echoes would be a guess and a
  // `409` an oracle for it.
  'settings',
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
  // The conversation, and the one grant that needs more than a clause, because
  // two things about it are true and neither is guessable. It is the only
  // collection whose text is **not** shown as it was said — every line has
  // anything path-shaped taken out (`chatRows`), because a model quotes what
  // its tools answered. And it is the only one that can carry something
  // nothing here can find: a credential somebody pasted into a message, or one
  // a tool printed and the model repeated. Tool lines carry a name and an
  // outcome and never an argument, which is the part that *is* enforced.
  //
  // What is granted here is *reading* it. Sending a message is
  // `surfaces.web.orchestrator` plus the `ask` scope, which is a different
  // decision made in a different place.
  talk:
    'the conversation with Tade — what was asked, what it answered, which tools it used; ' +
    'machine paths are taken out, and anything else said into it is not',
  // **Outside text, and a third kind of value.** Everything above is either
  // Tade's own words or the owner's; these two are what a stranger wrote in a
  // system Tade does not control. So they are two grants and not one, and the
  // split is where the volume is: a title is a line on a row and a body is
  // every word somebody typed into a ticket, and wanting to see *what is
  // waiting* is not wanting to read it from a phone.
  //
  // Neither is scrubbed, for the reason a note is not: rewording somebody's
  // request is the same lie as rewording a note. What stands instead is the
  // grant, the budget, the label, and the page never building markup.
  requests: 'what each outside request calls itself, and the handle of whoever filed it',
  material:
    'the request itself, as it arrived — somebody else’s words, under a heading saying so. ' +
    'An agent reads them as material and they authorise nothing; a person reading them on a ' +
    'phone should know the same thing, which is why the heading travels with the words',
  workflows:
    'the stored workflows and the personas they are told from — every step’s own prompt, in ' +
    'the words you wrote them in',
  // **Two halves and neither is the comfortable one.** What *is* taken out is
  // enforced and tested (`screen.ts`, `test/screen.test.ts`): machine paths,
  // every key Tade holds and every variable of its environment named like a
  // credential, and anything shaped like one. What is *not* is everything else
  // an agent printed — a customer's address in a fixture, a key in a shape
  // nobody listed — and a person deciding has to be told that half too.
  lanes:
    'the last lines each agent’s own screen shows, read only while you are looking at it — ' +
    'machine paths, the keys Tade holds and anything shaped like a credential are taken out, ' +
    'and anything else an agent printed is not',
  settings:
    'what Tade is set up with, as the Settings page lists it, for the projects this device ' +
    'reads — a key or a token is said as set or not set and never shown, and machine paths ' +
    'are taken out',
}

/**
 * Where each grant is enforced: every place on the wire it withholds, and
 * nowhere else.
 *
 * **One table for the three that must agree** — what the projection withholds,
 * what the page says *not granted* about, and what a box in the window's panel
 * grants. A bare name is a whole collection (its rows withheld, its count
 * kept); a dotted one is a field, null on every row. `agent.screen` and
 * `settings` are answers of their own (`/api/agent/...`, `/api/settings`)
 * rather than a part of the snapshot.
 *
 * `test/withholds.test.ts` takes each grant away from a device that has every
 * other one and asserts the snapshot changes in exactly these places, so a gate
 * added to the projection without a line here, or a line here with no gate
 * behind it, fails; the page asks by path (`mayFor` in `assets/access.js`, a
 * copy held equal to this one) and never names a grant itself.
 */
export const WITHHOLDS: Readonly<Record<Grant, readonly string[]>> = {
  titles: ['projects.title', 'tasks.title'],
  intent: ['tasks.intent', 'queue.waitsOn.why', 'runs.steps.waits.why', 'evaluations.races.said'],
  notes: ['notes'],
  findings: ['findings', 'evaluations.findings', 'evaluations.races.order'],
  // Quotas are `plans`: what a sign-in has used of its plan is a figure about
  // money, and goes with the rest of it.
  spend: [
    'tasks.spend',
    'plans',
    'intake.would.limits',
    'runs.steps.usd',
    'runs.usd',
    'evaluations.cost',
    'evaluations.races.usd',
  ],
  reviews: ['tasks.review.url'],
  accounts: ['tasks.account', 'plans.account'],
  talk: ['chat'],
  requests: ['intake.title', 'intake.who', 'intake.url'],
  material: ['intake.material', 'intake.materialSays', 'intake.materialLabel'],
  workflows: ['workflows'],
  lanes: ['agent.screen'],
  settings: ['settings'],
}

/** The grant a place on the wire is withheld under, or null for what every paired device reads. */
export function grantOf(path: string): Grant | null {
  for (const grant of GRANTS) if (WITHHOLDS[grant].includes(path)) return grant
  return null
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
  /**
   * Whether it may answer what an agent is waiting on (its `answer` scope),
   * which is what lets it read the command it would be answering
   * (`ANSWERING`). Absent is no: a reach made for reading alone answers nothing.
   */
  answers?: boolean
}

/**
 * Where answering reaches on the wire: what a device granted the `answer`
 * scope reads that no reading grant gives, and what one without it is never
 * sent.
 *
 * **Not a grant, and not in `WITHHOLDS`**, because it is not a separate
 * decision. The person decided this phone may say yes to what an agent is
 * waiting on; saying yes to a command you are not shown is what an approval
 * exists to prevent, so seeing it goes with answering it and is never offered
 * on its own. `test/withholds.test.ts` takes the scope away and asserts the
 * snapshot changes here and nowhere else. A device without it sees the tool's
 * name, as every paired device does, and nothing new.
 */
export const ANSWERING: readonly string[] = ['tasks.approval.command']

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
