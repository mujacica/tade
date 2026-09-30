import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CheckRun, CheckState } from '@tade/checks-core'
import { gitEnv, mkrepo } from '../../../../test/fixtures/mkrepo.ts'

// The real repositories the CI watches are asked about, and the real git that
// answers.
//
// **git is real here, and that is the whole point of this file.** The first
// question any of this asks is "what branch is this checkout on, at what
// commit, and is that commit on the remote" — and a scripted `git` would only
// ever answer what the tests already believe: that a detached worktree says
// `HEAD`, that `%H%n%s` is a sha and a subject, that a worktree shares its
// parent's refs. Every one of those was got wrong once by believing it.
//
// The forge is never real, and this file has none: what CI said is the scripted
// forge's or the GitHub replay's, and nothing here reaches the network.
//
// Shared by `commit.test.ts` (what CI can say about a commit, and every honest
// reason it cannot) and `branch.test.ts` (the watch built on that).

export const NOW = Date.parse('2026-09-19T08:00:00Z')

/** Commits the scripted forge is asked about, where no real repository is in it. */
export const RED = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
export const FRESH = '1111111111111111111111111111111111111111'

const run = promisify(execFile)

/** Really run a program, the way the window's own exec does. */
export const reallyExec = async (command: string, args: readonly string[]) => {
  try {
    const got = await run(command, [...args], { env: gitEnv() as NodeJS.ProcessEnv })
    return { code: 0, stdout: got.stdout, stderr: got.stderr }
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string }
    return { code: failed.code ?? 1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' }
  }
}

/**
 * A real repository with a real remote, on `main`, with one commit on it —
 * really pushed unless the test is about a commit that is not.
 *
 * `origin` is fetched from the URL the GitHub forge serves and pushed to a bare
 * repository next door, so the push is a real push writing a real
 * `refs/remotes/origin/*` and nothing reaches the network. A fixture that wrote
 * that ref with `update-ref` would be answering the one question the watch now
 * asks git before anything else, which is the question that was got wrong.
 */
export function project(
  options: {
    branch?: string
    remote?: boolean
    subject?: string
    pushed?: boolean
    /** The URL `origin` is fetched from — an SSH alias, for the account tests. */
    remoteUrl?: string
  } = {},
) {
  const repo = mkrepo({ remote: options.remote !== false })
  if (options.remote !== false) {
    repo.git('remote', 'set-url', 'origin', options.remoteUrl ?? 'git@github.com:acme/api.git')
    repo.git('remote', 'set-url', '--push', 'origin', repo.remote ?? '')
  }
  if (options.branch && options.branch !== 'main') {
    repo.git('checkout', '-q', '-b', options.branch)
  }
  repo.commit(options.subject ?? 'retry refunds once')
  if (options.remote !== false && options.pushed !== false) {
    repo.git('push', '-q', 'origin', options.branch ?? 'main')
  }
  return { repo, commit: repo.git('rev-parse', 'HEAD').trim() }
}

/**
 * A worktree of a project, on a branch of its own, with a commit of its own —
 * and really pushed unless the test is about one that is not.
 *
 * This is `worktree` mode as an agent leaves it: the project's own checkout is
 * still on the branch it was, at the commit it was, and the work is on
 * `tade/<name>` in a directory of its own.
 */
export function worktree(
  repo: ReturnType<typeof mkrepo>,
  name: string,
  options: { pushed?: boolean; subject?: string } = {},
) {
  const path = repo.addTask(name, { project: 'api' })
  const commit = repo.commit(options.subject ?? 'retry refunds twice', undefined, path)
  if (options.pushed !== false) repo.git('push', '-q', 'origin', `tade/${name}`)
  return { path, branch: `tade/${name}`, commit }
}

/** One run of one check, as the scripted forge answers about a commit. */
export const ran = (commit: string, check: string, state: CheckState): CheckRun => ({
  id: `${commit}:${check}:scripted:1`,
  check,
  commit,
  state,
  where: { kind: 'forge', forge: 'scripted', job: check, url: null },
  required: true,
  startedAt: '2026-09-19T07:00:00.000Z',
  finishedAt: state === 'running' || state === 'queued' ? null : '2026-09-19T07:04:00.000Z',
  code: null,
  summary: state === 'failed' ? '8 failed' : null,
  by: null,
})
