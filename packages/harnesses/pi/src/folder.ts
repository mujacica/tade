import { open, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { TaskId } from '@tade/core'
import { firstSaidIn, type HarnessSession, ifMissing, jsonOf, newestIn } from '@tade/harnesses-core'
import { historyLine, sessionDirFor, sessionsOf } from './sessions.ts'

// The sessions pi keeps for a folder, and carrying one of them into a task's.
//
// pi files a working directory's sessions together, one JSONL file each named
// `<when it started>_<session id>.jsonl`, whose first line is the session's
// own header (`{type: 'session', id, cwd}`). A task's session is the one named
// after it (`sessionIdFor`), so which task a session is, is read off its name.

/** Where pi files a folder's sessions, and whether every folder's are in it together. */
export interface PiFolder {
  dir: string
  /** The folder as pi says it in a session's header: resolved. */
  cwd: string
  shared: boolean
}

/**
 * Where pi files the sessions it starts in `cwd`: under `root` when a test
 * named one, else wherever pi launched with `env` files them (`sessionsOf`).
 */
export async function folderOf(
  cwd: string,
  root: string | undefined,
  env: NodeJS.ProcessEnv,
): Promise<PiFolder> {
  const real = await realpath(cwd).catch(ifMissing(cwd))
  if (root) return { dir: sessionDirFor(real, root), cwd: real, shared: false }
  return { ...(await sessionsOf(real, env)), cwd: real }
}

/** How far into a session its header is looked for. */
const HEADER = 64 * 1024

/** A session's header (`{type: 'session', id, cwd}`), or null for a file that does not start with one. */
async function headerOf(file: string): Promise<Record<string, unknown> | null> {
  const handle = await open(file, 'r').catch(ifMissing(null))
  if (!handle) return null
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.allocUnsafe(HEADER), 0, HEADER, 0)
    const head = jsonOf(buffer.toString('utf8', 0, bytesRead).split('\n')[0] ?? '')
    return typeof head === 'object' &&
      head !== null &&
      (head as { type?: unknown }).type === 'session'
      ? (head as Record<string, unknown>)
      : null
  } finally {
    await handle.close()
  }
}

/** Whether a session in `at` was started in its folder: every one is, unless every folder's are together. */
async function startedIn(file: string, folder: PiFolder): Promise<boolean> {
  return !folder.shared || (await headerOf(file))?.cwd === folder.cwd
}

/** `<when>_<id>.jsonl` → the id; null for anything else in the folder. */
function idOf(name: string): string | null {
  const at = name.indexOf('_')
  return at > 0 && name.endsWith('.jsonl') ? name.slice(at + 1, -'.jsonl'.length) || null : null
}

/**
 * The sessions pi keeps for a folder (`folderOf`), newest first, with each of `tasks` whose session is one of them named on it
 * (`named` is the session id a task's agent talks in). A task's session is
 * found by `fileOf` wherever it is, so one is never missed for being older
 * than the newest few; one nothing was said in is left out unless it is a
 * task's.
 */
export async function sessionsHere(
  folder: PiFolder,
  tasks: readonly TaskId[],
  named: (task: TaskId) => string,
  fileOf: (task: TaskId) => Promise<string | null>,
): Promise<HarnessSession[]> {
  const ids = new Map(tasks.map((task) => [named(task), task]))
  const files = await newestIn(folder.dir, (name) => idOf(name) !== null)
  const listed = new Set(files.map((one) => idOf(one.name)))
  for (const [id, task] of ids) {
    if (listed.has(id)) continue
    const file = await fileOf(task)
    const said = file ? await stat(file).catch(ifMissing(null)) : null
    if (file && said) files.push({ file, name: basename(file), at: said.mtimeMs })
  }
  const found = await Promise.all(
    files.map(async ({ file, name, at }): Promise<HarnessSession | null> => {
      const id = idOf(name) ?? ''
      const task = ids.get(id) ?? null
      if (!task && !(await startedIn(file, folder))) return null
      const first = await firstSaidIn(file, historyLine)
      if (first === null || (first === '' && !task)) return null
      return { id, at, first, task }
    }),
  )
  return found.filter((one) => one !== null).sort((a, b) => b.at - a.at)
}

/**
 * Carry one of a folder's sessions into a task's: a copy named after the
 * task's session, its header saying so, so the session it came from is left
 * exactly as it was and pi continues the copy at the task's next launch.
 * Written whole and then put in place, so a launch never finds half of one;
 * a task that already has a session is never written over.
 */
export async function carryHere(
  folder: PiFolder,
  session: string,
  into: { task: TaskId; id: string; has: () => Promise<boolean> },
): Promise<boolean> {
  const found = (await newestIn(folder.dir, (name) => idOf(name) === session, 1))[0]
  if (!found || !(await startedIn(found.file, folder))) return false
  if (await into.has()) {
    throw new Error(
      `${into.task} already has a conversation of its own, which carrying one would end`,
    )
  }
  const id = into.id
  const text = await readFile(found.file, 'utf8')
  const cut = text.indexOf('\n')
  const head = JSON.parse(cut < 0 ? text : text.slice(0, cut)) as Record<string, unknown>
  if (head.type !== 'session' || head.id !== session) return false
  const to = join(folder.dir, `${found.name.slice(0, found.name.indexOf('_'))}_${id}.jsonl`)
  const writing = `${to}.carrying`
  await writeFile(writing, `${JSON.stringify({ ...head, id })}${cut < 0 ? '' : text.slice(cut)}`, {
    mode: 0o600,
  })
  await rename(writing, to)
  return true
}
