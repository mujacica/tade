import { z } from 'zod'

// The event log is the system's memory: append-only, and the journal that
// answers "what was I doing last Tuesday". Every event carries an urgency,
// and the attention policy decides which surfaces render it.

export const Urgency = z.enum(['blocking', 'notable', 'routine', 'trace'])
export type Urgency = z.infer<typeof Urgency>

/** Lower is more important. Used for ordering and for dropping under pressure. */
export const URGENCY_RANK: Record<Urgency, number> = {
  blocking: 0,
  notable: 1,
  routine: 2,
  trace: 3,
}

/**
 * Who a record says did something.
 *
 * Three answers and not two, because the third is load-bearing: `you` is the
 * keyboard, `orchestrator` is the thing you talk to acting on your word, and
 * `device <id>` is **a request from a paired device** — which is not the
 * person's own doing and must never be written as though it were.
 * `historyFrom` reads a `by` that is not `you` as *not something you did*, and
 * `namedBy` authorises an `asked`-tier setting change only against words
 * somebody actually said. A remote act recorded as `you` would quietly widen
 * both (`ACTING_IS_NOT_YOU`).
 *
 * The device's **id** and never its label: a label is a person's own words
 * about their own phone, and an id is sixteen hex characters that mean nothing
 * on their own. `@tade/web`'s `byOf` is the one place either becomes one of
 * these.
 */
export type Asker = 'you' | 'orchestrator' | `device ${string}`

export const EventType = z.enum([
  // lanes
  'lane_opened',
  /** Picked up again on open, still running from a previous window. */
  'lane_adopted',
  'lane_exited',
  'lane_closed',
  'output',
  'input',
  // tasks
  'task_created',
  /** An agent that started without a branch got one, named for its work. */
  'task_named',
  'task_removed',
  /**
   * A change that spans repositories was named: its slug and the sentence
   * that asked for it, verbatim, written once when the plan is made. The
   * effort itself is the fold of the task files that name it — this is here
   * for the same reason `intent_spoken` is, because nothing else can recover
   * the sentence once those files are gone.
   */
  'effort_named',
  /**
   * A stored workflow was stamped out: which template, which version, and the
   * content hash of the published snapshot it was made from.
   *
   * Here because the snapshot is the only thing that remembers *what* the
   * shape was, and this is the only thing that remembers *which* snapshot a
   * run came from — a template's draft moves on, and without this line a task
   * made in March reads as having come from whatever the file says today.
   */
  'template_used',
  'state_change',
  /**
   * A task finished: its agent said so, a person marked it, or Tade saw its
   * own rule met. What work waiting on it waits for.
   */
  'task_done',
  /**
   * Somebody read the document a task produced and said what they decided.
   *
   * The one thing about a document that **cannot be asked again**, which is
   * the only reason it is written down: what work followed is derived from the
   * tasks that name it and from its agent being started again, but "I read it
   * and nothing should follow" leaves no mark anywhere else, and that is the
   * answer a document waits on most often. Without it the only way to clear a
   * document off the list is to queue work, which is the incentive backwards.
   *
   * It carries **whose** decision and **their sentence**, because the sentence
   * is the whole value of the record — a bare flag is a flag that goes unset.
   * The sentence is `decided` and never `because`: `because` is on telemetry's
   * allow-list, and a sentence about somebody's work never leaves the machine.
   */
  'document_triaged',
  /**
   * Somebody added to what a task's agent is told.
   *
   * The line carries **how much** was added and who added it, and never a word
   * of it: the text is in the task's own context file, where the agent reads
   * it, and a journal holding a second copy would put somebody's words in two
   * places with one of them unreachable. Here rather than folded into
   * `state_change` because a context edit changes nothing about the task's
   * state and everything about what the next turn does.
   */
  'context_added',
  // the queue
  /** Queued work started: what it waited on finished, its time came, or someone started it. */
  'queue_started',
  /** Queued work is held: what it waits on failed, stopped or went, or it could not start. */
  'queue_held',
  /** Someone changed queued work: paused it, resumed it, started it anyway, or chose to wait. */
  'queue_changed',
  /** A schedule came due: what it did then — or that it skipped runs Tade was closed for. */
  'schedule_fired',
  /** A schedule was made, renamed, paused, resumed or removed, and by whom. */
  'schedule_changed',
  /** A watch looked: how much it found, how much was new, where its next look starts — or why it could not. */
  'watch_checked',
  /** Something a watch found for the first time, and the work started on it or who was told. */
  'watch_found',
  // intake: work that came from outside this machine
  /**
   * An external request was handed to this machine — a ticket, a message, a
   * line typed at the local door — and is Tade's business: its source, its own
   * id, the revision it is at, and the correlation id every line about it
   * carries. **Written before anything is made**, which is what makes a crash
   * in the middle readable: a `received` with no `accepted` or `refused` after
   * it is a delivery that was interrupted, and the next look picks it up by its
   * external id rather than losing a request nobody will send twice.
   *
   * Only ever about something a rule could have allowed. A look that saw a
   * thousand issues and nothing addressed to Tade writes its counts on
   * `watch_checked` and nothing here: a line per non-event fills the journal
   * with the world.
   */
  'intake_received',
  /**
   * A request the rule said no to: the grant is off, the project is not on the
   * source's list, the requester is not on the owner's list, or the source
   * itself says it was an app.
   *
   * Written down every time, for the reason a refused pairing is: a refusal
   * nobody made is what makes an attack visible. **Never replied to** — a reply
   * tells an unauthorised person the machine is there and listening.
   */
  'intake_refused',
  /**
   * A request allowed, by which grant, at which mode, and the work made for it
   * — with the template and published version where one was stamped out.
   *
   * `propose` is the default and means the tasks are parked: a person approves
   * one, and nothing an outside request said is what started an agent.
   */
  'intake_accepted',
  /**
   * Carrying one out failed, or something about it has to be answered before it
   * can go on: a transient failure with tries left, a revision nobody can
   * order, an edit that invalidated an approval already given — or that Tade
   * has given up, which is the one of these that must never be silent.
   */
  'intake_held',
  /**
   * Something was said back to the source about one request: which, and which
   * of the fixed sentences. Never what was said by an agent, because nothing an
   * agent wrote is ever posted — the line records that a status went out.
   */
  'intake_replied',
  // agents
  'run_started',
  /**
   * What a run turned out to be on, the moment its harness said so.
   *
   * `run_started` can only record what was *asked* for, and with nothing asked
   * for there is nothing to ask for: pi picks by what you are signed in to, so
   * 86 of the 161 runs in the journal this was written from named no model at
   * all and every hour they ran was time attributed to nothing. A harness says
   * which model it opened on before it does any work, and a run that never
   * bills says it and nothing else — so this is the only place it can be, and
   * a fact not written down when it was true is a question nobody can answer
   * later. Which harness, sign-in and provider it was on rides along with it,
   * as it does on `usage`: a model is the harness's own, and one read back
   * without the harness that ran it is a name nobody can hand anywhere.
   */
  'run_model',
  'run_exited',
  'tool_call',
  'permission_request',
  'permission_granted',
  'permission_denied',
  /**
   * A turn began: the moment a model started working, as its harness said so.
   *
   * How long an agent *ran* is the span its lane was open, which counts every
   * hour it sat finished waiting for somebody to read it — the honest answer
   * to "how long was it there" and the wrong answer to "how long was it
   * working". The second needs the beginnings of turns, and the journal that
   * produced this comment had 7,090 `turn_done` in it and not one thing saying
   * when any of them started, so the question could not be asked of a single
   * hour of history.
   *
   * All three harnesses already say it (`turn_started` on the wire) and the
   * supervisor already reads it to time its spans; what was missing was
   * writing it down. Nothing keeps a stopwatch: this is the beginning and
   * `turn_done` is the end, and `runtimeFrom` folds the pair.
   */
  'turn_started',
  'turn_done',
  'failed',
  /**
   * An agent whose turn the machine cut off — a laptop that slept mid-reply —
   * was told to carry on where it stopped, and how long the machine was away.
   *
   * The one record that a gap in an agent's transcript was the machine and
   * not the agent. Nothing else can say it afterwards: the harness's own
   * session shows a turn that ended in an error and a turn that began after
   * it, which reads exactly like an agent that failed and was retried by
   * somebody at the keyboard.
   */
  'agent_continued',
  /** What a turn consumed, in tokens and money. */
  'usage',
  /** A finished task was looked back over, so it is never looked at twice. */
  'reflected',
  // what was verified, and what was written
  /**
   * A check finished, against the commit it checked. The run itself is kept in
   * the worktree it ran in, which goes when the worktree does; this is the
   * line that outlives it, so "how often does `types` fail, and how long does
   * it take" stays answerable after the work is merged and cleaned up.
   */
  'check_ran',
  /**
   * A commit was seen for the first time, and what it changed. Written once
   * per commit, by sha, so a look that reads the same history twice counts it
   * once — and so the numbers survive the worktree being removed, which is
   * what re-reading `git log` every time would not.
   */
  'commit_seen',
  /**
   * Tade added its own files to a project's ignore rules, and which lines it
   * added. Nothing writes this any more — Tade writes nothing inside a project
   * to ignore — and it stays here because journals that have it must still
   * read.
   */
  'ignore_written',
  /**
   * Tade took its own rule back out of a project's ignore file, and which
   * lines it took. The undo of `ignore_written`, and here for the same reason
   * that was: it edits a file that is not its own, once, so the one line
   * saying it did is what makes that readable rather than mysterious.
   */
  'ignore_removed',
  /**
   * The journal was compacted: what was dropped, what is left, and what the
   * file weighed before and after.
   *
   * Compaction removes lines from the one file that is the truth, so the line
   * saying it happened is what makes that readable rather than mysterious —
   * the same reason `ignore_written` exists. It is written after the fact and
   * only when something was actually dropped, so a journal with none of these
   * in it has never had anything taken out of it.
   */
  'journal_compacted',
  /**
   * What Tade has been told was changed: a setting written, a project opened
   * or closed. What it was before is in the line, because the config is one
   * file that is rewritten in place and nothing else remembers — so a change
   * made through a tool, by somebody who was not at the keyboard, is a line
   * anybody can read and undo rather than a value that is simply different
   * now. Who asked is on it, and where their own words were what allowed it,
   * so are they.
   */
  'config_changed',
  // the away view
  /**
   * The away view came up, or went: `enabled`, `bind` and `port`, as the
   * window read them when it started listening — and the addresses it
   * actually bound, which is the half a config cannot say.
   *
   * Notable for the reason `config_changed` is: somebody changed how
   * reachable the control room is, and the person who did *not* make the
   * change is the one who most needs to see it. Written when the listener
   * comes up and when it goes, so a journal read a month later can say over
   * which stretches of time anything was listening at all.
   */
  'web_enabled',
  /**
   * A device was paired: it may now read what it was granted, from off this
   * machine, until it is signed out or expires. The line carries the device's
   * id, the label the device suggested, the address it came from and what it
   * was granted — never the ticket it used and never the credential it was
   * given, neither of which anything may read back.
   */
  'web_paired',
  /**
   * A pairing was not allowed: refused at the machine, or nobody answered
   * before the deadline. Two reasons, one line each, because a person saying
   * no and a person not being there are different things to read back.
   */
  'web_denied',
  /** A device was signed out: by itself, or at the machine. */
  'web_revoked',
  /**
   * Requests were refused at the door and kept coming: a `Host` that is not
   * this machine, a cross-site `Origin`, a session that is not one. Written
   * once a peer is past the threshold rather than per request, because a
   * refusal is cheap and a line per refusal is how a journal becomes a
   * request log nobody reads.
   */
  'web_refused',
  /**
   * A paired device changed something: the device, the verb, what it was
   * about, and what came of it.
   *
   * **The audit half of acting, and it is the half that makes the rest
   * answerable.** A remote act is never a `said` line — `namedBy` reads those
   * to authorise a setting change and a request from a phone is not somebody's
   * own words — so this is the only record that one happened, and it carries
   * the device id so that "every act one takes is in the journal under its id"
   * (`DEVICES_AND_AGENTS`) is a fact rather than a promise. Written whatever
   * the outcome: a refusal and a repeat that did nothing are both things
   * somebody reading back needs to be able to see.
   *
   * Notable for the reason `config_changed` is: somebody who was not holding
   * the phone is the one who most needs to know.
   */
  'web_did',
  /**
   * A paired device said something to the orchestrator: the device, how much
   * it sent, and what came of the turn.
   *
   * **Its own type and not a `web_did`, because it answers a different
   * question.** A `web_did` is one bounded verb against one target; this is
   * free text handed to a model that holds tools, and "what has this phone
   * asked Tade" is the question somebody reading back actually has. It is
   * also the type the `said` rule is stated against: a remote request is
   * **never** a `said` line — `namedBy` reads those to authorise a setting
   * change, and nothing in this one can ever reach that set.
   *
   * **The words are not in it, deliberately.** The detail carries the device,
   * the length and the outcome; what was typed is in the conversation, where
   * the window draws it marked as the device's. A journal line is what
   * telemetry reads from and what `summary` reads back, and neither is a place
   * for a paragraph somebody typed on a phone.
   */
  'web_asked',
  /**
   * A paired device asked to be told about work, or stopped asking: the
   * device, and Tade's own word for which.
   *
   * **Its own type and not a `web_paired`, because what it changes is the
   * other direction.** Pairing decides what a phone may *read* when it asks;
   * this decides that this machine will reach *out* to a third-party push
   * service about that phone, unasked, on its own beat. A person who did not
   * hold the phone is the one who most needs to see that happen, which is why
   * it is `notable` like the grants rather than `routine` like a refusal.
   *
   * **The endpoint is not in it.** It is a URL at somebody else's service with
   * a per-device token in its path, it is in `web-pushes.jsonl` where the
   * sender reads it, and a journal line is what telemetry reads from.
   */
  'web_subscribed',
  /**
   * A notification was sent to a device, or could not be: the device, what the
   * transition was, and what the push service said.
   *
   * `routine`, unlike every other `web_` line that is not a refusal, and the
   * reason is the one thing that is different about this one: the person has
   * **already been interrupted** by the thing itself. An earcon per
   * notification would be the same news twice, once in each room.
   *
   * **No payload and no title**, whatever was sent: the words are built from a
   * count (`noticed.ts`) and the record Tade keeps is which transition it was
   * about. What went wrong, where something did, is a `warning` with a
   * sentence in it.
   */
  'web_pushed',
  // you
  /** A line you said or typed to Tade, verbatim: what up and ctrl+r bring back. */
  'said',
  // the workbench itself
  'tade_opened',
  'tade_closing',
  'warning',
])
export type EventType = z.infer<typeof EventType>

export const DEFAULT_URGENCY: Record<EventType, Urgency> = {
  lane_opened: 'notable',
  lane_adopted: 'notable',
  lane_exited: 'notable',
  lane_closed: 'routine',
  output: 'trace',
  input: 'trace',
  task_created: 'notable',
  task_named: 'notable',
  task_removed: 'notable',
  effort_named: 'notable',
  template_used: 'notable',
  state_change: 'notable',
  task_done: 'notable',
  // Notable: a record nobody can reconstruct, so it is worth the fsync that
  // `notable` is the threshold for. Never `blocking` — nothing waits on it.
  document_triaged: 'notable',
  // Notable: what an agent is told changes what it does, so somebody coming
  // back wants to see that it was changed and by whom. Never `blocking` —
  // nothing is waiting on it.
  context_added: 'notable',
  queue_started: 'notable',
  // Not blocking: nothing is running into a wall, and the orchestrator is told
  // in words. Blocking would raise a pane for work that has none.
  queue_held: 'notable',
  queue_changed: 'notable',
  schedule_fired: 'notable',
  schedule_changed: 'notable',
  // Routine: it looks on a clock, and a look that found nothing is not news.
  // What it found is, and that is `watch_found`.
  watch_checked: 'routine',
  watch_found: 'notable',
  // Notable, all four of them, and none is `routine`: an outside request is
  // the one kind of news nobody at this machine asked for, so somebody coming
  // back wants to see that it arrived, what was decided and what is waiting.
  // Never `blocking` — nothing is running into a wall; `propose` means a task
  // is parked and will wait as long as it has to.
  intake_received: 'notable',
  intake_refused: 'notable',
  intake_accepted: 'notable',
  intake_held: 'notable',
  intake_replied: 'notable',
  run_started: 'notable',
  // Routine rather than trace, for the reason `usage` is: it is read back out
  // of the journal to be added up, and trace is the first thing dropped when a
  // subscriber falls behind — which here would mean an agent's hours going to
  // the bucket for nothing recorded, silently.
  run_model: 'routine',
  run_exited: 'notable',
  tool_call: 'routine',
  permission_request: 'blocking',
  permission_granted: 'routine',
  permission_denied: 'routine',
  // Routine rather than notable, and never trace. Not notable, because a turn
  // beginning is not news — the window already draws the agent as busy, and an
  // earcon per turn start is a metronome. Never trace, for the reason `usage`
  // is not: it is read back out of the journal to be added up, and trace is
  // the first thing dropped when a subscriber falls behind — which here would
  // mean a turn whose end was written and whose beginning was not, and so an
  // agent's working time silently reading as unknown.
  turn_started: 'routine',
  turn_done: 'notable',
  failed: 'blocking',
  // Notable: somebody back at their laptop wants to see that Tade noticed and
  // what it did about it. Once per sleep per agent, which is as often as
  // anybody goes for lunch — and never blocking, since nothing is waiting on
  // a person: the agent has already been put back to work.
  agent_continued: 'notable',
  // Routine rather than trace: spend is read back out of the journal, and
  // trace is the first thing dropped when a subscriber falls behind.
  usage: 'routine',
  // Nobody needs to be told that Tade thought about something.
  reflected: 'trace',
  // Routine rather than trace, for the same reason `usage` is: both are read
  // back out of the journal to be added up, and trace is the first thing
  // dropped when a subscriber falls behind. A statistic with holes in it that
  // nothing announces is worse than no statistic.
  check_ran: 'routine',
  commit_seen: 'routine',
  // Routine, for the same reason `commit_seen` is: a fact written down once so
  // it can be read back, not something to interrupt anybody with. The change
  // itself is already in `git status` and in the diff, which is where somebody
  // sees it; what this line adds is who put it there.
  ignore_written: 'routine',
  ignore_removed: 'routine',
  // Notable rather than routine, which is where the other written-once facts
  // are: this one is fsync'd, because it is the record of a destructive act
  // and a window that crashed just after compacting must not come back with
  // the lines gone and nothing saying who took them.
  journal_compacted: 'notable',
  // Notable, unlike the other things written down once: the rest are facts
  // being recorded, and this is somebody changing how Tade behaves. A person
  // who did not make the change is the one who most needs to see it.
  config_changed: 'notable',
  // A device gaining or losing the right to read Tade from off this machine is
  // the same shape as a setting changing, and for the same reason: the person
  // who did not do it is the one who most needs to see that it happened.
  web_enabled: 'notable',
  web_paired: 'notable',
  web_denied: 'notable',
  web_revoked: 'notable',
  // Not `notable`: a refusal at the door is the guard working, and an earcon
  // per scanner on the wifi is a sound nobody can act on. It is kept for the
  // record, where a sustained attempt reads as one.
  web_refused: 'routine',
  // Notable, unlike a refusal at the door: this is work changing because
  // somebody asked from off the machine, which is the one thing about the away
  // view a person at the keyboard cannot see happening.
  web_did: 'notable',
  // Notable for the reason `web_did` is, and more so: a turn in the
  // conversation the person types into, started by something that is not them.
  web_asked: 'notable',
  // Notable like the grants: this machine now reaches out to a push service
  // about a phone, and whoever was not holding it is the one who needs to see
  // that it does.
  web_subscribed: 'notable',
  // Routine, and the one `web_` line that is not a refusal and still is: the
  // person has already been interrupted by the notification itself, so an
  // earcon here is the same news twice.
  web_pushed: 'routine',
  said: 'routine',
  tade_opened: 'notable',
  tade_closing: 'notable',
  warning: 'notable',
}

/**
 * Names events were written under before the project was renamed. Tade never
 * writes one — it only reads them, because events.jsonl is append-only and is
 * the truth: a journal from before the rename still says when the window
 * opened and closed, and a reader that does not know the old word silently
 * loses those facts. That is not hypothetical — it is how runs from days
 * earlier stayed open and went on counting to now: nothing closed them,
 * because the closings were called something else, and a week of runtime
 * landed in a morning's total.
 *
 * An alias read rather than another `EventType`: what Tade writes stays one
 * list nobody can add an old name back to, and what it can read is the longer
 * one. Filters are widened for the same reason — asking for `tade_opened`
 * asks about window openings, whatever they were called when they happened.
 */
export const RENAMED_TYPES = {
  wilco_opened: 'tade_opened',
  wilco_closing: 'tade_closing',
} as const satisfies Record<string, EventType>

/** A name in the journal that Tade no longer writes. */
export type LegacyEventType = keyof typeof RENAMED_TYPES

/** Anything a reader may ask for: what is written now, and what once was. */
export type ReadableEventType = EventType | LegacyEventType

/** What a name in the journal means now. Anything current is itself. */
export function typeNow(type: string): EventType {
  return (RENAMED_TYPES as Record<string, EventType>)[type] ?? (type as EventType)
}

/**
 * Every name in the journal that reads as one of these types — for a filter
 * that matches on the stored word, like the index's `type IN (...)`.
 */
export function typeNames(types: readonly ReadableEventType[]): string[] {
  const wanted = new Set(types.map(typeNow))
  const names = new Set<string>(types)
  for (const [was, now] of Object.entries(RENAMED_TYPES)) if (wanted.has(now)) names.add(was)
  return [...names]
}

export const TadeEvent = z.object({
  /** Monotonic per log file, assigned on append. */
  seq: z.int().nonnegative(),
  ts: z.string(),
  type: EventType,
  urgency: Urgency,
  task: z.string().nullable().default(null),
  lane: z.string().nullable().default(null),
  run: z.string().nullable().default(null),
  detail: z.record(z.string(), z.unknown()).default({}),
})
export type TadeEvent = z.infer<typeof TadeEvent>

/** What callers pass to `append`: the log fills in seq, ts and the default urgency. */
export interface EventInput {
  type: EventType
  urgency?: Urgency
  task?: string | null
  lane?: string | null
  run?: string | null
  detail?: Record<string, unknown>
}

export interface EventFilter {
  /** Only events with `seq` greater than this. */
  since?: number
  task?: string
  lane?: string
  /** Matched by what a type means now, so an old name answers for the new one. */
  types?: readonly ReadableEventType[]
  /** Only events at least this urgent. */
  minUrgency?: Urgency
  limit?: number
}

export function matchesFilter(e: TadeEvent, f: EventFilter): boolean {
  if (f.since !== undefined && e.seq <= f.since) return false
  if (f.task !== undefined && e.task !== f.task) return false
  if (f.lane !== undefined && e.lane !== f.lane) return false
  if (f.types && !f.types.some((type) => typeNow(type) === typeNow(e.type))) return false
  if (f.minUrgency && URGENCY_RANK[e.urgency] > URGENCY_RANK[f.minUrgency]) return false
  return true
}
