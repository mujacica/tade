import { existsSync } from 'node:fs'
import { copyFile, mkdir, rename, rm, rmdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  type Compactable,
  DOCUMENT_EVENTS,
  type Document,
  documentMovedTo,
  documentsDir,
  documentsIn,
  documentsToCompact,
  type EventFilter,
  type EventInput,
  LINES_LOOKED_BACK,
  producesPath,
  producesProblem,
  type TadeEvent,
  taskDir,
  taskDocumentsDir,
  type Wait,
} from '@tade/core'
import { producedDetail, readTaskFile } from './tasks.ts'

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
// down is that a line leaves a list — and, once it is old enough and whatever
// was queued off it has finished, that the cleanup may take the file.
//
// **What deletes a document, and what never does.** A document lives in its
// project's documents folder in Tade's home and outlives its task, so removing
// a task or closing its agent deletes nothing anybody reads. Two things do:
// a person asking (`deleteDocument`, any document, with their reason), and the
// cleanup (`cleanupDocuments`, on every open and when asked), which may only
// take what `documentsToCompact` allows — never one nobody decided about. Each
// is a `document_deleted` line, written after the file went.

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
  return documentsIn(await deps.log.read({ types: [...DOCUMENT_EVENTS] }))
}

export interface TriageRequest {
  task: string
  path: string
  /** Their sentence. Never reworded, and never sent anywhere. */
  decided: string
  by?: string
  /** The person approves it: what queued work waiting on its approval waits for. */
  approved?: boolean
  /**
   * The line of the person's that approves it, word for word, when the one
   * writing it down is not the person themselves.
   */
  said?: string
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
 *
 * **An approval is the person's**, because it is what starts work planned to
 * wait for it, and a document or an agent asking to be approved is precisely
 * what it is there to stop. So one written by anybody but the person carries
 * a line of theirs (`said`) that the journal has them saying lately — the
 * barrier `namedBy` is for settings: text an agent read can never get into a
 * `said` line. It can follow a decision that was not one — "asked them which"
 * is usually what comes before it — but never another approval.
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
  if (found.triaged && (found.triaged.approved || !req.approved)) {
    throw new Error(
      `${req.task} was already decided about by ${found.triaged.by}: ${found.triaged.decided}`,
    )
  }
  const by = req.by ?? 'unknown'
  const approved = req.approved === true
  const said = approved && by !== 'person' ? await theirLine(deps, req.said ?? '') : null
  const triaged = { by, decided, at: (deps.now?.() ?? new Date()).toISOString(), approved }
  await deps.log.append({
    type: 'document_triaged',
    task: req.task,
    detail: {
      path,
      by,
      decided,
      ...(approved ? { approved: true } : {}),
      ...(said ? { said } : {}),
    },
  })
  return { ...found, triaged }
}

/**
 * The line of the person's an approval quotes, as they said it, or a refusal
 * saying what to do instead. Matched with case and spacing set aside, inside
 * one of the last lines they said (`LINES_LOOKED_BACK`): "yes, go with B" is
 * theirs when they said "Yes, go with B — and keep it small".
 *
 * `what` is the act it is quoted for — retiring a note asks the same question
 * (`notes.ts`) — and `missing` the refusal when nothing was quoted at all.
 */
export async function theirLine(
  deps: Pick<DocumentDeps, 'log'>,
  quoted: string,
  what = 'approval',
  missing = 'an approval is the person’s: pass the line of theirs that approves it, word for word, as said — and where they have not said one, ask them',
): Promise<string> {
  const plain = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()
  const want = plain(quoted)
  if (!want) throw new Error(missing)
  const lines = await deps.log.read({ types: ['said'], limit: LINES_LOOKED_BACK }).catch(() => [])
  const theirs = lines.flatMap((event) =>
    typeof event.detail.text === 'string' ? [event.detail.text] : [],
  )
  const line = theirs.find((one) => plain(one).includes(want))
  if (!line) {
    throw new Error(
      `nothing the person has said lately is "${quoted.trim()}", so this is not their ${what}: ask them, and pass their own words`,
    )
  }
  return line
}

/**
 * What work made to wait says it waits on, for its `task_created` line: every
 * task, and which of them it waits for the person to approve the document of
 * — work queued to wait for that approval is the plan waiting for the decision,
 * never somebody having acted on the document (`documentsIn`).
 */
export function waitedDetail(after: readonly Wait[]): { after: string[]; approval?: string[] } {
  const approval = after.filter((dep) => dep.approved).map((dep) => dep.task)
  return { after: after.map((dep) => dep.task), ...(approval.length > 0 ? { approval } : {}) }
}

/** What reading, moving and deleting documents needs: the journal, and the home they are in. */
export interface DocumentHome extends DocumentDeps {
  home: string
}

/**
 * What a removal writes down about the document its task produced, asked
 * before the task's folder goes.
 *
 * The document is not in that folder — `kept` says so, and is what tells the
 * fold the removal took nothing — except where an agent told under the old
 * rule wrote it there, and then it is moved out first (`document_moved`), so
 * removing the task is never what destroys it. It is also the only thing that
 * can speak for an agent killed before it finished, which never got a receipt
 * at all.
 */
export async function removedDocument(
  deps: DocumentHome,
  task: string | null,
): Promise<{ produces?: string; written?: true; kept: true }> {
  const made = await producedDetail(deps.home, task).catch(() => ({}))
  if (!task || !('produces' in made) || !made.produces) return { kept: true }
  // A folder made for a document that was never written is not worth keeping.
  if (made.missing) await rmdir(taskDocumentsDir(deps.home, task)).catch(() => {})
  const to = documentMovedTo(deps.home, task, made.produces)
  if (to && !made.missing) await moveDocument(deps, task, made.produces, to)
  const produces = to ?? made.produces
  return { produces, ...(made.missing ? {} : { written: true as const }), kept: true }
}

/** Move one document and say so: from where, to where. */
async function moveDocument(deps: DocumentDeps, task: string, from: string, to: string) {
  await mkdir(dirname(to), { recursive: true })
  await rename(from, to).catch(async (cause: NodeJS.ErrnoException) => {
    // Another volume: a home on one disk and its projects on another.
    if (cause.code !== 'EXDEV') throw cause
    await copyFile(from, to)
    await rm(from)
  })
  await deps.log.append({ type: 'document_moved', task, detail: { from, into: to } })
}

/** What one settling of the documents folder did. */
export interface Settled {
  moved: number
  deleted: Compactable[]
}

/**
 * Put the documents folder in order, on open: move what is still in a task's
 * own folder to where documents are kept now, then let the cleanup take what
 * it may.
 *
 * Never throws and never goes quiet: whatever went wrong is a `warning` line,
 * because a window that will not open over a document is worse than one that
 * says it could not tidy up.
 */
export async function settleDocuments(deps: DocumentHome, keepDays: number): Promise<Settled> {
  const done: Settled = { moved: 0, deleted: [] }
  try {
    for (const one of documentsIn(await deps.log.read({ types: [...DOCUMENT_EVENTS] }))) {
      if (one.state !== 'written') continue
      const to = documentMovedTo(deps.home, one.task, one.path)
      if (!to || !(await isFile(one.path))) continue
      await moveDocument(deps, one.task, one.path, to)
      done.moved += 1
    }
    done.deleted = await cleanupDocuments(deps, { keepDays, apply: true, by: 'cleanup' })
  } catch (cause) {
    await deps.log
      .append({
        type: 'warning',
        detail: { message: `could not put the documents folder in order: ${String(cause)}` },
      })
      .catch(() => {})
  }
  return done
}

export interface DeleteRequest {
  task: string
  path: string
  /** Their reason, in their words: the whole of what the journal will say about it. */
  why: string
  by?: string
}

/**
 * Delete a document a task produced, because somebody asked: any one, decided
 * about or not, which is what makes this a person's act and never the
 * cleanup's.
 *
 * Refused where the journal has no such document, where it is already gone,
 * with no reason — the reason is the whole record — and **where the path is
 * not in that task's documents folder or its own folder**: the path comes out
 * of the journal, and a line there is never permission to delete anything
 * else on the disk.
 */
export async function deleteDocument(deps: DocumentHome, req: DeleteRequest): Promise<Document> {
  const why = req.why.trim()
  if (!why) throw new Error('say why it is being deleted: that sentence is the whole record of it')
  const path = req.path.trim()
  const found = (await documentsOf(deps)).find((one) => one.task === req.task && one.path === path)
  if (!found) {
    throw new Error(
      `${path || '(no path)'} is not a document ${req.task} produced: tade_documents says which there are`,
    )
  }
  if (found.state === 'deleted' || found.state === 'gone') {
    throw new Error(
      `${req.task}'s ${path} is already gone: ${found.deleted?.why ?? 'removed with its task'}`,
    )
  }
  const folder = [taskDocumentsDir(deps.home, req.task), taskDir(deps.home, req.task)].find((dir) =>
    within(dir, path),
  )
  if (!folder)
    throw new Error(`${path} is not in ${req.task}'s documents folder, so Tade will not delete it`)
  await rm(path, { force: true })
  await pruneEmpty(dirname(path), folder)
  const at = (deps.now?.() ?? new Date()).toISOString()
  const by = req.by ?? 'unknown'
  await deps.log.append({
    type: 'document_deleted',
    task: req.task,
    detail: { path, by, explained: why },
  })
  return { ...found, state: 'deleted', removedAt: at, deleted: { by, why, at } }
}

export interface CleanupRequest {
  keepDays: number
  /** Delete them; otherwise only say which would go. */
  apply: boolean
  by?: string
}

/**
 * What the cleanup may take (`documentsToCompact`), and — only when `apply` —
 * take it, one `document_deleted` each with the sentence that allowed it.
 * Never an undecided document: there is no request that widens this.
 */
export async function cleanupDocuments(
  deps: DocumentHome,
  req: CleanupRequest,
): Promise<Compactable[]> {
  const now = (deps.now?.() ?? new Date()).getTime()
  const taken = documentsToCompact(
    await deps.log.read({ types: [...DOCUMENT_EVENTS] }),
    now,
    req.keepDays * 86_400_000,
  )
  if (!req.apply) return taken
  for (const { document, because } of taken) {
    await deleteDocument(deps, {
      task: document.task,
      path: document.path,
      why: `cleaned up: ${because}`,
      by: req.by ?? 'cleanup',
    })
  }
  return taken
}

/**
 * The document a task produces, wherever it is: the documents folder, or the
 * task's own where an agent told under the old rule wrote it. Null where the
 * task names none.
 */
export async function documentOf(home: string, task: string): Promise<string | null> {
  const named = (await readTaskFile(home, task))?.produces?.trim()
  if (!named || producesProblem(named)) return null
  const here = producesPath(home, task, named)
  const before = join(taskDir(home, task), named)
  return (await isFile(here)) || !(await isFile(before)) ? here : before
}

/**
 * A project's documents folder, for an agent to be told about — or null while
 * no task there has produced one, so an agent is not sent to read an empty
 * folder.
 */
export function documentsFolder(home: string, project: string): string | null {
  const dir = documentsDir(home, project)
  return existsSync(dir) ? dir : null
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(
    (found) => found.isFile(),
    () => false,
  )
}

/** Whether `path` is inside `dir`, by the names alone. */
function within(dir: string, path: string): boolean {
  const inside = relative(resolve(dir), resolve(path))
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
}

/** Take away the folders a deletion left empty, up to and including the task's documents folder. */
async function pruneEmpty(from: string, folder: string): Promise<void> {
  // Never above it, and only the documents folder's own: a task's own folder
  // still has its task file in it, so `rmdir` refuses there by itself.
  let dir = from
  while (within(folder, dir) || resolve(dir) === resolve(folder)) {
    const gone = await rmdir(dir).then(
      () => true,
      () => false,
    )
    if (!gone || resolve(dir) === resolve(folder)) return
    dir = dirname(dir)
  }
}
