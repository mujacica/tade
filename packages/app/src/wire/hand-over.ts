import { runProgram } from '@tade/core'
import { CLONE_URL } from '@tade/web'

// A running task handed to another machine of the person's (REMOTE-TADE.md
// §9.2), the parts of it that are git and words: what its agent is told, how
// this window tells that the work is on origin, and what the agent on the
// other machine is told it is carrying on. The flow — asking first, waiting,
// handing over, stopping — is `moves.ts`'s.
//
// **The agent commits and pushes; Tade looks.** What is the agent's to commit
// is the agent's to say — in a shared checkout most of all, where uncommitted
// work is nobody's — so it is told to, and this window only reads whether it
// happened: the branch on origin is where its work is, and nothing it holds is
// left behind. In a worktree that is the branch at the worktree's head with
// nothing uncommitted. In the shared checkout it is the branch in this
// checkout's history with every commit carrying this task's `Tade-Task:`
// trailer on it; what is uncommitted there is nobody's and stays here, and the
// sentence the agent is told says so.
//
// **Pushed with this machine's credentials, fetched with the other's.** The
// agent here pushes as it always does; the machine there fetches the branch
// with its own key (`web-take.ts`), never this one's — the link forwards no
// agent (`NO_AGENT`).

/** How long one look at origin may take. */
const LOOK_MS = 20_000

/** Where the work is, and what it is pushed as. */
export interface HandedFrom {
  task: string
  machine: string
  /** The branch it is pushed to on origin, and begun on there. */
  branch: string
  /** Where its agent works: its worktree, or the project's shared checkout. */
  cwd: string
  workspace: 'checkout' | 'worktree'
}

/** What the agent here is told: commit what is its own, push, and stop starting things. */
export function handSays(from: HandedFrom): string {
  const commit =
    from.workspace === 'checkout'
      ? 'Commit what is yours now — each file by its path, as you always do in this shared checkout; what you leave uncommitted stays here'
      : 'Commit everything you have now'
  return [
    `This task is being handed to the machine called ${from.machine}, where the work carries on from your branch.`,
    `${commit}, then push it with \`git push origin HEAD:refs/heads/${from.branch}\` and say when it is pushed.`,
    `Start nothing new after that: once it is on origin, Tade stops you here, and an agent on ${from.machine} begins on that branch with this task's words and context.`,
    'Your conversation does not move with it.',
  ].join(' ')
}

/** What the agent there is told first: where it begins, and that nothing of the conversation came. */
export function carryOnSays(from: { machine: string; branch: string }): string {
  return [
    `This task was handed to this machine from ${from.machine}, where an agent worked on it and was stopped once its work was committed and pushed to \`${from.branch}\`; your worktree begins there.`,
    'Its conversation did not come with it: read the task’s context file first — what it says under "Handed over" is where things stood — and then carry on.',
    `Push your work with \`git push origin HEAD:refs/heads/${from.branch}\`, so the same branch carries on.`,
  ].join(' ')
}

/** What is added to the context file there: where things stood, and what the first agent was told. */
export function handedNote(from: {
  machine: string
  task: string
  branch: string
  head: string
  told: string
}): string {
  const told = from.told.trim()
  return [
    '## Handed over',
    '',
    `From ${from.machine}, where this was ${from.task}. Its agent there committed and pushed its work to \`${from.branch}\` at \`${from.head.slice(0, 12)}\` and was stopped; its conversation stayed there.`,
    ...(told === ''
      ? []
      : [
          '',
          'What that agent was first told:',
          '',
          ...told.split('\n').map((line) => `> ${line}`),
        ]),
  ].join('\n')
}

async function git(cwd: string, args: readonly string[]) {
  return runProgram('git', ['-C', cwd, ...args], {
    timeoutMs: LOOK_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
}

/** git's last line, as the reason a look could not answer. */
function said(ran: { stderr: string; stdout: string; timedOut: boolean }): string {
  if (ran.timedOut) return `git did not answer within ${LOOK_MS / 1000}s`
  const lines = `${ran.stderr}\n${ran.stdout}`.split('\n').map((line) => line.trim())
  return lines.filter((line) => line !== '').at(-1) ?? 'git said nothing'
}

/**
 * Whether the work is on origin, and at which commit: the head to begin on
 * there, or what is not done yet, in a sentence.
 */
export async function pushedTo(from: HandedFrom): Promise<{ head: string } | { not: string }> {
  const remote = await git(from.cwd, [
    'ls-remote',
    '--exit-code',
    'origin',
    `refs/heads/${from.branch}`,
  ])
  // `--exit-code` says 2 for a ref that is not there, which is "not yet".
  if (remote.code === 2) return { not: `nothing is on origin at ${from.branch} yet` }
  if (remote.code !== 0) return { not: `origin could not be asked: ${said(remote)}` }
  const head = remote.stdout.trim().split(/\s+/)[0] ?? ''
  if (!/^[0-9a-f]{40,64}$/.test(head))
    return { not: `origin answered ${from.branch} with no commit` }
  if (from.workspace === 'worktree') {
    const here = await git(from.cwd, ['rev-parse', 'HEAD'])
    if (here.code !== 0) return { not: `its worktree has no head to read: ${said(here)}` }
    if (here.stdout.trim() !== head) {
      return {
        not: `origin has ${from.branch} at ${head.slice(0, 12)}, and its worktree is at ${here.stdout.trim().slice(0, 12)}`,
      }
    }
    const status = await git(from.cwd, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=normal',
    ])
    if (status.code !== 0) return { not: `its worktree could not be read: ${said(status)}` }
    if (status.stdout !== '') return { not: 'its worktree has changes it has not committed' }
    return { head }
  }
  // The shared checkout: on origin, in this history, and every commit of its own on it.
  const ours = await git(from.cwd, ['merge-base', '--is-ancestor', head, 'HEAD'])
  if (ours.code !== 0) {
    return {
      not: `${from.branch} on origin is not this checkout's history: it was pushed from somewhere else`,
    }
  }
  const missing = await git(from.cwd, [
    'log',
    '--format=%H',
    '--fixed-strings',
    `--grep=Tade-Task: ${from.task}`,
    `${head}..HEAD`,
  ])
  if (missing.code !== 0) return { not: `its commits could not be read: ${said(missing)}` }
  const left = missing.stdout.split('\n').filter((line) => line.trim() !== '').length
  if (left > 0) {
    return {
      not: `${left} of its commits ${left === 1 ? 'is' : 'are'} not on ${from.branch} on origin yet`,
    }
  }
  return { head }
}

/** The branch a worktree is on, or null where it is on none. */
export async function branchAt(cwd: string): Promise<string | null> {
  const on = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  return on.code === 0 && on.stdout.trim() !== '' ? on.stdout.trim() : null
}

/**
 * The URL another machine clones this checkout's repository from: its
 * `origin`, with any credential in it taken out — a token in an https remote
 * is this machine's, and the other clones with its own — or null where there
 * is none, or it is not one another machine could clone from (`CLONE_URL`).
 */
export async function cloneUrlAt(root: string): Promise<string | null> {
  const got = await git(root, ['remote', 'get-url', 'origin'])
  if (got.code !== 0) return null
  const url = withoutCredential(got.stdout.trim())
  return CLONE_URL.test(url) ? url : null
}

/** A remote URL with the user and password of an https or ssh URL taken out; `git@host:path` as it is. */
export function withoutCredential(url: string): string {
  if (!/^(?:https|ssh):\/\//.test(url)) return url
  // Not a URL `URL` reads is answered as nothing a clone could use.
  if (!URL.canParse(url)) return ''
  const parsed = new URL(url)
  // ssh's user is who to log in as, not a secret; https's is a token's place.
  if (parsed.protocol === 'https:') parsed.username = ''
  parsed.password = ''
  return parsed.toString()
}

/** The project half of a task's id. */
export function projectOf(task: string): string {
  return task.slice(0, Math.max(0, task.indexOf('/')))
}
