import { existsSync } from 'node:fs'
import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { TaskId } from '@tade/core'
import { firstSaidIn, type HarnessSession, ifMissing, SESSIONS_LISTED } from '@tade/harnesses-core'
import { folderFor, historyLine, sessionFolder, sessionIdFor } from './record.ts'

// The sessions Grok keeps for a folder, and carrying one of them into a task's
// conversation.
//
// Grok files a working directory's sessions together, a folder each named by
// the session's id, under the directory's path URL-encoded
// (`/Users/me/work` → `%2FUsers%2Fme%2Fwork`). A task's is found by its id
// wherever it is; a folder's are found under that encoding of its path, both
// as given and as resolved — so an encoding this got wrong is a folder with
// nothing listed, never one with somebody else's sessions in it.

/** A session's folder name: a UUID, which is all Grok names one. */
const SESSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The folders Grok may file `cwd`'s sessions in: its path as given and as resolved. */
export async function foldersFor(cwd: string, home: string): Promise<string[]> {
  const real = await realpath(cwd).catch(ifMissing(cwd))
  return [...new Set([real, cwd])].map((path) => join(home, 'sessions', encodeURIComponent(path)))
}

/**
 * The sessions Grok keeps for `cwd`, newest first, with each of `tasks` whose
 * session is one of them named on it. A task's is found wherever it was filed;
 * one nothing was ever said in is left out unless it is a task's, because
 * there is nothing in it to pick up.
 */
export async function sessionsIn(
  cwd: string,
  home: string,
  tasks: readonly TaskId[],
): Promise<HarnessSession[]> {
  const ids = new Map(tasks.map((task) => [sessionIdFor(task), task]))
  const found = new Map<string, string>()
  for (const folder of await foldersFor(cwd, home)) {
    for (const name of await readdir(folder).catch(ifMissing([] as string[]))) {
      if (SESSION.test(name)) found.set(name, join(folder, name))
    }
  }
  for (const [id, task] of ids) {
    if (found.has(id)) continue
    const folder = await folderFor(task, home)
    if (folder) found.set(id, folder)
  }
  const sessions = await Promise.all(
    [...found].map(async ([id, folder]): Promise<HarnessSession | null> => {
      const record = join(folder, 'updates.jsonl')
      const said = await stat(record).catch(ifMissing(null))
      if (!said) return null
      const task = ids.get(id) ?? null
      const first = await firstSaidIn(record, historyLine)
      if (first === null || (first === '' && !task)) return null
      return { id, at: said.mtimeMs, first, task }
    }),
  )
  return sessions
    .filter((one) => one !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, SESSIONS_LISTED)
}

/** The files of a session that name it by its id: everything Grok wrote as text. */
const TEXT = /\.(jsonl?|txt|md|toml)$/

/**
 * A session's folder copied to `to` under another id: every text file in it
 * says the new one where it said the old, since a copy still naming the old
 * one is a session Grok would know by two ids. Written beside and then put in
 * place, so a launch never finds half of one.
 */
export async function copySession(
  from: string,
  to: string,
  was: string,
  now: string,
): Promise<void> {
  const writing = `${to}.carrying`
  await rm(writing, { recursive: true, force: true })
  await cp(from, writing, { recursive: true, force: true })
  if (was !== now) {
    for (const entry of await readdir(writing, { recursive: true })) {
      const file = join(writing, String(entry))
      if (!TEXT.test(file) || !(await stat(file)).isFile()) continue
      const text = await readFile(file, 'utf8')
      if (text.includes(was)) await writeFile(file, text.replaceAll(was, now), { mode: 0o600 })
    }
  }
  await rename(writing, to)
}

/**
 * Carry one of `cwd`'s sessions into a task's, so the task's agent comes back
 * to it: a copy under the task's session id, in the same folder, so the
 * session it came from is left exactly as it was, for whoever had it. A task
 * that already has a session is never written over: that would end it.
 */
export async function carryInto(
  session: string,
  task: string,
  cwd: string,
  home: string,
): Promise<boolean> {
  if (!SESSION.test(session)) return false
  let from: string | null = null
  for (const folder of await foldersFor(cwd, home)) {
    if (existsSync(join(folder, session, 'updates.jsonl'))) {
      from = join(folder, session)
      break
    }
  }
  if (!from) return false
  if (await folderFor(task, home)) {
    throw new Error(`${task} already has a conversation of its own, which carrying one would end`)
  }
  const id = sessionIdFor(task)
  await copySession(from, join(from, '..', id), session, id)
  return true
}

/**
 * A task's session copied into another account's folder, where that
 * account's Grok will find it and carry on: the same id, under the same
 * working directory. False where there is nothing to carry.
 */
export async function carryAcross(task: string, from: string, to: string): Promise<boolean> {
  const id = sessionIdFor(task)
  const folder = await sessionFolder(id, from)
  if (!folder) return false
  const where = basename(dirname(folder))
  const parent = join(to, 'sessions', where)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await rm(join(parent, id), { recursive: true, force: true })
  await copySession(folder, join(parent, id), id, id)
  return true
}
