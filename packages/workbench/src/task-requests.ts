import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StartCondition, taskRequestsSpool } from '@tade/core'
import type { TaskWorktree } from './tasks.ts'
import type { CreateTaskRequest } from './workbench.ts'

// A task asked for from a terminal while a window holds the home: `tade task
// create` on a server whose `tade serve` is running, which is the only shell
// there is on a machine nobody sits at.
//
// **One writer numbers the journal**, as `config-changes.ts` says at length:
// `seq` is counted in the memory of whoever holds the home, and making a task
// is a `task_created` line — the one the name guard, the history, the queue
// and the briefing all read. So the terminal does not make it. It writes what
// it was asked into a spool under the home, and the window makes it on its
// next beat (`takeTaskRequests`), through the same `createTask` the terminal
// would have called, and writes the answer beside it for the terminal to print.
//
// **This is the door a task file with `start` already is**, and no wider: the
// queue starts such a file by rule whoever wrote it, which is how work was
// given to a served machine before this. What comes in this way is exactly
// what `tade task create` takes on the command line — a project, a name, the
// words, a root, and whether to start it — made as `by: 'you'`, as that
// command makes it with no window open. Nothing else in a request is read.
//
// **A request is claimed by renaming it**, so two beats never make one twice,
// and a terminal that gave up waiting takes its request back by removing it —
// whichever happens first is what happened.

/** What a terminal asks for: what `tade task create` takes, and nothing more. */
export interface TaskRequest {
  project: string
  slug: string
  intent: string
  root?: string
  /** Made as queued work that is ready now, told its own intent: the queue starts it by rule. */
  start?: boolean
}

/** What the window answers: the task it made, or why it made none. */
export type TaskAnswer = ({ ok: true } & TaskWorktree) | { ok: false; error: string }

/** What one take did, and what stopped it reading the spool, if anything did. */
export interface Taken {
  taken: number
  trouble: string | null
}

/** An answer nobody came back for is taken away after this long. */
const ANSWER_KEPT_MS = 60 * 60_000

const REQUEST = '.json'
const ANSWER = '.answer.json'
const TAKING = '.taking'

/** Into the spool, whole or not at all; the id to wait on its answer by. */
export async function requestTask(home: string, request: TaskRequest): Promise<string> {
  const dir = taskRequestsSpool(home)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const id = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`
  await whole(join(dir, `${id}${REQUEST}`), request)
  return id
}

/** The window's answer to request `id`, taken away once read; null while there is none. */
export async function answerFor(home: string, id: string): Promise<TaskAnswer | null> {
  const file = join(taskRequestsSpool(home), `${id}${ANSWER}`)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  await rm(file, { force: true })
  return answerFrom(text)
}

/**
 * Take request `id` back before a window has claimed it: true where it was
 * still waiting, and is gone now; false where a window has it, and will answer.
 */
export async function withdrawTask(home: string, id: string): Promise<boolean> {
  try {
    await rm(join(taskRequestsSpool(home), `${id}${REQUEST}`))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** How long a window is given to take a request, and then to make the task it asks for. */
export interface Waiting {
  /** A window beats every two seconds; one that has not taken it by this is not taking it. */
  takeMs: number
  /** Making one can prepare a worktree, which can run the project's install. */
  makeMs: number
  /** Between looks for the answer. */
  everyMs: number
}

export const WAITING: Waiting = { takeMs: 30_000, makeMs: 10 * 60_000, everyMs: 250 }

/**
 * What came of request `id`: the window's answer; `'untaken'` where no window
 * took it in time, so it was taken back and nothing was made; or `'making'`
 * where one took it and has not answered in time, so it may yet be made.
 */
export async function awaitTask(
  home: string,
  id: string,
  waiting: Waiting = WAITING,
): Promise<TaskAnswer | 'untaken' | 'making'> {
  let until = Date.now() + waiting.takeMs
  let taken = false
  for (;;) {
    const answer = await answerFor(home, id)
    if (answer) return answer
    if (Date.now() >= until) {
      if (taken) return 'making'
      if (await withdrawTask(home, id)) return 'untaken'
      taken = true
      until = Date.now() + waiting.makeMs
      continue
    }
    await new Promise((resolve) => setTimeout(resolve, waiting.everyMs))
  }
}

/**
 * Make every task a terminal asked for, oldest first, by `create` — the
 * workbench's own, held by whoever holds the journal — and answer each. Never
 * throws: what stopped it is handed back. A spool that is not there is nothing
 * to take, and costs one look at a directory.
 */
export async function takeTaskRequests(
  home: string,
  create: (request: CreateTaskRequest) => Promise<TaskWorktree>,
  now: number = Date.now(),
): Promise<Taken> {
  const dir = taskRequestsSpool(home)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { taken: 0, trouble: null }
    return { taken: 0, trouble: `could not read ${dir}: ${String(err)}` }
  }
  let taken = 0
  for (const name of names.filter(waiting).sort()) {
    const id = name.slice(0, -REQUEST.length)
    const file = join(dir, name)
    const claimed = `${file}${TAKING}`
    try {
      await rename(file, claimed)
    } catch (err) {
      // Withdrawn by the terminal that wrote it, a moment ago.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      return { taken, trouble: `could not take ${file}: ${String(err)}` }
    }
    // Whatever stops it being made is the terminal's answer: it is waiting to say it.
    let answer: TaskAnswer
    try {
      const request = requestFrom(await readFile(claimed, 'utf8'))
      answer =
        typeof request === 'string'
          ? { ok: false, error: `${file} is not a task request Tade wrote (${request})` }
          : { ok: true, ...(await create(taskCreated(request))) }
    } catch (err) {
      answer = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    try {
      await whole(join(dir, `${id}${ANSWER}`), answer)
      await rm(claimed, { force: true })
    } catch (err) {
      return { taken, trouble: `could not answer ${file}: ${String(err)}` }
    }
    taken += 1
  }
  for (const name of names.filter((n) => n.endsWith(ANSWER))) {
    const file = join(dir, name)
    try {
      if (now - (await stat(file)).mtimeMs > ANSWER_KEPT_MS) await rm(file, { force: true })
    } catch (err) {
      // Read by the terminal it was for, since the look: what was to be taken away is gone.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      return { taken, trouble: `could not take away ${file}: ${String(err)}` }
    }
  }
  return { taken, trouble: null }
}

/**
 * What the workbench is asked for a request: by `tade task create` itself
 * where it holds the home, and by the window that does where it does not, so
 * the two can never make different tasks of the same words.
 */
export function taskCreated(request: TaskRequest): CreateTaskRequest {
  return {
    project: request.project,
    slug: request.slug,
    intent: request.intent,
    ...(request.root ? { root: request.root } : {}),
    ...(request.start ? { start: StartCondition.parse({ prompt: request.intent }) } : {}),
    by: 'you',
  }
}

/** A finished request: never one being written, claimed or answered. */
function waiting(name: string): boolean {
  return !name.startsWith('.') && name.endsWith(REQUEST) && !name.endsWith(ANSWER)
}

/** Written beside its name and renamed over it, so a reader reads all of it or none. */
async function whole(file: string, value: unknown): Promise<void> {
  const draft = join(file, '..', `.${randomUUID()}.draft`)
  await writeFile(draft, JSON.stringify(value), { mode: 0o600 })
  await rename(draft, file)
}

/** The request a spool file holds, or why it is not one Tade wrote. */
function requestFrom(text: string): TaskRequest | string {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    return `not JSON: ${err instanceof Error ? err.message : String(err)}`
  }
  const shape = 'not the shape Tade writes'
  if (parsed === null || typeof parsed !== 'object') return shape
  const { project, slug, intent, root, start } = parsed as Record<string, unknown>
  if (typeof project !== 'string' || typeof slug !== 'string' || typeof intent !== 'string') {
    return shape
  }
  if (root !== undefined && typeof root !== 'string') return shape
  if (start !== undefined && typeof start !== 'boolean') return shape
  return {
    project,
    slug,
    intent,
    ...(root ? { root } : {}),
    ...(start ? { start: true } : {}),
  }
}

/** The answer a window wrote, or one saying it could not be read. */
function answerFrom(text: string): TaskAnswer {
  let parsed: Partial<TaskAnswer>
  try {
    parsed = JSON.parse(text) as Partial<TaskAnswer>
  } catch (err) {
    return {
      ok: false,
      error: `the window's answer is not JSON: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (parsed?.ok === true && typeof parsed.id === 'string') return parsed as TaskAnswer
  if (parsed?.ok === false && typeof parsed.error === 'string') return parsed as TaskAnswer
  return { ok: false, error: 'the window answered in a shape Tade does not write' }
}
