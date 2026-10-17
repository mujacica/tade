import { existsSync } from 'node:fs'
import { cp, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { TaskId } from '@tade/core'
import { firstSaidIn, type HarnessSession, ifMissing, newestIn } from '@tade/harnesses-core'
import { historyLine, sessionIdFor, transcriptFor } from './transcript.ts'

// The conversations Claude Code keeps for a folder, and carrying one of them
// into a conversation of Tade's.
//
// Claude Code files a working directory's conversations together, one JSONL
// file each named by its session id (`transcript.ts`). A task's is found by
// its name wherever it is; a folder's are found by the folder Claude Code
// files them in, which is its own encoding of the path — so that is only ever
// a place to look, and a folder it encodes some other way is one with nothing
// listed rather than one with somebody else's conversations in it.

/** A session's file: a UUID, which is all Claude Code names one. Its subagents' are inside a folder beside it. */
const SESSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/

/**
 * Where Claude Code files the conversations it has in `cwd`: the resolved
 * path with everything that is not a letter or a digit a dash
 * (`/Users/me/.tade` → `-Users-me--tade`), as its own folder names on this
 * machine read.
 */
export async function folderFor(cwd: string, configDir: string): Promise<string> {
  const real = await realpath(cwd).catch(ifMissing(cwd))
  return join(configDir, 'projects', real.replace(/[^a-zA-Z0-9]/g, '-'))
}

/**
 * The conversations Claude Code keeps for `cwd`, newest first, with each of
 * `tasks` whose conversation is one of them named on it. A task's is found
 * wherever it was filed, so a closed chat is never missed for an encoding
 * this got wrong; one nothing was ever said in is left out unless it is a
 * task's, because there is nothing in it to pick up.
 */
export async function sessionsIn(
  cwd: string,
  configDir: string,
  tasks: readonly TaskId[],
): Promise<HarnessSession[]> {
  const ids = new Map(tasks.map((task) => [sessionIdFor(task), task]))
  const files = await newestIn(await folderFor(cwd, configDir), (name) => SESSION_FILE.test(name))
  const listed = new Set(files.map((one) => one.name))
  for (const [id, task] of ids) {
    if (listed.has(`${id}.jsonl`)) continue
    const file = await transcriptFor(task, configDir)
    const said = file ? await stat(file).catch(ifMissing(null)) : null
    if (file && said) files.push({ file, name: basename(file), at: said.mtimeMs })
  }
  const found = await Promise.all(
    files.map(async ({ file, name, at }): Promise<HarnessSession | null> => {
      const id = name.slice(0, -'.jsonl'.length)
      const task = ids.get(id) ?? null
      const first = await firstSaidIn(file, (line) => historyLine(line))
      if (first === null || (first === '' && !task)) return null
      return { id, at, first, task }
    }),
  )
  return found.filter((one) => one !== null).sort((a, b) => b.at - a.at)
}

/**
 * Carry one of `cwd`'s conversations into a task's, so the task's agent comes
 * back to it: a copy under the task's session id, in the same folder, with
 * what it keeps beside it — so the conversation it came from is left exactly
 * as it was, for whoever had it, and the two never write into one file.
 *
 * Every line names its session, and a copy still naming the old one is a
 * conversation Claude Code would list twice under one id, so those are said
 * again. Written whole and then put in place, so a launch never finds half of
 * one. A task that already has a conversation is never written over: that
 * would end it.
 */
export async function carryInto(
  session: string,
  task: string,
  cwd: string,
  configDir: string,
): Promise<boolean> {
  if (!SESSION_FILE.test(`${session}.jsonl`)) return false
  const folder = await folderFor(cwd, configDir)
  const from = join(folder, `${session}.jsonl`)
  if (!existsSync(from)) return false
  const id = sessionIdFor(task)
  if (await transcriptFor(task, configDir)) {
    throw new Error(`${task} already has a conversation of its own, which carrying one would end`)
  }
  const text = await readFile(from, 'utf8')
  const to = join(folder, `${id}.jsonl`)
  const writing = `${to}.carrying`
  await writeFile(writing, text.replaceAll(`"sessionId":"${session}"`, `"sessionId":"${id}"`), {
    mode: 0o600,
  })
  // What the conversation keeps beside it — large tool results, what its
  // subagents said — goes with it, before the file that says it is there.
  const beside = join(dirname(from), session)
  if (existsSync(beside)) await cp(beside, join(folder, id), { recursive: true, force: true })
  await rename(writing, to)
  return true
}
