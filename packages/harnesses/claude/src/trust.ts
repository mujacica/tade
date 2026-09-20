import { mkdir, readFile, realpath, rename, rmdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { defaultConfigDir } from './transcript.ts'

// Saying yes, once, to the question Claude Code asks the first time it runs in
// a folder: "do you trust this folder?". Asked in a lane nobody is looking at,
// it holds the agent before it has started — no hook runs until it is
// answered — so an agent Tade started would sit there looking like it was
// thinking. Tade answers it for the folders it starts agents in: a project
// someone added to Tade, and the worktrees Tade made from it.
//
// The answer lives in Claude Code's own state file, which running sessions
// rewrite too. So this takes the lock Claude Code takes, reads the file again
// under it, and replaces it whole — never a write that could land half on top
// of theirs.

/** Claude Code's own state file for an account: beside its config folder when that is the default. */
export function stateFileFor(configDir: string, home = homedir()): string {
  return configDir === defaultConfigDir(home)
    ? join(home, '.claude.json')
    : join(configDir, '.claude.json')
}

/** How long a lock someone else holds is waited on, and when it is old enough to be abandoned. */
const WAIT_MS = 3_000
const STALE_MS = 10_000

async function locked<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      const age = await stat(lock)
        .then((info) => Date.now() - info.mtimeMs)
        .catch(() => 0)
      if (age > STALE_MS) {
        await rmdir(lock).catch(() => {})
        continue
      }
      if (Date.now() > deadline) throw new Error(`${lock} is held by another Claude Code`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  try {
    return await work()
  } finally {
    await rmdir(lock).catch(() => {})
  }
}

/**
 * Mark a folder as one this account trusts, and say whether anything changed.
 * The folder is named as Claude Code names it: its real path.
 */
export async function trustFolder(
  folder: string,
  configDir: string,
  opts: { home?: string; firstRun?: boolean } = {},
): Promise<boolean> {
  const file = stateFileFor(configDir, opts.home)
  const path = await realpath(folder)
  const read = async () => {
    const text = await readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return '{}'
      throw err
    })
    return JSON.parse(text) as {
      projects?: Record<string, Record<string, unknown>>
      hasCompletedOnboarding?: unknown
    }
  }
  const needs = (state: Awaited<ReturnType<typeof read>>) =>
    state.projects?.[path]?.hasTrustDialogAccepted !== true ||
    (opts.firstRun === true && state.hasCompletedOnboarding !== true)
  if (!needs(await read())) return false
  return locked(file, async () => {
    const state = await read()
    if (!needs(state)) return false
    const projects = state.projects ?? {}
    projects[path] = { ...(projects[path] ?? {}), hasTrustDialogAccepted: true }
    const next = {
      ...state,
      projects,
      ...(opts.firstRun ? { hasCompletedOnboarding: true } : {}),
    }
    const mode = await stat(file)
      .then((info) => info.mode & 0o777)
      .catch(() => 0o600)
    const temp = `${file}.tade-${process.pid}`
    await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode })
    await rename(temp, file)
    return true
  })
}
