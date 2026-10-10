import type { IntakeCandidate, IntakeReceipt, IntakeSource, LookTrouble } from '@tade/core'
import type { ExtensionContext, ExtensionWorkbench, JsonSchema, Link, ProjectRef } from './port.ts'

// The watch half of the port: a cheap look on a clock, what it finds, and the
// two things that may be asked about one finding afterwards.
//
// Its own file because it is a port within the port — a watch has its own
// context, its own answer shape, its own conformance section and its own three
// optional capabilities — and because `port.ts` reached the size a file is
// allowed to be. The arrow is types only, both ways, so nothing is imported at
// runtime and nothing is evaluated in either order.
//
// **Three capabilities, each honoured by absence.** A watch that does not say
// `intake` is an ordinary watch and no rule about grants, revisions or
// approvals applies to it. One with no `agent` has nothing to start work on and
// says so. One with no `reply` has no path back to its source at all — which is
// a stronger guarantee than a flag that disables one, and is the same argument
// the away view makes about its own missing methods.

/** Something a watch found: what it is, and a key that stays the same every time it is found. */
export interface Finding {
  key: string
  title: string
  /** More about it, for the agent that starts on it: written into its context. */
  detail?: string
  links?: readonly Link[]
  /**
   * What arrived from outside this machine, where this finding is one: the
   * request, who the source says asked, and where the exact bytes are.
   *
   * **Declared, never sniffed.** A watch that sets this is an intake source and
   * says so in `intake` as well; one that does not is an ordinary watch and
   * every rule about grants, approval, revisions and re-checks is simply absent
   * for it — which is why the existing watches keep their keys and their
   * behaviour without opting into anything.
   *
   * It carries no grant and no template, deliberately: a caller-chosen grant is
   * no grant, and a caller-chosen template is the hole that makes one
   * dangerous. Both are the owner's config's, filled in here.
   */
  intake?: IntakeCandidate
}

/** Whether a finding is still worth starting work on, asked at the moment it would start. */
export type Recheck =
  /** It is, and nothing has changed that matters. */
  | { still: true }
  /** It is not, in a sentence a person reads: closed, reassigned, relabelled, rewritten. */
  | { still: false; because: string }

/**
 * One of the statuses a source may be told, which are the only things a reply
 * ever says.
 *
 * **What is not in it is the capability.** There is no field for a label, an
 * assignee, a state, a milestone, a channel, a recipient or a reaction, and no
 * second method beside `reply` — so there is no route by which Tade closes,
 * assigns, labels, merges or deletes anything at a source, and none by which
 * it messages anywhere a finding did not come from. That is enforcement by
 * absence rather than a list of forbidden verbs: a transport cannot be asked
 * for what cannot be said.
 */
export interface ReplyRequest {
  /** The finding's key, so a watch can find the thing again at the source. */
  key: string
  /** The sentence to post, which Tade generated. Never a word an agent wrote. */
  say: string
  /**
   * Tade's own stable marker for this one status about this one request —
   * `tade:cli:req-7:accepted` — the same marker every time it is tried.
   *
   * **This is what makes a post idempotent across a crash.** A window that
   * died between posting and writing the line comes back with the status due
   * again and hands over the same marker; a transport that recognises it
   * answers `already` and creates nothing. It is for the transport's own
   * bookkeeping and **need not be posted**: putting Tade's machinery into the
   * visible text of somebody's issue is the disclosure the rest of this is
   * careful about.
   */
  mark: string
}

/**
 * What came of posting one status, as the transport that posted it says.
 *
 * The domain's own type (`IntakeReceipt`, `@tade/core`), named here in the
 * port's words: the same answer is written down by the workbench, which knows
 * nothing about extensions, so one definition serves both rather than two
 * shapes that have to agree.
 *
 * `posted` is the source's own id for whatever was created. `already` is that
 * this exact status was there and nothing was created — the answer to a crash
 * after a post, asked again with the same `mark`; a transport that cannot tell
 * says nothing rather than guessing. `revision` is where the source's own
 * revision moved to, and **any source whose revision moves when something is
 * posted to it owes that answer**: a GitHub issue's `updated_at` moves for a
 * comment, a moved revision is how Tade notices an edit, so a status going out
 * would otherwise read on the next look as somebody having rewritten the
 * request and would put back an approval a person had just given.
 */
export type ReplyReceipt = IntakeReceipt

/**
 * A look that could not reach the host it needs: nothing came back at all.
 *
 * Thrown by a watch instead of an ordinary error, and read by the one thing
 * that is allowed to have an opinion about connectivity — the scheduler's own
 * reach for a network. It names the host so that reach can ask about that
 * host, and the hosts it asks about are only ever ones a watch already needed.
 *
 * **Only for nothing coming back.** A 404, a 500, an auth failure, a rate
 * limit or a provider saying no is an answer: something was reached, and one
 * endpoint being down is not the machine being offline. Those stay ordinary
 * errors and keep exactly the behaviour they have.
 */
export class Unreachable extends Error {
  /** The host that did not answer: `github.com`, `sentry.io`. */
  readonly host: string

  constructor(host: string, said: string) {
    super(said)
    this.name = 'Unreachable'
    this.host = host
  }
}

/**
 * What kind of trouble a look ran into, out of the error it threw.
 *
 * **Here, because this is where the one type that cannot be guessed lives.** A
 * look is written down by the window's own `catch` (`wire/schedules.ts`), and
 * what it has there is an error — so the classification happens at the only
 * moment anything knows, and `LookTrouble` carries it into the journal. The
 * alternative, a classifier over the `problem` sentence, is a second answer
 * that goes wrong the first time somebody rewords an error.
 *
 * **Three ways a connector can say which, in widening order of trust.**
 * `Unreachable` is this package's own type and means nothing came back at all.
 * A `trouble` field is a connector's own answer about its own provider —
 * `LinearError` and the Slack door both carry one, with `ratelimited` among
 * their words — and it is read as a *word*, never as a class, so a connector
 * that is not loaded here cannot be `instanceof`-ed and does not have to be.
 * A `status` of `429` is HTTP's own answer and is the last resort. Everything
 * else is `refused` where something answered and `other` where nothing says.
 *
 * It never reads the message. A sentence containing "rate limit" is a sentence
 * about a rate limit, not a rate limit, and a look at a repository whose
 * README says so would be classified by its own content.
 */
export function troubleOf(err: unknown): LookTrouble {
  if (err instanceof Unreachable) return 'unreachable'
  const said = err as { trouble?: unknown; status?: unknown; resetsAt?: unknown }
  const trouble = typeof said?.trouble === 'string' ? said.trouble.toLowerCase() : ''
  if (trouble === 'ratelimited' || trouble === 'rate limited' || trouble === 'rate-limited') {
    return 'rate-limited'
  }
  if (trouble === 'network') return 'unreachable'
  if (trouble === 'auth' || trouble === 'forbidden') return 'refused'
  if (said?.status === 429) return 'rate-limited'
  if (typeof said?.status === 'number' && said.status >= 400) return 'refused'
  return trouble === '' ? 'other' : 'refused'
}

/**
 * When a spent budget is clear again, as the source itself said, or 0.
 *
 * `0` and not null, because that is the spelling `watchChecked` already writes
 * and `watchedFrom` already reads as *nobody said*. Read off the error for the
 * same reason the kind is: the connector is the only thing that saw the header.
 */
export function troubleUntil(err: unknown): number {
  const at = (err as { resetsAt?: unknown })?.resetsAt
  return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : 0
}

/** What a watch looks with. */
export interface WatchContext extends ExtensionContext {
  /** The project it watches. */
  watching: ProjectRef
  /**
   * What only an open window can do and see. A watch runs in one, so this is
   * normally there — but a look that cannot happen without it says so rather
   * than assuming it.
   */
  tade: ExtensionWorkbench | null
  /** What it was turned on with. */
  input: Readonly<Record<string, unknown>>
  /** Where its last look left off, as that look said; null the first time. */
  since: string | null
  /** When it was turned on, as an ISO time: what was already there then is not new. */
  turnedOn: string
  signal: AbortSignal
}

/** An agent on one finding: what its task is called, what it is told, and what it reads first. */
export interface WatchAgent {
  title: string
  prompt: string
  context?: string
  links?: readonly Link[]
}

/**
 * Work an extension can watch for: a cheap look, on a clock, at whether there
 * is anything to do — and what an agent is told about each thing it finds.
 *
 * Nothing is watched until someone turns it on, which makes it a schedule like
 * any other: paused, renamed or removed the same way. Tade keeps where each
 * look left off and every key it has found, so a watch keeps nothing itself and
 * one finding never starts two agents.
 */
export interface ExtensionWatch {
  /** Its name in the extension: `new-errors`. Turned on, it is `<extension>.<id>`. */
  id: string
  title: string
  /** What it looks for and what it starts, in a sentence. */
  means: string
  /** How often it looks unless told otherwise, as a schedule says it: `30m`, `1h`, `1d`. */
  every: string
  /** What it can be turned on with, as a tool's parameters are said. Checked before it is. */
  input?: JsonSchema
  /**
   * What it is for, when somebody turns it on without saying: work started on
   * each finding (`agent`, the default), or the orchestrator told about it
   * (`ask`). A watch whose findings are about work already going — an agent
   * going in circles — has nothing to start, and says `ask`. Whoever turns it
   * on may still say otherwise, and a watch that offers no `agent` refuses
   * that rather than starting something it cannot describe.
   */
  offers?: 'ask' | 'agent'
  /**
   * On without anybody turning it on: the first look a window takes in a
   * project whose extension can look writes the schedule, once, and from then
   * on it is an ordinary schedule — listed, pausable, changeable, removable,
   * and removed it stays removed.
   *
   * A watch may only say this where being on costs nothing anybody has to
   * agree to: no key of somebody else's, no third party told anything, and a
   * look that finds nothing spends nothing. An extension that is not ready —
   * no key, turned off, broken — has no standing watch written at all, which
   * is what makes the no-key case exactly nothing rather than a schedule that
   * fails every ten minutes.
   */
  standing?: boolean
  /**
   * How many of what one look finds are acted on, where two — the schedule's
   * own default — is the wrong number for this watch.
   *
   * Only ever a starting point: whoever turns a watch on may say otherwise, and
   * the schedule is what decides from then on. It is here because two is a
   * sensible ceiling on *agents started* and no ceiling anybody wants on
   * *questions asked*: the findings sweep tells somebody about work that has
   * already happened, so a backlog of nine metered at two an hour is a backlog
   * that takes five hours to be mentioned once. A watch that starts agents
   * (`offers: 'agent'`) should leave this alone.
   */
  most?: number
  /**
   * Whether its look reaches off this machine.
   *
   * Declared, never sniffed. With no network there is nothing for one of these
   * to look with, so the scheduler does not start it at all — no request, no
   * timeout, no red line, and where its last look left off is untouched, so
   * the first look once the network is back finds everything since. A watch
   * that reads this machine and nothing else says nothing here and keeps
   * looking through an outage, which is the point of telling them apart: an
   * agent going in circles is still going in circles with the wifi off.
   *
   * A watch that says this should also throw `Unreachable` when the host it
   * needs is the thing that did not answer, so that an outage which leaves the
   * interfaces up — a router whose own uplink is down — is found on the first
   * failed look rather than on every look all night.
   */
  network?: boolean
  /**
   * Look, and say what there is. No model: it runs on a clock, and a look that
   * finds nothing costs nothing. Nothing found is an empty list, never a throw;
   * it throws, with why, only when it cannot look at all. What it returns as
   * `since` is handed to its next look, which may find some of the same things
   * again: Tade knows which it has seen.
   */
  check(ctx: WatchContext): Promise<{
    found: readonly Finding[]
    since?: string
    /**
     * Why a look found nothing, in one sentence a person can act on —
     * `nothing pushed yet`, never a service's error string.
     *
     * A look that found nothing because everything is fine and a look that
     * found nothing because there was nothing to look at are opposite facts,
     * and `found: 0` says both. This is the second of them, and it is **not** a
     * problem: a look that could not look at all still throws. It is kept with
     * the look and said when it starts being true rather than at every look
     * while it stays true, so word it as a standing fact — a sha or a count in
     * it is a sentence that changes every look, which is a sentence that gets
     * said every look.
     */
    said?: string
  }>
  /**
   * What an agent starting on one finding is told. Asked only for what work is
   * started on, so this is where anything slow to fetch about a finding belongs.
   * Left out by a watch that has nothing to start (`offers: 'ask'`), and then
   * nothing may be started on what it finds.
   */
  agent?(finding: Finding, ctx: WatchContext): Promise<WatchAgent> | WatchAgent
  /**
   * That this watch is an intake source, and which one.
   *
   * Declared rather than worked out from what it returns, so every rule about
   * grants, modes, revisions and re-checks can be asked of a watch *before* it
   * has looked — at the door that turns it on, in the conformance suite, and in
   * the window. A watch that says this must implement `recheck` and must put an
   * envelope of that source on every finding; one that says nothing is an
   * ordinary watch and nothing here applies to it.
   */
  intake?: IntakeSource
  /**
   * Whether one finding is still worth starting work on, asked at the moment
   * the queue would start it.
   *
   * The precedent is `lookAtTrees`: what the plan guessed about the code is
   * checked against the tree at the moment of starting, "because that is the
   * moment it is true". There was no equivalent for the *thing the work is
   * about*, so a ticket closed, reassigned or rewritten five minutes ago still
   * started an agent — and for an issue resolved in Sentry while its task
   * waited in a queue, exactly the same.
   *
   * **It may only ever hold.** Nothing it answers can start work that the
   * queue's rules would not, and a watch that cannot reach its source throws
   * (`Unreachable` where nothing came back) rather than answering `still: true`
   * — an inaccessible source is a hold, never an assumption of permission.
   *
   * Required of a watch that declares `intake`, and perfectly reasonable for
   * one that does not: it is about findings, not about tickets, and nothing in
   * its shape uses an intake's vocabulary.
   */
  recheck?(finding: Pick<Finding, 'key'>, ctx: WatchContext): Promise<Recheck> | Recheck
  /**
   * Say one status back to where a finding came from.
   *
   * **A capability, honoured by absence**: a watch that does not implement this
   * has no reply path at all, which is a stronger guarantee than a flag that
   * disables one. What may be said is not this method's to choose — it is a
   * fixed set of sentences Tade generates, capped per request, and never a word
   * an agent wrote, a diff, a log line, a file name or anything out of a
   * private repository.
   *
   * It is also not enough on its own: a reply goes out only where the owner
   * granted `reply` for that source, which is a second act and never implied by
   * accepting work.
   *
   * **It must be idempotent for one `mark`.** Asked twice with the same marker
   * it creates one status and the second answer says `already` — which is the
   * whole of what reconciling a crash after a post amounts to, and is asserted
   * by the conformance suite rather than asked for here.
   *
   * **A write being unavailable is an ordinary error and nothing else.** It
   * throws, with why; the look and the re-check keep working, the work carries
   * on, and the status is tried again a bounded number of times and then given
   * up on visibly. Nothing a source does to a reply may stop work: a request
   * that was granted gets built whether or not anybody could be told.
   */
  reply?(
    request: ReplyRequest,
    ctx: WatchContext,
    // biome-ignore lint/suspicious/noConfusingVoidType: a transport that posted and has nothing to report is an async function with no return, which is `Promise<void>`. Narrowing it to `undefined` would refuse the plainest honest implementation there is.
  ): Promise<ReplyReceipt | void> | ReplyReceipt | void
}
