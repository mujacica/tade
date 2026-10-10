import { join } from 'node:path'
import type { TadeEvent } from './events.ts'
import { taskDir } from './home.ts'

// What a task produces that is not a change to the code.
//
// An agent sent to plan, audit or research writes a document, and a task
// finishing reached the orchestrator as one line — the summary its agent
// wrote — with nothing saying a document existed or where. So every time, a
// person had to say "the research agent is done, go and read it", which is the
// one step nobody should have to remember.
//
// A task may therefore name what it produces (`TaskFile.produces`), written
// when the task is made like `done` and `start`, and the line that says it
// finished carries that path and whether the file is actually there. It is on
// `task_done` rather than looked up afterwards because **the journal is the
// only thing that remembers**: the task's folder goes when the task does, and
// a window that was shut when an agent finished still has to be able to say,
// when it opens, that there is a document waiting to be read.
//
// The document goes with the task, in the task's own folder in Tade's home
// (`producesPath`) — so it is not the repository's, not committed, and it is
// removed with the task's other files when somebody removes the task.
//
// **"The orchestrator is told the moment it finishes, and reads it then, which
// is the one moment anybody ever needed it for" was the whole of the rest of
// this, and it was the belief the mechanism broke on.** That moment is one
// in-memory line in a window that may be shut, in a list capped at forty, and
// the second telling — the briefing — forgot after three days and only ever
// spoke when a window opened. Meanwhile the only way to clear a document off
// that list was to queue work off it, so "I read it and nothing follows" could
// not be said at all; and closing an agent deleted the folder, the document
// and the record of it together, which is how twelve of thirteen documents on
// one machine were destroyed with nothing anywhere saying they had existed.
//
// So a document is not handed off when somebody is told. It is handed off when
// somebody says what they decided (`document_triaged`), and until then it
// stays on the list however long that takes (`waitingDocuments`). What bounds
// the list is decisions, never a clock.
//
// There is no research mode and no lifecycle of its own: a task is a task, and
// this is one optional field on it.
//
// Pure: the journal in, what is waiting out. Nothing here starts anything —
// what to do about an analysis is a judgement, and a rule that queued work off
// a document would fill the queue with somebody's guesses.

/**
 * Why a name cannot be what a task produces, or null when it can.
 *
 * What a task names is a file in its own folder: a name, or a path under it,
 * and never a way out of it — so the one question the rule exists to answer,
 * what happens to the document, has one answer for every task. It is where
 * Tade's bookkeeping for that task already is, and goes when that does.
 *
 * It used to be a path in the repository, committed like any other change,
 * because a document only in a worktree is one nobody can read once the
 * worktree has gone. That bought a document outliving its task and charged for
 * it in every project Tade touched: somebody's oauth-scope audit in their
 * history for good, on a branch that exists to carry no code. What it was
 * really paying for is that somebody is told, which the line saying the task
 * finished already does. A document that genuinely belongs to the repository —
 * a README, a skill, a changelog — is an ordinary change and never was this
 * field.
 */
export function producesProblem(path: string): string | null {
  const said = path.trim()
  if (!said) return "name the file it writes, as a name in the task's own folder"
  if (said.startsWith('/') || said.startsWith('~') || /^[a-z]:[\\/]/i.test(said)) {
    return `${said} is a path of its own: give a name in the task's own folder`
  }
  const parts = said.split(/[\\/]/)
  if (parts.includes('..')) {
    return `${said} climbs out of the task's folder: give a name inside it`
  }
  return null
}

/**
 * Where the document a task produces goes: the task's own folder in Tade's
 * home, under the name the task gave it.
 *
 * The one reader, so the sentence its agent is told, the path written on
 * `task_done` and the file Tade looks for are one string rather than three
 * that agree today. A name `producesProblem` refuses is not one to join onto a
 * path, so every caller checks first (`createTask`, `checkPlan`,
 * `producedDetail`, and the agent's own prompt).
 */
export function producesPath(home: string, task: string, produces: string): string {
  return join(taskDir(home, task), produces.trim())
}

/**
 * What state a produced document is in, which is three facts and not a
 * lifecycle: the file is there, the task named one and wrote none, or the task
 * was removed and took it with it.
 *
 * `gone` is here rather than being an absence because **a document destroyed
 * before anybody read it is a fact**, and the version of this that deleted the
 * record on `task_removed` reported it as nothing at all. Twelve of thirteen
 * documents on the machine this was written for had been destroyed that way,
 * six of them inside two seconds of a cleanup, and no surface in Tade could
 * say they had ever existed.
 */
export type DocumentState = 'written' | 'missing' | 'gone'

/**
 * A document a finished task produced, and what has come of it since.
 *
 * `Document` and not `Produced`, which this file's neighbour already uses for
 * what a task committed: one of them is lines of code and the other is the
 * thing somebody reads instead of the code.
 */
export interface Document {
  task: string
  /** Where it is: the path in Tade's home the journal recorded, ready to read. */
  path: string
  /** Whether the file is there, was never written, or went with its task. */
  state: DocumentState
  /** What its agent said when it finished. */
  summary: string
  /** When it finished, as the journal wrote it. */
  at: string
  /**
   * When its task was removed and the file went, or null while it is there.
   *
   * Kept apart from `at` because a `gone` one is aged against *this* and never
   * against its finish: a document written last week and destroyed a minute
   * ago is a minute-old loss, and ageing it against the finish is how it would
   * be unrecoverable and unmentioned in the same breath.
   */
  removedAt: string | null
  /** The task named it and the file was not there when it finished. */
  missing: boolean
  /** How big it was when it finished; null where nothing could look. */
  bytes: number | null
  /** Work made since it finished that waits on it: what was queued off it. */
  followed: string[]
  /** Its own agent was started again after it finished, warm context and all. */
  reused: boolean
  /** Somebody read it and said what they decided; null while nobody has. */
  triaged: Triage | null
}

/** Somebody's decision about a document: whose, what they said, and when. */
export interface Triage {
  by: string
  /** Their sentence. Never reworded, and never sent anywhere. */
  decided: string
  at: string
}

/**
 * Every document a task produced, oldest first, with what has come of each.
 *
 * Three things can resolve one, and the split between them is the whole design.
 * **Two are observed**: work made afterwards that waits on it (`followed`) and
 * its own agent started again (`reused`) — both are real events, so neither can
 * be claimed by a sentence in the document itself. **One is told**: `triaged`,
 * because "I read it and nothing should follow" is the answer a document waits
 * on most often and it leaves no mark anywhere. Deriving the two that can be
 * derived and writing down only the one that cannot is why this is not the
 * flag that goes unset — there is nothing to set about the other two.
 *
 * Keyed by task *and* path: a task that finishes twice, or whose `produces` was
 * edited between finishes, has two documents and two things to read.
 *
 * Pure, and takes no `now`: which of these is worth showing is the caller's
 * (`waitingDocuments`), because "worth showing" is about a clock and this is
 * about what happened.
 */
export function documentsIn(events: readonly TadeEvent[]): Document[] {
  const out = new Map<string, Document>()
  /** Every document of one task, so `followed`, `reused` and removal reach all of them. */
  const byTask = new Map<string, Document[]>()
  const keep = (one: Document): void => {
    out.set(keyOf(one.task, one.path), one)
    byTask.set(one.task, [...(byTask.get(one.task) ?? []).filter((o) => o.path !== one.path), one])
  }
  for (const event of events) {
    const task = event.task
    if (!task) continue
    const mine = byTask.get(task) ?? []
    if (event.type === 'task_removed') {
      // The document went with the folder. The record stays, and says so.
      for (const one of mine) {
        one.state = 'gone'
        one.removedAt = event.ts
      }
      // A task removed having never finished never got a receipt, so the
      // removal is the only thing that can say a document existed — which is
      // the whole of how an agent that crashed after writing is covered. Only
      // where one actually existed: a task that named a document, wrote none
      // and was removed has lost nothing and has nothing to decide about.
      const path = said(event.detail.produces)
      if (event.detail.written === true && path && !mine.some((one) => one.path === path)) {
        keep({
          task,
          path,
          state: 'gone',
          summary: '',
          at: event.ts,
          removedAt: event.ts,
          missing: false,
          bytes: null,
          followed: [],
          reused: false,
          triaged: null,
        })
      }
      continue
    }
    if (event.type === 'run_started') {
      for (const one of mine) one.reused = true
      continue
    }
    if (event.type === 'task_created') {
      const after = Array.isArray(event.detail.after) ? event.detail.after.map(String) : []
      // Only work made *after* it finished: a plan written before the research
      // ran always names it, and that is the plan waiting, not somebody
      // deciding what the document turned out to say.
      for (const waited of after) {
        for (const one of byTask.get(waited) ?? []) {
          if (!one.followed.includes(task)) one.followed.push(task)
        }
      }
      continue
    }
    if (event.type === 'document_triaged') {
      const path = said(event.detail.path)
      const decided = said(event.detail.decided)
      // Both named or the line does nothing: a decision with no sentence is
      // the flag that goes unset, and one with no path would clear every
      // document the task ever produced off the strength of its task id.
      if (!path || !decided) continue
      for (const one of mine) {
        if (one.path !== path) continue
        // **A triage is about the document as of the finish it was read
        // against.** A task reopened and finished again has written something
        // else, and a verdict on what it used to say is not a verdict on that.
        if (when(event.ts) < when(one.at)) continue
        one.triaged = { by: said(event.detail.by) || 'unknown', decided, at: event.ts }
      }
      continue
    }
    if (event.type !== 'task_done') continue
    const path = said(event.detail.produces)
    if (!path) continue
    const missing = event.detail.missing === true
    keep({
      task,
      path,
      state: missing ? 'missing' : 'written',
      summary: said(event.detail.summary),
      at: event.ts,
      removedAt: null,
      missing,
      bytes: typeof event.detail.bytes === 'number' ? event.detail.bytes : null,
      followed: [],
      reused: false,
      triaged: null,
    })
  }
  return [...out.values()]
}

/**
 * How long a document whose file is gone stays worth mentioning.
 *
 * The same three days the briefing calls stale, and applied to **nothing
 * else** — see `waitingDocuments`.
 */
const GONE_STALE = 3 * 86_400_000

/**
 * The documents still waiting on somebody, oldest first.
 *
 * **Time may only ever retire what cannot be acted on.** A document whose file
 * is there can still be read, so it never ages out — not after three days, not
 * after three weeks, and a window left open for a fortnight is not a window
 * that forgot. One whose task was removed cannot be read by anybody ever
 * again, so there is nothing to do about it but note it, and that may age out.
 *
 * What bounds this list is therefore **decisions and not the clock**: anything
 * resolved — queued off, picked back up, or triaged — leaves it at once. The
 * version of this that bounded it by three days lost a document nobody had
 * read on the fourth morning, without a word.
 */
export function waitingDocuments(documents: readonly Document[], now: number): Document[] {
  return documents.filter((one) => {
    // **`reused` is said beside one and never clears it.** Work made that
    // waits on it is somebody acting; a decision written down is somebody
    // deciding. Its agent being started again is neither — `run_started` also
    // fires for a window reopening what it left running, a harness changed
    // under it and a model picked, and a list whose whole purpose is that a
    // document is not lost may not be emptied by a relaunch.
    if (one.triaged || one.followed.length > 0) return false
    if (one.state !== 'gone') return true
    return when(one.removedAt ?? one.at) >= now - GONE_STALE
  })
}

/**
 * What a task produced and what has come of it, as a clause after its own
 * name: "produced …/tasks/audit/scope.md, and nothing has been done about it
 * yet".
 *
 * One wording, said by the news the moment a task finishes and by the briefing
 * a window later, because two descriptions of one fact drift apart.
 */
export function producedClause(one: {
  path: string
  state?: DocumentState
  missing?: boolean
  bytes?: number | null
  followed?: readonly string[]
  reused?: boolean
  triaged?: Triage | null
}): string {
  if (one.state === 'gone') {
    return one.missing
      ? `said it would produce ${one.path}, and the task was removed`
      : `produced ${one.path}, and it was removed with its task — ${actedOnSays(one)}`
  }
  if (one.missing) return `said it would produce ${one.path} and did not write it`
  return `produced ${one.path}${documentSize(one.bytes)}, and ${actedOnSays(one)}`
}

/**
 * How big it was, as a clause, or nothing where nothing could look.
 *
 * Exported because the window says it too, in front of somebody about to
 * destroy one: two wordings of the same number would disagree about when a
 * document is big enough to mention.
 */
export function documentSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || bytes < 0) return ''
  if (bytes === 0) return ' (empty)'
  return bytes < 10_240 ? ` (${bytes} bytes)` : ` (${Math.round(bytes / 1024)} KB)`
}

/**
 * The documents waiting on somebody, as lines to read and act on.
 *
 * **Paths and never contents**, which is the whole of why this is a wording and
 * not a payload: what a document says is read from the file by whoever will act
 * on it, so it arrives as material under the rule about what an agent reads,
 * and never as the answer to a Tade tool — the one voice there is no reason to
 * doubt. The size is said so a huge one can be declined before it is opened.
 *
 * Here beside `producedClause` for the reason that clause is here: one wording,
 * said by the briefing, the window and the tool alike.
 */
export function documentsWaitingSays(documents: readonly Document[], now: number): string {
  const waiting = waitingDocuments(documents, now)
  if (waiting.length === 0) {
    return 'No documents are waiting: every one a task produced has been decided about.'
  }
  return [
    'Documents tasks produced that nobody has decided about yet. Read each file before you say anything about it — you have a path, not a summary — then say what follows and record it with tade_document_triage. Deciding that nothing should follow is an answer.',
    ...waiting.map((one) => `  ${one.task} ${producedClause(one)}`),
  ].join('\n')
}

/** What was written down about one, as the answer to having written it. */
export function triagedSays(one: Document): string {
  return `Written down: ${one.task} — ${one.triaged?.decided ?? ''}. It is no longer listed as waiting.`
}

/** What has been done about a document since its task finished, in one clause. */
export function actedOnSays(one: {
  followed?: readonly string[]
  reused?: boolean
  triaged?: Triage | null
}): string {
  const followed = one.followed ?? []
  const parts: string[] = []
  if (followed.length > 0) {
    parts.push(`${followed.join(', ')} ${followed.length === 1 ? 'was' : 'were'} queued off it`)
  }
  if (one.reused) parts.push('its own agent was started again')
  // Last, and in their own words: whatever else happened, what somebody
  // decided is the thing worth reading, and it is never reworded.
  if (one.triaged) parts.push(`${one.triaged.by} read it and decided: ${one.triaged.decided}`)
  return parts.length === 0 ? 'nothing has been done about it yet' : parts.join(', and ')
}

/**
 * What identifies one document: its task and its path, together.
 *
 * A separator that cannot occur in either, written as an escape rather than
 * typed, because a literal NUL in a source file makes the file binary — `file`
 * reports it as data and `grep` goes silently blind on it.
 */
function keyOf(task: string, path: string): string {
  return `${task}\u0000${path}`
}

/** A detail value as the string it is meant to be, trimmed; empty for anything else. */
function said(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** A journal timestamp as a moment; an unreadable one counts as the epoch rather than NaN. */
function when(ts: string): number {
  const at = Date.parse(ts)
  return Number.isNaN(at) ? 0 : at
}
