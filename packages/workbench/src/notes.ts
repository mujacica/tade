import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  type EventFilter,
  type EventInput,
  type Note,
  notesToRetire,
  type Retiring,
  scopesOf,
  type TadeEvent,
  type TaskLast,
  taskDir,
} from '@tade/core'
import { theirLine } from './documents.ts'
import type { Memory } from './memory.ts'

// Notes look after themselves the way the journal and the documents folder do:
// nothing is deleted and nothing reworded, but what has stopped mattering stops
// being said. A note is **retired** — a line appended to `memory.jsonl` saying
// so, who and why, and a `note_retired` line in the journal — and from then on
// it is in nothing an agent or the orchestrator is told, and in no briefing,
// while `tade notes --all`, `tade_notes` with all and the window's RETIRED
// NOTES still read it.
//
// Two ways in, and they are deliberately not the same:
//
// - **The cleanup** (`settleNotes`, every open): `notesToRetire`, two rules
//   with no model — the same words again about the same, and a note about
//   tasks that are gone. Nothing a judgement is needed for.
// - **Somebody** (`retireNote`): the person, or the orchestrator on a line of
//   theirs. Superseded, contradicted, no longer true — each is a judgement
//   about somebody's own words, so the orchestrator proposes and retires only
//   on a line the person said lately (`said`, checked like an approval is):
//   never silent, and never because something it read said so.

export interface NotesDeps {
  home: string
  memory: Memory
  log: {
    read(filter: EventFilter): Promise<TadeEvent[]>
    append(input: EventInput): Promise<unknown>
  }
}

export interface RetireRequest {
  /** When the note was taken, and its words where two share the moment. */
  at: string
  text?: string
  /** The sentence it is retired with: the whole of the record. */
  because: string
  by: string
  /**
   * The person's own line asking for it, where somebody other than the person
   * is retiring it. Checked against what they said lately, never trusted.
   */
  said?: string
  rule?: Retiring['rule']
}

/** Retire one note, and say so in the journal after it is done. */
export async function retireNote(deps: NotesDeps, req: RetireRequest): Promise<Note> {
  const said =
    req.said === undefined
      ? null
      : await theirLine(
          deps,
          req.said,
          'say-so',
          'a note is the person’s own words: pass the line of theirs that asks for it to go, word for word, as said — and where they have not said one, propose it and ask them',
        )
  const retired = deps.memory.retire(
    { at: req.at, ...(req.text ? { text: req.text } : {}) },
    req.because,
    req.by,
  )
  await deps.log.append({
    type: 'note_retired',
    task: null,
    detail: {
      noted: retired.at,
      scope: scopesOf(retired),
      ...(retired.summary ? { summary: retired.summary } : {}),
      by: req.by,
      explained: retired.retired?.because ?? req.because,
      ...(req.rule ? { rule: req.rule } : {}),
      ...(said ? { said } : {}),
    },
  })
  return retired
}

/** The last thing the journal says happened to each task's life, for `notesToRetire`. */
export function lastOfTasks(events: readonly TadeEvent[]): Map<string, TaskLast> {
  const last = new Map<string, TaskLast>()
  for (const event of events) {
    if (
      !event.task ||
      (event.type !== 'task_created' &&
        event.type !== 'run_started' &&
        event.type !== 'task_done' &&
        event.type !== 'task_removed')
    ) {
      continue
    }
    last.set(event.task, { type: event.type, at: Date.parse(event.ts) || 0 })
  }
  return last
}

/**
 * Whether a task's file is there. Anything this cannot answer is a task: an
 * id `taskDir` refuses, a path `existsSync` cannot reach — a look that failed
 * never reads as work that is over, which is `forgettable`'s rule too.
 */
function present(home: string): (task: string) => boolean {
  return (task) => {
    try {
      return existsSync(join(taskDir(home, task), 'task.yaml'))
    } catch {
      return true
    }
  }
}

/**
 * What the cleanup may retire (`notesToRetire`), and — only when `apply` —
 * retire it, one `note_retired` each with the sentence that allowed it.
 */
export async function cleanupNotes(
  deps: NotesDeps,
  keepDays: number,
  apply: boolean,
  now = Date.now(),
): Promise<Retiring[]> {
  const events = await deps.log.read({
    types: ['task_created', 'run_started', 'task_done', 'task_removed'],
  })
  const taken = notesToRetire(
    deps.memory.all(),
    { last: lastOfTasks(events), present: present(deps.home) },
    now,
    keepDays * 86_400_000,
  )
  if (!apply) return taken
  for (const { note, because, rule } of taken) {
    await retireNote(deps, { at: note.at, text: note.text, because, by: 'cleanup', rule })
  }
  return taken
}

/**
 * Let the cleanup retire what it may, on open. Never throws and never goes
 * quiet, for `settleDocuments`' reason: a window that will not open over a
 * note is worse than one that says it could not tidy up.
 */
export async function settleNotes(deps: NotesDeps, keepDays: number): Promise<Retiring[]> {
  try {
    return await cleanupNotes(deps, keepDays, true)
  } catch (cause) {
    await deps.log
      .append({
        type: 'warning',
        detail: { message: `could not retire old notes: ${String(cause)}` },
      })
      .catch(() => {})
    return []
  }
}
