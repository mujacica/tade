import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskId } from '@tade/core'
import {
  firstSaidIn,
  type HarnessSession,
  ifMissing,
  jsonOf,
  SESSIONS_LISTED,
} from '@tade/harnesses-core'
import { historyLine, rememberThread, rolloutFor, threadOf } from './sessions.ts'

// The threads Codex keeps for a folder, and carrying one of them into a task's
// conversation.
//
// Codex files every thread by the day it started, whatever folder it ran in,
// and says which folder in the thread's first line (`session_meta`). So a
// folder's threads are found by reading first lines, newest day first, and
// the reading stops at a bound: a machine with years of threads costs the
// newest of them, never all.

/** How many threads' first lines are read looking for a folder's, newest first. */
const LOOKED_AT = 400

/** How far into a thread its first line is looked for: Codex puts its instructions in it. */
const META = 64 * 1024

/** A thread's id and folder, out of its first line; null where that is not a `session_meta`. */
async function metaOf(file: string): Promise<{ id: string; cwd: string } | null> {
  const handle = await open(file, 'r').catch(ifMissing(null))
  if (!handle) return null
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.allocUnsafe(META), 0, META, 0)
    const entry = jsonOf(buffer.toString('utf8', 0, bytesRead).split('\n')[0] ?? '') as {
      type?: unknown
      payload?: Record<string, unknown>
    } | null
    const { id, cwd } = entry?.payload ?? {}
    if (entry?.type !== 'session_meta' || typeof id !== 'string' || typeof cwd !== 'string') {
      return null
    }
    return { id, cwd }
  } finally {
    await handle.close()
  }
}

/** A folder's entries, newest first by name — which is by when, since Codex names them so. */
async function newestFirst(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(ifMissing([] as string[]))
  return names.sort().reverse()
}

/**
 * The threads Codex keeps for `cwd`, newest first, with each of `tasks` whose
 * thread is one of them named on it. A task's thread is the one Tade wrote
 * down for it (`threadOf`), found wherever Codex filed it.
 */
export async function threadsIn(
  cwd: string,
  codexHome: string,
  stateDir: string,
  tasks: readonly TaskId[],
): Promise<HarnessSession[]> {
  const real = await realpath(cwd).catch(ifMissing(cwd))
  const owned = new Map<string, TaskId>()
  for (const task of tasks) {
    const thread = await threadOf(task, stateDir)
    if (thread) owned.set(thread, task)
  }
  const files = new Map<string, string>()
  const root = join(codexHome, 'sessions')
  let looked = 0
  walk: for (const year of await newestFirst(root)) {
    for (const month of await newestFirst(join(root, year))) {
      for (const day of await newestFirst(join(root, year, month))) {
        const dir = join(root, year, month, day)
        for (const name of await newestFirst(dir)) {
          if (!name.endsWith('.jsonl')) continue
          if (++looked > LOOKED_AT || files.size >= SESSIONS_LISTED) break walk
          const file = join(dir, name)
          const meta = await metaOf(file)
          if (meta && (meta.cwd === real || meta.cwd === cwd)) files.set(meta.id, file)
        }
      }
    }
  }
  for (const thread of owned.keys()) {
    if (files.has(thread)) continue
    const file = await rolloutFor(thread, codexHome)
    if (file) files.set(thread, file)
  }
  const found = await Promise.all(
    [...files].map(async ([id, file]): Promise<HarnessSession | null> => {
      const task = owned.get(id) ?? null
      const [said, first] = await Promise.all([
        stat(file).catch(ifMissing(null)),
        firstSaidIn(file, historyLine),
      ])
      if (!said || first === null || (first === '' && !task)) return null
      return { id, at: said.mtimeMs, first, task }
    }),
  )
  return found.filter((one) => one !== null).sort((a, b) => b.at - a.at)
}

/**
 * Have a task's agent carry on one of `cwd`'s threads. Codex makes a thread's
 * id itself and takes no other, so carrying one is writing it down as the
 * task's (`rememberThread`): its next launch resumes that very thread, which
 * goes on in the file it is in. A task that already has a thread is never
 * pointed elsewhere, which would leave its own behind.
 */
export async function carryThread(
  thread: string,
  task: TaskId,
  cwd: string,
  codexHome: string,
  stateDir: string,
): Promise<boolean> {
  const file = await rolloutFor(thread, codexHome)
  const meta = file ? await metaOf(file) : null
  const real = await realpath(cwd).catch(ifMissing(cwd))
  if (!meta || meta.id !== thread || (meta.cwd !== real && meta.cwd !== cwd)) return false
  if (await threadOf(task, stateDir)) {
    throw new Error(`${task} already has a conversation of its own, which carrying one would end`)
  }
  await rememberThread(task, stateDir, thread)
  return true
}
