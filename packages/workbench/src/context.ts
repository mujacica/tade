import { constants as FS } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { type EventInput, TaskId, taskDir } from '@tade/core'
import { aloneOn, taskContextPath } from './tasks.ts'

// Adding to what a task's agent is told, which is the one write a request from
// away makes to a file rather than to the journal.
//
// **It is an append, by task id, and never a path.** The caller says which
// task; where that task's own files are is `taskDir`'s answer and nothing
// else's. So there is no path on the wire, nothing to normalise, no `..` to
// refuse — and the containment that is still owed is owed *here*, because a
// task folder is a folder on a disk and a folder can be a link to somewhere
// else.
//
// **What the containment actually is, and the limit, said rather than implied.**
// Three things, in this order:
//
// 1. The id is `TaskId`'s own regex, so `taskFolder` is given something that
//    cannot contain a separator before it ever builds a path.
// 2. The task's folder is resolved with `realpath` and must come out **inside**
//    the resolved home. That is what catches a folder, or anything above it,
//    that is a link pointing out of the home — which `taskDir` on its own does
//    not: joining names produces a path inside the home and says nothing
//    about what the directories on it are.
// 3. The file itself is opened `O_NOFOLLOW`, so a `context.md` that is a
//    symlink is refused by the open rather than followed by it. That one is
//    atomic: the check and the write are the same call.
//
// The limit is step 2. Node has no `openat`, so between resolving the folder
// and opening the file inside it a directory on the path could be replaced —
// the window is microseconds and the check is made **again afterwards**, so a
// swap is a refusal rather than a write somewhere else, but it is not the
// impossibility that `O_NOFOLLOW` gives the last component. Written down
// because a caller who believed otherwise would stop thinking about it, and
// because the thing that would close it properly is a different API.
//
// What that threat model is *worth* is also worth saying: everything under
// Tade's home is writable by whoever runs Tade, agents included
// (`KEYS_AND_AGENTS`), and something already running as you needs no symlink
// to edit a context file. So this is containment against links and mistakes —
// a home restored from a backup with a symlinked project, a task folder
// somebody moved — and never a boundary around an attacker who is already
// inside.

/**
 * How much of a task's context may be the result of adding to it from away.
 *
 * A total and not a per-append bound: the per-act bound is `@tade/web`'s
 * (`BOUNDS.add`), and without a total a phone could add four thousand
 * characters a thousand times and rewrite an agent's instructions by
 * accumulation. Over it is a refusal and never a truncation.
 */
export const CONTEXT_MAX = 64_000

/** That there is no such task, so there is nothing to add to. */
export class NoTaskFolder extends Error {
  constructor(task: string) {
    super(`there is no folder for ${task}: nothing to add to`)
    this.name = 'NoTaskFolder'
  }
}

/** That the context file is not a file Tade will write, and why. */
export class ContextNotOurs extends Error {
  constructor(said: string) {
    super(said)
    this.name = 'ContextNotOurs'
  }
}

/** That adding this would take the context past what one may ever be. */
export class ContextTooBig extends Error {
  /** What it is now, so the caller can say how much room is left. */
  readonly bytes: number

  constructor(bytes: number) {
    super(
      `that would take the context past ${CONTEXT_MAX} characters (it is ${bytes} now): say less, or edit it at the machine`,
    )
    this.name = 'ContextTooBig'
    this.bytes = bytes
  }
}

/** What adding came to: how big the file is now, and the heading it went under. */
export interface ContextAdded {
  task: string
  bytes: number
  /** Tade's own heading for the block. Never the text itself. */
  heading: string
}

/**
 * Add to a task's context: the file, then the line in the journal.
 *
 * The order is the order `park` uses and for the same reason — nothing is
 * written down that did not happen, so the file moves first and a throw leaves
 * no line claiming it did.
 *
 * **One at a time per file** (`aloneOn`), which is what makes two appends two
 * blocks rather than one lost one. An append is commutative, so a person
 * typing at the machine and a phone adding a paragraph cannot lose each
 * other's words whatever order they land in — which is the property an
 * If-Match was reaching for, had there been a way to read the file out to a
 * phone and write it back.
 */
export async function addToContext(
  tade: { home: string; log: { append(input: EventInput): Promise<unknown> } },
  req: {
    task: string
    /** What to add, verbatim. Never reworded, never trimmed into meaning. */
    add: string
    /** Who asked: `you`, or `device <id>`. Goes on the heading and the line. */
    by: string
    /** The moment, so nothing here reads a clock. */
    at: number
  },
): Promise<ContextAdded> {
  if (!TaskId.safeParse(req.task).success) throw new NoTaskFolder(req.task)
  const home = await inside(tade.home, req.task)
  const path = taskContextPath(tade.home, req.task)
  const heading = headingFor(req.by, req.at)
  const bytes = await aloneOn(path, async () => {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      // `O_NOFOLLOW` is the atomic half: a `context.md` that is a link is
      // refused by this call rather than followed by it. `O_APPEND` so the
      // write goes to the end whatever else has it open, and `O_CREAT`
      // because a task may never have had a context file at all — an append
      // to one of those is the first thing in it.
      handle = await open(path, FS.O_WRONLY | FS.O_CREAT | FS.O_APPEND | NOFOLLOW, 0o600)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'ELOOP' || code === 'EMLINK') {
        throw new ContextNotOurs(`${req.task}’s context file is a link: Tade will not write it`)
      }
      if (code === 'ENOENT') throw new NoTaskFolder(req.task)
      throw err
    }
    try {
      const was = (await handle.stat()).size
      const text = `\n${heading}\n\n${req.add}\n`
      if (was + text.length > CONTEXT_MAX) throw new ContextTooBig(was)
      // Asked **again**, now that the file is open, so a directory on the path
      // that was swapped between the resolve and the open is a refusal rather
      // than a write somewhere else. The window is what it is; the answer to
      // it being open at all is in this file's own comment.
      await inside(home.home, req.task)
      await handle.write(text)
      return was + text.length
    } finally {
      await handle.close()
    }
  })
  await tade.log.append({
    type: 'context_added',
    task: req.task,
    // Names, counts and Tade's own words: how much was added and by whom,
    // never a word of what was added. The text is in the file, where the agent
    // reads it; a journal that held a copy would put somebody's words in two
    // places with one of them unreachable.
    detail: { by: req.by, added: req.add.length, bytes },
  })
  return { task: req.task, bytes, heading }
}

/** `O_NOFOLLOW` where the platform has one, and nought where it does not. */
const NOFOLLOW: number = FS.O_NOFOLLOW ?? 0

/**
 * Tade's own heading for one added block.
 *
 * **Said by Tade and about the request, never in the person's voice.** An
 * agent reading its context has to be able to tell what the owner wrote when
 * the task was made from what arrived afterwards and from where — the same
 * reason a remote act is `device <id>` in the journal and never `you`
 * (`ACTING_IS_NOT_YOU`). The words beneath it are verbatim.
 */
export function headingFor(by: string, at: number): string {
  return `## Added ${new Date(at).toISOString()} by ${by}`
}

/**
 * The task's own folder, resolved, and inside the home it claims to be in.
 *
 * Both ends are resolved, because a home that is itself reached through a link
 * — `/tmp` on a Mac, a home somebody symlinked — would otherwise fail this
 * for every task. What is compared is the resolved folder against the resolved
 * home, by path segment, so `<home>-other/tasks/x` is not inside `<home>`.
 */
async function inside(home: string, task: string): Promise<{ home: string; dir: string }> {
  let real: string
  let realHome: string
  try {
    realHome = await realpath(resolve(home))
    real = await realpath(taskDir(home, task))
  } catch {
    throw new NoTaskFolder(task)
  }
  const step = relative(realHome, real)
  if (step === '' || step.startsWith('..') || step.startsWith(sep) || resolve(step) === step) {
    throw new ContextNotOurs(
      `${task}’s folder does not resolve inside Tade’s home: Tade will not write it`,
    )
  }
  return { home, dir: real }
}
