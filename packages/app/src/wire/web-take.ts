import { expandHome, runProgram } from '@tade/core'
import type { Take, TakeAnswer, WebTaking } from '@tade/web'
import { guardName, TASK_BRANCH_PREFIX } from '@tade/workbench/tasks'
import { type Wiring, why } from './context.ts'

// This machine's half of work another machine of the person's hands it
// (`@tade/web`'s `taken.ts`, REMOTE-TADE.md §9.2): made queued work in one of
// this machine's projects, through the workbench's one write path for a task,
// which this window's queue then starts by its own rule — as if it had been
// planned at this keyboard, and by the person (`by: you`), because the person
// pressed for it on their other machine.
//
// **Where it begins is fetched with this machine's own credentials.** Work
// already under way arrives as a branch on the project's `origin` and the
// commit the other machine saw pushed; this window fetches that branch into
// `refs/remotes/origin/` — git's own place for it, nothing in the working tree
// moves — checks the commit is there, and makes the task a worktree that
// begins on it (`start.from`, `beginFrom`), so the agent here picks up the
// branch where the one there left it. Its branch here is this machine's own
// name for the task (`tade/<name>`), the name the other machine pushed under,
// so a push from here carries the same branch on. A dry-run push says whether
// it could push there too: a machine that cannot is said, never refused.
//
// **Every git here has a deadline and never asks**, because the window draws
// on the thread that would wait: `GIT_TERMINAL_PROMPT=0`, and a child run
// detached has no terminal for ssh to ask on, so a credential nobody can type
// is a failure in git's words rather than a hang. The person's own
// `core.sshCommand` is left as it is — it is often what names this machine's
// key.

/**
 * How long fetching the branch may take, and the dry-run push and the small
 * looks: all of it inside the one call the other machine makes (`CALL_MS`, a
 * minute), so it is answered rather than given up on there while it goes on here.
 */
const FETCH_MS = 30_000
const LOOK_MS = 10_000

/** What git is run with: the window's own environment, and nothing that asks. */
function quiet(): Record<string, string | undefined> {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' }
}

async function git(root: string, args: readonly string[], ms = LOOK_MS) {
  return runProgram('git', ['-C', root, ...args], { timeoutMs: ms, env: quiet() })
}

/** git's last word on why, on one line. */
function gitSaid(ran: { stderr: string; stdout: string; timedOut: boolean }, ms: number): string {
  if (ran.timedOut) return `it did not answer within ${ms / 1000}s`
  const lines = `${ran.stderr}\n${ran.stdout}`.split('\n').map((line) => line.trim())
  return lines.filter((line) => line !== '').at(-1) ?? 'git said nothing'
}

function no(said: string): TakeAnswer {
  return { took: false, said }
}

/** Why a name could not be a new task here, or null where it could. */
async function nameRefused(wire: Wiring, id: string): Promise<string | null> {
  const client = wire.opts.client
  try {
    await guardName(
      { keyOf: client.keyOf(), created: () => client.log.read({ types: ['task_created'] }) },
      id,
    )
    return null
  } catch (err) {
    return why(err)
  }
}

/**
 * The answer to a hand-over this machine made already, or null where it made
 * none: what it made is `task_taken` with that hand-over's id.
 */
async function takenBefore(wire: Wiring, id: string, handOver: string): Promise<TakeAnswer | null> {
  let made: boolean
  try {
    const lines = await wire.opts.client.log.read({ task: id, types: ['task_taken'] })
    made = lines.some((line) => line.detail.handOver === handOver)
  } catch (err) {
    return no(`Whether ${id} was taken here before could not be read (${why(err)}).`)
  }
  if (!made) return null
  return {
    took: true,
    task: id,
    said: `${id} was taken here already.`,
    pushes: null,
    already: true,
  }
}

/** The window's `WebTaking`. */
export function takingFrom(wire: Wiring): WebTaking {
  return async (take, device) => {
    const id = `${take.project}/${take.name}`
    const projects = wire.opts.config.projects
    // `hasOwn`: `projects.__proto__` is truthy on any plain object.
    const configured = Object.hasOwn(projects, take.project) ? projects[take.project] : undefined
    if (configured === undefined) return no(`There is no project called ${take.project} here.`)
    const root = expandHome(configured.root)
    // The same hand-over asked again, by a window there that closed before it
    // heard the answer: the same answer, not a no for a name used.
    if (take.handOver !== undefined) {
      const before = await takenBefore(wire, id, take.handOver)
      if (before !== null) return before
    }
    const named = await nameRefused(wire, id)
    if (named !== null) return no(`${named}.`)
    const branch = `${TASK_BRANCH_PREFIX}${take.name}`
    if (take.begins) {
      const there = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      if (there.code === 0) {
        return no(
          `${take.project} here already has a branch called ${branch}, so ${id} cannot begin on one of its own: choose another name.`,
        )
      }
    }
    if (take.check) return { took: true, task: id, said: `${id} can be taken here.`, pushes: null }
    const begun = take.begins ? await begin(root, take.begins) : null
    if (begun !== null && 'refused' in begun) return no(begun.refused)
    try {
      await wire.opts.client.createTask({
        project: take.project,
        slug: take.name,
        intent: take.intent,
        ...(take.context.trim() === '' ? {} : { context: take.context }),
        ...(take.links.length > 0 ? { links: take.links } : {}),
        by: 'you',
        ...(take.done ? { done: take.done } : {}),
        // A branch to begin on is a worktree of its own here, whatever the
        // project's own answer: in a shared checkout `start.from` means nothing.
        ...(take.begins ? { workspace: 'worktree' as const } : {}),
        start: {
          after: [],
          prompt: take.prompt,
          touches: [],
          ...(take.at ? { at: take.at } : {}),
          ...(take.begins ? { from: take.begins.head } : {}),
        },
      })
    } catch (err) {
      return no(`${id} could not be made here: ${why(err)}.`)
    }
    await wire.opts.client.log.append({
      type: 'task_taken',
      task: id,
      detail: {
        from: take.from,
        was: take.was,
        device,
        ...(take.begins ? { branch: take.begins.branch, head: take.begins.head } : {}),
        ...(take.handOver === undefined ? {} : { handOver: take.handOver }),
      },
    })
    // The next look starts it, by the queue's own rule.
    void wire.live?.refresh()
    const pushes = begun === null ? null : begun.pushes
    return {
      took: true,
      task: id,
      said: saidOf(take, id, begun),
      pushes,
    }
  }
}

type Begun = { pushes: boolean; said: string } | { refused: string }

/** The branch fetched from origin with this machine's own credentials, and whether it could push it. */
async function begin(root: string, begins: NonNullable<Take['begins']>): Promise<Begun> {
  const { branch, head } = begins
  const fetched = await git(
    root,
    [
      'fetch',
      '--quiet',
      '--no-tags',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    FETCH_MS,
  )
  if (fetched.code !== 0) {
    return {
      refused: `This machine could not fetch ${branch} from its origin with its own credentials: ${gitSaid(fetched, FETCH_MS)}. It fetches and pushes with a key of its own, never the other machine's.`,
    }
  }
  const has = await git(root, ['cat-file', '-e', `${head}^{commit}`])
  if (has.code !== 0) {
    return {
      refused: `${branch} on origin does not have ${head.slice(0, 12)}, the commit it was pushed at: it was pushed again since, or never reached origin.`,
    }
  }
  const dry = await git(root, [
    'push',
    '--dry-run',
    '--no-verify',
    '--porcelain',
    'origin',
    `${head}:refs/heads/${branch}`,
  ])
  return dry.code === 0
    ? { pushes: true, said: '' }
    : {
        pushes: false,
        said: `This machine could not push to ${branch} with its own credentials (${gitSaid(dry, LOOK_MS)}), so its agent will not be able to push its work until it can: give it a key of its own.`,
      }
}

function saidOf(take: Take, id: string, begun: Begun | null): string {
  const starts = take.at ? `starts here at ${take.at}` : 'starts here as soon as there is room'
  if (begun === null || 'refused' in begun) return `${id} is queued and ${starts}.`
  const from = `on ${take.begins?.branch} at ${take.begins?.head.slice(0, 12)}`
  return [`${id} is queued ${from} and ${starts}.`, begun.said].filter(Boolean).join(' ')
}
