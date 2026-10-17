import { readFile } from 'node:fs/promises'
import { expandHome, printable, runProgram, type TaskFile } from '@tade/core'
import type { Answer, Remote, RemoteLink } from '@tade/remotes-core'
import { TAKE_CONTEXT_MOST, type Take, type TakeAnswer, TakeAnswerSchema } from '@tade/web'
import { contextDocument, taskContextPath } from '@tade/workbench/tasks'
import { type Wiring, why } from './context.ts'

// What moving a task to another machine reads, asks and does here
// (`moves.ts`): the parts of a `Take` read off the task — its context file
// and links, and where it begins — the asking itself, and the task removed
// here once that machine has it. Beside the flow rather than in it, so
// neither is over its budget.

/** Over the link already up, as this machine's owner there. Throws what to say where it was not taken. */
export async function askThere(
  reach: { link: RemoteLink; remote: Remote },
  machine: string,
  take: Take,
): Promise<TakeAnswer> {
  return answerOf(machine, await call(reach, machine, take))
}

/**
 * A hand-over's take, with its id — asked again without it of a machine too
 * old to read one, whose strict reading refuses a field it does not know as
 * a request that made no sense, having made nothing. Whether the id was read.
 */
export async function askHanding(
  reach: { link: RemoteLink; remote: Remote },
  machine: string,
  take: Take,
): Promise<{ answer: TakeAnswer; readId: boolean }> {
  const { handOver, ...without } = take
  const answer = await call(reach, machine, take)
  if (handOver === undefined || answer.status !== 400) {
    return { answer: answerOf(machine, answer), readId: handOver !== undefined }
  }
  return { answer: await askThere(reach, machine, without), readId: false }
}

/**
 * Over a call of its own rather than the held link's quick request: making
 * the work there may fetch a branch first, which takes longer than a look
 * at a screen is given (`CALL_MS`, against `REQUEST_MS`).
 */
async function call(
  reach: { link: RemoteLink; remote: Remote },
  machine: string,
  take: Take,
): Promise<Answer> {
  let answer: Answer
  try {
    answer = await reach.link.call(reach.remote, '/api/take', take)
  } catch (err) {
    throw new Error(
      `${machine}: ${printable(why(err))} — it may not have been taken there; look at its queue before moving it again`,
    )
  }
  if (answer.status === 404) {
    throw new Error(
      `${machine}'s Tade cannot take work from another machine: it is older than this one. Update it there (tade update), then try again.`,
    )
  }
  return answer
}

/** What that machine answered, read for its shape. Throws what to say where it refused. */
function answerOf(machine: string, answer: Answer): TakeAnswer {
  const read = TakeAnswerSchema.safeParse(answer.body)
  if (answer.status !== 200 || !read.success) {
    const said = (answer.body as { said?: unknown } | null)?.said
    throw new Error(
      `${machine} refused it: ${typeof said === 'string' ? printable(said) : `it answered ${answer.status}`}`,
    )
  }
  return read.data
}

/** Its context file's text, with the links it ends in handed over as links. */
export async function contextOf(
  wire: Wiring,
  task: string,
  file: TaskFile,
): Promise<{ context: string; links: { title: string; url: string }[] }> {
  const links = file.links.map(({ title, url }) => ({ title, url }))
  let text = ''
  try {
    text = await readFile(taskContextPath(wire.opts.home, task), 'utf8')
  } catch (err) {
    // No context file is a task made with nothing to say beyond its words;
    // one that is there and will not read is not that.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`${task}'s context file could not be read: ${why(err)}`)
    }
  }
  // What `contextDocument` wrote is the context and then its links: handed
  // over as two, so the other machine writes the same file rather than the
  // links twice. A file somebody edited since is handed over whole.
  const block = contextDocument('', links)
  const own = block !== '' && text.endsWith(block) ? text.slice(0, -block.length).trim() : text
  if (own.length > TAKE_CONTEXT_MOST) {
    throw new Error(
      `${task}'s context file is ${Math.round(own.length / 1000)} kB, more than one request to another machine carries (${TAKE_CONTEXT_MOST / 1000} kB): shorten it first.`,
    )
  }
  return { context: own, links: block !== '' && own !== text ? links : [] }
}

/** Work that begins on a review's branch begins there on the same branch, as origin has it. */
export async function beginsOf(
  wire: Wiring,
  task: string,
  project: string,
  from: string,
): Promise<NonNullable<Take['begins']>> {
  const branch = from.startsWith('origin/') ? from.slice('origin/'.length) : null
  const root = rootOf(wire, project)
  if (branch === null || root === null) {
    throw new Error(
      `${task} begins on ${from}, which is not a branch on origin, so another machine could not begin there.`,
    )
  }
  const head = await runProgram('git', ['-C', root, 'rev-parse', '--verify', `${from}^{commit}`], {
    timeoutMs: 10_000,
  })
  if (head.code !== 0) throw new Error(`${task} begins on ${from}, which is not here to read.`)
  return { branch, head: head.stdout.trim() }
}

/**
 * Removed here once the other machine has it: null, or why it could not be.
 * Where it is, as the journal said when it was made — it has not started, so
 * nothing has moved it since.
 */
export async function removeHere(
  wire: Wiring,
  task: string,
  project: string,
): Promise<string | null> {
  const client = wire.opts.client
  const [made] = await client.log.read({ task, types: ['task_created'] })
  const worktree = typeof made?.detail.worktree === 'string' ? made.detail.worktree : null
  const branch = typeof made?.detail.branch === 'string' ? made.detail.branch : ''
  const root = rootOf(wire, project)
  if (worktree === null || root === null) return 'the journal does not say where it is'
  try {
    const result = await client.removeTask({ root, worktree, branch, task, force: true })
    return result.removed ? null : result.reason
  } catch (err) {
    return why(err)
  }
}

/** The root of a project here, as the config has it; or null where it has none. */
function rootOf(wire: Wiring, project: string): string | null {
  const projects = wire.opts.config.projects
  const configured = Object.hasOwn(projects, project) ? projects[project] : undefined
  return configured === undefined ? null : expandHome(configured.root)
}
