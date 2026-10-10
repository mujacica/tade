import {
  type Document,
  documentsIn,
  type EventFilter,
  type EventInput,
  type TadeEvent,
} from '@tade/core'
import { producedDetail } from './tasks.ts'

// Reading what tasks produced, and writing down what somebody decided.
//
// Its own file because it is its own subject, and because the fold it stands
// on is core's: this is the journal read, the two refusals, and the one line
// appended. `workbench.ts` is at its budget and a budget only goes down.
//
// **Why there is a record here at all, in a codebase whose rule is that status
// is derived.** Two of the three things that resolve a document are observed —
// work queued off it, its own agent started again — and `documentsIn` derives
// both, so neither can be claimed by a sentence inside the document. The third
// is "somebody read it and nothing should follow", which has no consequence
// anywhere and therefore cannot be observed at all. It joins `commit_seen` and
// `check_ran`: written down precisely because it cannot be asked again. The
// version of this that derived everything left no way to say it, so the only
// way to clear a document off the waiting list was to queue work off it —
// which is the incentive backwards, and why six analyses on one machine were
// deleted rather than decided about.
//
// Nothing here starts anything. The only effect of a decision being written
// down is that a line leaves a list.

/**
 * What deciding about a document needs, which a `Workbench` already is.
 *
 * Taken as a parameter rather than reached for through a method on the
 * workbench, which is how `useTemplate` and `inboxFrom` are already written:
 * the workbench is the facade over tmux, the journal and git, and a subject
 * that only needs the journal says so in its type.
 */
export interface DocumentDeps {
  log: {
    read(filter: EventFilter): Promise<TadeEvent[]>
    append(input: EventInput): Promise<unknown>
  }
  now?(): Date
}

/** Every document a task produced, with what has come of each. The fold is core's. */
export async function documentsOf(deps: DocumentDeps): Promise<Document[]> {
  return documentsIn(await deps.log.read({}))
}

export interface TriageRequest {
  task: string
  path: string
  /** Their sentence. Never reworded, and never sent anywhere. */
  decided: string
  by?: string
}

/**
 * Record that somebody read the document a task produced and what they
 * decided.
 *
 * Refused where the journal has no such document — a path reconstructed from
 * memory is the shape of that mistake — and refused again where one has
 * already been decided about since it was last produced: a second line would
 * be a second answer, and the first one is somebody's. Refused with no
 * sentence, because the sentence is the whole of the record and a bare flag is
 * the flag that goes unset.
 */
export async function triageDocument(deps: DocumentDeps, req: TriageRequest): Promise<Document> {
  const decided = req.decided.trim()
  if (!decided) throw new Error('say what you decided: a record with no sentence says nothing')
  const path = req.path.trim()
  const found = (await documentsOf(deps)).find((one) => one.task === req.task && one.path === path)
  if (!found) {
    throw new Error(
      `${path || '(no path)'} is not a document ${req.task} produced: tade_documents says which there are`,
    )
  }
  if (found.triaged) {
    throw new Error(
      `${req.task} was already decided about by ${found.triaged.by}: ${found.triaged.decided}`,
    )
  }
  const triaged = {
    by: req.by ?? 'unknown',
    decided,
    at: (deps.now?.() ?? new Date()).toISOString(),
  }
  await deps.log.append({
    type: 'document_triaged',
    task: req.task,
    detail: { path, by: triaged.by, decided },
  })
  return { ...found, triaged }
}

/**
 * What a removal must write down about the document it is about to destroy.
 *
 * Here rather than inline at the removal, because the *timing* is the whole
 * point and it reads as an ordinary lookup otherwise: a task's folder holds
 * the only copy of what it produced, so once `rm -rf` has run nothing can
 * answer this ever again. It is also the only thing that can speak for an
 * agent killed before it finished, which never got a receipt at all.
 */
export async function removedDocument(
  home: string,
  task: string | null,
): Promise<{ produces?: string; written?: true }> {
  const made = await producedDetail(home, task).catch(() => ({}))
  if (!('produces' in made) || !made.produces) return {}
  return { produces: made.produces, ...(made.missing ? {} : { written: true as const }) }
}
